// Finite, programmatic host settlement. This controller never dispatches work.
import { randomUUID } from 'node:crypto';
import { unresolvedEffects } from './effect-resolution.mjs';

export function settlementBlockers(state) {
  const blockers = [];
  for (const [field, label] of [['dispatchReservations', 'lifetimes'], ['dispatchRecoveryIssues', 'recovery issues'], ['pendingEffects', 'pending effects']]) {
    if (state[field] !== undefined && (!Array.isArray(state[field]) || state[field].length)) {
      blockers.push(`${label}: ${Array.isArray(state[field]) ? state[field].length : 'invalid ledger'}`);
    }
  }
  const uncertain = unresolvedEffects(state).length;
  if (uncertain) blockers.push(`uncertain effects: ${uncertain}`);
  if (state.repairPlanRevision) blockers.push('repair plan revision');
  if (!Object.values(state.nodes).length || Object.values(state.nodes).some(n => !['SUCCEEDED', 'SKIPPED'].includes(n.state))) blockers.push('graph acceptance incomplete');
  return blockers;
}

export function createSettlementController({ store, exclusive, reconcile, timeoutMs = 30000,
  clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
  const runs = new Map();
  let closed = false;
  function observe(state, previous) {
    if (closed || state.lifecycleVersion !== 1 || state.status !== 'SETTLING') return;
    // Loading an old SETTLING document is handled explicitly by restore().
    if (!previous) return;
    if (runs.has(state.runId)) {
      const entry = runs.get(state.runId);
      if (!entry.flight) { if (entry.timer) cancel(entry.timer); entry.timer = null; arm(state.runId, 0); }
      return;
    }
    const entry = { start: clock(), id: state.settlement?.id ?? randomUUID(), flight: null, timer: null };
    runs.set(state.runId, entry);
    arm(state.runId, 0);
  }
  const unsubscribe = store.onCommitted(observe);
  function arm(id, ms) {
    const entry = runs.get(id);
    if (!entry || closed || entry.timer) return;
    entry.timer = schedule(() => { entry.timer = null; void tick(id); }, Math.max(0, ms));
    entry.timer?.unref?.();
  }
  function retire(id) {
    const entry = runs.get(id);
    if (entry?.timer) cancel(entry.timer);
    runs.delete(id);
  }
  function tick(id, restored = false) {
    let entry = runs.get(id);
    if (!entry && restored) {
      entry = { start: clock(), id: store.getRun(id)?.settlement?.id ?? randomUUID(), timer: null };
      runs.set(id, entry);
    }
    if (!entry || closed) return Promise.resolve();
    if (entry.flight) return entry.flight;
    const deadline = entry.start + (restored ? Math.min(timeoutMs, 2000) : timeoutMs);
    entry.flight = exclusive(id, async () => {
      let state = store.getRun(id);
      if (!state || state.status !== 'SETTLING' || store.fault?.(id)) { retire(id); return; }
      let reconciliationFailed = false;
      if (clock() < deadline) {
        try { await reconcile(id, () => Math.max(0, deadline - clock()), restored); }
        catch { reconciliationFailed = true; }
      }
      state = store.getRun(id);
      if (!state || state.status !== 'SETTLING' || store.fault?.(id)) { retire(id); return; }
      const blockers = settlementBlockers(state);
      if (reconciliationFailed) blockers.push('host reconciliation unavailable');
      let evidenceChanged = false;
      if (!blockers.length && clock() < deadline) {
        const snapshots = Object.values(state.artifacts).filter(a => a.status === 'valid').map(a => a.snapshot ?? {});
        const files = [...new Set(snapshots.flatMap(Object.keys))];
        if (files.length) {
          let timer;
          try {
            // Hashing is read-only; late results cannot publish or mutate state.
            const actual = await Promise.race([store.hashFiles(files), new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('snapshot deadline')), Math.max(1, Math.ceil(deadline - clock())));
            })]);
            evidenceChanged = snapshots.some(snapshot => Object.entries(snapshot).some(([path, hash]) => hash === 'UNVERIFIABLE' || actual[path] !== hash));
          } catch { evidenceChanged = true; }
          finally { clearTimeout(timer); }
          if (evidenceChanged) blockers.push('accepted file evidence changed or unavailable');
        }
      }
      const expired = clock() >= deadline;
      const candidate = structuredClone(state);
      candidate.settlement = { id: entry.id, startedAt: state.settlement?.startedAt ?? new Date().toISOString(),
        elapsedMs: restored ? null : Math.max(0, clock() - entry.start), timeoutMs, blockers,
        outcome: expired ? 'timeout' : evidenceChanged ? 'evidence-changed' : blockers.length ? (restored ? 'interrupted' : 'pending') : 'completed' };
      if (expired || restored && blockers.length) {
        candidate.status = 'FAILED';
        candidate.failReason = restored ? 'SETTLEMENT_INTERRUPTED' : 'SETTLEMENT_TIMEOUT';
      } else if (evidenceChanged) {
        candidate.status = 'FAILED';
        candidate.failReason = 'SETTLEMENT_EVIDENCE_CHANGED';
      } else if (!blockers.length) {
        candidate.status = 'SUCCEEDED';
        candidate.blockedReason = null;
      }
      await store.saveRun(candidate);
      if (candidate.status !== 'SETTLING') retire(id);
    }).catch(() => {
      // A save failure is already latched by the reliable store. Never turn it
      // into success or an unhandled timer rejection.
      retire(id);
    }).finally(() => {
      entry.flight = null;
      if (runs.has(id)) arm(id, Math.min(1000, Math.max(0, deadline - clock())));
    });
    return entry.flight;
  }
  return Object.freeze({ tick, restore: id => tick(id, true),
    close() { closed = true; unsubscribe(); for (const id of runs.keys()) retire(id); } });
}
