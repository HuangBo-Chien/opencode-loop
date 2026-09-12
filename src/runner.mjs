// Runner: the decision core. Pure functions over a run-state document; the
// enforcement layer calls these before/after host tool activity and persists
// the mutated state through the run store. Design invariants:
// - Nodes are units of work; agents are roles executing them.
// - The task DAG stays acyclic; bounded repair loops re-PENDING nodes and are
//   counted separately via revisionCounters.
// - Verdicts: PASS advances, REVISE returns to planner (capped), FAIL
//   terminates the run, BLOCKED pauses without faking success.
// - Evidence binds to artifact versions; superseded or hash-mismatched
//   artifacts invalidate downstream results conservatively.

import { cleanJson } from './json-safe.mjs';
import { matchScopePath, normalizeScopePath, validateFileClaim } from './task-spec.mjs';

const READ_ONLY_AGENTS = new Set(['graph-explorer', 'graph-multimodal', 'graph-planner', 'graph-plan-critic']);
const WRITE_AGENTS = new Set(['graph-implementer', 'graph-verifier']);
const ELIGIBLE_STATES = new Set(['PENDING', 'INCOMPLETE', 'STALE']);
const TERMINAL_RUN = new Set(['FAILED', 'SUCCEEDED', 'ABORTED']);

function nodeMaxAttempts(node, fallback) {
  return Number.isInteger(node.spec.maxAttempts) ? node.spec.maxAttempts : fallback;
}

// Appended to dependency denials so a naming mismatch points straight at the
// contract instead of looking like a missing deliverable.
function artifactNameHint(entries) {
  return entries.some((entry) => typeof entry === 'string' && entry.includes('does not exist'))
    ? ' (runner artifact names are findings, plan, review, change:<implement node id>, verification:<verify node id>; resubmit a corrected plan if an input name is wrong)'
    : '';
}

function artifactRef(state, ref) {
  const atIndex = ref.lastIndexOf('@');
  const name = atIndex === -1 ? ref : ref.slice(0, atIndex);
  const version = atIndex === -1 ? null : Number(ref.slice(atIndex + 1));
  const artifact = state.artifacts[name];
  if (!artifact) return { missing: `artifact ${ref} does not exist` };
  if (version !== null && artifact.version !== version) return { missing: `artifact ${ref} is not the current version (v${artifact.version})` };
  if (artifact.status !== 'valid') return { missing: `artifact ${name}@${artifact.version} is ${artifact.status}` };
  return { artifact };
}

export function depsSatisfied(state, node) {
  const missing = [];
  for (const dep of node.spec.dependsOn ?? []) {
    const dependency = state.nodes[dep];
    if (!dependency) missing.push(`dependency ${dep} does not exist`);
    else if (dependency.state !== 'SUCCEEDED') missing.push(`dependency ${dep} is ${dependency.state}`);
  }
  for (const input of node.spec.inputs ?? []) {
    const resolution = artifactRef(state, input);
    if (resolution.missing) missing.push(resolution.missing);
  }
  return { ok: missing.length === 0, missing };
}

// Exhaustion and fundamental rejection no longer fail the run silently: the
// run pauses for an explicit user decision (graph_run_decide). Nodes, attempt
// counters, artifacts and violations stay exactly as they were for audit.
function pauseForDecision(state, cause, detail, now) {
  state.status = 'AWAITING_USER_DECISION';
  state.pendingDecision = { cause, detail, at: now };
  state.blockedReason = null;
  state.updatedAt = now;
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
  const nodes = Object.values(state.nodes);
  if (nodes.length && nodes.every((node) => node.state === 'SUCCEEDED' || node.state === 'SKIPPED')) {
    state.status = 'SUCCEEDED';
    state.blockedReason = null;
    state.updatedAt = now;
    return true;
  }
  return false;
}

export function createRunner({ maxAttempts, maxPlanRevisions, implementerParallel = 2 }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isInteger(maxPlanRevisions) || maxPlanRevisions < 1) throw new TypeError('maxPlanRevisions must be a positive integer');
  if (!Number.isInteger(implementerParallel) || implementerParallel < 1 || implementerParallel > 4) throw new TypeError('implementerParallel must be an integer from 1 to 4');

  // Effective writer capacity: the configured ceiling, narrowed by the
  // critic's approvedParallel when the current valid review provides one.
  function implementerCapacity(state) {
    const review = state.artifacts.review;
    const approved = review && review.status === 'valid' && Number.isInteger(review.payload?.approvedParallel) && review.payload.approvedParallel >= 1
      ? review.payload.approvedParallel : null;
    return Math.max(1, Math.min(implementerParallel, approved ?? implementerParallel));
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
    if (chosen.spec.kind === 'implement') {
      const failures = Object.values(state.artifacts)
        .filter((artifact) => {
          if (artifact.kind !== 'verification' || artifact.payload?.verdict !== 'FAIL') return false;
          const verifier = state.nodes[artifact.nodeId];
          return Array.isArray(verifier?.spec?.dependsOn) && verifier.spec.dependsOn.includes(chosen.spec.id);
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
  function admissibleNode(state, chosen, agent, now) {
    if (!ELIGIBLE_STATES.has(chosen.state)) {
      return { allowed: false, code: 'NODE_NOT_ADMISSIBLE', detail: `${chosen.spec.id} is ${chosen.state} and cannot begin` };
    }
    const deps = depsSatisfied(state, chosen);
    if (!deps.ok) {
      return { allowed: false, code: 'NODE_NOT_ADMISSIBLE', detail: `${chosen.spec.id} is not yet admissible: ${deps.missing.join(', ')}${artifactNameHint(deps.missing)}` };
    }
    if (chosen.attempt >= nodeMaxAttempts(chosen, maxAttempts)) {
      chosen.state = 'FAILED';
      chosen.finishedAt = now;
      pauseForDecision(state, 'attempt-budget-exhausted', `${chosen.spec.id} exhausted its attempt budget`, now);
      return { allowed: false, code: 'ATTEMPTS_EXHAUSTED', detail: `${chosen.spec.id} has no attempts left` };
    }
    return { allowed: true, nodeId: chosen.spec.id, reconcile: chosen.reconcile === true || state.sideEffects.some((effect) => effect.nodeId === chosen.spec.id), ...(revisionContext(state, chosen) ?? {}) };
  }

  function admitDispatch(state, { agent, now, nodeId = null, excludeNodeIds = null }) {
    if (TERMINAL_RUN.has(state.status)) {
      return { allowed: false, code: 'RUN_TERMINATED', detail: state.failReason ? `run failed: ${state.failReason}` : 'run already finished' };
    }
    if (state.status === 'RECOVERY_REQUIRED') {
      return { allowed: false, code: 'RECOVERY_REQUIRED', detail: 'run needs graph_run_resume before further dispatch' };
    }
    if (state.status === 'AWAITING_USER_DECISION') {
      const pending = state.pendingDecision;
      return { allowed: false, code: 'AWAITING_DECISION', detail: pending ? `run is awaiting a user decision (${pending.cause}: ${pending.detail}); report to the user and use graph_run_decide to reset or abort` : 'run is awaiting a user decision; use graph_run_decide to reset or abort' };
    }
    if (state.status === 'BLOCKED') {
      return { allowed: false, code: 'RUN_BLOCKED', detail: state.blockedReason ? `${state.blockedReason.kind}: ${state.blockedReason.detail}` : 'run is blocked' };
    }
    if (typeof agent !== 'string' || (!READ_ONLY_AGENTS.has(agent) && !WRITE_AGENTS.has(agent))) {
      return { allowed: false, code: 'INVALID_AGENT', detail: `${agent} is not a dispatchable graph specialist` };
    }

    const mine = Object.values(state.nodes).filter((node) => node.spec.agent === agent);
    // Implementers run under a bounded-capacity gate: several write nodes with
    // pairwise-disjoint writeScopes may be RUNNING at once, up to
    // min(implementerParallel, critic-approvedParallel). Every other role
    // keeps one-in-flight semantics.
    if (agent === 'graph-implementer') {
      const running = Object.values(state.nodes).filter((node) => node.spec.kind === 'implement' && node.state === 'RUNNING').length;
      const capacity = implementerCapacity(state);
      if (running >= capacity) {
        return { allowed: false, code: 'WRITER_CAPACITY', detail: `${running}/${capacity} implement nodes are in flight; wait for one to finish before dispatching another` };
      }
    } else if (mine.some((node) => node.state === 'RUNNING')) {
      return { allowed: false, code: 'ALREADY_RUNNING', detail: `a ${agent} task for this run is still in flight` };
    }

    // Coordinator-targeted dispatch: validate exactly the requested node so
    // the binding always matches the node the coordinator described.
    if (typeof nodeId === 'string' && nodeId.length) {
      const chosen = mine.find((node) => node.spec.id === nodeId);
      if (!chosen) {
        return { allowed: false, code: 'NODE_NOT_FOUND', detail: `${nodeId} is not a ${agent} node in the current task graph` };
      }
      return admissibleNode(state, chosen, agent, now);
    }

    // Concurrent reservations for the same role must not collide on one node:
    // the dispatcher passes already-reserved node ids to skip here.
    const exclude = excludeNodeIds instanceof Set ? excludeNodeIds
      : Array.isArray(excludeNodeIds) ? new Set(excludeNodeIds) : null;
    const ready = mine
      .filter((node) => ELIGIBLE_STATES.has(node.state) && !(exclude?.has(node.spec.id) ?? false))
      .map((node) => ({ node, deps: depsSatisfied(state, node) }))
      .filter((entry) => entry.deps.ok)
      .sort((a, b) => a.node.attempt - b.node.attempt || a.node.spec.id.localeCompare(b.node.spec.id));
    if (!ready.length) {
      // Free consultation applies only to roles whose submissions never
      // require a node binding (explorer, planner and multimodal deliver
      // findings or plans unbound). The critic can only deliver through a
      // bound review node, so an inadmissible review is rejected up front
      // instead of stranding a child that could never submit.
      if (READ_ONLY_AGENTS.has(agent) && agent !== 'graph-plan-critic') return { allowed: true, nodeId: null, free: true };
      const waiting = mine.filter((node) => ELIGIBLE_STATES.has(node.state)).map((node) => `${node.spec.id}(${depsSatisfied(state, node).missing.join(', ') || 'no attempts left'})`);
      return {
        allowed: false,
        code: 'NO_READY_NODE',
        detail: waiting.length ? `not yet admissible: ${waiting.join('; ')}${artifactNameHint(waiting)}` : `no admissible ${agent} node exists in the current task graph`,
      };
    }
    return admissibleNode(state, ready[0].node, agent, now);
  }

  function beginNode(state, nodeId, { now, sessionId = null, dispatchId = null }) {
    const node = state.nodes[nodeId];
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    if (node.state !== 'PENDING' && node.state !== 'INCOMPLETE' && node.state !== 'STALE') throw new Error(`Node ${nodeId} is ${node.state} and cannot begin`);
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
    if (intent !== 'plan-only' && intent !== 'change') return { ok: false, code: 'INVALID_INTENT', detail: 'intent must be plan-only or change' };
    if (!(nodes instanceof Map) || nodes.size < 1) return { ok: false, code: 'INVALID_GRAPH', detail: 'nodes must be a non-empty validated graph' };
    const previous = state.artifacts.plan;
    const version = previous ? previous.version + 1 : 1;
    if (previous && previous.status === 'valid') previous.status = 'superseded';
    state.mode = intent;
    state.status = 'RUNNING';
    state.blockedReason = null;

    const preservedNodes = new Map(Object.values(state.nodes).map((node) => [node.spec.id, { attempt: node.attempt, sessionId: node.sessionId ?? null }]));
    state.nodes = {};
    for (const [id, spec] of nodes) {
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
    state.artifacts.plan = { kind: 'plan', nodeId: 'plan', version, basedOn, payload: { intent, specs: [...nodes.values()], parallel }, status: 'valid', createdAt: now };
    state.updatedAt = now;
    return { ok: true, version, mode: intent };
  }

  function submitReview(state, { planVersion, verdict, findings = [], approvedParallel = null, now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const reviewNode = Object.values(state.nodes).find((node) => node.spec.kind === 'review');
    if (!reviewNode || reviewNode.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: 'review verdict submitted without an in-flight review dispatch' };
    const plan = state.artifacts.plan;
    if (!plan || plan.status !== 'valid' || plan.version !== planVersion) {
      return { ok: false, code: 'STALE_PLAN_VERSION', detail: plan ? `current plan is v${plan.version} (${plan.status})` : 'no plan artifact exists' };
    }
    const previous = state.artifacts.review;
    const version = previous ? previous.version + 1 : 1;
    if (previous && previous.status === 'valid') previous.status = 'superseded';

    if (verdict === 'PASS') {
      state.artifacts.review = { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: [`plan@${planVersion}`], payload: { verdict, findings, approvedParallel }, status: 'valid', createdAt: now };
      reviewNode.state = 'SUCCEEDED';
      reviewNode.finishedAt = now;
      completeIfDone(state, now);
      state.updatedAt = now;
      return { ok: true, effect: 'advance' };
    }
    if (verdict === 'REVISE') {
      state.revisionCounters['plan-review'] += 1;
      state.artifacts.review = { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: [`plan@${planVersion}`], payload: { verdict, findings }, status: 'superseded', createdAt: now };
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
      state.artifacts.review = { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: [`plan@${planVersion}`], payload: { verdict, findings }, status: 'valid', createdAt: now };
      reviewNode.state = 'PENDING';
      reviewNode.finishedAt = now;
      pauseForDecision(state, 'plan-rejected-by-critic', findings.length ? `plan rejected by critic: ${findings[0]}` : 'plan rejected by critic', now);
      return { ok: true, effect: 'await-decision', detail: 'plan rejected by critic; awaiting user decision' };
    }
    return { ok: false, code: 'INVALID_VERDICT', detail: 'verdict must be PASS, REVISE or FAIL' };
  }

  function recordViolation(state, { nodeId = null, kind, detail, now }) {
    state.violations.push({ nodeId, kind, detail, at: now });
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
  function taintAttempt(state, { nodeId, detail, now }) {
    const node = state.nodes[nodeId];
    if (!node || node.state !== 'RUNNING') return false;
    node.lastFailure = { code: 'EXECUTED_DESPITE_DENY', detail, retryable: false };
    node.state = 'FAILED';
    node.finishedAt = now;
    state.updatedAt = now;
    return true;
  }

  function checkChange(state, { nodeId, filesTouched, filesDeleted = [], now }) {
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
    const edited = state.sideEffects.filter((effect) => effect.nodeId === nodeId && effect.tool === 'edit').map((effect) => effect.target);
    const undisclosed = edited.filter((target) => !claimed.has(target));
    if (undisclosed.length) {
      return rejectClaim(state, nodeId, 'LEDGER_MISMATCH', `files edited but not disclosed: ${undisclosed.join(', ')}`, now);
    }
    return { ok: true, claimed: [...claimed] };
  }

  function submitChange(state, { nodeId, filesTouched, filesDeleted = [], summary, checksRun = [], unresolved = [], snapshot = {}, now }) {
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
    if (previous && previous.status === 'valid') previous.status = 'superseded';
    state.artifacts[name] = { kind: 'change', nodeId, version, basedOn: [`review@${state.artifacts.review?.version ?? 1}`], payload: { filesTouched: checked.claimed, filesDeleted: [...new Set(filesDeleted)], summary, checksRun, unresolved }, snapshot, status: 'valid', createdAt: now };
    node.state = 'SUCCEEDED';
    node.lastFailure = null;
    node.finishedAt = now;
    state.updatedAt = now;
    return { ok: true, version };
  }

  function supersedeChangeAndInvalidate(state, nodeId, now) {
    const name = `change:${nodeId}`;
    const change = state.artifacts[name];
    if (change && change.status === 'valid') change.status = 'superseded';
    for (const artifact of Object.values(state.artifacts)) {
      if (artifact.status !== 'valid') continue;
      if (artifact.kind === 'verification' && artifact.basedOn.some((ref) => ref === `${name}@${change?.version ?? 1}`)) {
        artifact.status = 'stale';
        const verifier = state.nodes[artifact.nodeId];
        if (verifier && verifier.state === 'SUCCEEDED') verifier.state = 'STALE';
      }
    }
    state.updatedAt = now;
  }

  function submitVerification(state, { nodeId, verdict, commands = [], changeRefs = null, summary = '', snapshot = {}, now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const node = state.nodes[nodeId];
    if (!node || node.spec.kind !== 'verify') return { ok: false, code: 'NOT_VERIFY_NODE', detail: `${nodeId} is not a verify node` };
    if (node.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: `${nodeId} is ${node.state}` };

    if (verdict === 'PASS') {
      if (!commands.length || commands.some((command) => command.exitCode !== 0)) {
        return { ok: false, code: 'INSUFFICIENT_EVIDENCE', detail: 'PASS requires at least one command and every exitCode must be 0' };
      }
      const refs = changeRefs ?? node.spec.dependsOn.map((dep) => `change:${dep}@${state.artifacts[`change:${dep}`]?.version ?? 1}`);
      for (const ref of refs) {
        const resolution = artifactRef(state, ref);
        if (resolution.missing) return { ok: false, code: 'STALE_CHANGE', detail: resolution.missing };
      }
      const name = `verification:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      if (previous && previous.status === 'valid') previous.status = 'superseded';
      state.artifacts[name] = { kind: 'verification', nodeId, version, basedOn: refs, payload: { verdict, commands, summary }, snapshot, status: 'valid', createdAt: now };
      node.state = 'SUCCEEDED';
      node.finishedAt = now;
      completeIfDone(state, now);
      return { ok: true, effect: 'advance' };
    }
    if (verdict === 'FAIL') {
      state.revisionCounters['implement-verify'] += 1;
      node.state = 'PENDING';
      node.finishedAt = now;
      // Failed verification is durable evidence: store it (superseded — it
      // gates nothing) so repair dispatches and audits can cite the exact
      // commands and summary instead of relying on free-text relay.
      const name = `verification:${nodeId}`;
      const previous = state.artifacts[name];
      const version = previous ? previous.version + 1 : 1;
      if (previous && previous.status === 'valid') previous.status = 'superseded';
      const refs = node.spec.dependsOn.map((dep) => `change:${dep}@${state.artifacts[`change:${dep}`]?.version ?? 1}`);
      state.artifacts[name] = { kind: 'verification', nodeId, version, basedOn: refs, payload: { verdict, commands, summary }, snapshot, status: 'superseded', createdAt: now };
      if (state.revisionCounters['implement-verify'] >= maxAttempts) {
        pauseForDecision(state, 'verification-repair-exhausted', 'verification repair loop exhausted (maxAttempts reached)', now);
        return { ok: true, effect: 'await-decision', detail: 'verification repair loop exhausted; awaiting user decision' };
      }
      const repairs = node.spec.dependsOn.map((dep) => state.nodes[dep]).filter((dep) => dep && dep.spec.kind === 'implement');
      for (const repair of repairs) {
        supersedeChangeAndInvalidate(state, repair.spec.id, now);
        repair.state = 'PENDING';
        repair.finishedAt = now;
      }
      state.updatedAt = now;
      return { ok: true, effect: 'repair', detail: 'verification failed; implementer repair dispatches will carry this evidence' };
    }
    if (verdict === 'UNVERIFIED') {
      node.state = 'PENDING';
      node.finishedAt = now;
      state.status = 'BLOCKED';
      state.blockedReason = { kind: 'info', detail: summary || 'verifier could not verify' };
      state.updatedAt = now;
      return { ok: true, effect: 'blocked' };
    }
    return { ok: false, code: 'INVALID_VERDICT', detail: 'verdict must be PASS, FAIL or UNVERIFIED' };
  }

  function recordSideEffect(state, { nodeId, tool, target, now }) {
    const normalized = normalizeScopePath(target);
    state.sideEffects.push({ nodeId, tool, target: normalized ?? target, at: now });
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
    const report = { recovered: [], recoveryRequired: [] };
    for (const node of Object.values(state.nodes)) {
      if (node.state === 'RUNNING') {
        const hasEffects = state.sideEffects.some((effect) => effect.nodeId === node.spec.id);
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
        covered = new Set(effects.filter((effect) => effect.tool === 'edit' || effect.tool === 'write').map((effect) => effect.target));
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
    const nodes = Object.values(state.nodes).map((node) => {
      const deps = depsSatisfied(state, node);
      return {
        id: node.spec.id, kind: node.spec.kind, agent: node.spec.agent, state: node.state,
        attempt: node.attempt, maxAttempts: nodeMaxAttempts(node, maxAttempts),
        remainingAttempts: Math.max(0, nodeMaxAttempts(node, maxAttempts) - node.attempt),
        bindingStatus: node.state === 'RUNNING' ? (node.sessionId ? 'bound' : 'unbound') : 'none',
        lastFailure: node.lastFailure ?? null,
        recoveryAction: node.state === 'FAILED' ? 'inspect-failure' : node.lastFailure?.retryable && node.state === 'RUNNING' ? 'correct-and-resubmit'
          : ['INCOMPLETE', 'RECOVERY_REQUIRED'].includes(node.state) || node.state === 'RUNNING' && !node.sessionId ? 'resume-then-fresh-session' : null,
        ready: ELIGIBLE_STATES.has(node.state) && node.attempt < nodeMaxAttempts(node, maxAttempts) && deps.ok,
        waitingOn: deps.ok ? [] : deps.missing,
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
      decision: state.decision ?? null,
      successorRunId: state.successorRunId ?? null,
      carryOver: state.carryOver ?? null,
      blockedReason: state.blockedReason, revisionCounters: state.revisionCounters,
      nodes, artifacts: Object.entries(state.artifacts).map(([name, artifact]) => ({ name, kind: artifact.kind, version: artifact.version, status: artifact.status, basedOn: artifact.basedOn })),
      violations: state.violations.slice(-20), sideEffectCount: state.sideEffects.length, mermaid,
    };
  }

  return Object.freeze({
    admitDispatch, beginNode, attachSession, submitPlan, submitReview, checkChange, submitChange, submitVerification,
    recordSideEffect, recordViolation, captureRequest, completeRequestCapture, markIncomplete, resumeRun, reconcileNode, revalidateArtifacts, inspect,
    abortRun, archiveForReset, implementerCapacity, taintAttempt,
  });
}
