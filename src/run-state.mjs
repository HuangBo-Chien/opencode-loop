// Persistent run state: one JSON document per orchestrator session under
// <worktree>/<stateDirectory>/runs/<runId>.json. Writes are atomic
// (temp file + rename); a lock file guards cross-instance mutation.
// When no worktree is available the store degrades to in-memory only.

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanJson } from './json-safe.mjs';
import { validateFileClaim } from './task-spec.mjs';
export const SCHEMA_VERSION = 2;
export const RUN_STATUSES = Object.freeze(['RUNNING', 'BLOCKED', 'FAILED', 'SUCCEEDED', 'RECOVERY_REQUIRED']);
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

export function newRun({ runId, rootSessionId, now, request = null, requestCaptureCompleted = false }) {
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
    status: 'RUNNING',
    blockedReason: null,
    failReason: null,
    request: initialRequest,
    requestCaptureCompleted,
    revisionCounters: { 'plan-review': 0, 'implement-verify': 0 },
    nodes: {},
    artifacts: {},
    sideEffects: [],
    violations: [],
  };
}

function sanitizeRun(state) {
  let cleaned = cleanJson(state, { maxBytes: RUN_MAX_BYTES, maxValues: 20_000, maxDepth: 32 });
  if (cleaned.schemaVersion === 1) {
    cleaned = { ...cleaned, schemaVersion: SCHEMA_VERSION, request: null, requestCaptureCompleted: true };
  }
  else if (cleaned.schemaVersion !== SCHEMA_VERSION) throw new TypeError('Run state schema version mismatch');
  validateRequestCapture(cleaned.request, cleaned.requestCaptureCompleted);
  if (!RUN_STATUSES.includes(cleaned.status)) throw new TypeError('Run state has invalid status');
  for (const node of Object.values(cleaned.nodes ?? {})) {
    if (!NODE_STATES.includes(node.state)) throw new TypeError('Run state has invalid node state');
  }
  return cleaned;
}

export function createRunStore({ worktree, stateDirectory = '.opencode-loop' } = {}) {
  const memory = new Map();
  const runsDir = typeof worktree === 'string' && worktree ? join(worktree, stateDirectory, 'runs') : null;
  const runFile = (runId) => {
    if (!RUN_ID_PATTERN.test(runId)) throw new TypeError('Invalid run id');
    return join(runsDir, `${runId}.json`);
  };

  async function createRun({ runId, rootSessionId, now, request = null, requestCaptureCompleted = false }) {
    const state = newRun({ runId, rootSessionId, now, request, requestCaptureCompleted });
    memory.set(runId, state);
    if (runsDir) {
      try {
        await mkdir(runsDir, { recursive: true });
      } catch (error) {
        memory.delete(runId);
        throw error;
      }
      try {
        await open(`${runFile(runId)}.lock`, 'wx').then((handle) => handle.close());
      } catch (error) {
        memory.delete(runId);
        if (error?.code === 'EEXIST') throw new Error(`Run ${runId} is locked by another instance`);
        throw error;
      }
      await persist(state);
    }
    return state;
  }

  async function persist(state) {
    const frozen = sanitizeRun(state);
    const target = runFile(state.runId);
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(temporary, `${JSON.stringify(frozen, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  async function loadRun(runId) {
    if (!RUN_ID_PATTERN.test(runId)) return null;
    if (!runsDir) return memory.get(runId) ?? null;
    let raw;
    try {
      raw = await readFile(runFile(runId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return memory.get(runId) ?? null;
      throw error;
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
    state.updatedAt = new Date().toISOString();
    if (runsDir) await persist(state);
    return state;
  }

  async function releaseRun(runId) {
    memory.delete(runId);
    if (runsDir) await rm(`${runFile(runId)}.lock`, { force: true });
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
        const runId = entry.name.slice(0, -5);
        if (!RUN_ID_PATTERN.test(runId)) continue;
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
