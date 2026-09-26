import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../src/run-state.mjs';
import { createReliableRunStore } from '../src/run-reliability.mjs';
import { createRunner } from '../src/runner.mjs';
import { createEnforcement } from '../src/enforcement.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createSettlementController } from '../src/settlement.mjs';

const specs = [
  { id: 'p', kind: 'plan', agent: 'graph-planner', dependsOn: [] },
  { id: 'r', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['p'] },
  { id: 'i', kind: 'implement', agent: 'graph-implementer', dependsOn: ['r'], writeScope: ['src/**'], acceptance: ['fix'] },
  { id: 'v', kind: 'verify', agent: 'graph-verifier', dependsOn: ['i'] },
];

async function fixture(t) {
  const worktree = await mkdtemp(join(tmpdir(), 'loop-pr1-'));
  let fail = false, now = 0;
  const base = createRunStore({ worktree });
  const store = createReliableRunStore({ ...base, saveRun: async state => {
    if (fail) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    return base.saveRun(state);
  } });
  const bindings = new Map();
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const enforcement = createEnforcement({ store, runner, bindings, settings: { worktree } });
  const { dispatches } = enforcement;
  const { tools } = createSubmitTools({ store, runner, bindings, worktree, dispatches });
  const controller = createSettlementController({ store, exclusive: dispatches.exclusive, reconcile: enforcement.reconcileSettlement,
    clock: () => now, schedule: () => ({ unref() {} }), cancel() {} });
  t.after(async () => { controller.close(); await rm(worktree, { recursive: true, force: true }); });
  await enforcement.onChatMessage({ sessionID: 'root', agent: 'graph-orchestrator' });
  const call = async (name, args, id, agent) => JSON.parse(await tools[name].execute(args, { sessionID: id, agent }));
  const parts = new Map();
  async function dispatch(id, agent, nodeId) {
    const output = { args: { subagent_type: agent, prompt: 'work', description: id, ...(nodeId ? { nodeId } : {}) } };
    await enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID: id }, output);
    await dispatches.onSession({ id, parentID: 'root' });
    const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: id,
      state: { status: 'running', input: output.args, metadata: { sessionId: id, parentSessionId: 'root' } } };
    parts.set(id, part);
    await dispatches.onPart(part);
  }
  const finish = async id => { const part = structuredClone(parts.get(id)); part.state.status = 'completed'; await dispatches.onPart(part); };
  const plan = async () => {
    await dispatch('planner', 'graph-planner');
    assert.equal((await call('graph_submit_plan', { intent: 'change', specs }, 'planner', 'graph-planner')).ok, true);
    await finish('planner');
  };
  const review = async () => {
    await dispatch('reviewer', 'graph-plan-critic', 'r');
    assert.equal((await call('graph_submit_review', { planVersion: 1, verdict: 'PASS', findings: [] }, 'reviewer', 'graph-plan-critic')).ok, true);
    await finish('reviewer');
  };
  const change = async () => {
    await dispatch('implementer', 'graph-implementer', 'i');
    assert.equal((await call('graph_submit_change', { nodeId: 'i', filesTouched: [], summary: 'checked no-op' }, 'implementer', 'graph-implementer')).ok, true);
    await finish('implementer');
  };
  return { worktree, store, bindings, enforcement, dispatches, tools, controller, call, plan, review, change, dispatch, finish,
    fail: value => { fail = value; }, advance: ms => { now += ms; },
    disk: async () => JSON.parse(await readFile(join(worktree, '.opencode-loop/runs/root.json'), 'utf8')) };
}

for (const stage of ['review', 'change', 'verification']) test(`PR1 public ${stage} I/O failure leaves live and disk approvals intact`, async t => {
  const h = await fixture(t);
  await h.plan();
  if (stage !== 'review') await h.review();
  if (stage === 'verification') await h.change();
  const [id, agent, nodeId, tool, args] = stage === 'review'
    ? ['reviewer', 'graph-plan-critic', 'r', 'graph_submit_review', { planVersion: 1, verdict: 'PASS', findings: [] }]
    : stage === 'change' ? ['implementer', 'graph-implementer', 'i', 'graph_submit_change', { nodeId: 'i', filesTouched: [], summary: 'done' }]
      : ['verifier', 'graph-verifier', 'v', 'graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }];
  await h.dispatch(id, agent, nodeId);
  const before = await h.disk();
  const live = h.store.getRun('root');
  h.fail(true);
  await assert.rejects(h.tools[tool].execute(args, { sessionID: id, agent }), { code: 'PERSISTENCE_FAILED' });
  assert.deepEqual(await h.disk(), before);
  assert.deepEqual(live, before);
  assert.equal(h.store.getRun('root'), live);
  h.fail(false);
  await assert.rejects(h.dispatch('new-reader', 'graph-explorer'), /infrastructure/i);
  await h.finish(id);
  assert.equal(h.dispatches.inspect('root').length, 0);
  assert.equal(h.store.fault('root').code, 'PERSISTENCE_FAILED');
});

test('PR1 real public flow retains accepted verifier lifetime until terminal, then settles once', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  const result = await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }, 'verifier', 'graph-verifier');
  assert.equal(result.ok, true);
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  await h.finish('verifier');
  await h.finish('verifier');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  assert.equal((await h.disk()).status, 'SUCCEEDED');
  assert.equal(h.store.getRun('root').nodes.v.attempt, 1);
});

test('PR1 expired run keeps lifetimes and blocks graph_run_new and graph_run_resume', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }, 'verifier', 'graph-verifier');
  h.advance(30000);
  await h.controller.tick('root');
  assert.equal((await h.call('graph_run_new', {}, 'root', 'graph-orchestrator')).code, 'DISPATCH_PENDING');
  assert.equal((await h.call('graph_run_resume', {}, 'root', 'graph-orchestrator')).ok, false);
  await h.finish('verifier');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
});

test('PR1 terminal queued behind reconciliation is consumed without redelivery', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }, 'verifier', 'graph-verifier');
  await Promise.all([h.controller.tick('root'), h.finish('verifier')]);
  assert.equal(h.dispatches.inspect('root').length, 0);
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('PR1 explicit recovery resolves final-publication fault without new execution budget', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }, 'verifier', 'graph-verifier');
  await h.finish('verifier');
  h.fail(true);
  await h.controller.tick('root');
  assert.equal(h.store.fault('root').code, 'PERSISTENCE_FAILED');
  h.fail(false);
  const result = await h.call('graph_run_resume', {}, 'root', 'graph-orchestrator');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.store.fault('root'), null);
  assert.equal(h.store.getRun('root').status, 'FAILED');
  assert.equal(h.store.getRun('root').failReason, 'SETTLEMENT_INTERRUPTED');
});

test('PR1 verified resolution distinguishes a historical tool error from unresolved effects', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review();
  await h.dispatch('implementer', 'graph-implementer', 'i');
  const binding = h.bindings.get('implementer');
  await h.dispatches.exclusive('root', async () => {
    const state = h.store.getRun('root');
    state.sideEffects.push({ nodeId: 'i', sessionId: 'implementer', dispatchId: binding.dispatchId, callID: 'failed-edit', tool: 'edit', target: 'src/missing.js', outcome: 'error', uncertain: true });
    await h.store.saveRun(state);
  });
  assert.equal((await h.call('graph_submit_change', { nodeId: 'i', filesTouched: [], summary: 'failed edit had no effects' }, 'implementer', 'graph-implementer')).ok, true);
  await h.finish('implementer');
  await h.dispatch('verifier', 'graph-verifier', 'v');
  await writeFile(join(h.worktree, 'evidence.log'), 'Verified missing target; no changes occurred.');
  const result = await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS',
    commands: [{ command: 'node --test', exitCode: 0 }], artifacts: ['evidence.log'], probed: ['missing target inspected'],
    resolvedEffects: [{ sessionId: 'implementer', callID: 'failed-edit' }] }, 'verifier', 'graph-verifier');
  assert.equal(result.ok, true);
  await h.finish('verifier');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  assert.equal(h.store.getRun('root').sideEffects[0].uncertain, true, 'historical outcome is not rewritten');
});

test('PR1 real-store restart retains settlement ownership, fails boundedly and accepts late evidence', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }] }, 'verifier', 'graph-verifier');
  h.controller.close();
  const store = createReliableRunStore(createRunStore({ worktree: h.worktree }));
  const bindings = new Map();
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const enforcement = createEnforcement({ store, bindings, runner, settings: { worktree: h.worktree } });
  const controller = createSettlementController({ store, exclusive: enforcement.dispatches.exclusive,
    reconcile: enforcement.reconcileSettlement, schedule: () => ({ unref() {} }), cancel() {} });
  t.after(() => controller.close());
  await enforcement.onChatMessage({ sessionID: 'root', agent: 'graph-orchestrator' });
  await controller.restore('root');
  assert.equal(store.getRun('root').failReason, 'SETTLEMENT_INTERRUPTED');
  assert.equal(enforcement.dispatches.inspect('root').length, 1);
  await enforcement.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'verifier', state: {
    status: 'completed', input: { subagent_type: 'graph-verifier' }, metadata: { sessionId: 'verifier', parentSessionId: 'root' },
  } });
  assert.equal(enforcement.dispatches.inspect('root').length, 0);
  assert.equal(store.getRun('root').status, 'FAILED');
  assert.equal(store.getRun('root').nodes.v.attempt, 1);
});

test('PR1 verifier can resolve its own authenticated tool error with fresh PASS evidence', async t => {
  const h = await fixture(t);
  await h.plan(); await h.review(); await h.change();
  await h.dispatch('verifier', 'graph-verifier', 'v');
  const part = { type: 'tool', tool: 'bash', sessionID: 'verifier', callID: 'check', messageID: 'message-check', id: 'part-check', state: { status: 'running' } };
  await h.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part } } });
  await h.enforcement.onToolBefore({ sessionID: 'verifier', tool: 'bash', callID: 'check' }, { args: { command: 'node --test' } });
  part.state = { status: 'error', error: 'temporary shell launch failure', time: { end: 1 } };
  await h.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part } } });
  assert.equal(h.store.getRun('root').sideEffects.at(-1).outcome, 'error');
  await writeFile(join(h.worktree, 'evidence.log'), 'Fresh verification and probe of failed command outcome.');
  const result = await h.call('graph_submit_verification', { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'node --test', exitCode: 0 }],
    artifacts: ['evidence.log'], probed: ['failed command effects inspected'], resolvedEffects: [{ sessionId: 'verifier', callID: 'check' }] }, 'verifier', 'graph-verifier');
  assert.equal(result.ok, true, JSON.stringify(result));
  await h.finish('verifier');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});
