import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createEnforcement } from '../src/enforcement.mjs';

async function fixture() {
  const { createReliableRunStore } = await import('../src/run-reliability.mjs');
  const base = createRunStore();
  let fail = false;
  const store = createReliableRunStore({ ...base, saveRun: async state => {
    if (fail) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    return base.saveRun(state);
  } });
  await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'start' });
  return { store, fail: value => { fail = value; } };
}

test('PR1 candidate is invisible until durable publication; stable live identity survives', async () => {
  const { store } = await fixture();
  const live = store.getRun('root');
  await store.transaction('root', async () => {
    const candidate = store.getRun('root');
    assert.notEqual(candidate, live);
    candidate.mode = 'change';
    assert.equal(live.mode, 'unknown');
    await store.saveRun(candidate);
    assert.equal(live.mode, 'change');
    candidate.mode = 'uncommitted';
  });
  assert.equal(store.getRun('root'), live);
  assert.equal(live.mode, 'change');
});

test('PR1 permanent failure leaves committed authority intact and latches admission', async () => {
  const h = await fixture();
  const live = h.store.getRun('root');
  h.fail(true);
  await assert.rejects(h.store.transaction('root', async () => {
    const state = h.store.getRun('root');
    state.mode = 'not-committed';
    await h.store.saveRun(state);
  }), { code: 'PERSISTENCE_FAILED' });
  assert.equal(live.mode, 'unknown');
  assert.equal(h.store.fault('root').causeCode, 'EIO');
  assert.throws(() => h.store.assertHealthy('root'), { code: 'PERSISTENCE_FAILED' });
  h.fail(false);
  await h.store.transaction('root', () => h.store.saveRun(h.store.getRun('root')));
  assert.throws(() => h.store.assertHealthy('root'), { code: 'PERSISTENCE_FAILED' });
});

test('PR1 explicit fault recovery refuses surviving lifetimes and persists before clearing', async () => {
  const h = await fixture();
  h.fail(true);
  await assert.rejects(h.store.saveRun(h.store.getRun('root')));
  await assert.rejects(h.store.recover('root'), { code: 'PERSISTENCE_FAILED' });
  h.fail(false);
  await h.store.transaction('root', async () => {
    const state = h.store.getRun('root');
    state.dispatchReservations = [{ callID: 'alive' }];
    await h.store.saveRun(state);
  });
  await assert.rejects(h.store.recover('root'), { code: 'DISPATCH_PENDING' });
  await h.store.transaction('root', async () => {
    const state = h.store.getRun('root');
    state.dispatchReservations = [];
    await h.store.saveRun(state);
  });
  await h.store.recover('root');
  assert.equal(h.store.fault('root'), null);
});

test('PR1 production queue isolates a failed binding and blocks subsequent dispatch', async () => {
  const h = await fixture();
  const bindings = new Map([['root', { root: true, agent: 'graph-orchestrator', runId: 'root' }]]);
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const dispatches = createDispatchBindings({ store: h.store, runner, bindings });
  await dispatches.exclusive('root', async () => {
    const state = h.store.getRun('root');
    state.nodes.impl = { spec: { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: [], writeScope: ['src/**'] }, state: 'PENDING', attempt: 0 };
    await h.store.saveRun(state);
  });
  assert.equal((await dispatches.admit('root', 'call', { subagent_type: 'graph-implementer' }, 'impl')).allowed, true);
  await dispatches.onSession({ id: 'child', parentID: 'root' });
  h.fail(true);
  await dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'call', state: {
    status: 'running', input: { subagent_type: 'graph-implementer' }, metadata: { parentSessionId: 'root', sessionId: 'child' },
  } });
  assert.equal(h.store.getRun('root').nodes.impl.attempt, 0);
  assert.equal(bindings.has('child'), false);
  h.fail(false);
  assert.equal((await dispatches.admit('root', 'new', { subagent_type: 'graph-explorer' })).code, 'PERSISTENCE_FAILED');
});

test('PR1 planner I/O failure is infrastructure, never payload correction; hooks fence writes', async () => {
  const h = await fixture();
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const bindings = new Map([['root', { root: true, agent: 'graph-orchestrator', runId: 'root' }]]);
  const enforcement = createEnforcement({ store: h.store, runner, bindings, settings: {} });
  const dispatches = enforcement.dispatches;
  await dispatches.admit('root', 'plan-call', { subagent_type: 'graph-planner' });
  await dispatches.onSession({ id: 'planner', parentID: 'root' });
  await dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'plan-call', state: {
    status: 'running', input: { subagent_type: 'graph-planner' }, metadata: { parentSessionId: 'root', sessionId: 'planner' },
  } });
  const { tools } = createSubmitTools({ store: h.store, runner, bindings, dispatches });
  h.fail(true);
  const result = JSON.parse(await tools.graph_submit_plan.execute({ intent: 'plan-only', specs: [
    { id: 'p', kind: 'plan', agent: 'graph-planner', dependsOn: [] },
    { id: 'r', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['p'] },
  ] }, { sessionID: 'planner', agent: 'graph-planner' }));
  assert.equal(result.code, 'PERSISTENCE_FAILED');
  assert.equal(h.store.getRun('root').artifacts.plan, undefined);
  await assert.rejects(enforcement.onToolBefore({ sessionID: 'root', tool: 'bash', callID: 'write' }, { args: { command: 'echo bad' } }), /infrastructure|persistence/i);
});
