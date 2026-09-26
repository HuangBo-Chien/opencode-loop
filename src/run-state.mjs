// Persistent run state: one JSON document per orchestrator session under
// <worktree>/<stateDirectory>/runs/<encoded-runId>.json. Filenames are the
// percent-encoded logical run id — successor runs contain ':' (root:2),
// which Windows forbids in filenames, while 'root' still encodes to
// 'root' so legacy colon-free names are untouched. Writes are atomic
// (temp file + rename); a lock file guards cross-instance mutation.
// When no worktree is available the store degrades to in-memory only.

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanJson } from './json-safe.mjs';
import { validateFileClaim } from './task-spec.mjs';
import { writeRunSnapshot, reportPersistence } from './run-state-write.mjs';
export const SCHEMA_VERSION = 2;
export const RUN_STATUSES = Object.freeze(['RUNNING', 'BLOCKED', 'SETTLING', 'FAILED', 'SUCCEEDED', 'RECOVERY_REQUIRED', 'AWAITING_USER_DECISION', 'ABORTED']);
export const NODE_STATES = Object.freeze(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'STALE', 'INCOMPLETE', 'RECOVERY_REQUIRED']);
export const ARTIFACT_STATUSES = Object.freeze(['valid', 'stale', 'superseded']);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_MAX_BYTES = 1_048_576;
const RUN_LIST_MAX_OFFSET = 1_000_000;

function validateRequestCapture(request, requestCaptureCompleted) {
  if (typeof requestCaptureCompleted !== 'boolean') throw new TypeError('Run state has invalid request capture marker');
  if (request !== null) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Run state has invalid request');
    if (typeof request.text !== 'string' || !request.text.length) throw new TypeError('Run state has invalid request text');
    if (typeof request.truncated !== 'boolean') throw new TypeError('Run state has invalid request truncation metadata');
    if (!Number.isInteger(request.redactions) || request.redactions < 0) throw new TypeError('Run state has invalid request redaction metadata');
    if (typeof request.capturedAt !== 'string' || !request.capturedAt.length) throw new TypeError('Run state has invalid request capture timestamp');
    if (!requestCaptureCompleted) throw new TypeError('Run state request capture must be complete when a request is stored');
  }
}

export function newRun({ runId, rootSessionId, now, request = null, requestCaptureCompleted = false, executionStrategy = 'graph' }) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new TypeError('Invalid run id');
  if (typeof rootSessionId !== 'string' || !RUN_ID_PATTERN.test(rootSessionId)) throw new TypeError('Invalid root session id');
  const initialRequest = request === null ? null : cleanJson(request);
  validateRequestCapture(initialRequest, requestCaptureCompleted);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    rootSessionId,
    createdAt: now,
    updatedAt: now,
    mode: 'unknown',
    executionStrategy,
    status: 'RUNNING',
    blockedReason: null,
    failReason: null,
    request: initialRequest,
    requestCaptureCompleted,
    revisionCounters: { 'plan-review': 0, 'implement-verify': 0 },
    nodes: {},
    artifacts: {},
    findingsLog: [],
    sideEffects: [],
    violations: [],
  };
}

export function sanitizeRun(state) {
  let cleaned = cleanJson(state, { maxBytes: RUN_MAX_BYTES, maxValues: 20_000, maxDepth: 32 });
  if (cleaned.schemaVersion === 1) {
    cleaned = { ...cleaned, schemaVersion: SCHEMA_VERSION, request: null, requestCaptureCompleted: true };
  }
  else if (cleaned.schemaVersion !== SCHEMA_VERSION) throw new TypeError('Run state schema version mismatch');
  validateRequestCapture(cleaned.request, cleaned.requestCaptureCompleted);
  if (cleaned.executionStrategy === undefined) cleaned = { ...cleaned, executionStrategy: 'graph' };
  if (!['auto', 'graph'].includes(cleaned.executionStrategy)) throw new TypeError('Run state has invalid execution strategy');
  if (!RUN_STATUSES.includes(cleaned.status)) throw new TypeError('Run state has invalid status');
  for (const node of Object.values(cleaned.nodes ?? {})) {
    if (!NODE_STATES.includes(node.state)) throw new TypeError('Run state has invalid node state');
  }
  return cleaned;
}

// Filename encoding for run ids: percent-encoding escapes ':' (and every
// other path-hostile character) so logical ids like root:2 map to the
// platform-safe name root%3A2.json. '*' is escaped explicitly because
// encodeURIComponent leaves it through and Windows forbids it.
export const runFileKey = (runId) => encodeURIComponent(runId).replace(/\*/g, '%2A');

export function createRunStore({ worktree, stateDirectory = '.opencode-loop', onPersistenceEvent } = {}) {
  const memory = new Map();
  const tails = new Map();
  const creating = new Map();
  const releasing = new Map();
  let sequence = 0;
  const runsDir = typeof worktree === 'string' && worktree ? join(worktree, stateDirectory, 'runs') : null;
  const runFile = (runId) => {
    if (!RUN_ID_PATTERN.test(runId)) throw new TypeError('Invalid run id');
    return join(runsDir, `${runFileKey(runId)}.json`);
  };

  async function createRun({ runId, rootSessionId, now, request = null, requestCaptureCompleted = false, lifecycleVersion, executionStrategy }) {
    const state = newRun({ runId, rootSessionId, now, request, requestCaptureCompleted, executionStrategy });
    if (lifecycleVersion === 1) state.lifecycleVersion = 1;
    if (memory.has(runId) || creating.has(runId) || releasing.has(runId)) throw new Error(`Run ${runId} is locked by an existing registration or lifecycle operation`);
    // Defer I/O until the creation reservation is visible to other callers.
    const result = Promise.resolve().then(async () => {
      let locked = false;
      try {
        if (runsDir) {
          await mkdir(runsDir, { recursive: true });
          let handle;
          try { handle = await open(`${runFile(runId)}.lock`, 'wx'); }
          catch (error) {
            if (error?.code === 'EEXIST') throw new Error(`Run ${runId} is locked by another instance`);
            throw error;
          }
          locked = true;
          await handle.close();
          await persist(state);
        }
        memory.set(runId, state);
        return state;
      } catch (error) {
        if (locked) {
          try { await rm(`${runFile(runId)}.lock`, { force: true }); }
          catch (cleanupError) { reportPersistence(onPersistenceEvent, { runId, phase: 'cleanup-failed', stage: 'lock', code: cleanupError?.code }); }
        }
        throw error;
      }
    });
    creating.set(runId, result);
    try { return await result; }
    finally { creating.delete(runId); }
  }

  function persist(state) {
    // Capture before entering the queue: a shared live state can mutate while
    // an earlier rename is retrying. This queue orders writes, not mutations.
    const frozen = sanitizeRun(state);
    const target = runFile(state.runId);
    const content = `${JSON.stringify(frozen, null, 2)}\n`;
    const options = { runId: frozen.runId, sequence: ++sequence, onPersistenceEvent };
    const result = (tails.get(frozen.runId) ?? Promise.resolve()).then(() => writeRunSnapshot(target, content, options));
    const settled = result.then(() => undefined, () => undefined);
    tails.set(frozen.runId, settled);
    void settled.then(() => { if (tails.get(frozen.runId) === settled) tails.delete(frozen.runId); });
    return result;
  }

  async function loadRun(runId) {
    if (!RUN_ID_PATTERN.test(runId)) return null;
    if (!runsDir) return memory.get(runId) ?? null;
    let raw;
    try {
      raw = await readFile(runFile(runId), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Legacy pre-encoding filename (raw ':' ids only ever persisted on
      // POSIX): readable during the transition until listRunIds' lazy
      // migration renames it to the encoded form.
      let recovered = null;
      if (runFileKey(runId) !== runId) {
        try {
          recovered = await readFile(join(runsDir, `${runId}.json`), 'utf8');
        } catch {
          recovered = null;
        }
      }
      if (recovered === null) return memory.get(runId) ?? null;
      raw = recovered;
    }
    const parsed = JSON.parse(raw);
    const state = structuredClone(sanitizeRun(parsed));
    if (state.runId !== runId) throw new Error(`Run file ${runId} contains mismatched runId ${state.runId}`);
    memory.set(runId, state);
    return state;
  }

  function getRun(runId) {
    return memory.get(runId) ?? null;
  }

  async function saveRun(state) {
    if (!memory.has(state.runId)) throw new Error(`Run ${state.runId} is not registered`);
    if (releasing.has(state.runId)) throw new Error(`Run ${state.runId} is releasing`);
    state.updatedAt = new Date().toISOString();
    if (runsDir) await persist(state);
    return state;
  }

  async function releaseRun(runId) {
    if (releasing.has(runId)) return releasing.get(runId);
    const result = Promise.resolve().then(async () => {
      // Close admission before waiting; creation and every accepted save must
      // finish before another instance can acquire the lock.
      const pendingCreate = creating.get(runId);
      if (pendingCreate) {
        try { await pendingCreate; }
        catch { return; } // Failed creation already cleaned only its own lock.
      }
      await tails.get(runId);
      if (runsDir) await rm(`${runFile(runId)}.lock`, { force: true });
      memory.delete(runId);
    });
    releasing.set(runId, result);
    try { await result; }
    finally { releasing.delete(runId); }
  }

  async function listRunIds({ limit = 64, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    if (!Number.isInteger(offset) || offset < 0 || offset > RUN_LIST_MAX_OFFSET) {
      throw new TypeError(`offset must be an integer from 0 to ${RUN_LIST_MAX_OFFSET}`);
    }
    if (!runsDir) return [...memory.keys()].slice(offset, offset + limit);

    let handle;
    try {
      handle = await opendir(runsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const runIds = [];
    let skipped = 0;
    let missing = false;
    try {
      for await (const entry of handle) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const key = entry.name.slice(0, -5);
        let runId;
        try {
          runId = decodeURIComponent(key);
        } catch {
          continue; // malformed percent escapes are not run files
        }
        if (!RUN_ID_PATTERN.test(runId)) continue;
        if (runFileKey(runId) !== key) {
          // A legacy pre-encoding filename (raw ':' ids, only creatable on
          // POSIX): lazily migrate to the encoded name so the run stays
          // visible and a successor cannot mint a duplicate logical id.
          // Skip conservatively when the twin exists or the rename fails.
          if (runId !== key) continue;
          const target = join(runsDir, `${runFileKey(runId)}.json`);
          try {
            await lstat(target);
            continue; // encoded twin already exists; drop the duplicate
          } catch (error) {
            if (error?.code !== 'ENOENT') continue;
          }
          try {
            await rename(join(runsDir, entry.name), target);
          } catch {
            continue;
          }
        }
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        runIds.push(runId);
        if (runIds.length >= limit) break;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing = true; // Bun may defer opening the directory until iteration.
      runIds.length = 0;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        if (error?.code !== 'ERR_DIR_CLOSED' && !(missing && error?.code === 'ENOENT')) throw error;
      }
    }
    return runIds;
  }

  // Snapshot helper: sha256 of literal files; globs and unreadable entries are
  // reported conservatively so invalidation logic can treat them as unverifiable.
  async function hashFiles(files) {
    const snapshot = {};
    for (const entry of files) {
      if (typeof entry !== 'string' || !entry.length) continue;
      if (!validateFileClaim(entry).ok || !runsDirWorktree()) {
        snapshot[entry] = 'UNVERIFIABLE';
        continue;
      }
      try {
        let path = worktree;
        let unsafe = false;
        const segments = entry.split('/');
        for (let index = 0; index < segments.length; index += 1) {
          path = join(path, segments[index]);
          const info = await lstat(path);
          if (info.isSymbolicLink() || (index === segments.length - 1 ? !info.isFile() : !info.isDirectory())) {
            unsafe = true;
            break;
          }
        }
        if (unsafe) { snapshot[entry] = 'UNVERIFIABLE'; continue; }
        const content = await readFile(path);
        snapshot[entry] = createHash('sha256').update(content).digest('hex');
      } catch (error) {
        snapshot[entry] = error?.code === 'ENOENT' ? 'MISSING' : 'UNVERIFIABLE';
      }
    }
    return snapshot;
  }

  function runsDirWorktree() {
    return typeof worktree === 'string' && worktree.length > 0;
  }

  return Object.freeze({ createRun, loadRun, getRun, saveRun, releaseRun, listRunIds, hashFiles, get persistent() { return runsDir !== null; } });
}
