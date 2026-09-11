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
import { matchScopePath, normalizeScopePath } from './task-spec.mjs';

const READ_ONLY_AGENTS = new Set(['graph-explorer', 'graph-multimodal', 'graph-planner', 'graph-plan-critic']);
const WRITE_AGENTS = new Set(['graph-implementer', 'graph-verifier']);
const ELIGIBLE_STATES = new Set(['PENDING', 'INCOMPLETE', 'STALE']);
const TERMINAL_RUN = new Set(['FAILED', 'SUCCEEDED']);

function nodeMaxAttempts(node, fallback) {
  return Number.isInteger(node.spec.maxAttempts) ? node.spec.maxAttempts : fallback;
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

function failRun(state, reason, now) {
  state.status = 'FAILED';
  state.failReason = reason;
  state.blockedReason = null;
  for (const node of Object.values(state.nodes)) {
    if (node.state === 'RUNNING' || node.state === 'PENDING' || node.state === 'INCOMPLETE' || node.state === 'STALE') node.state = 'SKIPPED';
  }
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

export function createRunner({ maxAttempts, maxPlanRevisions }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  if (!Number.isInteger(maxPlanRevisions) || maxPlanRevisions < 1) throw new TypeError('maxPlanRevisions must be a positive integer');

  function admitDispatch(state, { agent, now }) {
    if (TERMINAL_RUN.has(state.status)) {
      return { allowed: false, code: 'RUN_TERMINATED', detail: state.failReason ? `run failed: ${state.failReason}` : 'run already finished' };
    }
    if (state.status === 'RECOVERY_REQUIRED') {
      return { allowed: false, code: 'RECOVERY_REQUIRED', detail: 'run needs graph_run_resume before further dispatch' };
    }
    if (state.status === 'BLOCKED') {
      return { allowed: false, code: 'RUN_BLOCKED', detail: state.blockedReason ? `${state.blockedReason.kind}: ${state.blockedReason.detail}` : 'run is blocked' };
    }
    if (typeof agent !== 'string' || (!READ_ONLY_AGENTS.has(agent) && !WRITE_AGENTS.has(agent))) {
      return { allowed: false, code: 'INVALID_AGENT', detail: `${agent} is not a dispatchable graph specialist` };
    }

    const mine = Object.values(state.nodes).filter((node) => node.spec.agent === agent);
    if (mine.some((node) => node.state === 'RUNNING')) {
      return { allowed: false, code: 'ALREADY_RUNNING', detail: `a ${agent} task for this run is still in flight` };
    }
    if (WRITE_AGENTS.has(agent)) {
      const writerBusy = Object.values(state.nodes).some((node) => node.spec.kind === 'implement' && node.state === 'RUNNING');
      if (writerBusy && agent === 'graph-implementer') {
        return { allowed: false, code: 'SINGLE_WRITER', detail: 'another implement node is RUNNING; single-writer is enforced' };
      }
    }

    const ready = mine
      .filter((node) => ELIGIBLE_STATES.has(node.state))
      .map((node) => ({ node, deps: depsSatisfied(state, node) }))
      .filter((entry) => entry.deps.ok)
      .sort((a, b) => a.node.attempt - b.node.attempt || a.node.spec.id.localeCompare(b.node.spec.id));
    if (!ready.length) {
      if (READ_ONLY_AGENTS.has(agent)) return { allowed: true, nodeId: null, free: true };
      const waiting = mine.filter((node) => ELIGIBLE_STATES.has(node.state)).map((node) => `${node.spec.id}(${depsSatisfied(state, node).missing.join(', ') || 'no attempts left'})`);
      return {
        allowed: false,
        code: 'NO_READY_NODE',
        detail: waiting.length ? `not yet admissible: ${waiting.join('; ')}` : `no ${agent} node exists in the current task graph`,
      };
    }
    const chosen = ready[0].node;
    if (chosen.attempt >= nodeMaxAttempts(chosen, maxAttempts)) {
      chosen.state = 'FAILED';
      chosen.finishedAt = now;
      if (WRITE_AGENTS.has(agent)) failRun(state, `${chosen.spec.id} exhausted its attempt budget`, now);
      return { allowed: false, code: 'ATTEMPTS_EXHAUSTED', detail: `${chosen.spec.id} has no attempts left` };
    }
    return { allowed: true, nodeId: chosen.spec.id, reconcile: chosen.reconcile === true };
  }

  function beginNode(state, nodeId, { now, sessionId = null }) {
    const node = state.nodes[nodeId];
    if (!node) throw new Error(`Unknown node ${nodeId}`);
    if (node.state !== 'PENDING' && node.state !== 'INCOMPLETE' && node.state !== 'STALE') throw new Error(`Node ${nodeId} is ${node.state} and cannot begin`);
    node.state = 'RUNNING';
    node.attempt += 1;
    node.startedAt = now;
    node.sessionId = sessionId;
    node.reconcile = false;
    state.updatedAt = now;
    return node;
  }

  function attachSession(state, nodeId, sessionId) {
    const node = state.nodes[nodeId];
    if (node) node.sessionId = sessionId;
  }

  function submitPlan(state, { intent, nodes, basedOn = [], parallel = null, now }) {
    if (state.status === 'FAILED' || state.status === 'SUCCEEDED') return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    if (intent !== 'plan-only' && intent !== 'change') return { ok: false, code: 'INVALID_INTENT', detail: 'intent must be plan-only or change' };
    if (!(nodes instanceof Map) || nodes.size < 1) return { ok: false, code: 'INVALID_GRAPH', detail: 'nodes must be a non-empty validated graph' };
    const previous = state.artifacts.plan;
    const version = previous ? previous.version + 1 : 1;
    if (previous && previous.status === 'valid') previous.status = 'superseded';
    state.mode = intent;
    state.status = 'RUNNING';
    state.blockedReason = null;

    const preservedAttempts = new Map(Object.values(state.nodes).map((node) => [node.spec.id, node.attempt]));
    state.nodes = {};
    for (const [id, spec] of nodes) {
      const preserved = preservedAttempts.get(id);
      state.nodes[id] = {
        spec,
        state: 'PENDING',
        attempt: typeof preserved === 'number' && spec.kind !== 'explore' && spec.kind !== 'analyze' ? preserved : 0,
        sessionId: null,
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
      if (state.revisionCounters['plan-review'] > maxPlanRevisions) {
        failRun(state, 'plan revisions exhausted (maxPlanRevisions reached)', now);
        return { ok: true, effect: 'run-failed', detail: 'plan revisions exhausted' };
      }
      plan.status = 'superseded';
      reviewNode.state = 'PENDING';
      reviewNode.finishedAt = now;
      const planner = Object.values(state.nodes).find((node) => node.spec.kind === 'plan');
      if (planner) planner.state = 'PENDING';
      state.updatedAt = now;
      return { ok: true, effect: 'revise' };
    }
    if (verdict === 'FAIL') {
      state.artifacts.review = { kind: 'review', nodeId: reviewNode.spec.id, version, basedOn: [`plan@${planVersion}`], payload: { verdict, findings }, status: 'valid', createdAt: now };
      failRun(state, findings.length ? `plan rejected by critic: ${findings[0]}` : 'plan rejected by critic', now);
      return { ok: true, effect: 'run-failed' };
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

  function submitChange(state, { nodeId, filesTouched, summary, checksRun = [], unresolved = [], snapshot = {}, now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', detail: state.failReason ?? 'run already finished' };
    const node = state.nodes[nodeId];
    if (!node || node.spec.kind !== 'implement') return { ok: false, code: 'NOT_IMPLEMENT_NODE', detail: `${nodeId} is not an implement node` };
    if (node.state !== 'RUNNING') return { ok: false, code: 'NOT_RUNNING', detail: `${nodeId} is ${node.state}` };

    const claimed = new Set();
    for (const file of filesTouched) {
      const normalized = normalizeScopePath(file);
      if (!normalized) {
        recordViolation(state, { nodeId, kind: 'invalid-path-claim', detail: `${file} is not a valid workspace path`, now });
        node.state = 'FAILED';
        node.finishedAt = now;
        return { ok: false, code: 'OUT_OF_SCOPE', detail: `${file} is not a valid workspace path` };
      }
      claimed.add(normalized);
      if (!node.spec.writeScope.some((pattern) => matchScopePath(pattern, normalized))) {
        recordViolation(state, { nodeId, kind: 'out-of-scope-claim', detail: `${normalized} is outside the assigned writeScope`, now });
        node.state = 'FAILED';
        node.finishedAt = now;
        return { ok: false, code: 'OUT_OF_SCOPE', detail: `${normalized} is outside the assigned writeScope` };
      }
    }
    const edited = state.sideEffects.filter((effect) => effect.nodeId === nodeId && effect.tool === 'edit').map((effect) => effect.target);
    const undisclosed = edited.filter((target) => !claimed.has(target));
    if (undisclosed.length) {
      recordViolation(state, { nodeId, kind: 'undisclosed-edit', detail: `edited but not reported: ${undisclosed.join(', ')}`, now });
      node.state = 'FAILED';
      node.finishedAt = now;
      return { ok: false, code: 'LEDGER_MISMATCH', detail: `files edited but not disclosed: ${undisclosed.join(', ')}` };
    }

    const name = `change:${nodeId}`;
    const previous = state.artifacts[name];
    const version = previous ? previous.version + 1 : 1;
    if (previous && previous.status === 'valid') previous.status = 'superseded';
    state.artifacts[name] = { kind: 'change', nodeId, version, basedOn: [`review@${state.artifacts.review?.version ?? 1}`], payload: { filesTouched: [...claimed], summary, checksRun, unresolved }, snapshot, status: 'valid', createdAt: now };
    node.state = 'SUCCEEDED';
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
      if (state.revisionCounters['implement-verify'] >= maxAttempts) {
        failRun(state, 'verification repair loop exhausted (maxAttempts reached)', now);
        return { ok: true, effect: 'run-failed', detail: 'verification repair loop exhausted' };
      }
      const repairs = node.spec.dependsOn.map((dep) => state.nodes[dep]).filter((dep) => dep && dep.spec.kind === 'implement');
      for (const repair of repairs) {
        supersedeChangeAndInvalidate(state, repair.spec.id, now);
        repair.state = 'PENDING';
        repair.finishedAt = now;
      }
      state.updatedAt = now;
      return { ok: true, effect: 'repair' };
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
      failRun(state, `${nodeId} never delivered a structured submission within its attempt budget`, now);
    }
    state.updatedAt = now;
    return { changed: true };
  }

  // Resume after a restart or crash: classify in-flight nodes, keep attempt
  // counters, and never blindly redo recorded side effects.
  function resumeRun(state, { now }) {
    if (TERMINAL_RUN.has(state.status)) return { ok: false, code: 'RUN_TERMINATED', changed: false };
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

  function inspect(state) {
    const nodes = Object.values(state.nodes).map((node) => {
      const deps = depsSatisfied(state, node);
      return {
        id: node.spec.id, kind: node.spec.kind, agent: node.spec.agent, state: node.state,
        attempt: node.attempt, maxAttempts: nodeMaxAttempts(node, maxAttempts),
        ready: node.state === 'PENDING' && deps.ok,
        waitingOn: deps.ok ? [] : deps.missing,
        writeScope: node.spec.writeScope ?? [], reconcile: node.reconcile === true,
      };
    });
    const edges = [];
    for (const node of Object.values(state.nodes)) {
      for (const dep of node.spec.dependsOn ?? []) edges.push([dep, node.spec.id]);
    }
    const mermaid = ['graph TD', ...nodes.map((node) => `  ${node.id}["${node.id} · ${node.kind} · ${node.state}${node.attempt ? ` · try ${node.attempt}` : ''}"]`), ...edges.map(([from, to]) => `  ${from} --> ${to}`)].join('\n');
    return {
      runId: state.runId, status: state.status, mode: state.mode, failReason: state.failReason,
      blockedReason: state.blockedReason, revisionCounters: state.revisionCounters,
      nodes, artifacts: Object.entries(state.artifacts).map(([name, artifact]) => ({ name, kind: artifact.kind, version: artifact.version, status: artifact.status, basedOn: artifact.basedOn })),
      violations: state.violations.slice(-20), sideEffectCount: state.sideEffects.length, mermaid,
    };
  }

  return Object.freeze({
    admitDispatch, beginNode, attachSession, submitPlan, submitReview, submitChange, submitVerification,
    recordSideEffect, recordViolation, captureRequest, completeRequestCapture, markIncomplete, resumeRun, reconcileNode, revalidateArtifacts, inspect,
  });
}
