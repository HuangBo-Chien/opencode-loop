// No-model diagnostic, run explicitly (not part of the default unit suite).
// node test/fixtures/run-state-stress.mjs --poll-ms 20 --iterations 100
// bun  test/fixtures/run-state-stress.mjs --poll-ms 20 --lock-ms 350
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { createRunStore } from '../../src/run-state.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const number = (name, fallback, min, max) => {
  const value = Number(option(name, fallback));
  assert.ok(Number.isInteger(value) && value >= min && value <= max, `Invalid ${name}`);
  return value;
};
const ids = ['root-a', 'root-b', 'root-c'];

async function reader() {
  const directory = option('--reader');
  const interval = number('--poll-ms', 20, 1, 1000);
  const last = Object.fromEntries(ids.map(id => [id, 0]));
  let samples = 0, busy = null;
  const errors = [];
  const sample = async () => {
    for (const id of ids) {
      try {
        const state = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
        assert.equal(state.runId, id);
        assert.ok(Number.isInteger(state.stressSequence) && state.stressSequence >= last[id], 'snapshot moved backwards');
        last[id] = state.stressSequence;
        samples++;
      } catch (error) { if (errors.length < 20) errors.push({ id, message: error.message }); }
    }
  };
  await sample();
  const timer = setInterval(() => {
    if (!busy) busy = sample().finally(() => { busy = null; });
  }, interval);
  process.on('disconnect', () => { clearInterval(timer); });
  process.on('message', async message => {
    if (message !== 'stop') return;
    clearInterval(timer);
    await busy;
    await sample();
    process.send({ type: 'result', samples, last, errors }, () => process.disconnect());
  });
  process.send({ type: 'ready' });
}

function completion(child) {
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Child exited ${code ?? signal}`)));
  });
  // Callers still await the original promise; cleanup can race process exit.
  void done.catch(() => {});
  return done;
}

async function main() {
  const pollMs = number('--poll-ms', 20, 0, 1000);
  const iterations = number('--iterations', 100, 1, 10000);
  const lockMs = number('--lock-ms', 0, 0, 10000);
  const expectFailure = args.includes('--expect-failure');
  const worktree = await mkdtemp(join(tmpdir(), 'loop-state-stress-'));
  const events = [], latencies = [], children = [];
  const store = createRunStore({ worktree, onPersistenceEvent: event => events.push(event) });
  const directory = join(worktree, '.opencode-loop', 'runs');
  let readerResult = null, lockResult = null;
  try {
    const states = [];
    for (const id of ids) {
      const state = await store.createRun({ runId: id, rootSessionId: id, now: 'stress' });
      state.stressSequence = 0;
      state.diagnosticPadding = 'x'.repeat(16000);
      await store.saveRun(state);
      states.push(state);
    }

    if (lockMs) {
      assert.equal(process.platform, 'win32', 'Native sharing test requires Windows');
      const target = join(directory, `${ids[0]}.json`);
      const holder = spawn('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./run-state-lock-holder.ps1', import.meta.url)), '-Path', target, '-Milliseconds', String(lockMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
      const done = completion(holder);
      children.push({ child: holder, done });
      await Promise.race([
        new Promise(resolve => holder.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); })),
        done.then(() => { throw new Error('Holder exited before readiness'); }),
      ]);
      // Control: the old single-rename strategy fails on this same real handle.
      const control = `${target}.control`;
      await writeFile(control, await readFile(target));
      let controlCode;
      try { await rename(control, target); }
      catch (error) { controlCode = error.code; }
      finally { await rm(control, { force: true }); }
      assert.equal(controlCode, 'EPERM', 'Native holder must reproduce a real rename EPERM');
      const snapshot = { ...states[0], mode: 'native-lock-recovered' };
      const start = performance.now();
      let failureCode = null;
      try { await store.saveRun(snapshot); }
      catch (error) { failureCode = error.code; }
      const elapsedMs = performance.now() - start;
      assert.equal(failureCode, expectFailure ? 'EPERM' : null);
      const saved = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(saved.mode, expectFailure ? 'unknown' : 'native-lock-recovered');
      assert.ok(events.some(event => event.phase === 'retry'));
      lockResult = { holderPid: holder.pid, lockMs, controlCode, failureCode, elapsedMs, snapshotPreserved: true };
      await done;
    }

    let observer, observerDone, report;
    if (pollMs) {
      observer = fork(fileURLToPath(import.meta.url), ['--reader', directory, '--poll-ms', String(pollMs)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observerDone = completion(observer);
      children.push({ child: observer, done: observerDone });
      report = new Promise(resolve => observer.on('message', message => { if (message.type === 'result') resolve(message); }));
      await Promise.race([
        new Promise(resolve => observer.on('message', message => { if (message.type === 'ready') resolve(); })),
        observerDone.then(() => { throw new Error('Reader exited before readiness'); }),
      ]);
    }

    const counters = ids.map(() => 0);
    // Four independent producers per run; FIFO store writes, parallel runs.
    const producers = states.flatMap((state, index) => Array.from({ length: 4 }, async () => {
      for (let i = 0; i < iterations; i++) {
        const snapshot = { ...state, stressSequence: ++counters[index] };
        const start = performance.now();
        await store.saveRun(snapshot);
        latencies.push(performance.now() - start);
      }
    }));
    const outcomes = await Promise.allSettled(producers);
    if (observer) {
      observer.send('stop');
      readerResult = await Promise.race([report, observerDone.then(() => { throw new Error('Reader exited without report'); })]);
      await observerDone;
      assert.deepEqual(readerResult.errors, []);
      assert.deepEqual(Object.values(readerResult.last), counters);
    }
    for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.stack);
    for (let i = 0; i < ids.length; i++) {
      const fresh = await createRunStore({ worktree }).loadRun(ids[i]);
      assert.equal(fresh.stressSequence, counters[i]);
      await store.releaseRun(ids[i]);
    }
    assert.deepEqual((await readdir(directory)).sort(), ids.map(id => `${id}.json`));
    latencies.sort((a, b) => a - b);
    const percentile = p => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
    const result = {
      runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`,
      platform: process.platform, pollMs, writes: latencies.length,
      retryEvents: events.filter(e => e.phase === 'retry').length,
      recoveredWrites: events.filter(e => e.phase === 'committed' && e.attempts > 1).length,
      failedWrites: events.filter(e => e.phase === 'failed').length,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) },
      reader: readerResult, nativeLock: lockResult,
    };
    if (option('--output')) await writeFile(option('--output'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const { child, done } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await done.catch(() => {});
    }
    await rm(worktree, { recursive: true, force: true });
  }
}

// Bound diagnostic child lifetimes even if a runtime's IPC/readiness breaks.
const timeout = setTimeout(() => { console.error('Stress diagnostic timed out'); process.exit(1); }, 120000);
try { await (args.includes('--reader') ? reader() : main()); }
finally { clearTimeout(timeout); }
