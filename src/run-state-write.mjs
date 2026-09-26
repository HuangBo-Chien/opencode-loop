// Atomic run snapshots only. Never replay a caller's mutation or remove the
// destination to work around Windows sharing violations.
import { randomUUID, createHash } from 'node:crypto';
import { writeFile, rename, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const RETRY_DELAYS = [10, 20, 40, 80, 160, 250, 250];
const RETRY_DEADLINE_MS = 1500;

// One outcome summary per troubled write (plus a cleanup failure, if any).
// The host log is independent of the run JSON; never wait for it to commit.
export function createPersistenceLogger(client) {
  return event => {
    if (event.phase === 'retry' || event.phase === 'committed' && event.attempts === 1) return;
    return client?.app?.log?.({
      body: {
        service: 'opencode-loop.persistence',
        level: event.phase === 'committed' ? 'warn' : 'error',
        message: `Run snapshot ${event.phase}`,
        extra: event,
      },
      signal: AbortSignal.timeout(1000),
    });
  };
}

// Diagnostics are advisory, outside the authoritative document and queue.
export function reportPersistence(emit, event) {
  try { Promise.resolve(emit?.(Object.freeze(event))).catch(() => {}); }
  catch { /* Logging must never change a commit's outcome. */ }
}

export async function writeRunSnapshot(target, content, {
  runId, sequence, onPersistenceEvent, platform = process.platform,
  delay = sleep, clock = () => performance.now(), random = Math.random,
} = {}) {
  const operationId = randomUUID();
  const temporary = `${target}.tmp-${process.pid}-${operationId}`;
  const started = clock();
  const context = {
    runId, sequence, operationId, pid: process.pid, target, temporary, platform,
    runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`,
    snapshotHash: createHash('sha256').update(content).digest('hex'),
  };
  let stage = 'write', attempts = 0, cleanup = true;
  const report = (phase, extra = {}) => reportPersistence(onPersistenceEvent, {
    ...context, phase, stage, attempts, elapsedMs: clock() - started, ...extra,
  });
  try {
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      // An exclusive-create collision is not our file to remove.
      if (error?.code === 'EEXIST') cleanup = false;
      throw error;
    }
    stage = 'rename';
    const deadline = clock() + RETRY_DEADLINE_MS;
    for (;;) {
      attempts++;
      try {
        await rename(temporary, target);
        cleanup = false;
        report('committed');
        return;
      } catch (error) {
        const remaining = deadline - clock();
        if (platform !== 'win32' || error?.code !== 'EPERM' || attempts > RETRY_DELAYS.length || remaining <= 0) throw error;
        const waitMs = Math.min(remaining, RETRY_DELAYS[attempts - 1] + Math.floor(random() * 10));
        report('retry', { code: error.code, waitMs });
        await delay(waitMs);
        // A suspended event loop must not turn a bounded retry into a late write.
        if (clock() >= deadline) throw error;
      }
    }
  } catch (error) {
    report('failed', { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
    throw error;
  } finally {
    if (cleanup) {
      try { await rm(temporary, { force: true }); }
      catch (error) { report('cleanup-failed', { code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }); }
    }
  }
}
