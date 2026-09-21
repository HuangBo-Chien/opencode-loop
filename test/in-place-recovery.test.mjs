import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunStore, sanitizeRun } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';
import { validateTaskGraph } from '../src/task-spec.mjs';
import { createEnforcement } from '../src/enforcement.mjs';
import { registerAgents } from '../src/agents.mjs';
import { parseOptions } from '../src/config.mjs';
import { prepareVerificationRetry } from '../src/recovery-policy.mjs';

const now = '2026-09-21T00:00:00.000Z';
const root = { sessionID: 'root', agent: 'graph-orchestrator' };
const roles = { plan: 'planner', review: 'plan-critic', implement: 'implementer', verify: 'verifier' };
const spec = (id, kind, dependsOn = [], extra = {}) => ({ id, kind, agent: `graph-${roles[kind]}`, dependsOn,
  inputs: [], outputs: [], acceptance: ['done'], ...(kind === 'implement' ? { writeScope: [`${id}.txt`] } : {}), ...extra });

async function fixture(t, { runId = 'root', maxAttempts = 4, light = false, extra = [], deleted = false, noop = false } = {}) {
  const dir = await mkdtemp(join(process.cwd(), '.retry-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const backing = createRunStore({ worktree: dir });
  if (runId !== 'root') {
    const previous = await backing.createRun({ runId: 'root', rootSessionId: 'root', now });
    previous.successorRunId = runId;
    await backing.saveRun(previous);
  }
  const state = await backing.createRun({ runId, rootSessionId: 'root', now });
  const runner = createRunner({ maxAttempts, maxPlanRevisions: 2 });
  let failSave = false;
  const store = { ...backing, saveRun: async (candidate) => {
    if (failSave) { candidate.updatedAt = 'unsaved'; throw new Error('injected EIO'); }
    return backing.saveRun(candidate);
  } };
  const bindings = new Map([['root', { root: true, runId, agent: root.agent }]]);
  const dispatches = createDispatchBindings({ store, runner, bindings });
  const tools = createSubmitTools({ store, runner, bindings, worktree: dir, dispatches }).tools;
  const specs = [spec('p', 'plan'), ...(!light ? [spec('r', 'review', ['p'])] : []),
    spec('a', 'implement', [light ? 'p' : 'r']), ...(!light ? [spec('b', 'implement', ['r'])] : []),
    spec('v', 'verify', light ? ['a'] : ['a', 'b']), ...extra];
  const graph = validateTaskGraph(specs, { light });
  assert.equal(graph.ok, true, JSON.stringify(graph.errors));
  assert.equal(runner.submitPlan(state, { intent: light ? 'light' : 'change', nodes: graph.nodes, now }).ok, true);
  if (!light) {
    runner.beginNode(state, 'r', { now, sessionId: 'review', dispatchId: 'review-1' });
    runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now });
  }
  for (const id of light ? ['a'] : ['a', 'b']) {
    runner.beginNode(state, id, { now, sessionId: id, dispatchId: `${id}-1` });
    const filesTouched = noop ? [] : [`${id}.txt`];
    if (!deleted && !noop) await writeFile(join(dir, `${id}.txt`), id);
    assert.equal(runner.submitChange(state, { nodeId: id, filesTouched, filesDeleted: deleted ? filesTouched : [],
      snapshot: await store.hashFiles(filesTouched), summary: id, now }).ok, true);
  }
  let sequence = 0;
  async function bind(id = 'v', taskId) {
    const callID = `call-${++sequence}`;
    const agent = state.nodes[id]?.spec.agent ?? 'graph-explorer';
    const args = { subagent_type: agent, prompt: state.nodes[id] ? `[nodeId:${id}]\nWork` : 'Explore', ...(taskId ? { task_id: taskId } : {}) };
    const admitted = await dispatches.admit('root', callID, args);
    if (!admitted.allowed) return admitted;
    const sessionId = taskId ?? `child-${sequence}`;
    await dispatches.onSession({ id: sessionId, parentID: 'root' });
    await dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID,
      state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId } } });
    return { allowed: true, sessionId, callID, args };
  }
  const end = (call) => dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: call.callID, state: { status: 'completed' } });
  const submit = (call, args = {}) => tools.graph_submit_verification.execute({ nodeId: 'v', verdict: 'UNVERIFIED',
    commands: [{ command: 'probe', exitCode: 1 }], summary: 'service unavailable', ...args },
  { sessionID: call.sessionId, agent: 'graph-verifier' }).then(JSON.parse);
  const decide = (args = {}, context = root) => tools.graph_run_decide.execute({ action: 'retry', reason: 'service restored',
    expectedPauseId: state.pendingDecision?.pauseId, ...args }, context).then(JSON.parse);
  const pause = async () => { const call = await bind(); assert.equal((await submit(call)).ok, true); await end(call); return call; };
  return { state, runner, store, backing, bindings, dispatches, tools, bind, end, submit, decide, pause, dir,
    failSave: (value) => { failSave = value; }, disk: () => readFile(join(dir, '.opencode-loop/runs', `${encodeURIComponent(runId)}.json`), 'utf8') };
}

for (const sameSession of [false, true]) test(`UNVERIFIED retries same run with ${sameSession ? 'task_id' : 'fresh session'} and preserves completed work`, async (t) => {
  const h = await fixture(t);
  const call = await h.pause();
  const before = structuredClone(h.state);
  const pauseId = h.state.pendingDecision.pauseId;
  assert.equal(Number.isSafeInteger(pauseId), true);
  assert.equal((await h.decide()).action, 'retry');
  assert.equal(h.state.status, 'RUNNING');
  assert.equal(h.state.pendingDecision, null);
  assert.equal(h.state.recoveryUsed, 1);
  assert.deepEqual(h.state.revisionCounters, before.revisionCounters);
  assert.deepEqual(h.state.nodes.a, before.nodes.a);
  assert.deepEqual(h.state.artifacts['change:a'], before.artifacts['change:a']);
  assert.equal(h.state.nodes.v.attempt, 1);
  assert.equal(h.state.nodes.v.sessionId, call.sessionId);
  const next = await h.bind('v', sameSession ? call.sessionId : undefined);
  assert.equal(next.allowed, true);
  assert.equal(h.state.nodes.v.attempt, 2);
  assert.notEqual(h.state.nodes.v.dispatchId, before.nodes.v.dispatchId);
  await h.end(call); // duplicate late terminal event cannot overwrite new work
  assert.equal(h.state.nodes.v.state, 'RUNNING');
  assert.equal((await h.submit(next, { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] })).ok, true);
  assert.equal(h.state.status, 'SUCCEEDED');
  assert.equal(h.state.artifacts['verification:v'].version, 2);
  assert.deepEqual(h.state.recoveryHistory[0].pause, before.pendingDecision);
  assert.equal(h.state.recoveryHistory[0].pause.evidence.payload.verdict, 'UNVERIFIED');
  assert.equal(h.state.recoveryHistory[0].decision.expectedPauseId, pauseId);
});

for (const corrected of [true, false]) test(`correctable rejection retry ${corrected ? 'accepts corrected evidence' : 'same payload re-pauses immediately'}`, async (t) => {
  const h = await fixture(t); const call = await h.bind();
  const bad = { verdict: 'PASS', commands: [] };
  assert.equal((await h.submit(call, bad)).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal((await h.submit(call, bad)).code, 'REJECTION_LOOP');
  await h.end(call);
  const original = structuredClone(h.state.pendingDecision);
  assert.equal((await h.decide()).ok, true);
  assert.equal(h.state.nodes.v.rejectionStreak.count, 2);
  const next = await h.bind();
  const result = await h.submit(next, corrected ? { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] } : bad);
  if (corrected) {
    assert.equal(result.ok, true); assert.equal(h.state.nodes.v.rejectionStreak, null);
  } else {
    assert.equal(result.code, 'REJECTION_LOOP');
    assert.equal(h.state.pendingDecision.pauseId, original.pauseId + 1);
    await h.end(next);
    assert.equal((await h.decide()).ok, false);
    assert.equal(h.state.recoveryUsed, 1);
  }
  assert.deepEqual(h.state.recoveryHistory[0].pause, original);
  assert.equal(original.evidence.payload.verdict, 'PASS');
});

const denials = {
  'attempt exhausted': (h) => { h.state.nodes.v.spec.maxAttempts = 1; },
  'legacy identity': (h) => { delete h.state.pendingDecision.dispatchId; },
  'wrong dispatch generation': (h) => { h.state.nodes.v.dispatchId = 'other'; },
  'wrong attempt generation': (h) => { h.state.nodes.v.attempt++; },
  'wrong plan generation': (h) => { h.state.artifacts.plan.version++; },
  'baseline': (h) => { h.state.nodes.v.spec.baseline = true; },
  'unknown cause': (h) => { h.state.pendingDecision.cause = 'unknown'; },
  'functional repair exhaustion': (h) => { h.state.pendingDecision.cause = 'verification-repair-exhausted'; },
  'STALE_CHANGE': (h) => { h.state.pendingDecision.cause = 'runner-rejection'; h.state.pendingDecision.rejectionCode = 'STALE_CHANGE'; },
  'failed sibling': (h) => { h.state.nodes.b.state = 'FAILED'; },
  'incomplete sibling': (h) => { h.state.nodes.b.state = 'INCOMPLETE'; },
  'stale sibling': (h) => { h.state.nodes.b.state = 'STALE'; },
  'recovery sibling': (h) => { h.state.nodes.b.state = 'RECOVERY_REQUIRED'; },
  'running sibling': (h) => { h.state.nodes.b.state = 'RUNNING'; },
  'started pending sibling': (h) => { h.state.nodes.b.state = 'PENDING'; },
  'pending effect': (h) => { h.state.pendingEffects = [{ nodeId: 'v', callID: 'effect' }]; },
  'persisted native reservation': (h) => { h.state.dispatchReservations = [{ nodeId: null, bound: false }]; },
  'Task1 replan required': (h) => { h.state.repairPlanRevision = { needsPlanRevision: true }; },
  'review closeout is not approval': (h) => {
    h.state.artifacts.review.status = 'superseded';
    h.state.closeouts = [{ tool: 'graph_submit_review', payload: { verdict: 'PASS' } }];
  },
  'review FAIL is not approval': (h) => { h.state.artifacts.review.payload.verdict = 'FAIL'; },
  'scope violation': (h) => { h.state.violations.push({ kind: 'out-of-scope-claim' }); },
  'ledger violation': (h) => { h.state.violations.push({ kind: 'undisclosed-edit' }); },
  'executed despite deny': (h) => { h.state.nodes.v.lastFailure = { code: 'EXECUTED_DESPITE_DENY' }; },
  'missing snapshot coverage': (h) => { delete h.state.artifacts['change:a'].snapshot['a.txt']; },
  'untrustworthy hash': (h) => { h.state.artifacts['change:a'].snapshot['a.txt'] = 'not-a-hash'; },
  'conflicting snapshots': (h) => { h.state.artifacts['change:b'].snapshot['a.txt'] = 'f'.repeat(64); },
  'unverifiable expected snapshot': (h) => { h.state.artifacts['change:a'].snapshot['a.txt'] = 'UNVERIFIABLE'; },
  'unexpected missing expected': (h) => { h.state.artifacts['change:a'].snapshot['a.txt'] = 'MISSING'; },
  'historical consumed evidence lacks retained proof': (h) => {
    h.state.nodes.a.consumedRefs.push('change:old@1');
    h.state.artifactLineage['change:old@1'] = { status: 'valid', basedOn: [] };
  },
  'actual drift': (h) => writeFile(join(h.dir, 'a.txt'), 'drift'),
  'actual deletion': (h) => rm(join(h.dir, 'a.txt')),
  'terminal': (h) => { h.state.status = 'SUCCEEDED'; },
  'superseded': (h) => { h.state.successorRunId = 'root:2'; },
};
for (const [name, mutate] of Object.entries(denials)) test(`retry denies ${name} atomically`, async (t) => {
  const h = await fixture(t); await h.pause(); await mutate(h);
  await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const bindings = structuredClone(h.bindings); const disk = await h.disk();
  assert.equal((await h.decide()).ok, false);
  assert.deepEqual(h.state, before); assert.deepEqual(h.bindings, bindings); assert.equal(await h.disk(), disk);
});

for (const args of [{ expectedPauseId: 999 }, { expectedPauseId: undefined }, { reason: '  ' }, { reason: '' }, { action: 'bogus' }]) {
  test(`retry rejects invalid decision ${JSON.stringify(args)}`, async (t) => {
    const h = await fixture(t); await h.pause(); const before = structuredClone(h.state);
    assert.equal((await h.decide(args)).ok, false); assert.deepEqual(h.state, before);
  });
}

for (const options of [{ light: true }, { noop: true }, { deleted: true }, { runId: 'root:2' }]) {
  test(`retry supports ${JSON.stringify(options)}`, async (t) => {
    const h = await fixture(t, options); await h.pause();
    assert.equal((await h.decide()).action, 'retry');
    assert.equal(h.state.runId, options.runId ?? 'root');
    assert.equal(h.bindings.get('root').runId, h.state.runId);
  });
}

test('retry EIO is atomic and identical request can succeed exactly once', async (t) => {
  const h = await fixture(t); await h.pause();
  const request = { expectedPauseId: h.state.pendingDecision.pauseId };
  const before = structuredClone(h.state); const bindings = structuredClone(h.bindings); const disk = await h.disk();
  h.failSave(true);
  await assert.rejects(h.decide(request), /EIO/);
  assert.deepEqual(h.state, before); assert.deepEqual(h.bindings, bindings); assert.equal(await h.disk(), disk);
  h.failSave(false);
  assert.equal((await h.decide(request)).action, 'retry');
  assert.equal((await h.decide(request)).ok, false);
  assert.equal(h.state.recoveryHistory.length, 1);
});

test('retry capacity refusal preserves essential history rather than truncating it', async (t) => {
  const h = await fixture(t); await h.pause();
  // Fill up to the real sanitizer's exact boundary, leaving no room for the
  // history/decision. The pre-decision run itself must still save successfully.
  let low = 0; let high = 1_048_576;
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    try { sanitizeRun({ ...h.state, padding: 'x'.repeat(size) }); low = size; }
    catch { high = size - 1; }
  }
  h.state.padding = 'x'.repeat(low);
  await h.store.saveRun(h.state);
  const before = structuredClone(h.state);
  const disk = await h.disk();
  assert.equal((await h.decide()).ok, false);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
});

test('future never-started work stays PENDING and later functional FAIL uses selective repair', async (t) => {
  const h = await fixture(t, { extra: [spec('later', 'verify', ['v', 'b'])] }); await h.pause();
  const b = structuredClone(h.state.nodes.b); const future = structuredClone(h.state.nodes.later);
  assert.equal((await h.decide()).action, 'retry');
  assert.deepEqual(h.state.nodes.later, future);
  const next = await h.bind();
  const result = await h.submit(next, { verdict: 'FAIL', repairTargets: ['a'] });
  assert.equal(result.effect, 'repair'); assert.deepEqual(result.repairTargets, ['a']);
  assert.deepEqual(h.state.nodes.b, b); assert.equal(h.state.nodes.a.state, 'PENDING');
  assert.equal(h.state.recoveryUsed, 1);
});

for (const [name, mutate] of Object.entries({
  'changed successful consumption': (h) => { h.state.nodes.a.consumedRefs = []; },
  'undisclosed confirmed ledger edit': (h) => { h.state.sideEffects.push({ nodeId: 'a', tool: 'edit', target: 'undeclared.txt' }); },
  'out-of-scope native violation': (h) => { h.state.violations.push({ kind: 'out-of-scope-edit' }); },
})) test(`retry refuses ${name} even when file snapshots agree`, async (t) => {
  const h = await fixture(t); await h.pause(); mutate(h);
  const before = structuredClone(h.state);
  assert.equal((await h.decide()).ok, false);
  assert.deepEqual(h.state, before);
});

for (const [name, prepare] of Object.entries({
  'missing claim coverage': (h) => { delete h.state.artifacts['change:a'].snapshot['a.txt']; },
  'conflicting retained snapshots': (h) => { h.state.artifacts['change:b'].snapshot['a.txt'] = 'f'.repeat(64); },
  'drift already present at pause': (h) => writeFile(join(h.dir, 'a.txt'), 'drift'),
  'deleted before pause': (h) => rm(join(h.dir, 'a.txt')),
})) test(`pause with ${name} never acquires guessed evidence`, async (t) => {
  const h = await fixture(t); await prepare(h); await h.pause();
  assert.equal((await h.decide()).ok, false);
  assert.equal(h.state.pendingDecision.proof, null);
});

for (const scenario of ['bound', 'unbound', 'free', 'queued']) test(`retry waits for real native ${scenario} lifetime`, async (t) => {
  const h = await fixture(t);
  let blocker;
  if (scenario === 'free') blocker = await h.bind('free');
  if (scenario === 'unbound') {
    blocker = { callID: 'unbound' };
    assert.equal((await h.dispatches.admit('root', blocker.callID, { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  }
  const call = await h.bind();
  if (scenario === 'queued') {
    blocker = { callID: 'queued' };
    assert.equal((await h.dispatches.admit('root', blocker.callID, { ...call.args, task_id: call.sessionId })).allowed, true);
  }
  await h.submit(call);
  if (scenario !== 'bound') await h.end(call);
  const before = structuredClone(h.state);
  assert.equal((await h.decide()).code, 'DISPATCH_PENDING');
  assert.deepEqual(h.state, before);
  await h.end(blocker ?? call);
  assert.equal((await h.decide()).action, 'retry');
});

test('owned PASS closeout never grants approval; retry still needs a fresh normal PASS', async (t) => {
  const h = await fixture(t); const call = await h.bind(); await h.submit(call);
  assert.equal((await h.submit(call, { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] })).effect, 'settlement');
  assert.equal(h.state.artifacts['verification:v'].payload.verdict, 'UNVERIFIED');
  assert.equal((await h.decide()).ok, false);
  await h.end(call);
  assert.equal((await h.decide()).action, 'retry');
  assert.equal(h.state.nodes.v.state, 'PENDING');
  const next = await h.bind();
  assert.equal((await h.submit(next, { verdict: 'PASS', commands: [] })).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(h.state.status, 'RUNNING');
});

for (const context of [{ sessionID: 'root', agent: 'graph-verifier' }, { sessionID: 'other-root', agent: root.agent },
  { sessionID: 'child-1', agent: root.agent }]) test(`retry rejects unauthorized caller ${JSON.stringify(context)}`, async (t) => {
  const h = await fixture(t); await h.pause();
  h.bindings.set('other-root', { root: true, runId: 'root', agent: root.agent });
  const before = structuredClone(h.state);
  assert.equal((await h.decide({}, context)).ok, false); assert.deepEqual(h.state, before);
});

test('native ask and configured denial remain authoritative for retry', async (t) => {
  const h = await fixture(t); await h.pause();
  const config = {};
  registerAgents(config, parseOptions({}));
  assert.equal(config.agent['graph-orchestrator'].permission.graph_run_decide, 'ask');
  assert.equal(config.agent['graph-verifier'].permission.graph_run_decide, undefined);
  assert.equal(config.agent['graph-verifier'].permission['*'], 'deny');
  const enforcement = createEnforcement({ settings: { worktree: h.dir }, store: h.store, runner: h.runner, bindings: h.bindings, dispatches: h.dispatches });
  const before = structuredClone(h.state); const output = { status: 'deny' };
  await enforcement.onPermissionAsk({ type: 'graph_run_decide', sessionID: 'root', callID: 'denied-retry' }, output);
  assert.equal(output.status, 'deny'); assert.deepEqual(h.state, before);
});

for (const rejection of ['ARTIFACT_REQUIRED', 'INVALID_VERDICT']) test(`${rejection} is eligible and corrected normal PASS clears streak`, async (t) => {
  const h = await fixture(t);
  if (rejection === 'ARTIFACT_REQUIRED') h.state.nodes.a.spec.deliverables = ['a.txt'];
  const call = await h.bind();
  const bad = rejection === 'INVALID_VERDICT' ? { verdict: 'BASELINE' } : { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] };
  assert.equal((await h.submit(call, bad)).code, rejection);
  assert.equal((await h.submit(call, bad)).code, 'REJECTION_LOOP'); await h.end(call);
  assert.equal((await h.decide()).action, 'retry');
  const next = await h.bind();
  assert.equal((await h.submit(next, { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], artifacts: ['a.txt'] })).ok, true);
  assert.equal(h.state.nodes.v.rejectionStreak, null);
});

async function restart(h) {
  await h.backing.releaseRun(h.state.runId);
  const store = createRunStore({ worktree: h.dir });
  const bindings = new Map();
  const enforcement = createEnforcement({ settings: { worktree: h.dir }, store, runner: h.runner, bindings });
  await enforcement.onChatMessage(root);
  const dispatches = enforcement.dispatches;
  const tools = createSubmitTools({ store, runner: h.runner, bindings, dispatches, worktree: h.dir }).tools;
  return { store, bindings, dispatches, tools, state: store.getRun(bindings.get('root').runId) };
}

for (const afterDecision of [false, true]) test(`restart ${afterDecision ? 'after saved retry before dispatch' : 'before decision'} preserves allowance and generation`, async (t) => {
  const h = await fixture(t); const call = await h.pause();
  const pause = structuredClone(h.state.pendingDecision);
  if (afterDecision) assert.equal((await h.decide()).action, 'retry');
  const r = await restart(h);
  assert.equal(r.state.nodes.v.attempt, 1);
  if (!afterDecision) {
    assert.deepEqual(r.state.pendingDecision, pause);
    assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'service restored', expectedPauseId: pause.pauseId }, root)).ok, true);
  }
  assert.equal(r.state.status, 'RUNNING'); assert.equal(r.state.recoveryUsed, 1);
  const args = { subagent_type: 'graph-verifier', prompt: '[nodeId:v]\nRetry', task_id: call.sessionId };
  assert.equal((await r.dispatches.admit('root', 'after-restart', args)).allowed, true);
  assert.equal(r.state.nodes.v.attempt, 1, 'reservation alone never charges');
  await r.dispatches.onSession({ id: call.sessionId, parentID: 'root' });
  const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: 'after-restart',
    state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId: call.sessionId } } };
  await r.dispatches.onPart(part); await r.dispatches.onPart(part);
  assert.equal(r.state.nodes.v.attempt, 2);
  assert.equal(JSON.parse(await r.tools.graph_submit_verification.execute({ nodeId: 'v', verdict: 'UNVERIFIED', summary: 'still offline' },
    { sessionID: call.sessionId, agent: 'graph-verifier' })).ok, true);
  assert.equal(r.state.pendingDecision.pauseId, pause.pauseId + 1);
  await r.dispatches.onPart({ ...part, state: { status: 'completed' } });
  const result = JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'try again', expectedPauseId: r.state.pendingDecision.pauseId }, root));
  assert.equal(result.ok, false); assert.deepEqual(r.state.recoveryHistory[0].pause, pause);
});

test('replan does not replenish recovery allowance or pause sequence', async (t) => {
  const h = await fixture(t); await h.pause();
  assert.equal((await h.decide()).action, 'retry');
  const graph = validateTaskGraph(Object.values(h.state.nodes).map((n) => n.spec));
  assert.equal(h.runner.submitPlan(h.state, { intent: 'change', nodes: graph.nodes, now }).ok, true);
  assert.equal(h.state.recoveryUsed, 1); assert.equal(h.state.pauseSequence, 1); assert.equal(h.state.recoveryHistory.length, 1);
  h.runner.beginNode(h.state, 'r', { now, sessionId: 'r2', dispatchId: 'r2' });
  h.runner.submitReview(h.state, { planVersion: 2, verdict: 'PASS', now });
  for (const id of ['a', 'b']) {
    h.runner.beginNode(h.state, id, { now, sessionId: id, dispatchId: `${id}-2` });
    h.runner.submitChange(h.state, { nodeId: id, filesTouched: [], summary: 'replan', now });
  }
  await h.pause(); assert.equal(h.state.pendingDecision.pauseId, 2);
  assert.equal((await h.decide()).ok, false);
});

test('filesystem junction is UNVERIFIABLE even when its target bytes equal the expected file', async (t) => {
  const h = await fixture(t); await h.pause();
  // A junction needs no Windows symlink privilege. The claim itself is a file;
  // converting it to a linked directory must still fail the actual hash check.
  await mkdir(join(h.dir, 'target')); await writeFile(join(h.dir, 'target/a.txt'), 'a');
  await rm(join(h.dir, 'a.txt'));
  await symlink(join(h.dir, 'target'), join(h.dir, 'a.txt'), 'junction');
  assert.equal((await h.store.hashFiles(['a.txt']))['a.txt'], 'UNVERIFIABLE');
  assert.equal((await h.decide()).ok, false);
});

test('attempt max 1 is denied without refunds or a successor', async (t) => {
  const h = await fixture(t, { maxAttempts: 1 }); await h.pause();
  assert.equal((await h.decide()).ok, false);
  assert.equal(h.state.nodes.v.attempt, 1); assert.equal(h.state.successorRunId, undefined);
});

test('pure recovery preparation requires actual observed coverage and never mutates source state', async (t) => {
  const h = await fixture(t); await h.pause();
  const before = structuredClone(h.state);
  const args = { expectedPauseId: h.state.pendingDecision.pauseId, reason: 'restored', maxAttempts: 4, now };
  for (const observedSnapshot of [undefined, {}, { 'a.txt': 'UNVERIFIABLE' }, { 'a.txt': 'MISSING' }]) {
    assert.equal(prepareVerificationRetry(h.state, { ...args, observedSnapshot }).ok, false);
    assert.deepEqual(h.state, before);
  }
  const observedSnapshot = await h.store.hashFiles(['a.txt', 'b.txt']);
  const result = prepareVerificationRetry(h.state, { ...args, observedSnapshot });
  assert.equal(result.ok, true); assert.deepEqual(h.state, before);
  assert.equal(result.candidate.recoveryUsed, 1);
});

test('graph_inspect pause ID is stable; first active pause survives unrelated ending attempts', async (t) => {
  const h = await fixture(t); await h.pause();
  const pause = structuredClone(h.state.pendingDecision);
  const first = JSON.parse(await h.tools.graph_inspect.execute({}, root));
  assert.equal(first.pauseId, pause.pauseId);
  assert.equal(JSON.parse(await h.tools.graph_inspect.execute({}, root)).pauseId, first.pauseId);
  h.state.nodes.b.state = 'RUNNING'; h.state.nodes.b.attempt = 4;
  h.runner.markIncomplete(h.state, { nodeId: 'b', now });
  assert.deepEqual(h.state.pendingDecision, pause);
  assert.equal(h.state.pauseSequence, 1);
});

test('crash after retry binding retains allowance while ordinary crash policy refunds only the interrupted attempt', async (t) => {
  const h = await fixture(t); await h.pause(); assert.equal((await h.decide()).action, 'retry');
  await h.bind(); assert.equal(h.state.nodes.v.attempt, 2);
  const r = await restart(h);
  assert.equal(r.state.status, 'RECOVERY_REQUIRED');
  assert.equal(r.state.nodes.v.attempt, 1); assert.equal(r.state.recoveryUsed, 1);
  assert.equal(JSON.parse(await r.tools.graph_run_resume.execute({}, root)).ok, true);
  assert.equal(r.state.status, 'RUNNING'); assert.equal(r.state.nodes.v.state, 'PENDING');
  assert.equal(r.state.recoveryHistory.length, 1); assert.equal(r.state.recoveryUsed, 1);
});

test('successor root:2 remains the latest run across restart and retry', async (t) => {
  const h = await fixture(t, { runId: 'root:2' }); await h.pause();
  const r = await restart(h);
  assert.equal(r.bindings.get('root').runId, 'root:2');
  const result = JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root));
  assert.equal(result.action, 'retry'); assert.equal(result.runId, 'root:2');
  assert.equal(r.state.successorRunId, undefined);
});

test('old late host and closeout events cannot overwrite a newer pause generation', async (t) => {
  const h = await fixture(t); const old = await h.pause();
  assert.equal((await h.decide()).action, 'retry');
  const next = await h.bind(); await h.submit(next);
  const pause = structuredClone(h.state.pendingDecision);
  const attempt = h.state.nodes.v.attempt;
  assert.equal((await h.submit(old, { verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] })).ok, false);
  await h.end(old);
  await h.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: old.callID,
    state: { status: 'running', input: old.args, metadata: { parentSessionId: 'root', sessionId: old.sessionId } } });
  assert.deepEqual(h.state.pendingDecision, pause); assert.equal(h.state.nodes.v.attempt, attempt);
  assert.equal((await h.decide({ expectedPauseId: pause.pauseId - 1 })).ok, false);
});

test('retry verification binding save failure charges the new attempt only once', async (t) => {
  const h = await fixture(t); await h.pause(); await h.decide();
  const args = { subagent_type: 'graph-verifier', prompt: '[nodeId:v]\nRetry' };
  assert.equal((await h.dispatches.admit('root', 'new-bind', args)).allowed, true);
  await h.dispatches.onSession({ id: 'new-child', parentID: 'root' });
  const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: 'new-bind',
    state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId: 'new-child' } } };
  h.failSave(true); await h.dispatches.onPart(part);
  assert.equal(h.state.nodes.v.attempt, 2);
  assert.equal(h.bindings.has('new-child'), false);
  h.failSave(false); await h.dispatches.onPart(part); await h.dispatches.onPart(part);
  assert.equal(h.state.nodes.v.attempt, 2); assert.equal(h.bindings.get('new-child').active, true);
});

test('retry preserves dispatch settlement headroom before spending the allowance', async (t) => {
  const h = await fixture(t); await h.pause();
  h.state.padding = 'x'.repeat(525000); // savable, but a new dispatch cannot fit
  await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const disk = await h.disk();
  assert.equal((await h.decide()).ok, false);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
});

test('successful verifier sibling and artifact-only dependencies remain exact across retry', async (t) => {
  const h = await fixture(t, { extra: [spec('sibling', 'verify', ['b'])] });
  const sibling = await h.bind('sibling');
  assert.equal((await h.submit(sibling, { nodeId: 'sibling', verdict: 'PASS', commands: [{ command: 'test b', exitCode: 0 }] })).ok, true);
  await h.end(sibling);
  h.state.nodes.v.spec.inputs = ['verification:sibling@1'];
  await h.pause();
  const saved = structuredClone({ node: h.state.nodes.sibling, artifact: h.state.artifacts['verification:sibling'] });
  const result = await h.decide();
  assert.equal(result.action, 'retry', JSON.stringify(result));
  assert.deepEqual({ node: h.state.nodes.sibling, artifact: h.state.artifacts['verification:sibling'] }, saved);
});

test('unsatisfiable future work blocks retry even when the paused target and all retained evidence agree', async (t) => {
  const h = await fixture(t, { extra: [spec('later', 'verify', ['v', 'b'])] });
  h.state.nodes.later.spec.inputs = ['verification:absent@1'];
  await h.pause(); assert.ok(h.state.pendingDecision.proof);
  const before = structuredClone(h.state);
  assert.equal((await h.decide()).ok, false); assert.deepEqual(h.state, before);
});

for (const [bound, terminalClaim] of [[false, false], [true, false], [true, true]]) test(`R1 missing admission history preserves ${bound ? 'bound' : 'unbound'} lifetime across repeated real-store restarts (terminalClaim=${terminalClaim})`, async (t) => {
  const h = await fixture(t);
  const lost = bound ? await h.bind('free') : { callID: 'lost-admission' };
  if (!bound) assert.equal((await h.dispatches.admit('root', lost.callID, { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause();
  assert.equal((await h.decide()).code, 'DISPATCH_PENDING');
  const reservation = structuredClone(h.state.dispatchReservations.find((r) => r.callID === lost.callID));
  const admissionKey = JSON.stringify(['root', lost.callID]);
  assert.ok(h.state.dispatchCallIds.includes(admissionKey));
  h.state.dispatchCallIds = h.state.dispatchCallIds.filter((key) => key !== admissionKey);
  if (terminalClaim) h.state.dispatchReservations.find((entry) => entry.callID === lost.callID).terminal = true;
  await h.store.saveRun(h.state);
  let r = await restart(h);
  for (let restartNumber = 0; restartNumber < 2; restartNumber++) {
    const issue = r.state.dispatchRecoveryIssues.find((entry) => entry.reservation.callID === lost.callID);
    const retained = issue.reservation;
    assert.ok(retained, 'unproven pending work must remain on disk');
    assert.equal(retained.dispatchId, reservation.dispatchId);
    assert.equal(issue.code, 'MISSING_ADMISSION_PROOF');
    assert.ok(r.dispatches.inspect(r.state.runId).some((entry) => entry.callID === lost.callID));
    assert.equal(r.dispatches.current(r.bindings.get(lost.sessionId)), false);
    for (const action of ['retry', 'abort', 'reset']) {
      const before = structuredClone(r.state);
      const result = JSON.parse(await r.tools.graph_run_decide.execute({ action, reason: 'user decision',
        ...(action === 'retry' ? { expectedPauseId: r.state.pendingDecision.pauseId } : {}) }, root));
      assert.equal(result.ok, false, action);
      assert.deepEqual(r.state, before);
    }
    const sessionId = lost.sessionId ?? 'late-unproven-child';
    await r.dispatches.onSession({ id: sessionId, parentID: 'root' });
    await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: lost.callID,
      state: { status: 'running', input: { subagent_type: 'graph-explorer' }, metadata: { parentSessionId: 'root', sessionId } } });
    await r.dispatches.onIdle(sessionId, `ambiguous-idle-${restartNumber}`);
    await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: lost.callID, state: { status: 'completed' } });
    assert.equal(r.dispatches.current(r.bindings.get(sessionId)), false);
    assert.ok(JSON.parse(await h.disk()).dispatchRecoveryIssues.some((entry) => entry.reservation.callID === lost.callID));
    r = await restart({ ...h, state: r.state, backing: r.store });
  }
});

for (const bound of [false, true]) test(`R1 authentic terminal proof still clears a restored ${bound ? 'bound' : 'unbound'} reservation and permits retry`, async (t) => {
  const h = await fixture(t);
  const call = bound ? await h.bind('free') : { callID: 'authentic' };
  if (!bound) assert.equal((await h.dispatches.admit('root', call.callID, { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause();
  const r = await restart(h);
  assert.equal(r.dispatches.inspect('root').length, 1);
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: call.callID, state: { status: 'completed' } });
  assert.equal(r.dispatches.inspect('root').length, 0);
  assert.deepEqual(r.state.dispatchReservations, []);
  assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root)).ok, true);
});

const pausedRecordMutations = {
  kind: (a) => { a.kind = 'baseline'; },
  nodeId: (a) => { a.nodeId = 'other'; },
  basedOn: (a) => { a.basedOn = []; },
  'provenance alias': (a) => { a.basedOn = a.basedOn.map((ref) => ref.replace(/@1$/, '@01')); },
  version: (a) => { a.version++; },
  'version type alias': (a) => { a.version = String(a.version).padStart(2, '0'); },
  status: (a) => { a.status = 'stale'; },
  payload: (a) => { a.payload.summary = 'replaced'; },
  'deleted payload': (a) => { delete a.payload; },
  'deleted provenance': (a) => { delete a.basedOn; },
  'deleted snapshot': (a) => { delete a.snapshot; },
  snapshot: (a) => { a.snapshot = {}; },
  createdAt: (a) => { a.createdAt = 'different-generation-time'; },
  'extra field': (a) => { a.unexpected = 'replacement'; },
};
for (const [name, mutate] of Object.entries(pausedRecordMutations)) {
  test(`R2 UNVERIFIED full output record rejects changed ${name}`, async (t) => {
    const h = await fixture(t); await h.pause();
    mutate(h.state.artifacts['verification:v']);
    const before = structuredClone(h.state);
    const observedSnapshot = await h.store.hashFiles(['a.txt', 'b.txt']);
    assert.equal(h.runner.prepareRetry(h.state, { reason: 'restored', expectedPauseId: h.state.pendingDecision.pauseId, observedSnapshot, now }).ok, false);
    assert.deepEqual(h.state, before);
    await h.store.saveRun(h.state);
    const r = await restart(h);
    assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root)).ok, false);
  });
}

async function rejectionPause(h, prior = null) {
  if (prior) h.state.artifacts['verification:v'] = structuredClone(prior);
  const call = await h.bind();
  const bad = { verdict: 'PASS', commands: [] };
  assert.equal((await h.submit(call, bad)).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal((await h.submit(call, bad)).code, 'REJECTION_LOOP');
  await h.end(call);
}
const priorOutput = { kind: 'verification', nodeId: 'v', version: 7, status: 'superseded', basedOn: ['change:a@1', 'change:b@1', 'review@1'],
  payload: { verdict: 'FAIL', summary: 'prior attempt', commands: [{ command: 'old test', exitCode: 1 }] }, snapshot: { 'old.txt': 'f'.repeat(64) }, createdAt: now };

for (const present of [false, true]) for (const mutation of ['insert/replace', 'delete', 'null', 'alias']) {
  if (!present && mutation === 'delete') continue;
  test(`R2 rejection output ${present ? 'present' : 'absent'} refuses ${mutation}`, async (t) => {
    const h = await fixture(t); await rejectionPause(h, present ? priorOutput : null);
    if (mutation === 'delete') delete h.state.artifacts['verification:v'];
    else if (mutation === 'null') h.state.artifacts['verification:v'] = null;
    else h.state.artifacts['verification:v'] = { ...structuredClone(priorOutput), version: mutation === 'alias' ? '07' : 77 };
    const before = structuredClone(h.state);
    const observedSnapshot = await h.store.hashFiles(['a.txt', 'b.txt']);
    assert.equal(h.runner.prepareRetry(h.state, { reason: 'restored', expectedPauseId: h.state.pendingDecision.pauseId, observedSnapshot, now }).ok, false);
    assert.deepEqual(h.state, before);
  });
}

for (const mode of ['UNVERIFIED', 'rejection-present', 'rejection-absent']) test(`R2 unchanged ${mode} full record survives disk roundtrip and remains exact in audit`, async (t) => {
  const h = await fixture(t);
  if (mode === 'UNVERIFIED') await h.pause();
  else await rejectionPause(h, mode === 'rejection-present' ? priorOutput : null);
  const present = Object.hasOwn(h.state.artifacts, 'verification:v');
  const original = present ? structuredClone(h.state.artifacts['verification:v']) : null;
  const r = await restart(h);
  const result = JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(r.state.recoveryHistory[0].pause.outputSlot, { name: 'verification:v', present, artifact: original });
  const args = { subagent_type: 'graph-verifier', prompt: '[nodeId:v]\nRetry' };
  assert.equal((await r.dispatches.admit('root', 'replace-output', args)).allowed, true);
  await r.dispatches.onSession({ id: 'replacement-verifier', parentID: 'root' });
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'replace-output',
    state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId: 'replacement-verifier' } } });
  assert.equal(JSON.parse(await r.tools.graph_submit_verification.execute({ nodeId: 'v', verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }] },
    { sessionID: 'replacement-verifier', agent: 'graph-verifier' })).ok, true);
  assert.equal(r.state.artifacts['verification:v'].version, present ? original.version + 1 : 1);
  assert.deepEqual(JSON.parse(await h.disk()).recoveryHistory[0].pause.outputSlot, { name: 'verification:v', present, artifact: original });
});

test('R1 settlement of authenticated sibling never drops the unproven lifetime', async (t) => {
  const h = await fixture(t);
  for (const callID of ['unproven', 'authenticated']) assert.equal((await h.dispatches.admit('root', callID,
    { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause();
  h.state.dispatchCallIds = h.state.dispatchCallIds.filter((key) => key !== JSON.stringify(['root', 'unproven']));
  await h.store.saveRun(h.state);
  const r = await restart(h);
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'authenticated', state: { status: 'completed' } });
  assert.deepEqual(r.state.dispatchReservations, []);
  assert.deepEqual(r.state.dispatchRecoveryIssues.map((entry) => entry.reservation.callID), ['unproven']);
  const second = await restart({ ...h, state: r.state, backing: r.store });
  assert.deepEqual(second.state.dispatchReservations, []);
  assert.deepEqual(second.state.dispatchRecoveryIssues.map((entry) => entry.reservation.callID), ['unproven']);
  assert.equal(JSON.parse(await second.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: second.state.pendingDecision.pauseId }, root)).ok, false);
});

test('R2 legacy pause without a captured full output slot cannot acquire one from the current artifact', async (t) => {
  const h = await fixture(t); await h.pause(); delete h.state.pendingDecision.outputSlot;
  const before = structuredClone(h.state);
  assert.equal((await h.decide()).ok, false); assert.deepEqual(h.state, before);
});

const unrestorableReservations = {
  'missing dispatchId': (r) => { delete r.dispatchId; },
  'null dispatchId': (r) => { r.dispatchId = null; },
  'numeric dispatchId': (r) => { r.dispatchId = 7; },
  'empty dispatchId': (r) => { r.dispatchId = ''; },
  'blank dispatchId': (r) => { r.dispatchId = '  '; },
  'malformed generated dispatchId': (r) => { r.dispatchId = 'not-a-dispatch-generation'; },
  'oversized dispatchId': (r) => { r.dispatchId = 'x'.repeat(257); },
  'missing runId': (r) => { delete r.runId; },
  'foreign runId': (r) => { r.runId = 'other-run'; },
  'null runId': (r) => { r.runId = null; },
  'missing rootSessionId': (r) => { delete r.rootSessionId; },
  'foreign rootSessionId': (r) => { r.rootSessionId = 'other-root'; },
  'null rootSessionId': (r) => { r.rootSessionId = null; },
  'missing callID': (r) => { delete r.callID; },
  'null callID': (r) => { r.callID = null; },
  'numeric callID': (r) => { r.callID = 1; },
  'empty callID': (r) => { r.callID = ''; },
  'missing agent': (r) => { delete r.agent; },
  'null agent': (r) => { r.agent = null; },
  'invalid agent': (r) => { r.agent = 'graph-orchestrator'; },
  'missing nodeId': (r) => { delete r.nodeId; },
  'invalid nodeId': (r) => { r.nodeId = 12; },
  'missing sessionId': (r) => { delete r.sessionId; },
  'invalid sessionId': (r) => { r.sessionId = {}; },
  'empty sessionId': (r) => { r.sessionId = ''; },
  'bound without session': (r) => { r.bound = true; },
  'continuation without session': (r) => { r.continuation = true; },
  'missing bound flag': (r) => { delete r.bound; },
  'invalid bound flag': (r) => { r.bound = 'true'; },
  'missing turnToken': (r) => { delete r.turnToken; },
  'null turnToken': (r) => { r.turnToken = null; },
  'malformed generated turnToken': (r) => { r.turnToken = 'not-a-turn-generation'; },
  'invalid planVersion': (r) => { r.planVersion = -1; },
  'missing planVersion': (r) => { delete r.planVersion; },
};
for (const [name, mutate] of Object.entries(unrestorableReservations)) test(`R3 generic reservation guard retains ${name} across repeated restarts`, async (t) => {
  const h = await fixture(t);
  assert.equal((await h.dispatches.admit('root', 'unknown-work', { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause();
  mutate(h.state.dispatchReservations.find((r) => r.callID === 'unknown-work'));
  const original = structuredClone(h.state.dispatchReservations);
  await h.store.saveRun(h.state);
  let r = await restart(h);
  for (let cycle = 0; cycle < 2; cycle++) {
    assert.deepEqual(r.state.dispatchReservations, [], 'unrestorable records grant no native identity');
    assert.deepEqual(r.state.dispatchRecoveryIssues.map((issue) => issue.reservation), original);
    assert.equal(r.dispatches.inspect('root').length, original.length);
    assert.equal([...r.bindings.values()].some((binding) => !binding.root && binding.active), false);
    const before = structuredClone(r.state); const disk = await h.disk();
    for (const action of ['retry', 'abort', 'reset']) {
      const result = JSON.parse(await r.tools.graph_run_decide.execute({ action, reason: 'user decision',
        ...(action === 'retry' ? { expectedPauseId: r.state.pendingDecision.pauseId } : {}) }, root));
      assert.equal(result.ok, false, action); assert.deepEqual(r.state, before); assert.equal(await h.disk(), disk);
    }
    // Native events cannot fill gaps in the original admission identity.
    await r.dispatches.onSession({ id: 'late-child', parentID: 'root' });
    await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'unknown-work',
      state: { status: 'running', input: { subagent_type: 'graph-explorer' }, metadata: { parentSessionId: 'root', sessionId: 'late-child' } } });
    await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'unknown-work', state: { status: 'completed' } });
    assert.equal(r.dispatches.current(r.bindings.get('late-child')), false);
    assert.deepEqual(r.state.dispatchRecoveryIssues, before.dispatchRecoveryIssues);
    r = await restart({ ...h, state: r.state, backing: r.store });
  }
});

for (const value of [null, 42, 'unknown', [], {}]) test(`R3 non-record outstanding entry ${JSON.stringify(value)} is durable, never dropped`, async (t) => {
  const h = await fixture(t); await h.pause(); h.state.dispatchReservations = [value]; await h.store.saveRun(h.state);
  const r = await restart(h);
  assert.deepEqual(r.state.dispatchRecoveryIssues.map((issue) => issue.reservation), [value]);
  assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root)).ok, false);
});

for (const conflict of ['same call', 'same dispatch different role', 'same dispatch different session', 'same turn token', 'outstanding versus settled']) {
  test(`R3 conflicting identity ${conflict} cannot overwrite or revive a lifetime`, async (t) => {
    const h = await fixture(t);
    for (const callID of ['one', 'two']) assert.equal((await h.dispatches.admit('root', callID, { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
    await h.pause();
    const [a, b] = h.state.dispatchReservations;
    if (conflict === 'same call') b.callID = a.callID;
    if (conflict.startsWith('same dispatch')) {
      b.dispatchId = a.dispatchId;
      if (conflict.endsWith('role')) b.agent = 'graph-planner';
      else b.sessionId = 'other-child';
    }
    if (conflict === 'same turn token') b.turnToken = a.turnToken;
    if (conflict === 'outstanding versus settled') h.state.settledDispatches.push({ ...a, bound: true, sessionId: 'known-completed', terminal: true });
    const original = structuredClone(h.state.dispatchReservations);
    await h.store.saveRun(h.state);
    const r = await restart(h);
    const issues = r.state.dispatchRecoveryIssues;
    assert.ok(issues?.length);
    assert.deepEqual(issues.map((issue) => issue.reservation), original.filter((entry) => conflict !== 'outstanding versus settled' || entry.callID === 'one'));
    assert.equal(r.dispatches.current(r.bindings.get('known-completed')), false);
    assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root)).ok, false);
    const second = await restart({ ...h, state: r.state, backing: r.store });
    assert.deepEqual(second.state.dispatchRecoveryIssues, issues);
  });
}

test('R3 overflow reservations are retained as issues rather than sliced out of the run', async (t) => {
  const h = await fixture(t); await h.pause();
  const prototype = h.state.settledDispatches[0];
  h.state.dispatchReservations = Array.from({ length: 129 }, (_, i) => ({ ...prototype, callID: `overflow-${i}`, dispatchId: randomUUID(),
    turnToken: randomUUID(), nodeId: null, agent: 'graph-explorer', bound: false, sessionId: null, terminal: false, acknowledged: false }));
  h.state.dispatchCallIds.push(...h.state.dispatchReservations.map((r) => JSON.stringify(['root', r.callID])));
  await h.store.saveRun(h.state);
  const r = await restart(h);
  assert.equal(r.state.dispatchReservations.length + r.state.dispatchRecoveryIssues.length, 129);
  assert.ok(r.state.dispatchRecoveryIssues.length > 0);
});

for (const change of ['agent', 'nodeId', 'planVersion']) test(`R3 bound node ${change} inconsistent with its exact generation is quarantined`, async (t) => {
  const h = await fixture(t); const call = await h.bind(); await h.submit(call);
  const record = h.state.dispatchReservations.find((r) => r.callID === call.callID);
  if (change === 'agent') record.agent = 'graph-explorer';
  if (change === 'nodeId') record.nodeId = 'a';
  if (change === 'planVersion') record.planVersion++;
  await h.store.saveRun(h.state);
  const r = await restart(h);
  assert.equal(r.state.dispatchRecoveryIssues?.length, 1);
  assert.equal(r.bindings.has(call.sessionId), false);
});

for (const admission of [null, {}, 'legacy']) test(`R3 malformed admission ledger ${JSON.stringify(admission)} cannot erase outstanding work`, async (t) => {
  const h = await fixture(t);
  assert.equal((await h.dispatches.admit('root', 'unknown-work', { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause(); h.state.dispatchCallIds = admission; await h.store.saveRun(h.state);
  const original = structuredClone(h.state.dispatchReservations);
  const r = await restart(h);
  assert.deepEqual(r.state.dispatchRecoveryIssues.map((issue) => issue.reservation), original);
  assert.equal(JSON.parse(await r.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: r.state.pendingDecision.pauseId }, root)).ok, false);
});

test('R3 failed issue persistence never opens a decision gate through an empty private registry', async (t) => {
  const h = await fixture(t);
  assert.equal((await h.dispatches.admit('root', 'unknown-work', { subagent_type: 'graph-explorer', prompt: 'Explore' })).allowed, true);
  await h.pause(); delete h.state.dispatchReservations[0].dispatchId; await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const disk = await h.disk();
  h.failSave(true);
  await assert.rejects(h.dispatches.recoverPaused(h.state), /EIO/);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  for (const action of ['retry', 'abort', 'reset']) assert.equal((await h.decide({ action, expectedPauseId: action === 'retry' ? h.state.pendingDecision.pauseId : undefined })).ok, false);
  h.failSave(false); await h.dispatches.recoverPaused(h.state);
  assert.equal(h.state.dispatchRecoveryIssues.length, 1);
  assert.equal((await h.decide()).ok, false);
});

test('R3 issues block pure retry and decisions without a private dispatcher', async (t) => {
  const h = await fixture(t); await h.pause();
  h.state.dispatchRecoveryIssues = [{ code: 'INVALID_RESERVATION_IDENTITY', reservation: { callID: 'lost' } }];
  const args = { action: 'retry', reason: 'restored', expectedPauseId: h.state.pendingDecision.pauseId };
  assert.equal(h.runner.prepareRetry(h.state, { ...args, observedSnapshot: await h.store.hashFiles(['a.txt', 'b.txt']), now }).ok, false);
  const tools = createSubmitTools({ store: h.store, runner: h.runner, bindings: h.bindings, worktree: h.dir }).tools;
  for (const action of ['retry', 'abort', 'reset']) assert.equal(JSON.parse(await tools.graph_run_decide.execute({ action, reason: 'user decision',
    ...(action === 'retry' ? { expectedPauseId: args.expectedPauseId } : {}) }, root)).ok, false);
});

for (const container of [null, {}, 'unknown', '', { length: 0 }]) test(`R3 malformed reservation container ${JSON.stringify(container)} never means quiescent`, async (t) => {
  const h = await fixture(t); await h.pause(); h.state.dispatchReservations = container;
  assert.equal(h.runner.prepareRetry(h.state, { reason: 'restored', expectedPauseId: h.state.pendingDecision.pauseId,
    observedSnapshot: await h.store.hashFiles(['a.txt', 'b.txt']), now }).ok, false);
  await h.store.saveRun(h.state);
  const r = await restart(h);
  assert.deepEqual(r.state.dispatchRecoveryIssues.map((issue) => issue.reservation), [container]);
});

test('R3 issue-capacity refusal retains the entire original ledger and disk', async (t) => {
  const h = await fixture(t);
  await h.dispatches.admit('root', 'unknown-work', { subagent_type: 'graph-explorer', prompt: 'Explore' });
  await h.pause(); delete h.state.dispatchReservations[0].dispatchId;
  let low = 0; let high = 1_048_576;
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    try { sanitizeRun({ ...h.state, padding: 'x'.repeat(size) }); low = size; }
    catch { high = size - 1; }
  }
  h.state.padding = 'x'.repeat(low); await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const disk = await h.disk();
  await assert.rejects(h.dispatches.recoverPaused(h.state), /limit/);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  assert.equal((await h.decide()).ok, false);
});

async function recoveryBoot(h, saveRun) {
  await h.backing.releaseRun(h.state.runId);
  const backing = createRunStore({ worktree: h.dir });
  const store = { ...backing, saveRun: (candidate) => saveRun(candidate, backing) };
  const bindings = new Map();
  const enforcement = createEnforcement({ settings: { worktree: h.dir }, store, runner: h.runner, bindings });
  const dispatches = enforcement.dispatches;
  const tools = createSubmitTools({ store, runner: h.runner, bindings, dispatches, worktree: h.dir }).tools;
  return { store, backing, bindings, enforcement, dispatches, tools, boot: () => enforcement.onChatMessage(root) };
}

for (const bound of [false, true]) test(`R4 partition EIO then authentic ${bound ? 'bound' : 'unbound'} completion cannot erase unknown work before root reentry`, async (t) => {
  const h = await fixture(t);
  await h.dispatches.admit('root', 'unknown', { subagent_type: 'graph-explorer', prompt: 'Explore' });
  const authentic = bound ? await h.bind('free') : { callID: 'authentic' };
  if (!bound) await h.dispatches.admit('root', authentic.callID, { subagent_type: 'graph-explorer', prompt: 'Explore' });
  await h.pause();
  if (bound) await h.dispatches.onIdle(authentic.sessionId, 'saved-idle-hint');
  const unknown = h.state.dispatchReservations.find((r) => r.callID === 'unknown');
  delete unknown.dispatchId; await h.store.saveRun(h.state);
  const original = structuredClone(unknown); const disk = await h.disk();
  let offline = true;
  const r = await recoveryBoot(h, async (candidate, backing) => {
    if (offline) { candidate.updatedAt = 'unsaved'; throw new Error('partition EIO'); }
    return backing.saveRun(candidate);
  });
  await assert.rejects(r.boot(), /partition EIO/);
  assert.equal(await h.disk(), disk);
  offline = false;
  const completion = { type: 'tool', tool: 'task', sessionID: 'root', callID: authentic.callID, state: { status: 'completed' } };
  await r.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part: completion } } });
  // This is the original exploit's second write: only an unsafely published
  // private partition could serialize away the durable unknown reservation.
  const afterEvent = JSON.parse(await h.disk());
  assert.ok(afterEvent.dispatchReservations.some((entry) => entry.callID === 'unknown')
    || afterEvent.dispatchRecoveryIssues?.some((issue) => issue.reservation.callID === 'unknown'), 'completion after EIO must preserve unknown work');
  await r.boot();
  await r.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part: completion } } });
  const state = r.store.getRun('root');
  assert.deepEqual(state.dispatchReservations, []);
  assert.deepEqual(state.dispatchRecoveryIssues.map((issue) => issue.reservation), [original]);
  for (const action of ['retry', 'abort', 'reset']) {
    const before = structuredClone(state);
    const result = JSON.parse(await r.tools.graph_run_decide.execute({ action, reason: 'user decision',
      ...(action === 'retry' ? { expectedPauseId: state.pendingDecision.pauseId } : {}) }, root));
    assert.equal(result.code, 'DISPATCH_RECOVERY_UNRESOLVED', action); assert.deepEqual(state, before);
  }
  await r.dispatches.onSession({ id: 'late-unknown', parentID: 'root' });
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'unknown', state: {
    status: 'running', input: { subagent_type: 'graph-explorer' }, metadata: { parentSessionId: 'root', sessionId: 'late-unknown' },
  } });
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'unknown', state: { status: 'completed' } });
  assert.equal(r.dispatches.current(r.bindings.get('late-unknown')), false);
  const second = await restart({ ...h, state, backing: r.backing });
  assert.deepEqual(second.state.dispatchRecoveryIssues.map((issue) => issue.reservation), [original]);
  assert.equal(JSON.parse(await second.tools.graph_run_decide.execute({ action: 'retry', reason: 'restored', expectedPauseId: state.pendingDecision.pauseId }, root)).ok, false);
});

test('R4 failed cold recovery publishes no records, bindings, parents or idle history', async (t) => {
  const h = await fixture(t);
  const child = await h.bind('free'); await h.pause();
  await h.dispatches.onIdle(child.sessionId, 'persisted-child-idle');
  const r = await recoveryBoot(h, async (candidate) => { candidate.updatedAt = 'unsaved'; throw new Error('partition EIO'); });
  const beforeBindings = structuredClone(r.bindings); const beforeDispatches = r.dispatches.inspect('root');
  const disk = await h.disk();
  await assert.rejects(r.boot(), /partition EIO/);
  assert.deepEqual(r.bindings, beforeBindings);
  assert.deepEqual(r.dispatches.inspect('root'), beforeDispatches);
  // A root binding alone must not expose parents staged by the failed boot.
  r.bindings.set('root', { runId: 'root', agent: root.agent, root: true });
  assert.equal(r.dispatches.runForSession(child.sessionId), null);
  await r.dispatches.onIdle(child.sessionId, 'after-failed-boot');
  assert.equal(await h.disk(), disk);
});

test('R4 failed live recovery retains the complete previous private registry and bindings', async (t) => {
  const h = await fixture(t);
  const child = await h.bind('free');
  await h.dispatches.admit('root', 'unknown', { subagent_type: 'graph-explorer', prompt: 'Explore' });
  await h.pause(); await h.dispatches.onIdle(child.sessionId, 'existing-private-idle');
  delete h.state.dispatchReservations.find((r) => r.callID === 'unknown').dispatchId;
  await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const beforeBindings = new Map(h.bindings);
  const beforeDispatches = h.dispatches.inspect('root'); const disk = await h.disk();
  h.failSave(true); await assert.rejects(h.dispatches.recoverPaused(h.state), /EIO/);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  assert.deepEqual(h.dispatches.inspect('root'), beforeDispatches);
  for (const [session, binding] of beforeBindings) assert.equal(h.bindings.get(session), binding);
});

for (const fail of [false, true]) test(`R4 recovery ${fail ? 'EIO' : 'commit'} preserves another run changed during the staged save`, async (t) => {
  const h = await fixture(t); const targetChild = await h.bind('free'); await h.pause();
  let entered; let release;
  const saving = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let hold = true;
  const r = await recoveryBoot(h, async (candidate, backing) => {
    if (candidate.runId === 'root' && hold) { entered(); await gate; if (fail) throw new Error('partition EIO'); }
    return backing.saveRun(candidate);
  });
  t.after(() => release());
  const other = await r.store.createRun({ runId: 'other', rootSessionId: 'other', now });
  r.bindings.set('other', { runId: 'other', agent: root.agent, root: true });
  async function otherChild(callID, sessionId) {
    const args = { subagent_type: 'graph-explorer', prompt: 'Explore' };
    assert.equal((await r.dispatches.admit('other', callID, args)).allowed, true);
    await r.dispatches.onSession({ id: sessionId, parentID: 'other' });
    await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'other', callID,
      state: { status: 'running', input: args, metadata: { parentSessionId: 'other', sessionId } } });
  }
  await otherChild('old-other', 'old-other-child');
  const boot = r.boot(); await saving;
  const earlyBinding = r.bindings.has(targetChild.sessionId);
  const earlyRecords = r.dispatches.inspect('root');
  await r.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'other', callID: 'old-other', state: { status: 'completed' } });
  await otherChild('new-other', 'new-other-child');
  await r.dispatches.onIdle('new-other-child', 'other-idle-during-save');
  const otherBinding = r.bindings.get('new-other-child');
  const otherState = structuredClone(other);
  hold = false; release();
  if (fail) await assert.rejects(boot, /partition EIO/);
  else await boot;
  assert.equal(earlyBinding, false, 'target binding must wait for durable recovery');
  assert.deepEqual(earlyRecords, [], 'target records must wait for durable recovery');
  assert.equal(r.bindings.get('new-other-child'), otherBinding);
  assert.equal(r.dispatches.current(otherBinding), true);
  assert.equal(r.dispatches.runForSession('new-other-child'), 'other');
  assert.deepEqual(r.dispatches.inspect('other').map((entry) => entry.callID), ['new-other']);
  assert.deepEqual(other, otherState);
  // A later write probes that private idle history/evidence also survived.
  await r.dispatches.admit('other', 'flush-other', { subagent_type: 'graph-explorer', prompt: 'Explore' });
  assert.deepEqual(other.pendingIdleEvidence, otherState.pendingIdleEvidence);
  assert.deepEqual(other.idleEventIds, otherState.idleEventIds);
  assert.equal(r.dispatches.owns(r.bindings.get(targetChild.sessionId)), !fail, 'target ownership publishes only after a successful save');
});

test('R4 EIO leaves private idle dedup and receipts unchanged when a later event persists', async (t) => {
  const h = await fixture(t); const child = await h.bind('free'); await h.pause();
  await h.dispatches.onIdle(child.sessionId, 'original-private-receipt');
  const originalIds = [...h.state.idleEventIds];
  const originalReceipts = structuredClone(h.state.pendingIdleEvidence);
  // A recovery input differs from the previously published private history.
  // Its additional hint must not leak out through a later ordinary save.
  h.state.idleEventIds.push('staged-only-id');
  h.state.pendingIdleEvidence.push({ ...structuredClone(originalReceipts[0]), identity: 'staged-only-id' });
  await h.store.saveRun(h.state);
  const before = structuredClone(h.state); const disk = await h.disk();
  h.failSave(true); await assert.rejects(h.dispatches.recoverPaused(h.state), /EIO/);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  h.failSave(false); await h.dispatches.onIdle(child.sessionId, 'new-native-receipt');
  assert.deepEqual(h.state.idleEventIds.slice(0, originalIds.length), originalIds);
  assert.equal(h.state.idleEventIds.includes('staged-only-id'), false);
  assert.equal(h.state.idleEventIds.length, originalIds.length + 1);
  assert.equal(h.state.pendingIdleEvidence.some((entry) => entry.identity === 'staged-only-id'), false);
  assert.deepEqual(h.state.pendingIdleEvidence.slice(0, originalReceipts.length), originalReceipts);
});
