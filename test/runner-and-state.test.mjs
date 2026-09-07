import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore, newRun } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { validateTaskGraph } from '../src/task-spec.mjs';

const NOW = '2026-09-07T00:00:00.000Z';
const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 2 });

function spec(id, kind, agent, overrides = {}) {
  return { id, kind, agent, dependsOn: [], inputs: [], outputs: [], acceptance: ['done'], ...overrides };
}
function changeGraph({ writeScope = ['src/a.ts'] } = {}) {
  const specs = [
    spec('explore-1', 'explore', 'graph-explorer', { outputs: ['findings'] }),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'], outputs: ['plan'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'], outputs: ['review'] }),
    spec('impl-1', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope, outputs: ['change:impl-1'] }),
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1'], outputs: ['verification:impl-1'] }),
  ];
  return validateTaskGraph(specs);
}
function freshRun(graph = changeGraph()) {
  const state = newRun({ runId: 'run-1', rootSessionId: 'sess-root', now: NOW });
  const submission = runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  assert.equal(submission.ok, true, JSON.stringify(submission));
  return state;
}
async function dispatchCriticAndPass(state, planVersion = 1) {
  const admit = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-critic' });
  const review = runner.submitReview(state, { planVersion, verdict: 'PASS', findings: [], now: NOW });
  assert.equal(review.ok, true, JSON.stringify(review));
  return admit;
}
async function dispatchImplementerAndSucceed(state, { snapshot = {} } = {}) {
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-impl' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });
  const change = runner.submitChange(state, { nodeId: admit.nodeId, filesTouched: ['src/a.ts'], summary: 'fixed', snapshot, now: NOW });
  assert.equal(change.ok, true, JSON.stringify(change));
  return admit;
}
async function dispatchVerifier(state, verdict, commands = [{ command: 'npm test', exitCode: 0 }], snapshot = { 'src/a.ts': 'hash-post' }) {
  const admit = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-verify' });
  const result = runner.submitVerification(state, { nodeId: admit.nodeId, verdict, commands, snapshot, now: NOW });
  if (!result.ok) runner.markIncomplete(state, { nodeId: admit.nodeId, now: NOW });
  return result;
}

test('run-state persists atomically, reloads, and locks across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  const state = await store.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW });
  state.mode = 'change';
  await store.saveRun(state);

  const disk = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'abc123.json'), 'utf8'));
  assert.equal(disk.runId, 'abc123');
  assert.equal(disk.mode, 'change');

  const second = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  const reloaded = await second.loadRun('abc123');
  assert.notEqual(reloaded, state);
  assert.equal(reloaded.mode, 'change');
  reloaded.mode = 'plan-only';
  await second.saveRun(reloaded);
  assert.equal((await store.loadRun('abc123')).mode, 'plan-only');

  await assert.rejects(second.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW }), /locked/);
  await second.releaseRun('abc123');
  const third = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  await third.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW });

  await assert.rejects(store.createRun({ runId: '../escape', rootSessionId: 'x', now: NOW }), TypeError);
  assert.equal(await store.loadRun('../escape'), null);
  assert.equal(await store.loadRun('missing-run'), null);
});

test('run-state fails closed on corrupted or foreign schema documents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  await mkdir(join(dir, '.opencode-loop', 'runs'), { recursive: true });
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad1.json'), JSON.stringify({ ...newRun({ runId: 'bad1', rootSessionId: 'bad1', now: NOW }), schemaVersion: 99 }));
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad2.json'), '{not json');
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad3.json'), JSON.stringify({ ...newRun({ runId: 'bad3', rootSessionId: 'bad3', now: NOW }), status: 'EXPLODING' }));
  for (const id of ['bad1', 'bad2', 'bad3']) await assert.rejects(store.loadRun(id));
});

test('hashFiles snapshots literals, reports globs and missing files conservatively', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-hash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
  const store = createRunStore({ worktree: dir });
  const snapshot = await store.hashFiles(['a.ts', 'missing.ts', 'src/*.ts']);
  assert.match(snapshot['a.ts'], /^[0-9a-f]{64}$/);
  assert.equal(snapshot['missing.ts'], 'MISSING');
  assert.equal(snapshot['src/*.ts'], 'UNVERIFIABLE');
  const memory = createRunStore({});
  assert.equal((await memory.hashFiles(['a.ts']))['a.ts'], 'UNVERIFIABLE');
});

test('scenario: critic FAIL terminates the run; implementer dispatch is rejected', () => {
  const state = freshRun();
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const review = runner.submitReview(state, { planVersion: 1, verdict: 'FAIL', findings: ['plan misses the error path'], now: NOW });
  assert.equal(review.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');

  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'RUN_TERMINATED');
  for (const agent of ['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-verifier']) {
    assert.equal(runner.admitDispatch(state, { agent, now: NOW }).allowed, false, agent);
  }
  assert.equal(runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW }).code, 'RUN_TERMINATED');
});

test('scenario: implementer cannot be dispatched before review PASS (gate skip rejected)', () => {
  const state = freshRun();
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'NO_READY_NODE');
  assert.match(denied.detail, /review-1/);

  const verifier = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  assert.equal(verifier.allowed, false);
  assert.equal(verifier.code, 'NO_READY_NODE');
});

test('REVISE returns to planner, is capped, and burns the plan artifact version', () => {
  const state = freshRun();
  for (let round = 1; round <= 2; round += 1) {
    const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
    runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
    const verdict = runner.submitReview(state, { planVersion: round, verdict: 'REVISE', findings: [`fix ${round}`], now: NOW });
    assert.equal(verdict.effect, 'revise');
    assert.equal(state.artifacts.plan.status, 'superseded');
    const replan = runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
    assert.equal(replan.version, round + 1);
  }
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const third = runner.submitReview(state, { planVersion: 3, verdict: 'REVISE', findings: ['again'], now: NOW });
  assert.equal(third.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');
  assert.match(state.failReason, /revisions exhausted/);
});

test('review verdict must target the current plan version (no stale PASS)', () => {
  const state = freshRun();
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const stale = runner.submitReview(state, { planVersion: 99, verdict: 'PASS', now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_PLAN_VERSION');
  assert.equal(state.nodes['review-1'].state, 'RUNNING');

  const resubmitted = runner.submitReview(state, { planVersion: 1, verdict: 'REVISE', findings: ['x'], now: NOW });
  assert.equal(resubmitted.ok, true);
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  const critic2 = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic2.nodeId, { now: NOW, sessionId: 'c' });
  const oldPass = runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now: NOW });
  assert.equal(oldPass.code, 'STALE_PLAN_VERSION');
});

test('happy path: PASS chain completes the run and requires command evidence', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state, { snapshot: { 'src/a.ts': 'hash-1' } });

  const weak = await dispatchVerifier(state, 'PASS', []);
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'INSUFFICIENT_EVIDENCE');
  const failing = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(failing.ok, false);

  const strong = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 0 }]);
  assert.equal(strong.ok, true, JSON.stringify(strong));
  assert.equal(state.status, 'SUCCEEDED');
  const after = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(after.code, 'RUN_TERMINATED');
});

test('verification FAIL triggers a capped repair loop and supersedes the change', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state);
  const first = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(first.effect, 'repair');
  assert.equal(state.nodes['impl-1'].state, 'PENDING');
  assert.equal(state.artifacts['change:impl-1'].status, 'superseded');

  await dispatchImplementerAndSucceed(state);
  const second = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(second.effect, 'repair');
  await dispatchImplementerAndSucceed(state);
  const third = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(third.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');
  assert.match(state.failReason, /repair loop exhausted/);
});

test('UNVERIFIED blocks the run without faking success', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state);
  const result = await dispatchVerifier(state, 'UNVERIFIED', []);
  assert.equal(result.effect, 'blocked');
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.blockedReason.kind, 'info');
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RUN_BLOCKED');
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  assert.equal(state.status, 'RUNNING');
});

test('change submission cross-checks the side-effect ledger and writeScope', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/secret.ts', now: NOW });

  const undisclosed = runner.submitChange(state, { nodeId: admit.nodeId, filesTouched: ['src/a.ts'], summary: 'x', now: NOW });
  assert.equal(undisclosed.code, 'LEDGER_MISMATCH');
  assert.equal(state.nodes['impl-1'].state, 'FAILED');
  assert.ok(state.violations.some((entry) => entry.kind === 'undisclosed-edit'));

  const state2 = freshRun();
  await dispatchCriticAndPass(state2);
  const admit2 = runner.admitDispatch(state2, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state2, admit2.nodeId, { now: NOW, sessionId: 'i2' });
  const outOfScope = runner.submitChange(state2, { nodeId: admit2.nodeId, filesTouched: ['docs/readme.md'], summary: 'x', now: NOW });
  assert.equal(outOfScope.code, 'OUT_OF_SCOPE');
  assert.equal(state2.nodes['impl-1'].state, 'FAILED');
});

test('attempts persist across reload and are not reset by restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-attempts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  let state = await store.createRun({ runId: 'r1', rootSessionId: 'r1', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  await dispatchCriticAndPass(state);
  for (let round = 1; round <= 2; round += 1) {
    const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
    runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
    runner.markIncomplete(state, { nodeId: admit.nodeId, now: NOW });
  }
  assert.equal(state.nodes['impl-1'].attempt, 2);
  assert.equal(state.nodes['impl-1'].state, 'INCOMPLETE');
  await store.saveRun(state);

  const reloaded = await store.loadRun('r1');
  assert.equal(reloaded.nodes['impl-1'].attempt, 2);
  const admit = runner.admitDispatch(reloaded, { agent: 'graph-implementer', now: NOW });
  assert.equal(admit.allowed, true);
  runner.beginNode(reloaded, admit.nodeId, { now: NOW, sessionId: 'i' });
  assert.equal(reloaded.nodes['impl-1'].attempt, 3);
  runner.markIncomplete(reloaded, { nodeId: admit.nodeId, now: NOW });
  assert.equal(reloaded.status, 'FAILED');
  assert.match(reloaded.failReason, /never delivered/);
});

test('single-writer: second implementer node cannot run while one is RUNNING', async () => {
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
    spec('impl-1', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['src/a.ts'] }),
    spec('impl-2', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['docs/b.md'] }),
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1', 'impl-2'] }),
  ]);
  const state = newRun({ runId: 'r2', rootSessionId: 'r2', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  await dispatchCriticAndPass(state);
  const first = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(first.nodeId, 'impl-1');
  runner.beginNode(state, 'impl-1', { now: NOW, sessionId: 'i1' });
  const second = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'ALREADY_RUNNING');
});

test('resume: crash windows classify conservatively and keep counters', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });

  const result = runner.resumeRun(state, { now: NOW });
  assert.deepEqual(result.report.recoveryRequired, ['impl-1']);
  assert.equal(state.status, 'RECOVERY_REQUIRED');
  assert.equal(state.nodes['impl-1'].state, 'RECOVERY_REQUIRED');

  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RECOVERY_REQUIRED');

  const reconciled = runner.reconcileNode(state, 'impl-1', { now: NOW });
  assert.equal(reconciled.ok, true);
  assert.equal(state.status, 'RUNNING');
  assert.equal(state.nodes['impl-1'].state, 'PENDING');
  assert.equal(state.nodes['impl-1'].attempt, 1);
  const redispatch = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(redispatch.allowed, true);
  assert.equal(redispatch.reconcile, true);
  runner.beginNode(state, redispatch.nodeId, { now: NOW, sessionId: 'i' });
  const change = runner.submitChange(state, { nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'reconciled', now: NOW });
  assert.equal(change.ok, true);

  const clean = freshRun();
  const admitClean = runner.admitDispatch(clean, { agent: 'graph-verifier', now: NOW });
  assert.equal(admitClean.code, 'NO_READY_NODE');
});

test('revalidation: hash mismatch invalidates stale verification evidence', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state, { snapshot: { 'src/a.ts': 'hash-1' } });
  const verified = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 0 }], { 'src/a.ts': 'hash-1' });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(state.status, 'SUCCEEDED');

  const drifted = runner.revalidateArtifacts(state, { currentSnapshot: { 'src/a.ts': 'hash-2' }, now: NOW });
  assert.deepEqual(drifted.invalidated, ['change:impl-1@1', 'verification:verify-1@1']);
  assert.equal(state.artifacts['verification:verify-1'].status, 'stale');
  assert.equal(state.nodes['verify-1'].state, 'STALE');
});

test('plan-only runs admit reviewers but never implementers', () => {
  const state = newRun({ runId: 'r3', rootSessionId: 'r3', now: NOW });
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
  ]);
  runner.submitPlan(state, { intent: 'plan-only', nodes: graph.nodes, now: NOW });
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(critic.allowed, true);
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  assert.equal(runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now: NOW }).ok, true);
  assert.equal(state.status, 'SUCCEEDED');
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RUN_TERMINATED');
});

test('read-only agents dispatch freely on healthy runs and need no node', () => {
  const state = newRun({ runId: 'r4', rootSessionId: 'r4', now: NOW });
  const free = runner.admitDispatch(state, { agent: 'graph-explorer', now: NOW });
  assert.deepEqual({ allowed: free.allowed, nodeId: free.nodeId, free: free.free }, { allowed: true, nodeId: null, free: true });
  const invalid = runner.admitDispatch(state, { agent: 'build', now: NOW });
  assert.equal(invalid.code, 'INVALID_AGENT');
});

test('inspect reports blockers, counters, artifacts and a mermaid graph', async () => {
  const state = freshRun();
  const report = runner.inspect(state);
  assert.equal(report.status, 'RUNNING');
  assert.equal(report.mode, 'change');
  const impl = report.nodes.find((node) => node.id === 'impl-1');
  assert.equal(impl.ready, false);
  assert.match(impl.waitingOn.join('; '), /review-1/);
  assert.match(report.mermaid, /graph TD/);
  assert.match(report.mermaid, /review-1 --> impl-1/);
  assert.ok(report.artifacts.some((artifact) => artifact.name === 'plan' && artifact.version === 1));
  await dispatchCriticAndPass(state);
  const after = runner.inspect(state);
  assert.equal(after.nodes.find((node) => node.id === 'impl-1').ready, true);
});
