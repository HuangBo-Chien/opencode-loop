import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { createRunStore } from '../src/run-state.mjs';
import { writeRunSnapshot } from '../src/run-state-write.mjs';
import { createRunner } from '../src/runner.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';

const deferred = () => Promise.withResolvers();
const fault = (code) => Object.assign(new Error(`injected ${code}`), { code });

function patch(t, name, replacement) {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
}

async function fixture(t, options = {}) {
  const worktree = await fs.mkdtemp(join(tmpdir(), 'loop-persistence-'));
  t.after(() => fs.rm(worktree, { recursive: true, force: true }));
  const events = [];
  const store = createRunStore({ worktree, onPersistenceEvent: event => events.push(event), ...options });
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'initial' });
  const directory = join(worktree, '.opencode-loop', 'runs');
  const target = join(directory, 'root.json');
  const disk = async () => JSON.parse(await fs.readFile(target, 'utf8'));
  return { worktree, directory, target, disk, store, state, events };
}

test('transient Windows EPERM retries the same snapshot and temp without exposing failure', { skip: process.platform !== 'win32' }, async t => {
  const h = await fixture(t);
  const sources = [];
  const observed = [];
  patch(t, 'rename', original => async (from, to) => {
    sources.push(from);
    observed.push(JSON.parse(await fs.readFile(from, 'utf8')).mode);
    assert.equal((await h.disk()).mode, 'unknown');
    if (sources.length <= 2) throw fault('EPERM');
    return original(from, to);
  });
  h.state.mode = 'new';
    const saving = h.store.saveRun(h.state);
  h.state.mode = 'later-unsaved-mutation';
  await saving;
  assert.equal(sources.length, 3);
  assert.equal(new Set(sources).size, 1);
  assert.deepEqual(observed, ['new', 'new', 'new']);
  assert.equal((await h.disk()).mode, 'new');
  assert.equal(h.events.filter(e => e.phase === 'retry').length, 2);
  assert.equal(h.events.at(-1).phase, 'committed');
  assert.deepEqual((await fs.readdir(h.directory)).sort(), ['root.json', 'root.json.lock']);
});

for (const code of ['EIO', 'ENOSPC', 'EACCES', ...(process.platform === 'win32' ? ['EPERM'] : [])]) {
  test(`rename ${code} preserves last commit, reports cause and removes owned temp`, async t => {
    const h = await fixture(t);
    const error = fault(code);
    let attempts = 0;
    patch(t, 'rename', () => async () => { attempts++; throw error; });
    h.state.mode = 'not-committed';
    await assert.rejects(h.store.saveRun(h.state), e => e === error);
    assert.equal((await h.disk()).mode, 'unknown');
    if (code === 'EPERM') assert.ok(attempts >= 1 && attempts <= 8);
    else assert.equal(attempts, 1);
    assert.equal(h.events.at(-1).phase, 'failed');
    assert.equal(h.events.at(-1).code, code);
    assert.deepEqual((await fs.readdir(h.directory)).sort(), ['root.json', 'root.json.lock']);
  });
}

test('failed initial commit removes registration, temp and its lock; creation can retry', async t => {
  const h = await fixture(t);
  const error = fault('EIO');
  let failing = true;
  patch(t, 'rename', original => async (...args) => {
    if (failing) throw error;
    return original(...args);
  });
  await assert.rejects(h.store.createRun({ runId: 'new', rootSessionId: 'new', now: 'initial' }), e => e === error);
  assert.equal(h.store.getRun('new'), null);
  assert.deepEqual((await fs.readdir(h.directory)).sort(), ['root.json', 'root.json.lock']);
  failing = false;
  assert.equal((await h.store.createRun({ runId: 'new', rootSessionId: 'new', now: 'retry' })).runId, 'new');
});

test('same-run saves are FIFO frozen snapshots while another run can commit', async t => {
  const h = await fixture(t);
  const other = await h.store.createRun({ runId: 'other', rootSessionId: 'other', now: 'initial' });
  const entered = deferred(), gate = deferred();
  const writes = [];
  patch(t, 'rename', original => async (from, to) => {
    if (to === h.target) {
      const mode = JSON.parse(await fs.readFile(from, 'utf8')).mode;
      writes.push(mode);
      if (mode === 'first') { entered.resolve(); await gate.promise; }
    }
    return original(from, to);
  });
  h.state.mode = 'first';
  const first = h.store.saveRun(h.state);
  await entered.promise;
  h.state.mode = 'second';
  const second = h.store.saveRun(h.state);
  h.state.mode = 'not-saved';
  try {
    other.mode = 'independent';
    await h.store.saveRun(other);
    assert.deepEqual(writes, ['first']);
    assert.equal(JSON.parse(await fs.readFile(join(h.directory, 'other.json'), 'utf8')).mode, 'independent');
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
  }
  assert.deepEqual(writes, ['first', 'second']);
  assert.equal((await h.disk()).mode, 'second');
});

test('release closes admission and waits for accepted saves before unlocking', async t => {
  const h = await fixture(t);
  const entered = deferred(), gate = deferred();
  patch(t, 'rename', original => async (...args) => { entered.resolve(); await gate.promise; return original(...args); });
  h.state.mode = 'last';
  const saving = h.store.saveRun(h.state);
  await entered.promise;
  let released = false;
  let unlockStarted = false;
  patch(t, 'rm', original => async (path, ...args) => {
    if (path === `${h.target}.lock`) unlockStarted = true;
    return original(path, ...args);
  });
  const releasing = h.store.releaseRun('root').then(() => { released = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false);
    assert.equal(unlockStarted, false);
    await fs.stat(`${h.target}.lock`);
    await assert.rejects(h.store.saveRun(h.state), /releas|registered/i);
  } finally {
    gate.resolve();
    await Promise.all([saving, releasing]);
  }
  assert.equal((await h.disk()).mode, 'last');
  assert.equal(h.store.getRun('root'), null);
  await assert.rejects(fs.stat(`${h.target}.lock`), { code: 'ENOENT' });
});

test('a rejected write does not poison the next save', async t => {
  const h = await fixture(t);
  let failing = true;
  patch(t, 'rename', original => async (...args) => {
    if (failing) { failing = false; throw fault('EIO'); }
    return original(...args);
  });
  await assert.rejects(h.store.saveRun(h.state), { code: 'EIO' });
  h.state.mode = 'recovered';
  await h.store.saveRun(h.state);
  assert.equal((await h.disk()).mode, 'recovered');
});

test('duplicate create cannot erase the original registered state', async t => {
  const h = await fixture(t);
  await assert.rejects(h.store.createRun({ runId: 'root', rootSessionId: 'root', now: 'duplicate' }));
  assert.equal(h.store.getRun('root'), h.state);
  await h.store.saveRun(h.state);
});

test('cleanup failure cannot mask the primary rename error', async t => {
  const h = await fixture(t);
  const error = fault('EIO');
  patch(t, 'rename', () => async () => { throw error; });
  patch(t, 'rm', original => async (path, ...args) => {
    if (String(path).includes('.tmp-')) throw fault('EACCES');
    return original(path, ...args);
  });
  await assert.rejects(h.store.saveRun(h.state), e => e === error);
  assert.ok(h.events.some(e => e.phase === 'cleanup-failed' && e.code === 'EACCES'));
  assert.equal((await h.disk()).mode, 'unknown');
});

test('non-Windows EPERM is not retried', async t => {
  const h = await fixture(t);
  let attempts = 0;
  patch(t, 'rename', () => async () => { attempts++; throw fault('EPERM'); });
  await assert.rejects(writeRunSnapshot(h.target, '{}', { platform: 'linux' }), { code: 'EPERM' });
  assert.equal(attempts, 1);
  assert.equal((await h.disk()).runId, 'root');
});

test('elapsed retry deadline stops after a delayed wakeup instead of committing late', async t => {
  const h = await fixture(t);
  let now = 0, attempts = 0;
  const waits = [];
  patch(t, 'rename', () => async () => { attempts++; throw fault('EPERM'); });
  await assert.rejects(writeRunSnapshot(h.target, '{}', {
    platform: 'win32', clock: () => now, random: () => 0,
    delay: async ms => { waits.push(ms); now += 2000; },
  }), { code: 'EPERM' });
  assert.deepEqual(waits, [10]);
  assert.equal(attempts, 1);
  assert.equal((await h.disk()).runId, 'root');
});

test('Windows retry policy caps attempts even when the monotonic deadline has not expired', async t => {
  const h = await fixture(t);
  let attempts = 0, now = 0;
  const waits = [];
  patch(t, 'rename', () => async () => { attempts++; throw fault('EPERM'); });
  await assert.rejects(writeRunSnapshot(h.target, '{}', {
    platform: 'win32', clock: () => now, random: () => 0,
    delay: async ms => { waits.push(ms); now += ms; },
  }), { code: 'EPERM' });
  assert.equal(attempts, 8);
  assert.deepEqual(waits, [10, 20, 40, 80, 160, 250, 250]);
});

test('partial temp write failure cleans up without retrying write or rename', async t => {
  const h = await fixture(t);
  let writes = 0, renames = 0;
  patch(t, 'writeFile', original => async (path, data, options) => {
    writes++;
    await original(path, data.slice(0, 10), options);
    throw fault('EPERM');
  });
  patch(t, 'rename', () => async () => { renames++; });
  await assert.rejects(h.store.saveRun(h.state), { code: 'EPERM' });
  assert.equal(writes, 1);
  assert.equal(renames, 0);
  assert.deepEqual((await fs.readdir(h.directory)).sort(), ['root.json', 'root.json.lock']);
});

for (const emit of [() => { throw new Error('logger unavailable'); }, async () => { throw new Error('logger unavailable'); }]) {
  test('diagnostic callback failure does not change successful commits', async t => {
    const h = await fixture(t, { onPersistenceEvent: emit });
    h.state.mode = 'saved';
    await h.store.saveRun(h.state);
    assert.equal((await h.disk()).mode, 'saved');
  });
}

test('failed lock removal keeps registration available for release retry', async t => {
  const h = await fixture(t);
  let blocked = true;
  patch(t, 'rm', original => async (path, ...args) => {
    if (path === `${h.target}.lock` && blocked) throw fault('EACCES');
    return original(path, ...args);
  });
  await assert.rejects(h.store.releaseRun('root'), { code: 'EACCES' });
  assert.equal(h.store.getRun('root'), h.state);
  blocked = false;
  await h.store.releaseRun('root');
  assert.equal(h.store.getRun('root'), null);
});

test('release racing failed foreign-lock creation must not remove that foreign lock', async t => {
  const h = await fixture(t);
  const other = createRunStore({ worktree: h.worktree });
  const creating = other.createRun({ runId: 'root', rootSessionId: 'root', now: 'other' });
  const rejected = assert.rejects(creating, /locked/);
  await other.releaseRun('root');
  await rejected;
  await fs.stat(`${h.target}.lock`);
});

test('host logger records recovery and failure summaries, not every normal save or retry', async () => {
  const { createPersistenceLogger } = await import('../src/run-state-write.mjs');
  const calls = [];
  const log = createPersistenceLogger({ app: { log: async input => { calls.push(input); } } });
  await log({ phase: 'committed', attempts: 1 });
  await log({ phase: 'retry', attempts: 1 });
  await log({ phase: 'committed', attempts: 3, runId: 'root', operationId: 'write-1' });
  await log({ phase: 'failed', attempts: 8, code: 'EPERM' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.body.level), ['warn', 'error']);
  assert.equal(calls[0].body.service, 'opencode-loop.persistence');
  assert.equal(calls[0].body.extra.operationId, 'write-1');
  assert.ok(calls.every(c => c.signal instanceof AbortSignal));
});

for (const stage of ['before', 'after']) {
  test(`process interruption ${stage} replacement reloads the last complete commit`, { timeout: 10000 }, async t => {
    const h = await fixture(t);
    const child = fork(new URL('./fixtures/run-state-interrupt.mjs', import.meta.url), [h.worktree, stage], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const ended = new Promise(resolve => child.once('exit', resolve));
    try {
      await Promise.race([
        new Promise((resolve, reject) => {
          child.once('message', resolve);
          child.once('error', reject);
        }),
        ended.then(() => { throw new Error('Child exited before reaching interruption point'); }),
      ]);
    } finally {
      child.kill();
      await ended;
    }
    const fresh = createRunStore({ worktree: h.worktree });
    assert.deepEqual(await fresh.listRunIds(), ['root']);
    const recovered = await fresh.loadRun('root');
    assert.equal(recovered.mode, stage === 'after' ? 'interrupted-save' : 'unknown');
    recovered.mode = 'resumed';
    await fresh.saveRun(recovered);
    assert.equal((await h.disk()).mode, 'resumed');
  });
}

for (const persistent of [false, true]) {
  test(`disk-backed binding handles ${persistent ? 'exhausted' : 'transient'} EPERM without a duplicate attempt`, { skip: process.platform !== 'win32' }, async t => {
    const h = await fixture(t);
    h.state.nodes.impl = { spec: { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: [], writeScope: ['work/**'] }, state: 'PENDING', attempt: 0 };
    const bindings = new Map([['root', { root: true, runId: 'root' }]]);
    const dispatches = createDispatchBindings({ store: h.store, runner: createRunner({ maxAttempts: 3, maxPlanRevisions: 3 }), bindings });
    assert.equal((await dispatches.admit('root', 'call', { subagent_type: 'graph-implementer' }, 'impl')).allowed, true);
    await dispatches.onSession({ id: 'child', parentID: 'root' });
    let failures = 0, offline = true;
    patch(t, 'rename', original => async (from, to) => {
      if (JSON.parse(await fs.readFile(from, 'utf8')).nodes.impl.state === 'RUNNING' && offline && (persistent || failures < 2)) {
        failures++;
        throw fault('EPERM');
      }
      return original(from, to);
    });
    const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: 'call', state: {
      status: 'running', input: { subagent_type: 'graph-implementer' }, metadata: { parentSessionId: 'root', sessionId: 'child' },
    } };
    await dispatches.onPart(part);
    assert.equal(h.state.nodes.impl.attempt, 1);
    if (persistent) {
      assert.equal(bindings.has('child'), false);
      assert.equal(dispatches.inspect('root')[0].bound, false);
      const disk = await h.disk();
      assert.equal(disk.nodes.impl.attempt, 0);
      assert.equal(disk.dispatchReservations.length, 1);
      offline = false;
      await dispatches.onPart(part);
    }
    assert.equal(dispatches.inspect('root')[0].bound, true);
    assert.equal(bindings.get('child').nodeId, 'impl');
    assert.equal((await h.disk()).nodes.impl.attempt, 1);
    await dispatches.onPart(part);
    assert.equal(h.state.nodes.impl.attempt, 1);
    assert.equal((await h.disk()).dispatchReservations.length, 1);
    assert.equal((await createRunStore({ worktree: h.worktree }).loadRun('root')).nodes.impl.attempt, 1);
  });
}
