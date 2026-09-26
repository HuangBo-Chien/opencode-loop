// Runner: the decision core. Pure functions over a run-state document; the
// enforcement layer calls these before/after host tool activity and persists
// the mutated state through the run store. Design invariants:
// - Nodes are units of work; agents are roles executing them.
// - The task DAG stays acyclic; bounded repair loops re-PENDING nodes and are
//   counted separately via revisionCounters.
// - Verdicts: PASS advances, REVISE returns to planner (capped), FAIL
//   triggers capped repair (or pauses when the repair budget is gone),
//   UNVERIFIED pauses for a user decision.
// - Evidence binds to artifact versions; superseded or hash-mismatched
//   artifacts invalidate downstream results conservatively.

import { cleanJson } from './json-safe.mjs';
import { resolveEffectClaims } from './effect-resolution.mjs';
import { captureVerificationPause, prepareVerificationRetry } from './recovery-policy.mjs';
import { artifactRef, canonicalRef, exactRef, lineageIndex, consumedRefs, publishArtifact, retainedLineage, validateRepairTargets, repairClosure, applyRepair, repairSettlementPending } from './artifact-dependencies.mjs';
import { matchScopePath, normalizeScopePath, validateFileClaim, validateTaskGraph, validateDependencies, canonicalOutput, ARTIFACT_REF_PATTERN } from './task-spec.mjs';

const READ_ONLY_AGENTS = new Set(['graph-explorer', 'graph-multimodal', 'graph-planner', 'graph-plan-critic']);
const WRITE_AGENTS = new Set(['graph-implementer', 'graph-verifier']);
const ELIGIBLE_STATES = new Set(['PENDING', 'INCOMPLETE', 'STALE']);
const TERMINAL_RUN = new Set(['FAILED', 'SUCCEEDED', 'ABORTED']);

// A terminal tool error proves the attempt ended, not that a write occurred.
// Legacy successful after-hook entries have neither field and stay confirmed.
export function isUncertainEffect(effect) {
  return effect.uncertain === true || effect.outcome === 'error';
}

// New ledger admissions leave headroom below sanitizeRun's 1 MiB / 20k values
// / 1000 array elements for outstanding calls to record witnesses and settle.
export function assertSettlementCapacity(state) {
  cleanJson(state, { maxBytes: 524_288, maxValues: 12_000, maxDepth: 32 });
  if ((state.sideEffects?.length ?? 0) + (state.pendingEffects?.length ?? 0) > 900) {
    throw new TypeError('side-effect history has no reserved settlement capacity');
  }
}

function nodeMaxAttempts(node, fallback) {
  return Number.isInteger(node.spec.maxAttempts) ? node.spec.maxAttempts : fallback;
}

// Appended to dependency denials so a naming mismatch points straight at the
// contract instead of looking like a missing deliverable.
function artifactNameHint(entries) {
  return entries.some((entry) => typeof entry === 'string' && entry.includes('does not exist'))
    ? ' (runner artifact names are findings, plan, review, change:<implement node id>, verification:<verify node id>, baseline:<baseline verify node id>; resubmit a corrected plan if an input name is wrong)'
    : '';
}

// A nonzero command on a PASS verdict is tolerated only when the exact
// command string and exit code match a still-valid baseline entry, i.e. the
// failure predates the change and did not get worse. Matching stays purely
// mechanical (no output parsing) and therefore ecosystem-agnostic.
function baselineMatches(state, command) {
  return Object.values(state.artifacts).some((artifact) => artifact.kind === 'baseline'
    && artifact.status === 'valid'
    && Array.isArray(artifact.payload?.commands)
    && artifact.payload.commands.some((entry) => entry?.command === command.command && entry?.exitCode === command.exitCode));
}

// PASS/FAIL verification binding derives one artifact ref per dependsOn entry,
// keyed by the dependency's node kind: implement deps mint change:<id>,
// baseline verify deps mint baseline:<id>, other verify deps mint
// verification:<id>. Verify nodes never produce change: artifacts, so a
// verify→verify dependency must bind to the upstream verification instead.
const verificationDependencyName = (spec, id) => spec?.kind === 'verify' ? canonicalOutput(spec) : `change:${id}`;

function depArtifactRef(state, dep) {
  const name = verificationDependencyName(state.nodes[dep]?.spec, dep);
  return `${name}@${state.artifacts[name]?.version ?? 1}`;
}

// Version pins on plan/review inputs are unknowable at authoring time: the
// plan's version is assigned by the very submission that carries the graph,
// and the gating review's version by the critic's future verdict. A pin
// copied from a previous revision (plan@1 once the runner assigns v2) stays
// forever stale and strands the review node behind a dependency that can
// never be satisfied again. The runner therefore rewrites these references
// mechanically instead of trusting planner-authored version numbers:
// plan (pinned or not) re-pins to the version being created, review pins
// resolve unpinned to whichever PASS verdict eventually gates this graph.
// Evidence pins to pre-existing artifacts (findings@N, change:<id>@N,
// verification:<id>@N) are kept exactly as authored.
function normalizePlanInputs(specs, version) {
  const rewritten = new Map();
  for (const [id, spec] of specs) {
    if (!Array.isArray(spec.inputs) || !spec.inputs.some((ref) => ref === 'plan' || ref === 'review' || /^plan@\d+$/.test(ref) || /^review@\d+$/.test(ref))) {
      rewritten.set(id, spec);
      continue;
    }
    rewritten.set(id, {
      ...spec,
      inputs: spec.inputs.map((ref) => {
        if (ref === 'plan' || /^plan@\d+$/.test(ref)) return `plan@${version}`;
        if (ref === 'review' || /^review@\d+$/.test(ref)) return 'review';
        return ref;
      }),
    });
  }
  return rewritten;
}

const completedByPlan = (spec) => ['explore', 'analyze', 'plan'].includes(spec.kind);

// A current explicit pin has a finite read window: its slot will be replaced
// on the producer's next success. Protect that read in BOTH validation and
// dispatch, including pinned provenance of pre-existing evidence. Unpinned
// inputs may consume the replacement and need no direct read-before-write edge.
function publicationReaders(nodes, artifacts) {
  const readers = new Map([...nodes.keys()].map((id) => [id, new Map()]));
  const producers = new Map([...nodes.values()].filter((node) => !completedByPlan(node.spec))
    .map((node) => [canonicalOutput(node.spec), node.spec.id]));
  // Every cache belongs to this calculation only. Publications, state changes
  // and replans must be observed by the next inspection/admission/check.
  const resolutions = new Map();
  const resolve = (ref) => {
    if (!resolutions.has(ref)) resolutions.set(ref, artifactRef({ artifacts }, ref));
    return resolutions.get(ref);
  };
  const inputs = new Map([...nodes].map(([id, node]) => [id, new Set(node.spec.inputs ?? [])]));
  // Only prerequisites that scheduling actually awaits can order a future
  // publication before a read: dependsOn and currently unresolved inputs.
  const prerequisites = new Map([...nodes].map(([id, node]) => [id, [
    ...(node.spec.dependsOn ?? []),
    ...[...inputs.get(id)].filter((ref) => resolve(ref).missing)
      .map((ref) => producers.get(ref.split('@')[0])).filter(Boolean),
  ]]));
  function awaitsPublication(id, producer, seen = new Set()) {
    const node = nodes.get(id);
    if (!node || completedByPlan(node.spec) || ['SUCCEEDED', 'SKIPPED'].includes(node.state) || seen.has(id)) return false;
    if (id === producer) return true;
    seen.add(id);
    return prerequisites.get(id).some((dep) => awaitsPublication(dep, producer, seen));
  }
  // Build the reachable provenance graph once. Propagate only pins naming a
  // proposed publisher (at most one per node), rather than recursively copying
  // entire historical chains for every ref. The worklist also handles shared
  // ancestors and legacy provenance cycles without recursion or partial caches.
  const sources = new Map();
  const parents = new Map();
  const provenance = new Map();
  const work = [];
  function collect(root) {
    const pending = [root];
    while (pending.length) {
      const ref = pending.pop();
      if (sources.has(ref)) continue;
      const pins = new Set();
      sources.set(ref, pins);
      const { artifact } = resolve(ref);
      if (!artifact) continue;
      const [name, pin] = ref.split('@');
      if (pin !== undefined && producers.has(name)) {
        pins.add(name);
        work.push([ref, name]);
      }
      // Current-plan publications have already consumed their provenance.
      if (name === 'plan' || nodes.get(producers.get(name))?.state === 'SUCCEEDED') continue;
      if (!provenance.has(artifact)) provenance.set(artifact, new Set(artifact.basedOn ?? []));
      for (const source of provenance.get(artifact)) {
        if (!parents.has(source)) parents.set(source, new Set());
        parents.get(source).add(ref);
        pending.push(source);
      }
    }
  }
  const reads = [];
  for (const node of nodes.values()) {
    if (completedByPlan(node.spec) || ['SUCCEEDED', 'SKIPPED'].includes(node.state)) continue;
    for (const ref of inputs.get(node.spec.id)) {
      const [name, pin] = ref.split('@');
      // A latest-version read behind its producer consumes the replacement,
      // not the old slot's provenance. Explicit old pins still need protection
      // and will form a rejection cycle if replacement must happen first.
      const producer = producers.get(name);
      if (pin === undefined && producer && producer !== node.spec.id && awaitsPublication(node.spec.id, producer)) continue;
      collect(ref);
      reads.push([node.spec.id, ref]);
    }
  }
  for (let index = 0; index < work.length; index++) {
    const [ref, name] = work[index];
    for (const parent of parents.get(ref) ?? []) {
      if (!sources.get(parent).has(name)) {
        sources.get(parent).add(name);
        work.push([parent, name]);
      }
    }
  }
  for (const [id, ref] of reads) {
    for (const name of sources.get(ref)) {
      const producer = producers.get(name);
      // Own-slot reads finish before the node's own publication. Overlapping
      // refs need just one barrier per publisher/reader, with a witness ref.
      if (producer !== id && !readers.get(producer).has(id)) readers.get(producer).set(id, { id, via: `preserve ${ref} before replacing ${name}` });
    }
  }
  return new Map([...readers].map(([id, entries]) => [id, [...entries.values()]]));
}

// Project replacement effects without touching the accepted run. Status-only
// propagation also prevents a previous PASS, based on the old approval/change,
// from bootstrapping a new review. Historical payloads remain inspectable.
function planArtifacts(state, plan) {
  const artifacts = Object.fromEntries(Object.entries(state.artifacts).map(([name, artifact]) => [name, { ...artifact }]));
  // Invalidate old provenance before installing the new plan, so an unpinned
  // historical `plan` reference cannot silently rebind to the replacement.
  for (const artifact of Object.values(artifacts)) {
    if (artifact.status === 'valid' && ['plan', 'review', 'baseline'].includes(artifact.kind)) artifact.status = 'superseded';
  }
  let changed;
  do {
    changed = false;
    for (const artifact of Object.values(artifacts)) {
      if (artifact.status !== 'valid') continue;
      if ((artifact.basedOn ?? []).some((ref) => artifactRef({ artifacts }, ref).missing)) {
        artifact.status = 'stale';
        changed = true;
      }
    }
  } while (changed);
  artifacts.plan = plan;
  return artifacts;
}

function validatePlanLiveness(nodes, artifacts, basedOn, executionNodes = null) {
  const errors = [];
  const producers = new Map([...nodes.values()].filter((spec) => !completedByPlan(spec)).map((spec) => [canonicalOutput(spec), spec]));
  const edges = new Map([...nodes].map(([id, spec]) => [id, spec.dependsOn.map((id) => ({ id, via: 'dependsOn' }))]));
  function requireRef(id, ref, { historicalOnly = false, origin = 'input', planProvenance = false } = {}) {
    if (typeof ref !== 'string' || !ARTIFACT_REF_PATTERN.test(ref)) {
      errors.push(`${id}: invalid artifact reference ${String(ref)}`);
      return;
    }
    const [name, pin] = ref.split('@');
    const consumer = planProvenance ? null : nodes.get(id);
    const resolution = artifactRef({ artifacts }, ref);
    // Plan is installed by this submission, not a retained prior own output.
    // Other valid own-slot evidence can be read before publishing its successor.
    const submittedPlan = name === 'plan' && (consumer?.kind === 'plan' || planProvenance);
    if (!resolution.missing && !submittedPlan) return;
    if ((consumer && !['explore', 'analyze'].includes(consumer.kind) && canonicalOutput(consumer) === name)
      || (planProvenance && name === 'plan')) {
      errors.push(`${id} --${ref}--> ${id}: artifact dependency cycle (self-reference); remove this input or cite independent existing evidence`);
      return;
    }
    const producer = producers.get(name);
    const nextVersion = (artifacts[name]?.version ?? 0) + 1;
    if (!historicalOnly && producer && (pin === undefined || Number(pin) === nextVersion)) {
      edges.get(id).push({ id: producer.id, via: ref });
      return;
    }
    errors.push(`${id}: ${origin} ${ref}: ${resolution.missing}; ${producer && !historicalOnly
      ? `${producer.id} can publish only ${name}@${nextVersion} in this plan; correct the pin or use ${name}`
      : 'no satisfiable future producer; submit currently-valid evidence first or correct the input/producer (explore/analyze nodes document existing findings, they do not publish on plan acceptance)'}`);
  }
  for (const spec of nodes.values()) {
    // Retry keeps completed work. Unlike plan replacement, it cannot model
    // successful producers as future publications that will replace evidence.
    if (executionNodes && ['SUCCEEDED', 'SKIPPED'].includes(executionNodes.get(spec.id)?.state)) continue;
    for (const ref of spec.inputs ?? []) requireRef(spec.id, ref, { historicalOnly: completedByPlan(spec) });
    // PASS derives evidence from every dependsOn entry, even without inputs.
    // Keep this naming identical to submitVerification's default bindings.
    if (spec.kind === 'verify' && spec.baseline !== true) {
      for (const dep of spec.dependsOn) requireRef(spec.id, verificationDependencyName(nodes.get(dep), dep), { origin: `dependsOn ${dep} requires` });
    }
  }
  for (const ref of basedOn) requireRef('plan.basedOn', ref, { historicalOnly: true, planProvenance: true });
  if (errors.length) return { ok: false, errors };
  const readers = publicationReaders(executionNodes ?? new Map([...nodes].map(([id, spec]) => [id, { spec, state: 'PENDING' }])), artifacts);
  for (const [id, dependencies] of readers) {
    if (!executionNodes || !['SUCCEEDED', 'SKIPPED'].includes(executionNodes.get(id)?.state)) edges.get(id).push(...dependencies);
  }
  return validateDependencies(nodes, (spec) => edges.get(spec.id));
}

function dependencyChecker(state) {
  const readers = publicationReaders(new Map(Object.entries(state.nodes)), state.artifacts);
  const results = new Map();
  return (node) => {
    if (results.has(node)) return results.get(node);
    const missing = [];
    for (const dep of new Set(node.spec.dependsOn ?? [])) {
      const dependency = state.nodes[dep];
      if (!dependency) missing.push(`dependency ${dep} does not exist`);
      else if (dependency.state !== 'SUCCEEDED') missing.push(`dependency ${dep} is ${dependency.state}`);
    }
    for (const input of new Set(node.spec.inputs ?? [])) {
      const resolution = artifactRef(state, input);
      if (resolution.missing) missing.push(resolution.missing);
    }
    for (const reader of readers.get(node.spec.id) ?? []) missing.push(`${reader.id} must consume ${reader.via}`);
    const result = { ok: missing.length === 0, missing };
    results.set(node, result);
    return result;
  };
}

export function depsSatisfied(state, node) {
  return dependencyChecker(state)(node);
}

// Exhaustion and fundamental rejection no longer fail the run silently: the
// run pauses for an explicit user decision (graph_run_decide). Nodes, attempt
// counters, artifacts and violations stay exactly as they were for audit.
function pauseForDecision(state, cause, detail, now, identity = {}) {
  state.status = 'AWAITING_USER_DECISION';
  if (!state.pendingDecision) {
    state.pauseSequence = (state.pauseSequence ?? 0) + 1;
    state.pendingDecision = { cause, detail, at: now, pauseId: state.pauseSequence, ...identity };
  }
  state.blockedReason = null;
  state.updatedAt = now;
}

// Circuit breaker for deterministic verification rejections: two consecutive
// identical content-level rejections mean the submitted payload has not fixed
// the problem, so instead of burning the session in a loop the run pauses for
// a user decision and the node returns to PENDING (graph_run_decide's
// in-flight check can then pass). The streak deliberately persists across
// re-dispatches — a fresh session resubmitting the same broken payload is
// still the same loop — and resets only on an accepted verdict (which also
// covers rejections the corrected payload outgrew) or a different rejection.
function trackRejection(state, node, code, detail, now, evidence) {
  const previous = node.rejectionStreak;
  node.rejectionStreak = previous && previous.code === code && previous.detail === detail
    ? { code, detail, count: previous.count + 1 }
    : { code, detail, count: 1 };
  if (node.rejectionStreak.count >= 2) {
    node.state = 'PENDING';
    node.finishedAt = now;
    pauseForDecision(state, 'runner-rejection', detail, now, captureVerificationPause(state, node, { ...evidence, detail }, code));
    return { ok: false, code: 'REJECTION_LOOP', detail: `${node.rejectionStreak.count} consecutive identical ${code} rejections: ${detail}` };
  }
  return { ok: false, code, detail };
}

// Irreversible user termination. Evidence is preserved untouched; only the
// status, the reason and the decision record change.
function abortRun(state, { reason, now }) {
  state.status = 'ABORTED';
  state.failReason = `aborted by user: ${reason}`;
  state.blockedReason = null;
  state.decision = { action: 'abort', reason, at: now };
  state.updatedAt = now;
}

// Reset archives the run in place: original status, pendingDecision and all
// evidence remain; the successor link transfers session ownership.
function archiveForReset(state, { reason, successorRunId, now }) {
  state.decision = { action: 'reset', reason, at: now };
  state.successorRunId = successorRunId;
  state.updatedAt = now;
}

function completeIfDone(state, now) {
  if (state.repairPlanRevision) return false;
  const nodes = Object.values(state.nodes);
  if (nodes.length && nodes.every((node) => node.state === 'SUCCEEDED' || node.state === 'SKIPPED')) {
    state.status = state.lifecycleVersion === 1 ? 'SETTLING' : 'SUCCEEDED';
    state.blockedReason = null;
    state.updatedAt = now;
    return true;
  }
  return false;
}

export function createRunner({ maxAttempts, maxPlanRevisions, implementerParallel = 2, readerParallel = 4 }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isInteger(maxPlanRevisions) || maxPlanRevisions < 1) throw new TypeError('maxPlanRevisions must be a positive integer');
  if (!Number.isInteger(implementerParallel) || implementerParallel < 1 || implementerParallel > 4) throw new TypeError('implementerParallel must be an integer from 1 to 4');
  if (!Number.isInteger(readerParallel) || readerParallel < 1 || readerParallel > 16) throw new TypeError('readerParallel must be an integer from 1 to 16');

  // Effective writer capacity: the configured ceiling, narrowed by the
  // critic's approvedParallel when the current valid review provides one.
  function implementerCapacity(state) {
    const review = state.artifacts.review;
    const approved = review && review.status === 'valid' && Number.isInteger(review.payload?.approvedParallel) && review.payload.approvedParallel >= 1
      ? review.payload.approvedParallel : null;
    return Math.max(1, Math.min(implementerParallel, approved ?? implementerParallel));
  }

  // Effective reader capacity: the configured ceiling for concurrent
  // read-only exploration/analysis work. Node-bound reader dispatches are
  // gated here; free consultations will be gated at the dispatch-binding
  // layer against this same ceiling.
  function readerCapacity(state) {
    return readerParallel;
  }

  // Bounded revision/repair context derived from artifacts so dispatches
  // mechanically carry the critic's findings or the verifier's failure
  // evidence instead of relying on the coordinator to relay them.
  function revisionContext(state, chosen) {
    if (chosen.spec.kind === 'plan') {
      const reviews = Object.values(state.artifacts)
        .filter((artifact) => artifact.kind === 'review' && artifact.payload?.verdict === 'REVISE')
        .sort((a, b) => b.version - a.version);
      const latest = reviews[0];
      const findings = Array.isArray(latest?.payload?.findings)
        ? latest.payload.findings.slice(0, 8).map((finding) => String(finding).slice(0, 500))
        : [];
      return findings.length ? { reviseFindings: findings } : null;
    }
    if (chosen.spec.kind === 'implement' || chosen.spec.kind === 'verify') {
      if (chosen.repairEvidence) return { repairEvidence: chosen.repairEvidence };
      const failures = Object.values(state.artifacts)
        .filter((artifact) => {
          if (artifact.kind !== 'verification' || artifact.payload?.verdict !== 'FAIL') return false;
          const verifier = state.nodes[artifact.nodeId];
          return (artifact.payload.affectedNodeIds ?? artifact.payload.repairTargets ?? verifier?.spec?.dependsOn ?? []).includes(chosen.spec.id);
        })
        .sort((a, b) => b.version - a.version);
      const latest = failures[0];
      if (!latest) return null;
      return {
        repairEvidence: {
          verifier: latest.nodeId,
          summary: String(latest.payload?.summary ?? '').slice(0, 500),
          commands: (Array.isArray(latest.payload?.commands) ? latest.payload.commands : [])
            .slice(0, 5)
            .map((command) => `${String(command?.command ?? '').slice(0, 200)} (exit ${command?.exitCode ?? '?'})`),
        },
      };
    }
    return null;
  }

  // Per-node admissibility shared by the sorted and coordinator-targeted paths.
  // Attempt exhaustion keeps sorted-path semantics: the node fails, and write
  // agents additionally fail the run.
  function admissibleNode(state, chosen, agent, now, checkDeps) {
    if (repairSettlementPending(state, chosen.spec.id)) return { allowed: false, code: 'REPAIR_SETTLEMENT_PENDING', detail: `${chosen.spec.id} must await revoked host lifetimes and pending effects` };
    if (state.repairPlanRevision && !['plan', 'explore', 'analyze'].includes(chosen.spec.kind)) {
      return { allowed: false, code: 'PLAN_REVISION_REQUIRED', ...state.repairPlanRevision };
    }
    if (!ELIGIBLE_STATES.has(chosen.state)) {
      return { allowed: false, code: 'NODE_NOT_ADMISSIBLE', detail: `${chosen.spec.id} is ${chosen.state} and cannot begin` };
    }
    const deps = checkDeps(chosen);
    if (!deps.ok) {
      return { allowed: false, code: 'NODE_NOT_ADMISSIBLE', detail: `${chosen.spec.id} is not yet admissible: ${deps.missing.join(', ')}${artifactNameHint(deps.missing)}` };
    }
    if (chosen.attempt >= nodeMaxAttempts(chosen, maxAttempts)) {
      chosen.state = 'FAILED';
      chosen.finishedAt = now;
      pauseForDecision(state, 'attempt-budget-exhausted', `${chosen.spec.id} exhausted its attempt budget`, now);
      return { allowed: false, code: 'ATTEMPTS_EXHAUSTED', detail: `${chosen.spec.id} has no attempts left` };
    }
    return { allowed: true, nodeId: chosen.spec.id, reconcile: chosen.reconcile === true
      || state.sideEffects.some((effect) => effect.nodeId === chosen.spec.id)
      || (state.pendingEffects ?? []).some((effect) => effect.nodeId === chosen.spec.id), ...(revisionContext(state, chosen) ?? {}) };
  }

  function admitDispatch(state, { agent, now, nodeId = null, excludeNodeIds = null, consultOnly = false, autoResolveUnique = false }) {
    if (TERMINAL_RUN.has(state.status)) {
      return { allowed: false, code: 'RUN_TERMINATED', detail: state.failReason ? `run failed: ${state.failReason}` : 'run already finished' };
    }
    if (state.status === 'RECOVERY_REQUIRED') {
      return { allowed: false, code: 'RECOVERY_REQUIRED', detail: 'run needs graph_run_resume before further dispatch' };
    }
    if (state.status === 'AWAITING_USER_DECISION') {
      const pending = state.pendingDecision;
      return { allowed: false, code: 'AWAITING_DECISION', detail: pending ? `run is awaiting a user decision (${pending.cause}: ${pending.detail}); report to the user and use graph_run_decide to abort, reset, or retry an eligible verifier with expectedPauseId` : 'run is awaiting a user decision; inspect the pause and use graph_run_decide' };
    }
    // No code path sets BLOCKED anymore; this branch and blockedReason stay
    // for legacy persisted runs, which graph_run_decide can still terminate
    // (abort/reset do not gate on status).
    if (state.status === 'BLOCKED') {
      return { allowed: false, code: 'RUN_BLOCKED', detail: state.blockedReason ? `${state.blockedReason.kind}: ${state.blockedReason.detail}` : 'run is blocked' };
    }
    if (typeof agent !== 'string' || !agent.length) {
      return { allowed: false, code: 'AGENT_REQUIRED', detail: 'task dispatch requires subagent_type naming a graph-* specialist (graph-explorer, graph-planner, graph-plan-critic, graph-implementer, graph-verifier, graph-multimodal)' };
    }
    if (!READ_ONLY_AGENTS.has(agent) && !WRITE_AGENTS.has(agent)) {
      return { allowed: false, code: 'INVALID_AGENT', detail: `${agent} is not a dispatchable graph specialist` };
    }

    if (consultOnly) {
      if (state.status !== 'RUNNING' || agent !== 'graph-multimodal' || nodeId !== null) {
        return { allowed: false, code: 'INVALID_CONSULT', detail: 'consultOnly requires a RUNNING run, graph-multimodal and no node target' };
      }
      return { allowed: true, nodeId: null, free: true };
    }
    const mine = Object.values(state.nodes).filter((node) => node.spec.agent === agent);
    // Implementers run under a bounded-capacity writer gate: several write
    // nodes with pairwise-disjoint writeScopes may be RUNNING at once, up to
    // min(implementerParallel, critic-approvedParallel). Explorers and
    // multimodal analysts share a bounded reader gate: up to readerParallel
    // explore/analyze nodes may be RUNNING at once. Every other role keeps
    // one-in-flight semantics.
    if (agent === 'graph-implementer') {
      const running = Object.values(state.nodes).filter((node) => node.spec.kind === 'implement' && node.state === 'RUNNING').length;
      const capacity = implementerCapacity(state);
      if (running >= capacity) {
        return { allowed: false, code: 'WRITER_CAPACITY', detail: `${running}/${capacity} implement nodes are in flight; wait for one to finish before dispatching another` };
      }
    } else if (agent === 'graph-explorer' || agent === 'graph-multimodal') {
      const running = Object.values(state.nodes).filter((node) => (node.spec.kind === 'explore' || node.spec.kind === 'analyze') && node.state === 'RUNNING').length;
      const capacity = readerCapacity(state);
      if (running >= capacity) {
        return { allowed: false, code: 'READER_CAPACITY', detail: `${running}/${capacity} read-only exploration/analysis tasks are in flight; wait for one to finish before dispatching another` };
      }
    } else if (mine.some((node) => node.state === 'RUNNING')) {
      return { allowed: false, code: 'ALREADY_RUNNING', detail: `a ${agent} task for this run is still in flight` };
    }

    const checkDeps = dependencyChecker(state);
    // Coordinator-targeted dispatch: validate exactly the requested node so
    // the binding always matches the node the coordinator described.
    if (typeof nodeId === 'string' && nodeId.length) {
      const chosen = mine.find((node) => node.spec.id === nodeId);
      if (!chosen) {
        return { allowed: false, code: 'NODE_NOT_FOUND', detail: `${nodeId} is not a ${agent} node in the current task graph` };
      }
      const result = admissibleNode(state, chosen, agent, now, checkDeps);
      if (!result.allowed && result.code === 'NODE_NOT_ADMISSIBLE') {
        const others = mine
          .filter((node) => node.spec.id !== nodeId && ELIGIBLE_STATES.has(node.state))
          .map((node) => ({ id: node.spec.id, deps: checkDeps(node) }))
          .filter((entry) => entry.deps.ok)
          .map((entry) => entry.id);
          if (others.length) {
            result.detail += `; other admissible ${agent} nodes: ${others.join(', ')}`;
            result.candidates = others;
          }
      }
      return result;
    }

    // Concurrent reservations for the same role must not collide on one node:
    // the dispatcher passes already-reserved node ids to skip here.
    const exclude = excludeNodeIds instanceof Set ? excludeNodeIds
      : Array.isArray(excludeNodeIds) ? new Set(excludeNodeIds) : null;
    const ready = mine
      .filter((node) => ELIGIBLE_STATES.has(node.state) && !(exclude?.has(node.spec.id) ?? false))
      .map((node) => ({ node, deps: checkDeps(node) }))
      .filter((entry) => entry.deps.ok)
      .sort((a, b) => a.node.attempt - b.node.attempt || a.node.spec.id.localeCompare(b.node.spec.id));
    if (!ready.length) {
      // Free consultation applies only to roles whose submissions never
      // require a node binding (explorer, planner and multimodal deliver
      // findings or plans unbound). The critic can only deliver through a
      // bound review node, so an inadmissible review is rejected up front
      // instead of stranding a child that could never submit.
      if (READ_ONLY_AGENTS.has(agent) && agent !== 'graph-plan-critic') return { allowed: true, nodeId: null, free: true };
      const waiting = mine.filter((node) => ELIGIBLE_STATES.has(node.state)).map((node) => `${node.spec.id}(${checkDeps(node).missing.join(', ') || 'no attempts left'})`);
      return {
        allowed: false,
        code: 'NO_READY_NODE',
        detail: waiting.length ? `not yet admissible: ${waiting.join('; ')}${artifactNameHint(waiting)}` : `no admissible ${agent} node exists in the current task graph`,
      };
    }
    // Preserve the sorted path's top-candidate semantics (including
    // ATTEMPTS_EXHAUSTED pausing) before any ambiguity gate can apply.
    const result = admissibleNode(state, ready[0].node, agent, now, checkDeps);
    // Strict-target auto-resolve: a missing marker binds only when exactly one
    // node of the role is admissible. Several candidates stay an explicit
    // coordinator decision; malformed markers are rejected by the parser.
    if (result.allowed && autoResolveUnique) {
      if (ready.length > 1) {
        return { allowed: false, code: 'NODE_ID_REQUIRED', candidates: ready.map(entry => entry.node.spec.id), detail: `${agent} requires an explicit nodeId when several nodes are admissible (${ready.map((entry) => entry.node.spec.id).join(', ')}); set the nodeId field or use one leading [nodeId:<node>] marker` };
      }
      result.resolvedBy = 'unique-admissible';
    }
    return result;
  }

  function beginNode(state, nodeId, { now, sessionId = null, dispatchId = null }) {
    if (state.status !== 'RUNNING') throw new Error('Node execution requires a RUNNING run; paused runs permit settlement only');
    const node = state.nodes[nodeId];
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    if (repairSettlementPending(state, nodeId)) throw new Error(`${nodeId} must await repair settlement before replacement`);
    if (state.repairPlanRevision && !['plan', 'explore', 'analyze'].includes(node.spec.kind)) throw new Error(state.repairPlanRevision.detail);
    if (node.state !== 'PENDING' && node.state !== 'INCOMPLETE' && node.state !== 'STALE') throw new Error(`Node ${nodeId} is ${node.state} and cannot begin`);
    const refs = consumedRefs(state, node);
    assertSettlementCapacity({ ...state, nodes: { ...state.nodes, [nodeId]: { ...node, consumedRefs: refs } } });
    node.consumedRefs = refs;
    node.producedRef = null;
    node.state = 'RUNNING';
    node.attempt += 1;
    node.startedAt = now;
    node.sessionId = sessionId;
    node.dispatchId = dispatchId;
    node.reconcile = false;
    state.updatedAt = now;
    return node;
  }

  function attachSession(state, nodeId, sessionId) {
    const node = state.nodes[nodeId];
    if (node) node.sessionId = sessionId;
  }

  function submitPlan(state, { intent, nodes, basedOn = [], parallel = null, now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    if (state.status === 'AWAITING_USER_DECISION') {
      return { ok: false, code: 'AWAITING_DECISION', detail: 'the run is paused awaiting a user decision; deliver it with graph_run_decide before replacing the plan' };
    }
    if (intent !== 'plan-only' && intent !== 'change' && intent !== 'light') return { ok: false, code: 'INVALID_INTENT', detail: 'intent must be plan-only, change or light' };
    if (!(nodes instanceof Map) || nodes.size < 1) return { ok: false, code: 'INVALID_GRAPH', detail: 'nodes must be a non-empty validated graph' };
    const previous = state.artifacts.plan;
    const version = previous ? previous.version + 1 : 1;
    const graph = validateTaskGraph([...nodes.values()], { planOnly: intent === 'plan-only', light: intent === 'light' });
    if (!graph.ok) return { ok: false, code: 'INVALID_GRAPH', detail: graph.errors.join('; ') };
    if ([...nodes].some(([id, spec]) => id !== spec.id)) return { ok: false, code: 'INVALID_GRAPH', detail: 'Map keys must match TaskSpec node ids' };
    if (!Array.isArray(basedOn)) return { ok: false, code: 'INVALID_GRAPH', detail: 'plan.basedOn must be an array of artifact references' };
    const normalized = normalizePlanInputs(graph.nodes, version);
    const plan = { kind: 'plan', nodeId: 'plan', version, basedOn: basedOn.map((ref) => typeof ref === 'string' ? exactRef(state, ref) : ref), payload: { intent, specs: [...normalized.values()], parallel }, status: 'valid', createdAt: now };
    const artifacts = planArtifacts(state, plan);
    const liveness = validatePlanLiveness(normalized, artifacts, basedOn);
    if (!liveness.ok) return { ok: false, code: 'INVALID_GRAPH', detail: liveness.errors.join('; ') };
    const artifactLineage = retainedLineage(state, artifacts, Object.fromEntries([...normalized].map(([id, spec]) => [id, { spec }])));
    state.mode = intent;
    state.status = 'RUNNING';
    state.blockedReason = null;

    const preservedNodes = new Map(Object.values(state.nodes).map((node) => [node.spec.id, { attempt: node.attempt, sessionId: node.sessionId ?? null }]));
    state.nodes = {};
    for (const [id, spec] of normalized) {
      const preserved = preservedNodes.get(id);
      state.nodes[id] = {
        spec,
        state: 'PENDING',
        attempt: typeof preserved?.attempt === 'number' && spec.kind !== 'explore' && spec.kind !== 'analyze' ? preserved.attempt : 0,
        // The session that last worked this node survives plan replacement,
        // so a REVISE'd planner, a re-reviewing critic or a repaired
        // implementer can continue its conversation through task_id.
        sessionId: preserved?.sessionId ?? null,
        startedAt: null,
        finishedAt: null,
        reconcile: false,
        // Rejection-streak circuit breaker state (see trackRejection); null
        // on a fresh graph because a replaced plan is genuinely new work.
        rejectionStreak: null,
      };
    }
    // Explore/analyze nodes document evidence the plan was built on; the plan
    // deliverable itself is complete once submitted. Both are marked done.
    for (const node of Object.values(state.nodes)) {
      if (node.spec.kind === 'explore' || node.spec.kind === 'analyze' || node.spec.kind === 'plan') {
        node.state = 'SUCCEEDED';
        node.finishedAt = now;
      }
    }
    state.artifacts = artifacts;
    state.artifactLineage = artifactLineage;
    state.repairPlanRevision = null;
    state.updatedAt = now;
    return { ok: true, version, mode: intent };
  }

  function submitReview(state, { planVersion, verdict, findings = [], approvedParallel = null, now }) {
    if (state.status === 'AWAITING_USER_DECISION') return { ok: false, code: 'AWAITING_DECISION', detail: 'paused submissions are closeout evidence only' };
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const reviewNode = Object.values(state.nodes).find((node) => node.spec.kind === 'review');
    if (!reviewNode || reviewNode.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: 'review verdict submitted without an in-flight review dispatch' };
    const plan = state.artifacts.plan;
    if (!plan || plan.status !== 'valid' || plan.version !== planVersion) {
      return { ok: false, code: 'STALE_PLAN_VERSION', detail: plan ? `current plan is v${plan.version} (${plan.status})` : 'no plan artifact exists' };
    }
    const previous = state.artifacts.review;
    const version = previous ? previous.version + 1 : 1;

    if (verdict === 'PASS') {
      publishArtifact(state, 'review', { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: reviewNode.consumedRefs ?? [`plan@${planVersion}`], payload: { verdict, findings, approvedParallel }, status: 'valid', createdAt: now });
      reviewNode.producedRef = `review@${version}`;
      reviewNode.state = 'SUCCEEDED';
      reviewNode.finishedAt = now;
      completeIfDone(state, now);
      state.updatedAt = now;
      return { ok: true, effect: 'advance' };
    }
    if (verdict === 'REVISE') {
      publishArtifact(state, 'review', { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: reviewNode.consumedRefs ?? [`plan@${planVersion}`], payload: { verdict, findings }, status: 'superseded', createdAt: now });
      state.revisionCounters['plan-review'] += 1;
      plan.status = 'superseded';
      reviewNode.state = 'PENDING';
      reviewNode.finishedAt = now;
      const planner = Object.values(state.nodes).find((node) => node.spec.kind === 'plan');
      if (planner) planner.state = 'PENDING';
      if (state.revisionCounters['plan-review'] > maxPlanRevisions) {
        pauseForDecision(state, 'plan-revisions-exhausted', `plan revisions exhausted (maxPlanRevisions=${maxPlanRevisions} reached)`, now);
        return { ok: true, effect: 'await-decision', detail: 'plan revisions exhausted; awaiting user decision' };
      }
      state.updatedAt = now;
      return { ok: true, effect: 'revise' };
    }
    if (verdict === 'FAIL') {
      publishArtifact(state, 'review', { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: reviewNode.consumedRefs ?? [`plan@${planVersion}`], payload: { verdict, findings }, status: 'valid', createdAt: now });
      reviewNode.state = 'PENDING';
      reviewNode.finishedAt = now;
      pauseForDecision(state, 'plan-rejected-by-critic', findings.length ? `plan rejected by critic: ${findings[0]}` : 'plan rejected by critic', now);
      return { ok: true, effect: 'await-decision', detail: 'plan rejected by critic; awaiting user decision' };
    }
    return { ok: false, code: 'INVALID_VERDICT', detail: 'verdict must be PASS, REVISE or FAIL' };
  }

  function recordViolation(state, { nodeId = null, kind, detail, now, dispatchId, sessionId, callID, tool, target }) {
    state.violations.push({ nodeId, kind, detail, at: now,
      ...(dispatchId ? { dispatchId } : {}), ...(sessionId ? { sessionId } : {}),
      ...(callID ? { callID } : {}), ...(tool ? { tool } : {}), ...(target !== undefined ? { target } : {}) });
    state.updatedAt = now;
  }

  function captureRequest(state, request) {
    if (request === null || typeof request !== 'object') throw new TypeError('request must be an object');
    const { text, truncated, redactions, capturedAt } = cleanJson(request);
    if (typeof text !== 'string' || !text.length) throw new TypeError('request.text must be a nonempty string');
    if (typeof truncated !== 'boolean') throw new TypeError('request.truncated must be a boolean');
    if (!Number.isInteger(redactions) || redactions < 0) throw new TypeError('request.redactions must be a nonnegative integer');
    if (typeof capturedAt !== 'string' || !capturedAt.length) throw new TypeError('request.capturedAt must be a nonempty string');
    if (state.requestCaptureCompleted) return { changed: false };
    state.request = { text, truncated, redactions, capturedAt };
    state.requestCaptureCompleted = true;
    state.updatedAt = capturedAt;
    return { changed: true };
  }

  function completeRequestCapture(state, input) {
    if (input === null || typeof input !== 'object') throw new TypeError('request capture completion must be an object');
    const { now } = cleanJson(input);
    if (typeof now !== 'string' || !now.length) throw new TypeError('request capture completion time must be a nonempty string');
    if (state.requestCaptureCompleted) return { changed: false };
    state.requestCaptureCompleted = true;
    state.updatedAt = now;
    return { changed: true };
  }

  function rejectClaim(state, nodeId, code, detail, now) {
    const node = state.nodes[nodeId];
    const retryable = code === 'INVALID_FILE_CLAIM';
    node.lastFailure = { code, detail, retryable };
    if (!retryable) {
      recordViolation(state, { nodeId, kind: code === 'LEDGER_MISMATCH' ? 'undisclosed-edit' : 'out-of-scope-claim', detail, now });
      node.state = 'FAILED';
      node.finishedAt = now;
    }
    state.updatedAt = now;
    return { ok: false, code, detail, retryable,
      hint: retryable ? 'Correct filesTouched/filesDeleted and resubmit within this attempt; use literal file paths, not directories or globs' : 'Inspect the node failure and recorded scope/ledger evidence' };
  }

  // Strict failure for an attempt whose denied tool call executed anyway:
  // mirrors the out-of-scope claim semantics (FAILED, not retryable in this
  // attempt); a plan revision or fresh attempt is the only recovery.
  function taintAttempt(state, { nodeId, detail, now, sessionId, dispatchId }) {
    const node = state.nodes[nodeId];
    if (!node || node.state !== 'RUNNING' || typeof dispatchId !== 'string'
      || node.dispatchId !== dispatchId || node.sessionId !== sessionId) return false;
    node.lastFailure = { code: 'EXECUTED_DESPITE_DENY', detail, retryable: false };
    node.state = 'FAILED';
    node.finishedAt = now;
    state.updatedAt = now;
    return true;
  }

  function checkChange(state, { nodeId, filesTouched, filesDeleted = [], now }) {
    if (state.status === 'AWAITING_USER_DECISION') return { ok: false, code: 'AWAITING_DECISION', detail: 'paused submissions are closeout evidence only' };
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const node = state.nodes[nodeId];
    if (!node || node.spec.kind !== 'implement') return { ok: false, code: 'NOT_IMPLEMENT_NODE', detail: `${nodeId} is not an implement node` };
    if (node.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: `${nodeId} is ${node.state}` };

    const claimed = new Set();
    for (const file of filesTouched) {
      const checked = validateFileClaim(file);
      if (!checked.ok) return rejectClaim(state, nodeId, checked.code, checked.detail, now);
      const normalized = checked.path;
      claimed.add(normalized);
      if (!node.spec.writeScope.some((pattern) => matchScopePath(pattern, normalized))) {
        return rejectClaim(state, nodeId, 'OUT_OF_SCOPE', `${normalized} is outside the assigned writeScope`, now);
      }
    }
    for (const file of filesDeleted) {
      const checked = validateFileClaim(file);
      if (!checked.ok) return rejectClaim(state, nodeId, checked.code, checked.detail, now);
      if (!claimed.has(file)) return rejectClaim(state, nodeId, 'INVALID_FILE_CLAIM', `${file}: filesDeleted must be a subset of filesTouched`, now);
    }
    const edited = state.sideEffects.filter((effect) => effect.nodeId === nodeId && effect.tool === 'edit' && !isUncertainEffect(effect)).map((effect) => effect.target);
    const undisclosed = edited.filter((target) => !claimed.has(target));
    if (undisclosed.length) {
      return rejectClaim(state, nodeId, 'LEDGER_MISMATCH', `files edited but not disclosed: ${undisclosed.join(', ')}`, now);
    }
    return { ok: true, claimed: [...claimed] };
  }

  function submitChange(state, { nodeId, filesTouched, filesDeleted = [], summary, checksRun = [], unresolved = [], risks = [], snapshot = {}, now }) {
    const checked = checkChange(state, { nodeId, filesTouched, filesDeleted, now });
    if (!checked.ok) return checked;
    const node = state.nodes[nodeId];
    for (const file of checked.claimed) {
      if (!Object.hasOwn(snapshot, file)) continue; // Pure runner callers may supply no filesystem evidence.
      const value = snapshot[file];
      if (filesDeleted.includes(file) ? value !== 'MISSING' : !/^[a-f0-9]{64}$/.test(value)) {
        return rejectClaim(state, nodeId, 'INVALID_FILE_CLAIM', `${file}: ${filesDeleted.includes(file) ? 'deleted files must be absent' : 'expected a readable regular file; explicitly list deletions in filesDeleted'}`, now);
      }
    }

    const name = `change:${nodeId}`;
    const previous = state.artifacts[name];
    const version = previous ? previous.version + 1 : 1;
    const basedOn = node.consumedRefs ?? (state.artifacts.review?.status === 'valid'
      ? [`review@${state.artifacts.review.version}`]
      : [`plan@${state.artifacts.plan?.version ?? 1}`]);
    publishArtifact(state, name, { kind: 'change', nodeId, version, basedOn, payload: { filesTouched: checked.claimed, filesDeleted: [...new Set(filesDeleted)], summary, checksRun, unresolved, risks }, snapshot, status: 'valid', createdAt: now });
    node.producedRef = `${name}@${version}`;
    node.state = 'SUCCEEDED';
    node.lastFailure = null;
    node.repairEvidence = null;
    node.finishedAt = now;
    state.updatedAt = now;
    return { ok: true, version };
  }

  function submitVerification(state, args) {
    const checked = validateRepairTargets(state, args);
    if (!checked.ok) return checked;
    const candidate = structuredClone(state);
    let result;
    try {
      result = verificationTransition(candidate, { ...args, effectiveTargets: checked.targets });
      assertSettlementCapacity(candidate);
    } catch (error) {
      return { ok: false, code: 'PROVENANCE_CAPACITY', detail: `Verification could not fit durable evidence/provenance; revise the plan or inspect capacity: ${error.message}` };
    }
    // Preserve object identity for pure callers holding nodes/artifacts, and do
    // not touch healthy siblings. Public callers publish this candidate to disk first.
    for (const group of ['nodes', 'artifacts']) {
      for (const [id, value] of Object.entries(candidate[group])) {
        if (JSON.stringify(state[group][id]) === JSON.stringify(value)) candidate[group][id] = state[group][id];
        else if (state[group][id]) { Object.assign(state[group][id], value); candidate[group][id] = state[group][id]; }
      }
    }
    Object.assign(state, candidate);
    return result;
  }

  function verificationTransition(state, { nodeId, verdict, commands = [], artifacts = [], probed = [], skipped = [], resolvedEffects = [], changeRefs = null, summary = '', snapshot = {}, effectiveTargets, now }) {
    if (state.status === 'AWAITING_USER_DECISION') return { ok: false, code: 'AWAITING_DECISION', detail: 'paused submissions are closeout evidence only' };
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const node = state.nodes[nodeId];
    if (!node || node.spec.kind !== 'verify') return { ok: false, code: 'NOT_VERIFY_NODE', detail: `${nodeId} is not a verify node` };
    if (node.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: `${nodeId} is ${node.state}` };
    const evidence = { payload: { verdict, commands, summary, artifacts, probed, skipped }, snapshot,
      basedOn: changeRefs ?? node.consumedRefs ?? [] };
    const reject = (code, detail) => trackRejection(state, node, code, detail, now, evidence);
    const resolution = resolveEffectClaims(state, node, resolvedEffects, { verdict, artifacts, probed });
    if (!resolution.ok) return reject('INVALID_EFFECT_RESOLUTION', resolution.detail);

    // Baseline capture: pre-change suite evidence recorded before any
    // implement node writes. The artifact is what later PASS verdicts match
    // nonzero commands against, so failures that predate the change can be
    // told apart from regressions the change introduced.
    if (verdict === 'BASELINE') {
      if (node.spec.baseline !== true) return reject('INVALID_VERDICT', 'BASELINE verdicts are only accepted on baseline verify nodes (declare baseline: true in the plan)');
      if (!commands.length) return reject('INSUFFICIENT_EVIDENCE', 'BASELINE requires at least one recorded command (the pre-change suite evidence)');
      const name = `baseline:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      publishArtifact(state, name, { kind: 'baseline', nodeId, version, basedOn: node.consumedRefs ?? [], payload: { commands, summary }, status: 'valid', createdAt: now });
      node.producedRef = `${name}@${version}`;
      node.state = 'SUCCEEDED';
      node.rejectionStreak = null;
      node.finishedAt = now;
      completeIfDone(state, now);
      return { ok: true, effect: 'baseline' };
    }
    if (node.spec.baseline === true && (verdict === 'PASS' || verdict === 'FAIL')) {
      return reject('INVALID_VERDICT', 'baseline verify nodes only accept BASELINE or UNVERIFIED verdicts (there is no change to judge yet)');
    }
    if (verdict === 'PASS') {
      // Nonzero exit codes are tolerated only when the exact command and
      // exit code match a valid baseline entry: a pre-existing failure that
      // did not get worse. Everything else is a regression this change owns.
      const unmatched = commands.filter((command) => command.exitCode !== 0 && !baselineMatches(state, command));
      if (!commands.length || !commands.some((command) => command.exitCode === 0) || unmatched.length) {
        return reject('INSUFFICIENT_EVIDENCE', unmatched.length
          ? `nonzero commands not covered by a baseline entry: ${unmatched.map((command) => command.command).join('; ')} — every failing command on PASS must match a declared baseline (same command and exitCode)`
          : 'PASS requires at least one command with exitCode 0 (baseline matches tolerate pre-existing failures but never substitute for a green command)');
      }
      // Deliverable-backed work earns real-surface evidence: when any
      // dependency implement node declared deliverables, PASS must cite at
      // least one existing artifact path (log, output file, screenshot),
      // not only a green command.
      const deliverableDeps = node.spec.dependsOn.map((dep) => state.nodes[dep]).filter((dep) => dep && dep.spec.kind === 'implement' && Array.isArray(dep.spec.deliverables) && dep.spec.deliverables.length);
      if (deliverableDeps.length && !artifacts.length) {
        return reject('ARTIFACT_REQUIRED', `implement nodes with declared deliverables (${deliverableDeps.map((dep) => dep.spec.id).join(', ')}) require at least one artifact path (an existing evidence file) on PASS`);
      }
      const refs = changeRefs ?? node.consumedRefs ?? node.spec.dependsOn.map((dep) => depArtifactRef(state, dep));
      const history = lineageIndex(state);
      const consumed = new Set((node.consumedRefs ?? []).map(canonicalRef));
      for (const ref of refs) {
        const resolution = artifactRef(state, ref);
        const consumedHistory = consumed.has(canonicalRef(ref)) && history.get(canonicalRef(ref))?.status === 'valid';
        if (resolution.missing && !consumedHistory) {
          // The streak identity is the raw missing-reason (guidance prose is
          // presentation only), so rewording the clause can never silently
          // reset a persisted streak.
          const rejection = reject('STALE_CHANGE', resolution.missing);
          return { ...rejection, detail: `${rejection.detail} — if this ref was derived from dependsOn rather than authored in the submission, no payload change can fix it; report the rejection instead of resubmitting` };
        }
      }
      const name = `verification:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      publishArtifact(state, name, { kind: 'verification', nodeId, version, basedOn: changeRefs ?? [...new Set([...(node.consumedRefs ?? []), ...refs])], payload: { verdict, commands, summary, artifacts, probed, skipped, ...(resolution.resolutions.length ? { resolvedEffects: resolution.resolutions } : {}) }, snapshot, status: 'valid', createdAt: now });
      node.producedRef = `${name}@${version}`;
      node.state = 'SUCCEEDED';
      node.repairEvidence = null;
      node.rejectionStreak = null;
      node.finishedAt = now;
      completeIfDone(state, now);
      return { ok: true, effect: 'advance' };
    }
    if (verdict === 'FAIL') {
      const submittedAttempt = node.attempt;
      const closure = repairClosure(state, effectiveTargets, nodeId);
      const revision = applyRepair(state, closure, effectiveTargets, nodeId, now);
      for (const id of closure.nodeIds) if (state.nodes[id]) state.nodes[id].repairEvidence = {
        verifier: nodeId, directTarget: effectiveTargets.includes(id), summary: String(summary).slice(0, 500),
        commands: commands.slice(0, 5).map((command) => `${String(command?.command ?? '').slice(0, 200)} (exit ${command?.exitCode ?? '?'})`),
      };
      state.revisionCounters['implement-verify'] += 1;
      node.state = 'PENDING';
      node.rejectionStreak = null;
      node.finishedAt = now;
      // Failed verification is durable evidence: store it (superseded — it
      // gates nothing) so repair dispatches and audits can cite the exact
      // commands and summary instead of relying on free-text relay.
      const name = `verification:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      const refs = node.spec.dependsOn.map((dep) => depArtifactRef(state, dep));
      publishArtifact(state, name, { kind: 'verification', nodeId, version, basedOn: node.consumedRefs ?? refs, payload: { verdict, commands, summary, artifacts, probed, skipped,
        repairTargets: effectiveTargets, affectedNodeIds: closure.nodeIds, invalidatedRefs: closure.refs, ...revision }, snapshot, status: 'superseded', createdAt: now });
      const repair = { repairTargets: effectiveTargets, affectedNodeIds: closure.nodeIds, invalidatedRefs: closure.refs, ...revision };
      if (state.revisionCounters['implement-verify'] >= maxAttempts) {
        node.attempt = submittedAttempt;
        pauseForDecision(state, 'verification-repair-exhausted', 'verification repair loop exhausted (maxAttempts reached)', now);
        return { ok: true, effect: 'await-decision', ...repair, detail: 'verification repair loop exhausted; awaiting user decision' };
      }
      // The next dispatch verifies a NEW change version the repair will mint;
      // the loop budget lives on revisionCounters['implement-verify'], so the
      // node's per-attempt budget restarts instead of accumulating retries.
      // spec.maxAttempts on a verify node bounds begin-without-verdict
      // attempts only; FAIL repair rounds are capped by the runner-global
      // revision counter, not the node's attempt budget.
      node.attempt = 0;
      state.updatedAt = now;
      return { ok: true, effect: 'repair', ...repair, detail: revision.detail ?? 'verification failed; affected repair dispatches will carry this evidence' };
    }
    // UNVERIFIED is honest uncertainty, not a work failure: the run pauses
    // for an explicit user decision (graph_run_decide) with the verdict and
    // its evidence preserved as a superseded verification artifact.
    if (verdict === 'UNVERIFIED') {
      node.state = 'PENDING';
      node.rejectionStreak = null;
      node.finishedAt = now;
      const name = `verification:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      const refs = node.spec.dependsOn.map((dep) => depArtifactRef(state, dep));
      publishArtifact(state, name, { kind: 'verification', nodeId, version, basedOn: node.consumedRefs ?? refs, payload: { verdict, commands, summary, artifacts, probed, skipped }, snapshot, status: 'superseded', createdAt: now });
      pauseForDecision(state, 'verification-unverified', summary || 'verifier could not verify', now,
        captureVerificationPause(state, node, { ...evidence, ref: `${name}@${version}` }));
      return { ok: true, effect: 'await-decision', detail: 'verification could not be completed; run paused for a user decision (evidence preserved)' };
    }
    return reject('INVALID_VERDICT', 'verdict must be PASS, FAIL or UNVERIFIED');
  }

  function prepareRetry(state, args) {
    const result = prepareVerificationRetry(state, { ...args, maxAttempts });
    if (!result.ok) return result;
    const graph = validateTaskGraph(Object.values(state.nodes).map((n) => n.spec), { light: state.mode === 'light' });
    const liveness = graph.ok && validatePlanLiveness(graph.nodes, state.artifacts, state.artifacts.plan.basedOn, new Map(Object.entries(state.nodes)));
    const deps = depsSatisfied(state, state.nodes[result.nodeId]);
    if (!graph.ok || !liveness.ok || !deps.ok) return { ok: false, code: 'RETRY_INELIGIBLE', detail: 'The accepted graph or verifier dependencies are not satisfiable' };
    try { assertSettlementCapacity(result.candidate); }
    catch (error) { return { ok: false, code: 'RETRY_INELIGIBLE', detail: `Insufficient dispatch settlement capacity: ${error.message}` }; }
    return result;
  }

  function recordSideEffect(state, { nodeId, tool, target, now, dispatchId, callID, sessionId, outcome, uncertain, messageId, partId }) {
    const normalized = normalizeScopePath(target);
    state.sideEffects.push({ nodeId, tool, target: normalized ?? target, at: now,
      ...(dispatchId ? { dispatchId } : {}), ...(callID ? { callID } : {}), ...(sessionId ? { sessionId } : {}),
      ...(outcome ? { outcome, uncertain: uncertain === true } : {}), ...(messageId ? { messageId } : {}), ...(partId ? { partId } : {}) });
    state.updatedAt = now;
  }

  function markIncomplete(state, { nodeId, now }) {
    const node = state.nodes[nodeId];
    if (!node || node.state !== 'RUNNING') return { changed: false };
    node.state = 'INCOMPLETE';
    node.finishedAt = now;
    if (node.attempt >= nodeMaxAttempts(node, maxAttempts)) {
      node.state = 'FAILED';
      pauseForDecision(state, 'attempt-budget-exhausted', `${nodeId} never delivered a structured submission within its attempt budget`, now);
    }
    state.updatedAt = now;
    return { changed: true };
  }

  // Resume after a restart or crash: classify in-flight nodes, keep attempt
  // counters, and never blindly redo recorded side effects.
  function resumeRun(state, { now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', changed: false };
    if (state.status === 'AWAITING_USER_DECISION') return { ok: false, code: 'AWAITING_DECISION', changed: false };
    if (repairSettlementPending(state)) return { ok: false, code: 'REPAIR_SETTLEMENT_PENDING', changed: false };
    const report = { recovered: [], recoveryRequired: [] };
    for (const node of Object.values(state.nodes)) {
      if (node.state === 'RUNNING') {
        const hasEffects = state.sideEffects.some((effect) => effect.nodeId === node.spec.id)
          || (state.pendingEffects ?? []).some((effect) => effect.nodeId === node.spec.id);
        if (hasEffects) {
          node.state = 'RECOVERY_REQUIRED';
          node.reconcile = true;
          report.recoveryRequired.push(node.spec.id);
        } else {
          node.state = 'PENDING';
          report.recovered.push(node.spec.id);
        }
      } else if (node.state === 'INCOMPLETE') {
        node.state = 'PENDING';
        report.recovered.push(node.spec.id);
      }
    }
    if (report.recoveryRequired.length) state.status = 'RECOVERY_REQUIRED';
    else if (state.status === 'RECOVERY_REQUIRED') state.status = 'RUNNING';
    state.updatedAt = now;
    return { ok: true, changed: true, report };
  }

  // Reconcile one RECOVERY_REQUIRED node: back to PENDING with a reconcile
  // marker the dispatcher forwards to the implementer; attempts are preserved.
  function reconcileNode(state, nodeId, { now }) {
    const node = state.nodes[nodeId];
    if (!node || node.state !== 'RECOVERY_REQUIRED') return { ok: false, code: 'NOT_RECOVERY_REQUIRED', detail: `${nodeId} is not awaiting reconciliation` };
    node.state = 'PENDING';
    node.reconcile = true;
    const still = Object.values(state.nodes).some((entry) => entry.state === 'RECOVERY_REQUIRED');
    if (!still && state.status === 'RECOVERY_REQUIRED') state.status = 'RUNNING';
    state.updatedAt = now;
    return { ok: true };
  }

  // Re-check recorded snapshots against the current workspace; mismatches and
  // unverifiable entries invalidate the artifact and its node conservatively.
  function revalidateArtifacts(state, { currentSnapshot, now }) {
    const invalidated = [];
    for (const [name, artifact] of Object.entries(state.artifacts)) {
      if (artifact.status !== 'valid' || !artifact.snapshot) continue;
      for (const [file, recorded] of Object.entries(artifact.snapshot)) {
        const current = currentSnapshot[file];
        if (current === undefined || current !== recorded) {
          artifact.status = 'stale';
          const node = state.nodes[artifact.nodeId];
          // Deliberate asymmetry with repair invalidation: drift
          // invalidation has no revision counter, so per-node attempts are
          // the only bound on repeated drift re-verification — they must NOT
          // be reset on this route.
          if (node && node.state === 'SUCCEEDED') node.state = 'STALE';
          invalidated.push(`${name}@${artifact.version}`);
          break;
        }
      }
    }
    if (invalidated.length) state.updatedAt = now;
    return { invalidated };
  }

  // Mechanical per-node progress for graph_inspect: side-effect counts and
  // last activity come straight from the serialized ledger; deliverable
  // completion compares the declared list against the ledger's edit/write
  // targets mid-flight (bash writes are not tracked, so in-flight progress
  // may under-report honestly) and against the change artifact's claimed
  // files once the node has succeeded.
  function nodeProgress(state, node) {
    const effects = state.sideEffects.filter((effect) => effect.nodeId === node.spec.id);
    const lastActivityAt = effects.reduce((latest, effect) => latest === null || effect.at > latest ? effect.at : latest, node.startedAt ?? null);
    const progress = { sideEffectCount: effects.length, lastActivityAt };
    const declared = Array.isArray(node.spec.deliverables) ? node.spec.deliverables : null;
    if (node.spec.kind === 'implement' && declared && declared.length) {
      let covered;
      if (node.state === 'SUCCEEDED') {
        const claimed = state.artifacts[`change:${node.spec.id}`]?.payload?.filesTouched;
        covered = new Set(Array.isArray(claimed) ? claimed : []);
      } else {
        covered = new Set(effects.filter((effect) => (effect.tool === 'edit' || effect.tool === 'write') && !isUncertainEffect(effect)).map((effect) => effect.target));
      }
      progress.deliverables = {
        total: declared.length,
        done: declared.filter((file) => covered.has(file)).length,
        pending: declared.filter((file) => !covered.has(file)).slice(0, 8),
      };
    }
    return progress;
  }

  function inspect(state) {
    const checkDeps = dependencyChecker(state);
    const nodes = Object.values(state.nodes).map((node) => {
      const deps = checkDeps(node);
      const settling = repairSettlementPending(state, node.spec.id);
      return {
        id: node.spec.id, kind: node.spec.kind, agent: node.spec.agent, state: node.state,
        attempt: node.attempt, maxAttempts: nodeMaxAttempts(node, maxAttempts),
        remainingAttempts: Math.max(0, nodeMaxAttempts(node, maxAttempts) - node.attempt),
        bindingStatus: node.state === 'RUNNING' ? (node.sessionId ? 'bound' : 'unbound') : 'none',
        lastFailure: node.lastFailure ?? null,
        recoveryAction: node.state === 'FAILED' ? 'inspect-failure' : node.lastFailure?.retryable && node.state === 'RUNNING' ? 'correct-and-resubmit'
          : ['INCOMPLETE', 'RECOVERY_REQUIRED'].includes(node.state) || node.state === 'RUNNING' && !node.sessionId ? 'resume-then-fresh-session' : null,
        ready: ELIGIBLE_STATES.has(node.state) && node.attempt < nodeMaxAttempts(node, maxAttempts) && deps.ok
          && !settling && (!state.repairPlanRevision || ['plan', 'explore', 'analyze'].includes(node.spec.kind)),
        waitingOn: [...deps.missing, ...(settling ? ['REPAIR_SETTLEMENT_PENDING: await revoked host lifetimes and pending effects'] : []),
          ...(state.repairPlanRevision && !['plan', 'explore', 'analyze'].includes(node.spec.kind) ? [state.repairPlanRevision.detail] : [])],
        writeScope: node.spec.writeScope ?? [], reconcile: node.reconcile === true,
        ...nodeProgress(state, node),
      };
    });
    const edges = [];
    for (const node of Object.values(state.nodes)) {
      for (const dep of node.spec.dependsOn ?? []) edges.push([dep, node.spec.id]);
    }
    const mermaid = ['graph TD', ...nodes.map((node) => `  ${node.id}["${node.id} · ${node.kind} · ${node.state}${node.attempt ? ` · try ${node.attempt}` : ''}"]`), ...edges.map(([from, to]) => `  ${from} --> ${to}`)].join('\n');
    return {
      runId: state.runId, status: state.status, mode: state.mode, failReason: state.failReason,
      pendingDecision: state.pendingDecision ?? null,
      pauseId: state.pendingDecision?.pauseId ?? null,
      recoveryUsed: state.recoveryUsed ?? 0,
      recoveryHistory: state.recoveryHistory ?? [],
      ...(state.repairPlanRevision ?? { needsPlanRevision: false, offendingRefs: [] }),
      closeouts: (state.closeouts ?? []).map(({ nodeId, dispatchId, tool, payload, at }) => ({ nodeId, dispatchId, tool, summary: payload.summary ?? null, at })),
      decision: state.decision ?? null,
      successorRunId: state.successorRunId ?? null,
      carryOver: state.carryOver ?? null,
      blockedReason: state.blockedReason, revisionCounters: state.revisionCounters,
      nodes, artifacts: Object.entries(state.artifacts).map(([name, artifact]) => {
        const payload = artifact.payload ?? {};
        let counts;
        if (artifact.kind === 'verification') {
          counts = {
            artifacts: Array.isArray(payload.artifacts) ? payload.artifacts.length : 0,
            probed: Array.isArray(payload.probed) ? payload.probed.length : 0,
            skipped: Array.isArray(payload.skipped) ? payload.skipped.length : 0,
          };
        } else if (artifact.kind === 'baseline') {
          counts = { commands: Array.isArray(payload.commands) ? payload.commands.length : 0 };
        } else if (artifact.kind === 'change') {
          counts = { risks: Array.isArray(payload.risks) ? payload.risks.length : 0 };
        } else if (artifact.kind === 'findings') {
          counts = { learnings: Array.isArray(payload.learnings) ? payload.learnings.length : 0 };
        }
        return { name, kind: artifact.kind, version: artifact.version, status: artifact.status, basedOn: artifact.basedOn, ...(counts ? { counts } : {}) };
      }),
      violations: state.violations.slice(-20), sideEffectCount: state.sideEffects.length, mermaid,
      // Retained findings versions stay observable: parallel explorers each
      // contribute a version, and inspection surfaces them without dumping
      // payloads (summary digest + learnings count only).
      findingsHistory: (Array.isArray(state.findingsLog) ? state.findingsLog : []).slice(-8).map((entry) => ({
        version: entry?.version ?? null,
        nodeId: typeof entry?.nodeId === 'string' ? entry.nodeId : null,
        learnings: Array.isArray(entry?.learnings) ? entry.learnings.length : 0,
        summary: typeof entry?.summary === 'string' && entry.summary.length ? entry.summary.split('\n', 1)[0].slice(0, 200) : null,
      })),
    };
  }

  return Object.freeze({
    admitDispatch, beginNode, attachSession, submitPlan, submitReview, checkChange, submitChange, submitVerification,
    recordSideEffect, recordViolation, captureRequest, completeRequestCapture, markIncomplete, resumeRun, reconcileNode, revalidateArtifacts, inspect,
    abortRun, archiveForReset, prepareRetry, implementerCapacity, readerCapacity, taintAttempt,
  });
}
