import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectBoundary } from '../src/effect-boundary.mjs';

function harness(overrides = {}) {
  const calls = [];
  const callbacks = {
    preflight: async () => ({ decision: 'ALLOW' }),
    ask: async () => undefined,
    capturePermission: async () => ({ durable: true, evidenceId: 'permission-1' }),
    prepare: async () => ({ decision: 'ALLOW', authorizationId: 'auth-1' }),
    verify: async ({ operation }) => ({ decision: 'ALLOW', operationId: operation.id, payload: { text: 'verified' } }),
    effect: async () => ({ bytes: 8 }),
    commit: async () => ({ committed: true }),
    recover: async () => ({ recoveryRequired: true }),
    ...overrides,
  };
  return { calls, boundary: createEffectBoundary(Object.fromEntries(Object.entries(callbacks).map(([name, fn]) => [name, async (...args) => {
    calls.push(name);
    return fn(...args);
  }]))) };
}
const ordered = ['preflight', 'ask', 'capturePermission', 'prepare', 'verify', 'effect', 'commit'];

test('awaits every boundary and writes only the verified frozen payload, then commits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'output.txt');
  const operation = { id: 'write-1', payload: { text: 'caller' } };
  const { calls, boundary } = harness({
    ask: async ({ operation: snapshot }) => {
      await Promise.resolve();
      operation.payload.text = 'changed during Ask';
      assert.equal(snapshot.payload.text, 'caller');
      assert.ok(Object.isFrozen(snapshot.payload));
    },
    effect: async (payload) => {
      assert.ok(Object.isFrozen(payload));
      await writeFile(file, payload.text);
      return { bytes: 8 };
    },
    commit: async ({ result }) => {
      assert.equal(await readFile(file, 'utf8'), 'verified');
      assert.deepEqual(result, { bytes: 8 });
      return { committed: true };
    },
  });
  assert.deepEqual(await boundary.execute(operation), { status: 'COMMITTED', operationId: 'write-1', result: { bytes: 8 } });
  assert.deepEqual(calls, ordered);
});

for (const stage of ordered.slice(0, 5)) {
  test(`${stage} rejection prevents later stages and the effect`, async () => {
    const failure = new Error(`${stage} failed`);
    const { calls, boundary } = harness({ [stage]: async () => { await Promise.resolve(); throw failure; } });
    await assert.rejects(boundary.execute({ id: stage }), (error) => error === failure);
    assert.deepEqual(calls, ordered.slice(0, ordered.indexOf(stage) + 1));
  });
}

for (const [stage, value] of [
  ['preflight', { decision: 'DENY' }], ['preflight', undefined],
  ['capturePermission', { durable: false, evidenceId: 'x' }], ['capturePermission', { durable: true }],
  ['prepare', { decision: 'DENY' }], ['prepare', { decision: 'ALLOW' }],
  ['verify', { decision: 'ALLOW', operationId: 'other', payload: {} }],
  ['verify', { decision: 'ALLOW', operationId: 'op' }],
]) {
  test(`${stage} fails closed on ${JSON.stringify(value)}`, async () => {
    const { calls, boundary } = harness({ [stage]: async () => value });
    await assert.rejects(boundary.execute({ id: 'op' }));
    assert.deepEqual(calls, ordered.slice(0, ordered.indexOf(stage) + 1));
  });
}

for (const stage of ['effect', 'commit']) {
  test(`${stage} uncertainty marks recovery and never repeats a real file effect`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'loop-recovery-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'once.txt');
    const failure = new Error(`${stage} interrupted`);
    const { calls, boundary } = harness({
      effect: async () => { await writeFile(file, 'one', { flag: 'wx' }); if (stage === 'effect') throw failure; return { ok: true }; },
      commit: async () => { throw failure; },
      recover: async ({ error, stage: failedStage }) => {
        assert.equal(error, failure);
        assert.equal(failedStage, stage);
        assert.equal(await readFile(file, 'utf8'), 'one');
        return { recoveryRequired: true };
      },
    });
    const first = boundary.execute({ id: 'once' });
    await assert.rejects(first, (error) => error.code === 'RECOVERY_REQUIRED' && error.cause === failure);
    assert.equal(boundary.execute({ id: 'once' }), first);
    await assert.rejects(first);
    assert.deepEqual(calls, [...ordered.slice(0, ordered.indexOf(stage) + 1), 'recover']);
  });
}

test('recovery failure preserves both errors and cannot become success', async () => {
  const effectError = new Error('effect');
  const recoveryError = new Error('recovery');
  const { boundary } = harness({ effect: async () => { throw effectError; }, recover: async () => { throw recoveryError; } });
  await assert.rejects(boundary.execute({ id: 'recover' }), (error) => error.code === 'RECOVERY_REQUIRED' && error.cause === effectError && error.recoveryError === recoveryError);
});

test('pending duplicate joins the exact promise; changed invocation is rejected; completed replay does not execute', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const { calls, boundary } = harness({ ask: async () => wait });
  const first = boundary.execute({ id: 'duplicate', a: 1, b: 2 });
  assert.equal(boundary.execute({ b: 2, a: 1, id: 'duplicate' }), first);
  await assert.rejects(boundary.execute({ id: 'duplicate', a: 2, b: 2 }), /different invocation/);
  release();
  await first;
  assert.equal(boundary.execute({ id: 'duplicate', a: 1, b: 2 }), first);
  assert.deepEqual(calls, ordered);
});

test('rejects non-JSON, executable properties, prototypes, oversized and deep payloads before callbacks', async () => {
  let getterCalls = 0;
  const getter = { id: 'getter', get payload() { getterCalls++; return {}; } };
  const cycle = { id: 'cycle' }; cycle.self = cycle;
  let deep = {}; for (let i = 0; i < 80; i++) deep = { deep };
  const invalid = [null, [], {}, { id: '' }, { id: 'space id' }, { id: 'x', x: undefined }, { id: 'x', x: Infinity },
    { id: 'x', x: 1n }, { id: 'x', x() {} }, { id: 'x', x: new Date() }, { id: 'x', x: [,] }, getter, cycle,
    Object.assign(Object.create({ inherited: true }), { id: 'x' }), { id: 'x', [Symbol('x')]: true },
    { id: 'x', deep }, { id: 'x', text: 'x'.repeat(1_048_577) }, { id: 'x', items: Array(10001).fill(null) }];
  const { calls, boundary } = harness();
  for (const operation of invalid) await assert.rejects(boundary.execute(operation));
  assert.deepEqual(calls, []);
  assert.equal(getterCalls, 0);
});

test('malformed commit and recovery results remain uncertain', async () => {
  const { boundary } = harness({ commit: async () => undefined, recover: async () => undefined });
  await assert.rejects(boundary.execute({ id: 'bad-result' }), (error) => error.code === 'RECOVERY_REQUIRED' && error.recoveryError instanceof Error);
});

test('each unresolved stage blocks its successor, including recovery', async () => {
  const stages = [...ordered, 'recover'];
  const gates = Object.fromEntries(stages.map((stage) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return [stage, { promise, release }];
  }));
  const values = {
    preflight: { decision: 'ALLOW' }, capturePermission: { durable: true, evidenceId: 'event' },
    prepare: { decision: 'ALLOW', authorizationId: 'auth' },
    verify: { decision: 'ALLOW', operationId: 'barriers', payload: { bound: true } },
    effect: null, commit: { committed: false }, recover: { recoveryRequired: true },
  };
  const { boundary, calls } = harness(Object.fromEntries(stages.map((stage) => [stage, async () => {
    await gates[stage].promise;
    return values[stage];
  }])));
  let settled = false;
  const rejected = assert.rejects(boundary.execute({ id: 'barriers' }), { code: 'RECOVERY_REQUIRED' }).then(() => { settled = true; });
  for (let i = 0; i < stages.length; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, stages.slice(0, i + 1));
    assert.equal(settled, false);
    gates[stages[i]].release();
  }
  await rejected;
});

test('rejects proxies without executing reflection traps', async () => {
  let traps = 0;
  const operation = new Proxy({ id: 'proxy' }, { getPrototypeOf() { traps++; return Object.prototype; } });
  const { boundary, calls } = harness();
  await assert.rejects(boundary.execute(operation));
  assert.equal(traps, 0);
  assert.deepEqual(calls, []);
});
