// Persistent run state: one JSON document per orchestrator session under
// <worktree>/<stateDirectory>/runs/<runId>.json. Writes are atomic
// (temp file + rename); a lock file guards cross-instance mutation.
// When no worktree is available the store degrades to in-memory only.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanJson } from './json-safe.mjs';
export const SCHEMA_VERSION = 1;
export const RUN_STATUSES = Object.freeze(['RUNNING', 'BLOCKED', 'FAILED', 'SUCCEEDED', 'RECOVERY_REQUIRED']);
export const NODE_STATES = Object.freeze(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'STALE', 'INCOMPLETE', 'RECOVERY_REQUIRED']);
export const ARTIFACT_STATUSES = Object.freeze(['valid', 'stale', 'superseded']);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_MAX_BYTES = 1_048_576;

export function newRun({ runId, rootSessionId, now }) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw new TypeError('Invalid run id');
  if (typeof rootSessionId !== 'string' || !RUN_ID_PATTERN.test(rootSessionId)) throw new TypeError('Invalid root session id');
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
    revisionCounters: { 'plan-review': 0, 'implement-verify': 0 },
    nodes: {},
    artifacts: {},
    sideEffects: [],
    violations: [],
  };
}

function sanitizeRun(state) {
  const cleaned = cleanJson(state, { maxBytes: RUN_MAX_BYTES, maxValues: 20_000, maxDepth: 32 });
  if (cleaned.schemaVersion !== SCHEMA_VERSION) throw new TypeError('Run state schema version mismatch');
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

  async function createRun({ runId, rootSessionId, now }) {
    const state = newRun({ runId, rootSessionId, now });
    memory.set(runId, state);
    if (runsDir) {
      await mkdir(runsDir, { recursive: true });
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
    await writeFile(temporary, `${JSON.stringify(frozen, null, 2)}\n`, 'utf8');
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

  // Snapshot helper: sha256 of literal files; globs and unreadable entries are
  // reported conservatively so invalidation logic can treat them as unverifiable.
  async function hashFiles(files) {
    const snapshot = {};
    for (const entry of files) {
      if (typeof entry !== 'string' || !entry.length) continue;
      if (/[*?[\]{}!]/.test(entry) || !runsDirWorktree()) {
        snapshot[entry] = 'UNVERIFIABLE';
        continue;
      }
      try {
        const content = await readFile(join(worktree, entry), 'utf8');
        snapshot[entry] = createHash('sha256').update(content, 'utf8').digest('hex');
      } catch (error) {
        snapshot[entry] = error?.code === 'ENOENT' ? 'MISSING' : 'UNVERIFIABLE';
      }
    }
    return snapshot;
  }

  function runsDirWorktree() {
    return typeof worktree === 'string' && worktree.length > 0;
  }

  return Object.freeze({ createRun, loadRun, getRun, saveRun, releaseRun, hashFiles, get persistent() { return runsDir !== null; } });
}
