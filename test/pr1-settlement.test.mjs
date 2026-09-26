import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore } from '../src/run-state.mjs';
import { createReliableRunStore } from '../src/run-reliability.mjs';
import { parseOptions } from '../src/config.mjs';

async function fixture() {
  const { createSettlementController } = await import('../src/settlement.mjs');
  let now = 0, fail = false;
  const base = createRunStore();
  const store = createReliableRunStore({ ...base, saveRun: async state => {
    if (fail) throw Object.assign(new Error('disk'), { code: 'EIO' });
    return base.saveRun(state);
  } });
  await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'start' });
  const controller = createSettlementController({ store, timeoutMs: 30000, clock: () => now,
    schedule: () => ({ unref() {} }), cancel: () => {}, exclusive: (id, fn) => store.transaction(id, fn), reconcile: async () => {} });
  await store.transaction('root', async () => {
    const state = store.getRun('root');
    state.status = 'SETTLING';
    state.nodes.v = { spec: { id: 'v', kind: 'verify' }, state: 'SUCCEEDED' };
    state.dispatchReservations = [{ callID: 'alive', sessionId: 'child' }];
    await store.saveRun(state);
  });
  return { store, controller, advance: ms => { now += ms; }, fail: value => { fail = value; }, async settle() {
    await store.transaction('root', async () => { const s = store.getRun('root'); s.dispatchReservations = []; await store.saveRun(s); });
  } };
}

test('PR1 settlement timeout option has a bounded default and strict validation', () => {
  assert.equal(parseOptions().settlementTimeoutMs, 30000);
  for (const value of [0, -1, 999, 300001, 1000.1, '30000']) assert.throws(() => parseOptions({ settlementTimeoutMs: value }));
  assert.equal(parseOptions({ settlementTimeoutMs: 1000 }).settlementTimeoutMs, 1000);
});

test('PR1 graph acceptance waits for child; terminal evidence completes without a model turn', async () => {
  const h = await fixture();
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  h.advance(400);
  await h.settle();
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  assert.equal(h.store.getRun('root').settlement.elapsedMs, 400);
});

test('PR1 repeated evidence never renews deadline; late terminal cannot upgrade timeout', async () => {
  const h = await fixture();
  for (let i = 0; i < 3; i++) { h.advance(10000); await h.controller.tick('root'); }
  assert.equal(h.store.getRun('root').status, 'FAILED');
  assert.equal(h.store.getRun('root').failReason, 'SETTLEMENT_TIMEOUT');
  assert.equal(h.store.getRun('root').dispatchReservations.length, 1);
  await h.settle();
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
});

test('PR1 final save failure cannot expose success', async () => {
  const h = await fixture();
  await h.settle();
  h.fail(true);
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  assert.equal(h.store.fault('root').code, 'PERSISTENCE_FAILED');
});

test('PR1 restart does one reconciliation and never allocates another settlement budget', async () => {
  const h = await fixture();
  await h.controller.restore('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
  assert.equal(h.store.getRun('root').failReason, 'SETTLEMENT_INTERRUPTED');
  assert.equal(h.store.getRun('root').dispatchReservations.length, 1);
});

test('PR1 pending effects and uncertain outcomes prevent success', async () => {
  const h = await fixture();
  await h.settle();
  await h.store.transaction('root', async () => {
    const state = h.store.getRun('root');
    state.pendingEffects = [{ callID: 'effect' }];
    state.sideEffects = [{ outcome: 'error', uncertain: true }];
    await h.store.saveRun(state);
  });
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  h.advance(30000);
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
});

test('PR1 settlement rechecks accepted file evidence after the last pending effect', async () => {
  const h = await fixture();
  await h.settle();
  await h.store.transaction('root', async () => {
    const state = h.store.getRun('root');
    state.artifacts['verification:v'] = { kind: 'verification', status: 'valid', snapshot: { 'src/a.js': 'expected-before-late-tool' } };
    await h.store.saveRun(state);
  });
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
  assert.equal(h.store.getRun('root').failReason, 'SETTLEMENT_EVIDENCE_CHANGED');
});
