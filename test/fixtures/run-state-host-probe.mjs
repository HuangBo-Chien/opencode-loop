// Load only from an isolated diagnostic OpenCode config with LOOP_PROBE_REPORT.
// Executes during plugin initialization; no model request or session is needed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRunStore } from '../../src/run-state.mjs';
import { createPersistenceLogger } from '../../src/run-state-write.mjs';

export default async function probe(context) {
  assert.equal(process.platform, 'win32');
  assert.ok(process.env.LOOP_PROBE_REPORT, 'LOOP_PROBE_REPORT is required');
  const worktree = await mkdtemp(join(tmpdir(), 'loop-host-probe-'));
  const events = [];
  const log = createPersistenceLogger(context.client);
  const store = createRunStore({ worktree, onPersistenceEvent: event => { events.push(event); return log(event); } });
  let holder, done;
  try {
    const state = await store.createRun({ runId: 'host', rootSessionId: 'host', now: 'probe' });
    const target = join(worktree, '.opencode-loop', 'runs', 'host.json');
    holder = spawn('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('./run-state-lock-holder.ps1', import.meta.url)), '-Path', target, '-Milliseconds', '350'], { stdio: ['ignore', 'pipe', 'pipe'] });
    done = new Promise((resolve, reject) => {
      holder.once('error', reject);
      holder.once('exit', code => code === 0 ? resolve() : reject(new Error(`Holder exit ${code}`)));
    });
    void done.catch(() => {});
    await Promise.race([
      new Promise(resolve => holder.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolve(); })),
      done.then(() => { throw new Error('Holder exited before readiness'); }),
    ]);
    const control = `${target}.control`;
    await writeFile(control, await readFile(target));
    await assert.rejects(rename(control, target), { code: 'EPERM' });
    await rm(control);
    state.mode = 'native-host-saved';
    await store.saveRun(state);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).mode, 'native-host-saved');
    assert.ok(events.some(event => event.phase === 'retry'));
    await done;
    await store.releaseRun('host');
    await writeFile(process.env.LOOP_PROBE_REPORT, `${JSON.stringify({
      status: 'PASS', execPath: process.execPath, versions: process.versions,
      retryEvents: events.filter(event => event.phase === 'retry').length,
      outcome: events.at(-1),
    }, null, 2)}\n`);
    return {};
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill();
    await done?.catch(() => {});
    await rm(worktree, { recursive: true, force: true });
  }
}
