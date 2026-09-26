// Production publication boundary. The dispatch queue serializes mutations;
// async-local candidates keep uncommitted graph state out of other callbacks.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { sanitizeRun } from './run-state.mjs';

const replace = (target, source) => {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  Object.assign(target, structuredClone(source));
  return target;
};
const error = (code, message) => Object.assign(new Error(message), { code });

export function createReliableRunStore(base, { onFault = () => {}, onCommit = () => {} } = {}) {
  const scope = new AsyncLocalStorage();
  const committed = new Map(), faults = new Map(), listeners = new Set([onCommit]);
  function candidate(id) {
    const live = committed.get(id);
    if (!live) return null;
    const context = scope.getStore();
    if (!context) return live;
    if (!context.has(id)) context.set(id, structuredClone(live));
    return context.get(id);
  }
  function publish(state, metadata = {}) {
    const previous = committed.has(state.runId) ? structuredClone(committed.get(state.runId)) : null;
    const live = committed.get(state.runId) ?? {};
    replace(live, state);
    committed.set(state.runId, live);
    for (const listener of listeners) {
      try { Promise.resolve(listener(structuredClone(live), previous, metadata)).catch(() => {}); } catch { /* advisory */ }
    }
  }
  function latch(id, cause) {
    if (!faults.has(id)) {
      const fault = Object.freeze({ code: 'PERSISTENCE_FAILED', causeCode: String(cause?.code ?? 'UNKNOWN').slice(0, 64),
        operationId: randomUUID(), at: new Date().toISOString(), durable: false });
      faults.set(id, fault);
      try { Promise.resolve(onFault({ runId: id, ...fault })).catch(() => {}); } catch { /* independent logging */ }
    }
    return error('PERSISTENCE_FAILED', 'Run persistence failed; execution is fenced. Inspect evidence and recover explicitly; do not resubmit work.');
  }
  async function saveRun(state) {
    // Validation errors are not I/O failures. Freeze before crossing an await.
    const frozen = structuredClone(sanitizeRun(state));
    if (faults.has(state.runId)) frozen.infrastructureFault = { ...faults.get(state.runId), durable: true };
    try { await base.saveRun(frozen); }
    catch (cause) { throw latch(state.runId, cause); }
    if (faults.has(state.runId)) faults.set(state.runId, Object.freeze(frozen.infrastructureFault));
    publish(frozen);
    replace(state, frozen);
    const local = scope.getStore()?.get(state.runId);
    if (local && local !== state) replace(local, frozen);
    return state;
  }
  async function createRun(input) {
    let state;
    try { state = await base.createRun({ ...input, lifecycleVersion: 1 }); }
    catch (cause) {
      if (cause?.code) throw latch(input.runId, cause);
      throw cause;
    }
    publish(state);
    return candidate(state.runId);
  }
  async function loadRun(id) {
    if (committed.has(id)) return candidate(id);
    const state = await base.loadRun(id);
    if (!state) return null;
    publish(state, { loaded: true });
    if (state.infrastructureFault) faults.set(id, Object.freeze({ ...state.infrastructureFault, durable: true }));
    return candidate(id);
  }
  async function recover(id) {
    const state = candidate(id);
    if (!state) throw error('RUN_GONE', 'Run unavailable');
    if (state.dispatchReservations?.length || state.dispatchRecoveryIssues?.length || state.pendingEffects?.length) {
      throw error('DISPATCH_PENDING', 'Outstanding lifetimes and effects must settle before infrastructure recovery');
    }
    const saved = structuredClone(state);
    delete saved.infrastructureFault;
    if (saved.status === 'SETTLING') {
      saved.status = 'FAILED';
      saved.failReason = 'SETTLEMENT_INTERRUPTED';
      saved.settlement = { ...(saved.settlement ?? {}), outcome: 'interrupted', elapsedMs: null };
    }
    try { await base.saveRun(saved); } catch (cause) { throw latch(id, cause); }
    publish(saved);
    replace(state, saved);
    faults.delete(id);
  }
  return Object.freeze({ ...base, createRun, loadRun, saveRun, getRun: candidate,
    committed: id => committed.get(id) ?? null,
    transaction: (id, operation) => scope.run(new Map(), operation),
    fault: id => faults.get(id) ?? null,
    assertHealthy(id) { if (faults.has(id)) throw error('PERSISTENCE_FAILED', 'Run has an infrastructure fault; stop new work and use explicit recovery after settlement.'); },
    recover,
    onCommitted(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async releaseRun(id) { await base.releaseRun(id); committed.delete(id); faults.delete(id); },
  });
}
