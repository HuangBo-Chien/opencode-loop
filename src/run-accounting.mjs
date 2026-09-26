// Advisory, bounded per-process measurements. No model text or graph payloads.
import { randomUUID } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runFileKey } from './run-state.mjs';
import { writeRunSnapshot } from './run-state-write.mjs';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const terminal = state => ['SUCCEEDED', 'FAILED', 'ABORTED'].includes(state.status);
const elapsed = (start, end) => start === null || end === null ? null : Math.max(0, end - start);

export function createRunAccounting({ worktree, stateDirectory = '.opencode-loop', clock = () => performance.now(), maxMessages = 4096, enabled = true } = {}) {
  const epoch = randomUUID(), runs = new Map();
  const directory = worktree ? join(worktree, stateDirectory, 'metrics') : null;
  let closed = false;
  function ensure(id) {
    if (!enabled) return null;
    if (!validId(id)) return null;
    if (!runs.has(id)) {
      if (runs.size >= 128) return null;
      runs.set(id, { start: clock(), first: null, change: null, end: null, restored: false, messages: new Map(), phases: new Map(),
        persistence: { writes: 0, retries: 0, failed: 0, elapsedMs: 0 }, capacityExceeded: false, timer: null, writing: null, dirty: false, diagnosticError: false });
    }
    return runs.get(id);
  }
  function changed(id, r) {
    r.dirty = true;
    if (!directory || closed || r.timer) return;
    r.timer = setTimeout(() => { r.timer = null; void flush(id); }, 1000);
    r.timer.unref?.();
  }
  function commit(state, previous, metadata = {}) {
    const r = ensure(state.runId);
    if (!r) return;
    r.rootSessionId = state.rootSessionId;
    const now = clock();
    if (metadata.loaded || !previous && (Object.keys(state.nodes).length || state.sideEffects.length)) r.restored = true;
    r.phase = state.status === 'SETTLING' ? 'settlement' : 'orchestration';
    const active = new Set();
    function phase(key, kind, running) {
      if (running) active.add(key);
      if (!r.phases.has(key) && running) {
        if (r.phases.size >= 1024) { r.capacityExceeded = true; return; }
        r.phases.set(key, { kind, start: now, end: null });
      }
    }
    for (const [id, node] of Object.entries(state.nodes)) {
      phase(`node:${id}:${node.attempt}:${node.dispatchId}`, node.spec.kind, node.state === 'RUNNING');
      if (node.spec.kind === 'implement' && node.state === 'SUCCEEDED' && previous?.nodes[id]?.state !== 'SUCCEEDED') r.change = now;
    }
    for (const dispatch of state.dispatchReservations ?? []) if (dispatch.nodeId === null) {
      phase(`free:${dispatch.dispatchId}:${dispatch.callID}`, dispatch.agent.replace('graph-', ''), true);
    }
    phase('settlement', 'settlement', state.status === 'SETTLING');
    for (const [key, value] of r.phases) if (value.end === null && !active.has(key)) value.end = now;
    if (r.first === null && previous) {
      const before = new Set(previous.sideEffects.map(e => JSON.stringify([e.sessionId, e.callID])));
      if (state.sideEffects.some(e => ['edit', 'write'].includes(e.tool) && e.outcome !== 'error' && !e.uncertain && !before.has(JSON.stringify([e.sessionId, e.callID])))) r.first = now;
    }
    if (terminal(state) && r.end === null) r.end = now;
    changed(state.runId, r);
  }
  function message(info, binding) {
    if (!binding || !validId(binding.runId) || !validId(info?.id) || !validId(info?.sessionID) || info.role !== 'assistant') return;
    const r = runs.get(binding.runId);
    if (!r) return;
    if (binding.root ? info.sessionID !== r.rootSessionId : info.sessionID !== binding.sessionId) return;
    const id = JSON.stringify([info.sessionID, info.id]);
    const old = r.messages.get(id);
    if (!old && r.messages.size >= maxMessages) { r.capacityExceeded = true; changed(binding.runId, r); return; }
    const tokens = info.tokens ?? {};
    const phases = { 'graph-explorer': 'explore', 'graph-multimodal': 'analyze', 'graph-planner': 'plan', 'graph-plan-critic': 'review', 'graph-implementer': 'implement', 'graph-verifier': 'verify' };
    const entry = old ?? { group: binding.root ? 'root' : 'children', role: binding.agent ?? 'unknown',
      phase: binding.root ? r.phase ?? 'unknown' : phases[binding.agent] ?? 'unknown', input: null, output: null,
      reasoning: null, cacheRead: null, cacheWrite: null, total: null, completed: false };
    for (const [field, value] of Object.entries({ input: tokens.input, output: tokens.output, reasoning: tokens.reasoning,
      cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write, total: tokens.total })) {
      const n = number(value);
      if (n !== null && (!old?.completed || entry[field] === null)) entry[field] = n;
    }
    entry.completed ||= number(info.time?.completed) !== null;
    r.messages.set(id, entry);
    changed(binding.runId, r);
  }
  function persistence(event) {
    const r = ensure(event.runId);
    if (!r) return;
    if (event.phase === 'retry') r.persistence.retries++;
    if (event.phase === 'committed' || event.phase === 'failed') {
      r.persistence.writes++;
      if (event.phase === 'failed') r.persistence.failed++;
      if (Number.isFinite(event.elapsedMs)) r.persistence.elapsedMs += Math.max(0, event.elapsedMs);
    }
    changed(event.runId, r);
  }
  function inspect(id) {
    if (!enabled) return { enabled: false };
    const r = runs.get(id);
    if (!r) return null;
    const phases = {};
    for (const p of r.phases.values()) {
      const result = phases[p.kind] ??= { completedWorkMs: 0, completedIntervals: 0, activeIntervals: 0 };
      if (p.end === null) result.activeIntervals++;
      else { result.completedWorkMs += elapsed(p.start, p.end); result.completedIntervals++; }
    }
    function usage(entries) {
      const result = { messages: entries.length, unknownMessages: 0, knownSubtotal: 0, total: null };
      for (const e of entries) {
        const total = e.completed ? e.total ?? (e.input !== null && e.output !== null ? e.input + e.output : null) : null;
        if (total === null) result.unknownMessages++;
        else result.knownSubtotal += total;
      }
      if (!r.capacityExceeded && !result.unknownMessages && entries.length) result.total = result.knownSubtotal;
      for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite']) {
        result[field] = entries.length && entries.every(e => e[field] !== null && e.completed) && !r.capacityExceeded
          ? entries.reduce((sum, e) => sum + e[field], 0) : null;
      }
      return result;
    }
    const entries = [...r.messages.values()];
    return { schemaVersion: 1, epoch, coverage: 'current-process-observed', restored: r.restored,
      capacityExceeded: r.capacityExceeded, diagnosticError: r.diagnosticError,
      timings: { observedElapsedMs: elapsed(r.start, r.end ?? clock()),
        beforeFirstObservedModificationMs: r.restored ? null : elapsed(r.start, r.first), changeToRunEndMs: elapsed(r.change, r.end) },
      phases, phaseDurationMeaning: 'summed observed work intervals; concurrent intervals overlap, not wall elapsed',
      usage: { root: usage(entries.filter(e => e.group === 'root')), children: usage(entries.filter(e => e.group === 'children')),
        byRole: Object.fromEntries([...new Set(entries.map(e => e.role))].map(role => [role, usage(entries.filter(e => e.role === role))])),
        byPhase: Object.fromEntries([...new Set(entries.map(e => e.phase))].map(phase => [phase, usage(entries.filter(e => e.phase === phase))])) },
      usagePhaseMeaning: 'role/phase at first observed message event; not provider request start or split overlapping usage',
      persistence: { ...r.persistence }, tokenConvention: 'host total if present, otherwise input + output; reasoning/cache reported separately; unobserved helpers unknown' };
  }
  function flush(id) {
    const r = runs.get(id);
    if (!r || !directory) return Promise.resolve();
    if (r.writing) return r.writing;
    r.writing = (async () => {
      while (r.dirty) {
        r.dirty = false;
        try {
          if (!(await lstat(worktree)).isDirectory()) throw new Error('Diagnostic workspace unavailable');
          await mkdir(directory, { recursive: true });
          await writeRunSnapshot(join(directory, `${runFileKey(id)}.${epoch}.json`), JSON.stringify(inspect(id)), { runId: id });
          r.diagnosticError = false;
        } catch { r.diagnosticError = true; break; }
      }
    })().finally(() => { r.writing = null; });
    return r.writing;
  }
  return Object.freeze({ commit, message, persistence, inspect, flush,
    async close() { closed = true; for (const r of runs.values()) clearTimeout(r.timer); await Promise.all([...runs.keys()].map(flush)); } });
}
