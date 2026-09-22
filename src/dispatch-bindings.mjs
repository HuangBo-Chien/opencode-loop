// Native task correlation. Session creation order is not dispatch order.
// Only host task metadata, keyed by parent session + callID, can bind work.
import { createHash, randomUUID } from 'node:crypto';
import { resolveNodeIdHint, TARGET_REQUIRED_AGENTS } from './dispatch-target.mjs';
import { cleanJson } from './json-safe.mjs';
import { assertSettlementCapacity } from './runner.mjs';
import { sanitizeRun } from './run-state.mjs';
import { repairSettlementPending } from './artifact-dependencies.mjs';

const NOW = () => new Date().toISOString();
const key = (root, call) => JSON.stringify([root, call]);
const denied = (code, detail) => ({ allowed: false, code, detail });
// Roles whose sessions may be continued by identity alone (their structured
// submissions never require a node binding, so reusing the conversation is
// low-risk). Write-role continuations still require state-verified identity.
const CONTINUABLE_ROLES = new Set(['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-multimodal']);
// Read-only consultation roles whose free (unbound) dispatches share one
// capacity budget with node-bound explore/analyze work.
const READ_CONSULT_AGENTS = new Set(['graph-explorer', 'graph-multimodal']);
const DISPATCH_AGENTS = new Set([...CONTINUABLE_ROLES, 'graph-implementer', 'graph-verifier']);
const NESTED_CALLERS = new Set([...DISPATCH_AGENTS].filter((agent) => agent !== 'graph-multimodal'));
const callerOf = (record) => record.callerSessionId ?? record.rootSessionId;
const provenance = (record) => record.nested ? { nested: true, callerSessionId: record.callerSessionId, callerDispatchId: record.callerDispatchId } : {};
const identityString = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
// These two identifiers are minted only by randomUUID here, not by the host.
const generationId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hasRecoveryIssues = (state) => state?.dispatchRecoveryIssues !== undefined
  && (!Array.isArray(state.dispatchRecoveryIssues) || state.dispatchRecoveryIssues.length !== 0);

// Recovery is a partition, never a filter: every persisted outstanding entry
// becomes either an authenticated native record or an opaque durable issue.
// Issues retain the exact source JSON but are NEVER indexed as native calls.
function partitionReservations(state) {
  const issues = state.dispatchRecoveryIssues === undefined ? [] : Array.isArray(state.dispatchRecoveryIssues)
    ? structuredClone(state.dispatchRecoveryIssues) : [{ code: 'INVALID_RECOVERY_ISSUES', reservation: structuredClone(state.dispatchRecoveryIssues) }];
  const source = state.dispatchReservations === undefined ? [] : Array.isArray(state.dispatchReservations)
    ? state.dispatchReservations : [state.dispatchReservations];
  const admission = new Set(Array.isArray(state.dispatchCallIds) ? state.dispatchCallIds : []);
  const problem = (r, historical = false) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'INVALID_RESERVATION';
    if (r.runId !== state.runId || r.rootSessionId !== state.rootSessionId
      || !generationId(r.dispatchId) || !identityString(r.callID) || !generationId(r.turnToken)
      || !DISPATCH_AGENTS.has(r.agent) || !(r.nodeId === null || typeof r.nodeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.nodeId))
      || !(r.sessionId === null || identityString(r.sessionId)) || !Number.isSafeInteger(r.planVersion) || r.planVersion < 0
      || ['bound', 'continuation', 'acknowledged', 'idleSeen', 'terminal'].some((field) => typeof r[field] !== 'boolean')
      || ['started', 'resumed', 'background', 'settlementOnly', 'repairRevoked', 'recovery'].some((field) => r[field] !== undefined && typeof r[field] !== 'boolean')
      || (r.bound || r.started || r.continuation) && !identityString(r.sessionId)
      || r.nodeId === null && !CONTINUABLE_ROLES.has(r.agent)) return 'INVALID_RESERVATION_IDENTITY';
    if (r.recoveryBlocked) return 'UNRESOLVED_RESERVATION';
    if (r.callerSessionId !== undefined && !identityString(r.callerSessionId)
      || r.nested !== undefined && typeof r.nested !== 'boolean'
      || r.nested && (r.agent !== 'graph-multimodal' || r.nodeId !== null || !identityString(r.callerSessionId)
        || r.callerSessionId === r.rootSessionId || !generationId(r.callerDispatchId))
      || !r.nested && (callerOf(r) !== r.rootSessionId || r.callerDispatchId !== undefined)) return 'INVALID_CALLER_PROVENANCE';
    if (!admission.has(key(callerOf(r), r.callID))) return 'MISSING_ADMISSION_PROOF';
    if (!historical) {
      const version = state.artifacts.plan?.version ?? 0;
      const owner = Object.values(state.nodes).find((node) => node.dispatchId === r.dispatchId && node.sessionId === r.sessionId);
      if (r.planVersion > version || !r.settlementOnly && r.planVersion !== version
        || owner && (owner.spec.id !== r.nodeId || owner.spec.agent !== r.agent)) return 'CONFLICTING_NODE_GENERATION';
    }
    return null;
  };
  const problems = source.map((r) => problem(r));
  const groups = (field) => {
    const map = new Map();
    source.forEach((r, i) => {
      const value = r && typeof r === 'object' ? field(r) : null;
      if (value === null) return;
      const entries = map.get(value) ?? [];
      entries.push(i); map.set(value, entries);
    });
    return map;
  };
  const callKey = (r) => identityString(callerOf(r)) && identityString(r.callID) ? key(callerOf(r), r.callID) : null;
  const conflict = (indices) => { for (const index of indices) problems[index] = 'CONFLICTING_RESERVATION_IDENTITY'; };
  for (const indices of groups(callKey).values()) if (indices.length > 1) conflict(indices);
  for (const indices of groups((r) => identityString(r.turnToken) ? r.turnToken : null).values()) if (indices.length > 1) conflict(indices);
  for (const indices of groups((r) => identityString(r.dispatchId) ? r.dispatchId : null).values()) {
    const identities = new Set(indices.map((i) => {
      const r = source[i];
      return JSON.stringify([r.runId, r.rootSessionId, callerOf(r), r.callerDispatchId, r.nested, r.agent, r.nodeId, r.sessionId, r.planVersion]);
    }));
    if (identities.size > 1) conflict(indices);
  }
  const settled = Array.isArray(state.settledDispatches) ? state.settledDispatches : [];
  const lineageValid = (r) => !r.nested || [...source.filter((_, i) => !problems[i]), ...settled].some((parent) => !problem(parent, true)
    && !parent.nested && parent.bound && NESTED_CALLERS.has(parent.agent)
    && parent.sessionId === r.callerSessionId && parent.dispatchId === r.callerDispatchId);
  source.forEach((r, i) => { if (!problems[i] && !lineageValid(r)) problems[i] = 'INVALID_CALLER_LINEAGE'; });
  const settledCalls = new Set(settled.filter((r) => r && typeof r === 'object').map(callKey).filter(Boolean));
  const settledDispatches = new Set(settled.filter((r) => r?.runId === state.runId && identityString(r.dispatchId)).map((r) => r.dispatchId));
  const restored = [];
  source.forEach((r, i) => {
    if (r && (settledCalls.has(callKey(r)) || settledDispatches.has(r.dispatchId))) problems[i] = 'CONFLICT_WITH_SETTLED_IDENTITY';
    const code = problems[i] ?? (restored.length >= 128 ? 'RECOVERY_RESERVATION_CAPACITY' : null);
    if (code) issues.push({ code, reservation: structuredClone(r) });
    else restored.push({ ...r, ...(state.status !== 'AWAITING_USER_DECISION' ? { settlementOnly: true } : {}) });
  });
  return { restored, issues, settled: settled.filter((r) => !problem(r, true) && lineageValid(r)) };
}

// Shared by ordinary persistence and staged recovery. Receipt ownership is
// projected from the candidate ledger, never from a partially rebuilt registry.
function projectIdleEvidence(runId, reservations, evidence) {
  const live = new Set(reservations.map((r) => key(r.callID, r.dispatchId)));
  let remaining = 256;
  return evidence.filter((entry) => entry.runId === runId).slice(-128).reverse().map((entry) => {
    const owners = entry.owners.filter((owner) => live.has(key(owner.callID, owner.dispatchId))).slice(0, remaining);
    remaining -= owners.length;
    return { ...entry, owners };
  }).filter((entry) => entry.owners.length).reverse();
}
// Pinned native v1.18.25 compaction.ts creates this text with its internal
// compaction_continue marker. Text alone is never a lineage witness.
const COMPACTION_CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const COMPACTION_OVERFLOW = "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n";
export function createDispatchBindings({ store, runner, bindings, client, getSubagentDepth = () => 2 }) {
  const records = new Map();
  const parents = new Map();
  const tails = new Map();
  const resolutions = new Map();
  const idleEvidence = new Map();
  const seenIdleEvents = new Map();

  function publishIdleHistory(runId, idleEventIds, pendingIdleEvidence) {
    seenIdleEvents.set(runId, new Set(idleEventIds));
    for (const [session, entries] of idleEvidence) {
      const retained = entries.filter((entry) => entry.runId !== runId);
      if (retained.length) idleEvidence.set(session, retained);
      else idleEvidence.delete(session);
    }
    for (const entry of pendingIdleEvidence) {
      const entries = idleEvidence.get(entry.sessionId) ?? [];
      entries.push(entry);
      idleEvidence.set(entry.sessionId, entries);
    }
  }

  // Persist host lifetimes as well as node state. A delivered node and a free
  // consultation may still have an active host child when a sibling pauses.
  async function persist(state, omit = () => false, extra = {}, reserve = false) {
    const dispatchReservations = (extra.dispatchReservations ?? [...records.values()].filter((r) => r.runId === state.runId && !omit(r))).map((r) => ({ ...r }));
    const idleEventIds = [...(seenIdleEvents.get(state.runId) ?? new Set(state.idleEventIds ?? []))].slice(-256);
    // Receipts are hints, not completion authority. Bound total ownership refs
    // (not just each array), and discard references as reservations retire.
    const pendingIdleEvidence = projectIdleEvidence(state.runId, dispatchReservations, extra.pendingIdleEvidence ?? [...idleEvidence.values()].flat());
    const saved = { ...state, ...extra, dispatchReservations, idleEventIds, pendingIdleEvidence };
    if (reserve) assertSettlementCapacity(saved);
    cleanJson(saved, { maxBytes: 1_048_576, maxValues: 20_000, maxDepth: 32 });
    await store.saveRun(saved);
    state.dispatchReservations = dispatchReservations;
    state.idleEventIds = idleEventIds;
    state.pendingIdleEvidence = saved.pendingIdleEvidence;
    state.updatedAt = saved.updatedAt;
    Object.assign(state, extra, { pendingIdleEvidence });
    publishIdleHistory(state.runId, idleEventIds, pendingIdleEvidence);
  }

  function exclusive(runId, operation) {
    const result = (tails.get(runId) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(runId, settled);
    void settled.then(() => { if (tails.get(runId) === settled) tails.delete(runId); });
    return result;
  }

  // Ownership survives a pause and structured submission. Execution permission
  // does not: a host lifetime can still owe settlement after its node delivered.
  function owns(binding, { settled = false } = {}) {
    if (!binding || binding.root || binding.active === false && !(settled && binding.settled)) return false;
    if (bindings.get(binding.sessionId) !== binding) return false;
    const state = store.getRun(binding.runId);
    if (!state) return false;
    const candidates = binding.active === false ? state.settledDispatches ?? [] : [...records.values()];
    const record = candidates.find((r) => r.bound && r.runId === binding.runId && r.agent === binding.agent
      && r.sessionId === binding.sessionId && r.dispatchId === binding.dispatchId && r.nodeId === binding.nodeId);
    if (!record || record.recoveryBlocked) return false;
    if (binding.settlementOnly) return record.settlementOnly === true;
    if (!binding.nodeId) return true;
    const node = state.nodes[binding.nodeId];
    return node?.sessionId === binding.sessionId && node.dispatchId === binding.dispatchId;
  }

  function current(binding) {
    if (!owns(binding)) return false;
    const state = store.getRun(binding.runId);
    if (binding.nested) {
      const parent = bindings.get(binding.callerSessionId);
      if (!parent || parent.nested || parent.dispatchId !== binding.callerDispatchId || !current(parent)) return false;
    }
    return !binding.settlementOnly && state.status === 'RUNNING' && (!binding.nodeId || state.nodes[binding.nodeId]?.state === 'RUNNING');
  }

  // A missing binding is not a free-role identity. Authenticate host parentage
  // AND this run's ownership before reserving a fallback continuation. Native
  // call metadata plus the durable admission ledger can survive history eviction.
  async function rootContinuationOwned(state, sessionId, agent) {
    if (!identityString(sessionId) || !client?.session?.get) return false;
    const signal = AbortSignal.timeout(2000);
    try {
      const info = (await client.session.get({ path: { id: sessionId }, signal })).data;
      if (info?.id !== sessionId || info.parentID !== state.rootSessionId
        || info.agent !== undefined && info.agent !== agent) return false;
      const partition = partitionReservations(state);
      if ([...partition.restored, ...partition.settled].some((r) => !r.nested && r.bound
        && r.sessionId === sessionId && r.agent === agent && callerOf(r) === state.rootSessionId)) return true;
      if (!client.session.messages) return false;
      const messages = (await client.session.messages({ path: { id: state.rootSessionId }, query: { limit: 64 }, signal })).data;
      const admitted = new Set(state.dispatchCallIds ?? []);
      return (Array.isArray(messages) ? messages.slice(-64) : []).some((message) =>
        (Array.isArray(message.parts) ? message.parts.slice(0, 256) : []).some((part) =>
          part?.type === 'tool' && part.tool === 'task' && part.sessionID === state.rootSessionId
          && admitted.has(key(part.sessionID, part.callID)) && part.state?.input?.subagent_type === agent
          && part.state?.metadata?.parentSessionId === state.rootSessionId && part.state?.metadata?.sessionId === sessionId));
    } catch { return false; }
  }

  async function admit(callerSessionId, callID, args, desiredNodeId = null) {
    const root = bindings.get(callerSessionId);
    if (!root) return denied('NOT_GRAPH_SESSION', 'task dispatch requires an authenticated graph binding');
    const nested = !root.root;
    const agent = args?.subagent_type;
    const targetDecision = resolveNodeIdHint(args, desiredNodeId, { strict: TARGET_REQUIRED_AGENTS.has(agent) });
    if (!targetDecision.allowed) return targetDecision;
    const target = targetDecision.nodeId;
    if (target === null && TARGET_REQUIRED_AGENTS.has(agent)) {
      return denied('NODE_ID_REQUIRED', `${agent} requires an explicit nodeId for every dispatch, including task_id continuations and single-node graphs; put [nodeId:target-node] alone on the first prompt line`);
    }
    return exclusive(root.runId, async () => {
      const state = store.getRun(root.runId);
      if (!state) return denied('RUN_GONE', 'owning run is unavailable');
      const rootSessionId = state.rootSessionId;
      if (bindings.get(callerSessionId) !== root || nested && (!NESTED_CALLERS.has(root.agent) || !current(root))) {
        return denied('BINDING_UNAVAILABLE', 'nested consultation requires an active authenticated specialist dispatch');
      }
      if (nested && (agent !== 'graph-multimodal' || target !== null || args.nodeId !== undefined || /\[nodeId:/i.test(args.prompt ?? ''))) {
        return denied('NESTED_CONSULT_ONLY', 'specialists may only consult graph-multimodal without node markers');
      }
      if (hasRecoveryIssues(state)) return denied('DISPATCH_RECOVERY_UNRESOLVED', 'unrestorable outstanding lifetimes remain; inspection preserves their original evidence');
      const depthLimit = getSubagentDepth();
      if (!Number.isSafeInteger(depthLimit) || depthLimit < (nested ? 2 : 1)) {
        return denied('SUBAGENT_DEPTH_LIMIT', `native subagent_depth must be at least ${nested ? 2 : 1} for this dispatch; respect the configured limit and report it, or change host configuration and restart`);
      }
      const recordKey = key(callerSessionId, callID);
      const turnToken = randomUUID();
      const used = state.dispatchCallIds ?? [];
      const previousCallIds = state.dispatchCallIds;
      const previousBinding = args.task_id ? bindings.get(args.task_id) : null;
      const recordDispatch = () => {
        state.dispatchCallIds = [...used, recordKey];
      };
      const failedReservation = () => {
        records.delete(recordKey);
        if (previousCallIds) state.dispatchCallIds = previousCallIds; else delete state.dispatchCallIds;
        if (previousBinding) bindings.set(args.task_id, previousBinding);
        return denied('DISPATCH_PERSISTENCE_FAILED', 'could not durably reserve task and settlement headroom; inspect storage/capacity');
      };
      if (typeof callID !== 'string' || !callID.length || callID.length > 256 || used.includes(recordKey)) return denied('DUPLICATE_DISPATCH', 'a unique host callID is required, including after recovery');
      if (used.length >= 900) return denied('DISPATCH_LIMIT', 'run dispatch history reached its persistence-safe limit');
      if ([...records.values()].filter((r) => r.runId === root.runId).length >= 128) return denied('DISPATCH_LIMIT', 'too many outstanding task calls');
      // Nested continuations require durable exact-generation provenance, even
      // after settlement. Never use the root free-role identity fallback here.
      const prior = args.task_id === undefined ? null : [...records.values(), ...(state.settledDispatches ?? [])]
        .filter((r) => r.runId === state.runId && r.sessionId === args.task_id).at(-1);
      if (args.task_id !== undefined && (nested ? !prior?.nested || prior.nodeId !== null
        || prior.callerSessionId !== callerSessionId || prior.callerDispatchId !== root.dispatchId
        || previousBinding && previousBinding.runId !== state.runId : prior?.nested || previousBinding?.nested)) {
        return denied('TASK_CALLER_MISMATCH', 'task_id must belong to this caller and exact dispatch generation; use a fresh consultation');
      }
      if (nested) {
        const decision = runner.admitDispatch(state, { agent, now: NOW(), consultOnly: true });
        if (!decision.allowed) return decision;
        if ([...records.values()].some((r) => r.runId === state.runId && r.nested)) {
          return denied('NESTED_CONSULT_CAPACITY', 'one nested consultation is outstanding in this run; do not spin or wait on yourself; use available evidence or report the limitation');
        }
        const record = { runId: state.runId, rootSessionId, callerSessionId, callerDispatchId: root.dispatchId, nested: true,
          callID, agent, turnToken, nodeId: null, dispatchId: randomUUID(), sessionId: args.task_id ?? null,
          bound: false, continuation: args.task_id !== undefined, acknowledged: false, idleSeen: false, terminal: false,
          planVersion: state.artifacts.plan?.version ?? 0 };
        records.set(recordKey, record);
        recordDispatch();
        try { await persist(state, undefined, {}, true); }
        catch { return failedReservation(); }
        if (args.task_id) bindings.delete(args.task_id);
        return { ...decision, nested: true, turnToken };
      }
      // Selective repair revokes authority without ending host lifetimes. Both
      // fresh dispatch and task_id replacement wait for old calls AND effects.
      if (target && repairSettlementPending(state, target)) {
        return denied('REPAIR_SETTLEMENT_PENDING', `${target} has revoked host lifetimes or pending effects; wait for exact terminal/effect settlement before replacement`);
      }
      // A free-role continuation keeps the session identity: round-1
      // planners, explorers and multimodal sessions are free-bound (no node
      // identity to resume), but their conversation can still pick up the
      // next task. The shared reservation path below re-binds the same
      // session — node-bound when the runner has a ready node (e.g. the
      // REVISE'd plan node, attempt charged and revision findings injected),
      // free again otherwise.
      let continuationSession = null;
      if (args.task_id !== undefined) {
        let previous = bindings.get(args.task_id);
        // Cross-restart continuation: in-memory bindings are gone after a
        // plugin restart, but the run state still records which session last
        // worked each node. Rebuild the continuation identity from state.
        if (!previous) {
          const resumed = Object.values(state.nodes).find((node) => node.sessionId === args.task_id
            && node.spec.agent === agent && ['PENDING', 'INCOMPLETE', 'STALE'].includes(node.state));
          if (resumed) previous = { runId: root.runId, agent, nodeId: resumed.spec.id, sessionId: args.task_id, root: false, active: false };
          else if (CONTINUABLE_ROLES.has(agent)) {
            if (!await rootContinuationOwned(state, args.task_id, agent)) {
              return denied('TASK_CALLER_MISMATCH', 'task_id lacks authenticated native parentage and ownership in this run; use a fresh session');
            }
            continuationSession = args.task_id;
          }
        }
        const sameRole = previous && !previous.root && previous.runId === root.runId && previous.agent === agent;
        if (sameRole && previous.nodeId && target !== null && target !== previous.nodeId) {
          return denied('TASK_NODE_MISMATCH', `requested node ${target} conflicts with this task_id's node ${previous.nodeId}; continue ${previous.nodeId} with its matching marker, or dispatch ${target} with its own session or a fresh session`);
        }
        if (sameRole && current(previous)) {
          records.set(recordKey, { runId: root.runId, rootSessionId, callerSessionId, callID, agent, turnToken,
            nodeId: previous.nodeId, dispatchId: previous.dispatchId, sessionId: args.task_id,
            bound: true, continuation: true, acknowledged: false, idleSeen: false, terminal: false,
            planVersion: state.artifacts.plan?.version ?? 0 });
          recordDispatch();
          try { await persist(state, undefined, {}, true); }
          catch { return failedReservation(); }
          return { allowed: true, nodeId: previous.nodeId, continuation: true, turnToken };
        }
        // Resume continuation: the same session may pick its own unfinished
        // node back up (INCOMPLETE/PENDING/STALE with attempts left). A new
        // attempt is charged and the recorded side-effect ledger is attached.
        if (sameRole && previous.nodeId) {
          const node = state.nodes[previous.nodeId];
          const lastWorkedByCaller = node?.sessionId === args.task_id;
          if (node && lastWorkedByCaller && ['PENDING', 'INCOMPLETE', 'STALE'].includes(node.state)) {
            const decision = runner.admitDispatch(state, { agent, now: NOW(), nodeId: previous.nodeId });
            if (!decision.allowed) {
              await persist(state);
              const passthrough = decision.code === 'RECOVERY_REQUIRED' || decision.code === 'AWAITING_DECISION' || decision.code === 'WRITER_CAPACITY' || decision.code === 'READER_CAPACITY';
              return denied(passthrough ? decision.code : 'FRESH_SESSION_REQUIRED',
                `${previous.nodeId} cannot be continued in this session: ${decision.detail}`);
            }
            const dispatchId = randomUUID();
            records.set(recordKey, { runId: root.runId, rootSessionId, callerSessionId, callID, agent, turnToken,
              nodeId: previous.nodeId, dispatchId, sessionId: args.task_id,
              bound: false, continuation: true, resumed: true, acknowledged: false, idleSeen: false, terminal: false,
              planVersion: state.artifacts.plan?.version ?? 0 });
            bindings.delete(args.task_id); // the inactive entry is superseded by the resumed binding
            recordDispatch();
            try { await persist(state, undefined, {}, true); }
            catch { return failedReservation(); }
            return { allowed: true, nodeId: previous.nodeId, continuation: true, resumed: true, turnToken,
              reconcile: decision.reconcile, reviseFindings: decision.reviseFindings, repairEvidence: decision.repairEvidence };
          }
        }
        // Revoked read-only nodes retain a lifetime witness, not a permanent
        // node assignment. After the unfinished-node path above, their same-role
        // conversation may start a new consultation; writers never free-fallback.
        if (sameRole && (!previous.nodeId || previous.settlementOnly && CONTINUABLE_ROLES.has(agent))) continuationSession = args.task_id;
        if (!continuationSession) return denied('FRESH_SESSION_REQUIRED', 'task_id may only continue an active attempt, resume the unfinished node this session last worked on, or continue a session of the same role in this run; other nodes and foreign sessions need a fresh session');
      }
      // Free consultations never appear as nodes, so the runner-side reader
      // gate cannot see them: this layer counts them directly and holds them
      // to the same shared ceiling as RUNNING explore/analyze nodes. Only new
      // work reaches here — active-attempt continuations returned above.
      if (READ_CONSULT_AGENTS.has(agent)) {
        const capacity = runner.readerCapacity(state);
        const freeInFlight = [...records.values()].filter((r) => r.runId === root.runId && !r.nested && READ_CONSULT_AGENTS.has(r.agent) && !r.terminal && (!r.nodeId || r.settlementOnly)).length;
        const nodeInFlight = Object.values(state.nodes).filter((node) => (node.spec.kind === 'explore' || node.spec.kind === 'analyze') && node.state === 'RUNNING').length;
        if (freeInFlight + nodeInFlight >= capacity) {
          return denied('READER_CAPACITY', `${freeInFlight + nodeInFlight}/${capacity} read-only exploration/analysis tasks are in flight; wait for one to finish before dispatching another`);
        }
      }
      // Reservations are node-level: a fresh dispatch may not target a node
      // that another in-flight reservation already holds. Implementer
      // admission is additionally bounded by the writer capacity gate
      // (unbound reservations + RUNNING nodes); other roles keep single-flight
      // per-role pending semantics.
      const reserved = new Set([...records.values()].filter((r) => r.runId === root.runId && !r.settlementOnly && !r.bound && !r.terminal && r.nodeId && r.agent === agent).map((r) => r.nodeId));
      if (agent === 'graph-implementer') {
        if (target !== null && reserved.has(target)) return denied('DISPATCH_PENDING', `${target} is reserved and awaiting host session binding`);
        const running = Object.values(state.nodes).filter((node) => node.spec.kind === 'implement' && node.state === 'RUNNING').length;
        const capacity = runner.implementerCapacity(state);
        if (running + reserved.size >= capacity) {
          return denied('WRITER_CAPACITY', `${running} implement node(s) RUNNING and ${reserved.size} reservation(s) in flight; writer capacity ${running + reserved.size}/${capacity} is full`);
        }
      } else if (reserved.size > 0) {
        return denied('DISPATCH_PENDING', 'a task for this role is reserved and awaiting host session binding');
      }
      const decision = runner.admitDispatch(state, { agent, now: NOW(), nodeId: target, excludeNodeIds: reserved });
      if (!decision.allowed) {
        // A sorted pick that found nothing because every candidate is already
        // reserved is a pending reservation, not a missing graph.
        if (decision.code === 'NO_READY_NODE' && agent === 'graph-implementer' && reserved.size > 0) {
          return denied('DISPATCH_PENDING', `implement nodes are reserved and awaiting host session binding: ${[...reserved].join(', ')}`);
        }
        // A missing targeted node is a pure lookup failure. Do not persist an
        // empty dispatch history or a changed timestamp for a rejected call.
        if (decision.code !== 'NODE_NOT_FOUND') await persist(state);
        return decision;
      }
      records.set(recordKey, { runId: root.runId, rootSessionId, callerSessionId, callID, agent, turnToken, nodeId: decision.nodeId,
        dispatchId: randomUUID(), sessionId: continuationSession, bound: false, continuation: continuationSession !== null,
        resumed: continuationSession !== null, acknowledged: false, idleSeen: false, terminal: false, targeted: target !== null,
        planVersion: state.artifacts.plan?.version ?? 0 });
      if (continuationSession) bindings.delete(continuationSession); // the stale free binding must not block the fresh one
      recordDispatch();
      try { await persist(state, undefined, {}, true); }
      catch { return failedReservation(); }
      return { ...decision, turnToken, ...(continuationSession ? { continuation: true } : {}) };
    });
  }

  async function bind(record) {
    if (record.recoveryBlocked || record.bound || !record.sessionId || !parents.has(record.sessionId)) return;
    if (!record.acknowledged && !record.started) return;
    const state = store.getRun(record.runId);
    // A stale INACTIVE binding (its dispatch finished or was rejected) must
    // not block a freshly admitted reservation for the same session: allow
    // the overwrite. An active binding still refuses the collision.
    const established = bindings.get(record.sessionId);
    if (!state || !record.settlementOnly && (!['RUNNING', 'AWAITING_USER_DECISION'].includes(state.status) || (state.artifacts.plan?.version ?? 0) !== record.planVersion)
      || parents.get(record.sessionId) !== callerOf(record) || (established && established.active !== false)) return;
    const parent = bindings.get(record.callerSessionId);
    const settlementOnly = record.settlementOnly === true || record.nested && (!current(parent) || parent.dispatchId !== record.callerDispatchId)
      || state.status === 'AWAITING_USER_DECISION' && !record.started && !!record.nodeId;
    if (record.nodeId && !record.settlementOnly) {
      const node = state.nodes[record.nodeId];
      if (settlementOnly) {
        // An admitted host task can outlive the pause before beginNode. Bind
        // only its lifetime, never charge or grant workspace capability.
        if (!node || !['PENDING', 'INCOMPLETE', 'STALE'].includes(node.state)) return;
      } else if (!record.started) {
        // Re-validate the reserved node specifically. Reservations are
        // authoritative; a re-sorted choice must not silently reassign work.
        const decision = runner.admitDispatch(state, { agent: record.agent, now: NOW(), nodeId: record.nodeId });
        if (!decision.allowed) return;
        runner.beginNode(state, record.nodeId, { now: NOW(), sessionId: record.sessionId, dispatchId: record.dispatchId });
        record.started = true;
      } else if (node?.state !== 'RUNNING' || node.dispatchId !== record.dispatchId || node.sessionId !== record.sessionId) return;
    }
    record.bound = true;
    record.settlementOnly = settlementOnly;
    // Do not publish the binding until authoritative attempt/lifetime state is
    // saved. A repeated metadata event retries without charging another attempt.
    try {
      await persist(state);
      record.errorCode = null;
    } catch {
      record.bound = false;
      record.errorCode = 'BINDING_PERSISTENCE_FAILED';
      return;
    }
    // Binding proves ownership, not that the native queued prompt has ended.
    bindings.set(record.sessionId, { runId: record.runId, root: false, agent: record.agent,
      nodeId: record.nodeId, sessionId: record.sessionId, dispatchId: record.dispatchId, active: true, settlementOnly, ...provenance(record) });
    await consumeIdle(record.sessionId);
    if (record.terminal && ![...records.values()].some((r) => r.sessionId === record.sessionId && !r.terminal && !r.idleSeen)) await finish(record.sessionId, record.dispatchId);
  }

  async function onSession(info) {
    if (typeof info?.id !== 'string' || typeof info.parentID !== 'string') return;
    if (parents.has(info.id) && parents.get(info.id) !== info.parentID) return;
    parents.set(info.id, info.parentID);
    const runId = runForSession(info.parentID) ?? [...records.values()].find((r) => callerOf(r) === info.parentID)?.runId;
    if (!runId) return;
    await exclusive(runId, async () => {
      for (const record of records.values()) {
        if (callerOf(record) === info.parentID && record.sessionId === info.id) await bind(record);
      }
    });
  }

  async function finish(sessionId, dispatchId) {
    const binding = bindings.get(sessionId);
    const ended = (r) => r.sessionId === sessionId && r.dispatchId === dispatchId;
    const completed = [...records.values()].filter(ended).map((record) => ({ ...record }));
    if (!completed.length) return;
    const owner = completed[0];
    const state = store.getRun(owner.runId);
    if (!state) return;
    const node = state.nodes[owner.nodeId];
    // The original host call outlives execution rebinding. Only its exact
    // current attempt may be marked incomplete when that lifetime ends.
    if (!owner.settlementOnly && node?.sessionId === sessionId && node.dispatchId === dispatchId) {
      runner.markIncomplete(state, { nodeId: owner.nodeId, now: NOW() });
    }
    // Always retry persistence before releasing the lifetime, including when
    // an earlier save failed after mutating the node in memory.
    const history = [...(state.settledDispatches ?? []).filter((r) => !ended(r)), ...completed];
    const pinned = new Set([...records.values()].filter((r) => r.runId === state.runId && r.nested).map((r) => r.callerDispatchId));
    const kept = history.filter((r) => pinned.has(r.dispatchId));
    const settledDispatches = [...kept, ...history.filter((r) => !pinned.has(r.dispatchId)).slice(-(128 - kept.length))];
    const dependent = (r) => r.runId === state.runId && r.nested && r.callerSessionId === sessionId && r.callerDispatchId === dispatchId;
    const dispatchReservations = [...records.values()].filter((r) => r.runId === state.runId && !ended(r))
      .map((r) => dependent(r) ? { ...r, settlementOnly: true } : { ...r });
    await persist(state, ended, { settledDispatches, dispatchReservations });
    for (const r of records.values()) if (dependent(r)) r.settlementOnly = true;
    for (const b of bindings.values()) if (dependent(b)) b.settlementOnly = true;
    if (binding?.runId === owner.runId && binding.dispatchId === dispatchId) {
      binding.active = false;
      binding.settled = true;
    }
    for (const [id, record] of records) if (ended(record)) records.delete(id);
  }

  async function consumeIdle(sessionId, observed = null) {
    const pending = idleEvidence.get(sessionId) ?? [];
    const lifetimes = [...records.values()].filter((r) => r.sessionId === sessionId);
    if (!lifetimes.some((r) => r.bound || r.settlementOnly)) return;
    const state = store.getRun(lifetimes[0].runId);
    await refreshTurns(sessionId, callerOf(lifetimes[0]), observed);
    for (const dispatchId of new Set(lifetimes.map((r) => r.dispatchId))) {
      const calls = lifetimes.filter((r) => r.dispatchId === dispatchId);
      // Neither cached terminal flags nor sibling calls can retire a lifetime
      // whose original admission identity could not be authenticated.
      if (calls.some((r) => r.recoveryBlocked)) continue;
      // A failed begin/binding save must still reconcile through bind first.
      if (calls.some((r) => !r.bound && !r.settlementOnly)) continue;
      // Metadata is published before start/extend, and idle occurs before and
      // between queued prompts. Only a terminal child turn for EACH call proves
      // completion. Idle/status is secondary corroboration, never a substitute.
      const accounted = calls.every((r) => r.terminal || r.acknowledged && r.userAnchorSource === 'chat.message'
        && r.userMessageId && r.terminalMessageId && !r.anchorConflict && !r.turnConflict && !r.compactionPending && !r.lineageOverflow);
      const pendingEffects = (state.pendingEffects ?? []).some((effect) => effect.sessionId === sessionId);
      if (!accounted || pendingEffects && !calls.every((r) => r.terminal)) {
        if (calls.some((r) => {
          const saved = state.dispatchReservations?.find((entry) => callerOf(entry) === callerOf(r) && entry.callID === r.callID);
          return saved?.idleSeen !== r.idleSeen || saved?.acknowledged !== r.acknowledged || saved?.terminal !== r.terminal;
        })) await persist(state);
        continue;
      }
      if (!calls.every((r) => r.terminal)) {
        const idle = client?.session?.status ? await hostIsIdle(sessionId, callerOf(calls[0])) : pending.length > 0;
        if (!idle) continue;
      }
      await finish(sessionId, dispatchId);
    }
  }

  function boundedHash(value) {
    try {
      return createHash('sha256').update(JSON.stringify(cleanJson(value, { maxBytes: 131072, maxValues: 2048, maxDepth: 16 }))).digest('hex');
    } catch { return null; }
  }

  function replayHash(message, stripMedia) {
    const info = { agent: message.info.agent, model: message.info.model };
    for (const field of ['format', 'tools', 'system']) if (message.info[field] !== undefined) info[field] = message.info[field];
    const parts = message.parts.filter((part) => part.type !== 'compaction').map((part) => {
      // Native replay copies all non-identity fields, except image/PDF files
      // become attachment descriptions (message-v2.ts / util/media.ts).
      if (stripMedia && part.type === 'file' && (part.mime?.startsWith('image/') || part.mime === 'application/pdf')) {
        return { type: 'text', text: `[Attached ${part.mime}: ${part.filename ?? 'file'}]` };
      }
      const { id, sessionID, messageID, ...payload } = part;
      return payload;
    });
    return boundedHash({ info, parts });
  }

  function chronological(a, b) {
    return a.info.time.created - b.info.time.created || (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0);
  }

  function captureTurns(sessionId, callerSessionId, messages, scan, promptMessage = null) {
    let changed = false;
    const mine = [...records.values()].filter((r) => callerOf(r) === callerSessionId && (!r.sessionId || r.sessionId === sessionId) && r.turnToken);
    const validMessage = (m) => m?.info?.sessionID === sessionId && typeof m.info.id === 'string'
      && m.info.id.length <= 256 && Array.isArray(m.parts) && m.parts.length <= 256
      && m.parts.every((p) => p.sessionID === sessionId && p.messageID === m.info.id);
    const valid = messages.filter(validMessage);
    const carriesToken = (message, record) => message.info.role === 'user' && message.info.agent === record.agent
      && message.parts.some((p) => p.type === 'text' && !p.synthetic && typeof p.text === 'string'
        && p.text.length <= 131072 && p.text.split('\n').includes(`[RUNNER_TASK_CALL:${record.turnToken}]`));
    // Only the native prompt-creation hook supplies promptMessage. History scans,
    // message.updated events and exact lookups can all contain identical replays.
    const anchorMatches = promptMessage && validMessage(promptMessage) ? mine.filter((record) => carriesToken(promptMessage, record)) : [];
    const anchor = anchorMatches.length === 1 ? anchorMatches[0] : null;
    // Only the contiguous native page can establish adjacency. An exact lookup
    // can authenticate an individual message, but cannot fill an unknown gap.
    const window = scan.every((m) => validMessage(m) && Number.isFinite(m.info.time?.created)) ? [...scan].sort(chronological) : [];
    const runId = mine[0]?.runId;
    const all = [...records.values()].filter((r) => r.runId === runId).concat(store.getRun(runId)?.settledDispatches ?? []);
    let linkCount = all.reduce((n, r) => n + (r.userLineage?.length ?? 0), 0);
    let conflictCount = all.reduce((n, r) => n + (r.conflictingUserIds?.length ?? 0), 0);
    const set = (record, field, value) => {
      if (JSON.stringify(record[field]) !== JSON.stringify(value)) { record[field] = value; changed = true; }
    };
    const clearTerminal = (record) => {
      for (const field of ['terminalMessageId', 'terminalFinish', 'terminalUserMessageId']) {
        if (Object.hasOwn(record, field)) { delete record[field]; changed = true; }
      }
    };
    for (const record of mine) {
      const tokenUsers = valid.filter((message) => carriesToken(message, record))
        .sort((a, b) => Number.isFinite(a.info.time?.created) && Number.isFinite(b.info.time?.created) ? chronological(a, b) : 0);
      if (record === anchor) {
        if (record.userMessageId && record.userMessageId !== promptMessage.info.id) {
          set(record, 'anchorConflict', true);
          clearTerminal(record);
        } else {
          if (record.userAnchorSource !== 'chat.message') {
            // Do not upgrade old scan-derived terminal/lineage claims along with
            // a newly proven root; descendants must be authenticated again.
            clearTerminal(record);
            if (record.userLineage) { linkCount -= record.userLineage.length ?? 0; delete record.userLineage; changed = true; }
          }
          set(record, 'sessionId', sessionId);
          set(record, 'userMessageId', promptMessage.info.id);
          set(record, 'userAnchorSource', 'chat.message');
        }
      }
      if (!record.userMessageId || record.userAnchorSource !== 'chat.message' || record.anchorConflict) continue;
      const lineage = [...(record.userLineage ?? [])];
      let leaf = lineage.at(-1)?.userMessageId ?? record.userMessageId;
      while (!record.lineageOverflow) {
        const sourceIndex = window.findIndex((m) => m.info.id === leaf);
        if (sourceIndex < 0) break;
        const source = window[sourceIndex];
        const requestIndex = window.findIndex((m, i) => i > sourceIndex && m.info.role === 'user');
        if (requestIndex < 0) break;
        const request = window[requestIndex];
        const compaction = request.parts.find((p) => p.type === 'compaction');
        if (!compaction) break;
        set(record, 'compactionPending', request.info.id);
        clearTerminal(record);
        const nextIndex = window.findIndex((m, i) => i > requestIndex && m.info.role === 'user');
        if (nextIndex < 0 || compaction.auto !== true || request.parts.length !== 1
          || source.info.agent !== record.agent || request.info.agent !== record.agent) break;
        const next = window[nextIndex];
        const between = window.slice(requestIndex + 1, nextIndex);
        const summary = between.length === 1 ? between[0] : null;
        if (!summary || summary.info.role !== 'assistant' || summary.info.summary !== true
          || summary.info.agent !== 'compaction' || summary.info.mode !== 'compaction'
          || summary.info.parentID !== request.info.id || summary.info.error
          || !['stop', 'length'].includes(summary.info.finish) || !Number.isFinite(summary.info.time?.completed)
          || summary.info.time.completed < summary.info.time.created || summary.info.time.completed > next.info.time.created
          || summary.parts.some((p) => p.type === 'tool') || next.info.agent !== record.agent) break;
        const model = typeof source.info.model?.providerID === 'string' && typeof source.info.model?.modelID === 'string'
          ? boundedHash(source.info.model) : null;
        if (!model || model !== boundedHash(request.info.model) || model !== boundedHash(next.info.model)) break;
        const expected = compaction.overflow === true ? replayHash(source, true) : null;
        const replay = expected && expected === replayHash(next, false);
        const part = next.parts.length === 1 ? next.parts[0] : null;
        const automatic = part?.type === 'text' && part.synthetic === true && part.metadata?.compaction_continue === true
          && part.text === (compaction.overflow === true ? COMPACTION_OVERFLOW : '') + COMPACTION_CONTINUE
          && Number.isFinite(part.time?.start) && Number.isFinite(part.time?.end)
          && part.time.start >= next.info.time.created && part.time.end >= part.time.start
          && next.info.format === undefined && next.info.tools === undefined && next.info.system === undefined;
        if (!replay && !automatic) break;
        if (lineage.length >= 64 || linkCount >= 64) { set(record, 'lineageOverflow', true); break; }
        lineage.push({ fromUserId: leaf, compactionMessageId: request.info.id, summaryMessageId: summary.info.id,
          userMessageId: next.info.id, kind: replay ? 'replay' : 'auto' });
        linkCount++;
        set(record, 'userLineage', [...lineage]);
        set(record, 'compactionPending', null);
        leaf = next.info.id;
      }
      const owned = new Set([record.userMessageId, ...lineage.map((edge) => edge.userMessageId)]);
      const legacyConflict = record.legacyTurnConflict === true || record.turnConflict === true && !Array.isArray(record.conflictingUserIds);
      if (legacyConflict) set(record, 'legacyTurnConflict', true);
      const conflicts = new Set(record.conflictingUserIds ?? []);
      for (const message of tokenUsers) {
        if (!owned.has(message.info.id) && !conflicts.has(message.info.id)) {
          if (conflicts.size >= 64 || conflictCount >= 64) set(record, 'lineageOverflow', true);
          else { conflicts.add(message.info.id); conflictCount++; }
        }
      }
      for (const id of owned) if (conflicts.delete(id)) conflictCount--;
      if (conflicts.size || record.conflictingUserIds) set(record, 'conflictingUserIds', [...conflicts]);
      if (legacyConflict || conflicts.size || record.turnConflict !== undefined) set(record, 'turnConflict', legacyConflict || conflicts.size > 0);
      if (record.turnConflict || record.compactionPending || record.lineageOverflow) continue;
      const related = valid.filter((m) => m.info.role === 'assistant' && owned.has(m.info.parentID));
      const settledTools = (m) => m.parts.every((p) => p.type !== 'tool'
        || ['completed', 'error'].includes(p.state?.status) && Number.isFinite(p.state?.time?.end));
      if (related.some((m) => !settledTools(m))) continue;
      // Native prompt.ts keeps looping on ordinary tool calls even if a provider
      // reports finish=stop. Compaction summaries likewise never finish the task.
      const terminal = related.find((m) => m.info.parentID === leaf && (m.info.agent ?? m.info.mode) === record.agent && !m.info.error && !m.info.summary
        && m.parts.every((p) => p.type !== 'tool' || p.metadata?.providerExecuted === true)
        && ['stop', 'length', 'content-filter'].includes(m.info.finish) && Number.isFinite(m.info.time?.completed));
      if (terminal && !record.terminalMessageId) {
        set(record, 'terminalMessageId', terminal.info.id);
        set(record, 'terminalFinish', terminal.info.finish);
        set(record, 'terminalUserMessageId', leaf);
      }
    }
    return changed;
  }

  async function refreshTurns(sessionId, callerSessionId, observed = null, fromPrompt = false) {
    const signal = AbortSignal.timeout(2000);
    let messages = [];
    let scan = [];
    if (client?.session?.get && client?.session?.messages) {
      try {
        const info = (await client.session.get({ path: { id: sessionId }, signal })).data;
        if (info?.id !== sessionId || info.parentID !== callerSessionId) return;
        parents.set(sessionId, callerSessionId);
        const response = (await client.session.messages({ path: { id: sessionId }, query: { limit: 64 }, signal })).data;
        if (Array.isArray(response)) { scan = response.slice(-64); messages = [...scan]; }
      } catch { /* No scan result is not proof of completion. */ }
    }
    if (parents.get(sessionId) !== callerSessionId) return;
    // The page was read after an exact lookup and may contain a newer summary
    // or completed part. Do not replace it with an older observed snapshot.
    if (observed && !messages.some((m) => m.info?.id === observed.info?.id)) messages.push(observed);
    if (observed?.info?.role === 'assistant' && typeof observed.info.parentID === 'string' && observed.info.parentID.length <= 256
      && !messages.some((m) => m.info?.id === observed.info.parentID) && client?.session?.message) {
      try {
        const parent = (await client.session.message({ path: { id: sessionId, messageID: observed.info.parentID }, signal })).data;
        if (parent?.info?.id === observed.info.parentID && parent.info.sessionID === sessionId) messages.push(parent);
      } catch { /* A missing parent cannot authenticate this turn. */ }
    }
    const mine = [...records.values()].filter((r) => callerOf(r) === callerSessionId && r.sessionId === sessionId);
    const candidates = [...records.values()].filter((r) => callerOf(r) === callerSessionId && (!r.sessionId || r.sessionId === sessionId));
    if (!candidates.length) return;
    const before = candidates.map((record) => [record, structuredClone(record)]);
    const changed = captureTurns(sessionId, callerSessionId, messages, scan, fromPrompt ? observed : null);
    const state = store.getRun(candidates[0].runId);
    const unsaved = mine.some((record) => {
      const saved = state.dispatchReservations?.find((r) => r.callID === record.callID && r.dispatchId === record.dispatchId);
      return saved?.userMessageId !== record.userMessageId || saved?.terminalMessageId !== record.terminalMessageId || saved?.turnConflict !== record.turnConflict;
    });
    if (changed || unsaved) {
      try { await persist(state); }
      catch (error) {
        // Proof candidates must not poison later terminal saves on storage or
        // aggregate-budget failure. Rooted witnesses can be read again; an
        // unsaved original anchor still requires its native prompt hook.
        for (const [record, snapshot] of before) {
          for (const field of Object.keys(record)) delete record[field];
          Object.assign(record, snapshot);
        }
        throw error;
      }
    }
  }

  async function observeMessage(info, parts, fromPrompt = false) {
    if (typeof info?.sessionID !== 'string' || typeof info?.id !== 'string' || info.id.length > 256 || info.sessionID.length > 256) return;
    let runId = runForSession(info.sessionID);
    if (!runId && client?.session?.get) {
      try {
        const session = (await client.session.get({ path: { id: info.sessionID }, signal: AbortSignal.timeout(2000) })).data;
        const root = bindings.get(session?.parentID);
        if (session?.id === info.sessionID && root) {
          parents.set(info.sessionID, session.parentID);
          runId = root.runId;
        }
      } catch { return; }
    }
    if (!runId || bindings.get(info.sessionID)?.root) return;
    await exclusive(runId, async () => {
      let message = fromPrompt && info.role === 'user' && Array.isArray(parts) ? { info, parts } : null;
      if (!message && client?.session?.message) {
        try { message = (await client.session.message({ path: { id: info.sessionID, messageID: info.id }, signal: AbortSignal.timeout(2000) })).data; }
        catch { return; }
        if (message?.info?.id !== info.id || message.info.sessionID !== info.sessionID) return;
      }
      await refreshTurns(info.sessionID, parents.get(info.sessionID), message, fromPrompt);
      await consumeIdle(info.sessionID);
    });
  }

  const onMessage = (info) => observeMessage(info);
  const onUserPrompt = (info, parts) => info?.role === 'user' && Array.isArray(parts)
    ? observeMessage(info, parts, true) : Promise.resolve();

  async function reconcileSession(sessionId) {
    const runId = runForSession(sessionId);
    if (runId) await exclusive(runId, () => consumeIdle(sessionId));
  }

  async function hostIsIdle(sessionId, callerSessionId) {
    if (!client?.session?.get || !client?.session?.status) return false;
    const signal = AbortSignal.timeout(2000);
    try {
      const info = (await client.session.get({ path: { id: sessionId }, signal })).data;
      if (info?.id !== sessionId || info.parentID !== callerSessionId) return false;
      const statuses = (await client.session.status({ signal })).data;
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return false;
      // The native active-status map can omit idle sessions; the successful
      // parentage lookup above distinguishes that from an unknown session.
      return !Object.hasOwn(statuses, sessionId) || statuses[sessionId]?.type === 'idle';
    } catch { return false; }
  }

  async function onPart(part) {
    if (part?.type !== 'tool' || part.tool !== 'task') return;
    const recordKey = key(part.sessionID, part.callID);
    const record = records.get(recordKey);
    if (!record) return;
    await exclusive(record.runId, () => applyPart(part, recordKey, record));
  }

  // Also used by serialized restart reconciliation; never nests the run queue.
  async function applyPart(part, recordKey, record) {
    if (records.get(recordKey) !== record || record.recoveryBlocked) return; // revoked or insufficient lifetime proof
    const meta = part.state?.metadata;
    // The host call key is authoritative. Optional metadata may strengthen
    // it, but contradictory identity must never retire that call's owner.
    if (part.state?.input?.subagent_type !== undefined && part.state.input.subagent_type !== record.agent
      || meta?.parentSessionId !== undefined && meta.parentSessionId !== callerOf(record)
      || record.sessionId && meta?.sessionId !== undefined && meta.sessionId !== record.sessionId) return;
    if ((part.state?.status === 'running' || part.state?.status === 'completed' && meta?.background === true) && typeof meta?.sessionId === 'string'
      && meta.parentSessionId === callerOf(record) && part.state.input?.subagent_type === record.agent) {
      if (record.sessionId && record.sessionId !== meta.sessionId) return;
      record.sessionId = meta.sessionId;
      record.background = meta.background === true;
      record.acknowledged = true;
      await bind(record);
      await consumeIdle(record.sessionId);
    }
    if (part.state?.status === 'error') {
      record.hostError = true; // A cancelled/failed background task has no generation-linked end proof.
      await persist(store.getRun(record.runId));
      return;
    }
    if (part.state?.status === 'completed' && !meta?.background && !record.background) {
      record.terminal = true;
      if (!record.acknowledged) record.idleSeen = true;
      if (!record.bound && record.started) await bind(record);
      else if (!record.bound) {
        await persist(store.getRun(record.runId), (r) => r === record);
        records.delete(recordKey);
      } else await consumeIdle(record.sessionId);
    }
  }

  async function onIdle(sessionId, eventId) {
    const binding = bindings.get(sessionId);
    const runId = runForSession(sessionId);
    if (!runId || binding?.root) return;
    await exclusive(runId, async () => {
      const state = store.getRun(runId);
      if (!state) return;
      const previousSeen = seenIdleEvents.get(runId);
      const seen = new Set([...(previousSeen ?? state.idleEventIds ?? [])].slice(-255));
      // Rolling dedup suppresses redundant hints only. An evicted/ID-less idle
      // still cannot substitute for the per-call child-turn completion proof.
      const identity = createHash('sha256').update(key(sessionId, typeof eventId === 'string' ? eventId : 'legacy-idle')).digest('hex');
      if (seen.has(identity)) { await persist(state); await consumeIdle(sessionId); return; }
      const candidates = [...records.values()].filter((r) => r.runId === runId && !r.terminal && !r.idleSeen
        && (!parents.has(sessionId) || callerOf(r) === parents.get(sessionId))
        && (r.sessionId === sessionId || !r.sessionId && !r.continuation));
      if (!candidates.length) { await consumeIdle(sessionId); return; }
      seen.add(identity);
      seenIdleEvents.set(runId, seen);
      const previousPending = idleEvidence.get(sessionId);
      const pending = [...(previousPending ?? [])];
      pending.push({ identity, runId, rootSessionId: state.rootSessionId, sessionId,
        owners: candidates.map(({ callID, dispatchId }) => ({ callID, dispatchId })) });
      idleEvidence.set(sessionId, pending);
      // Save the transition and its receipt-time reservation fence even when
      // metadata/parent binding has not arrived. No event redelivery is required.
      try { await persist(state); }
      catch (error) {
        if (previousSeen) seenIdleEvents.set(runId, previousSeen); else seenIdleEvents.delete(runId);
        if (previousPending) idleEvidence.set(sessionId, previousPending); else idleEvidence.delete(sessionId);
        throw error;
      }
      await consumeIdle(sessionId);
    });
  }

  // Plan publication revokes all execution; repair selects only affected nodes.
  // Neither transition ends native host lifetimes.
  // Save the candidate graph and revoked ledger before changing live authority.
  async function revokeExecution(state, { nodeIds = null } = {}) {
    const selected = nodeIds === null ? null : new Set(nodeIds);
    const owners = new Set([...records.values(), ...(state.settledDispatches ?? [])]
      .filter((r) => r.runId === state.runId && (selected === null || selected.has(r.nodeId))).map((r) => r.dispatchId));
    const affected = (r) => r.runId === state.runId && (selected === null || selected.has(r.nodeId) || r.nested && owners.has(r.callerDispatchId));
    const revoked = (r) => affected(r) ? { ...r, settlementOnly: true, ...(selected ? { repairRevoked: true } : {}) } : { ...r };
    const dispatchReservations = [...records.values()].filter((r) => r.runId === state.runId).map(revoked);
    await persist(state, undefined, { dispatchReservations,
      ...(selected ? { pendingEffects: (state.pendingEffects ?? []).map((effect) => selected.has(effect.nodeId) ? { ...effect, repairRevoked: true } : effect) } : {}),
      settledDispatches: (state.settledDispatches ?? []).map(revoked) }, selected !== null);
    for (const record of records.values()) if (affected(record)) Object.assign(record, revoked(record));
    for (const binding of bindings.values()) if (!binding.root && affected(binding)) Object.assign(binding, revoked(binding));
  }

  function invalidate(runId) {
    // A restart/resume cannot erase a nested lifetime or its lineage witness.
    if ([...records.values()].some((r) => r.runId === runId && r.nested)) {
      for (const r of records.values()) if (r.runId === runId) r.settlementOnly = true;
      for (const b of bindings.values()) if (b.runId === runId && !b.root) b.settlementOnly = true;
      const state = store.getRun(runId);
      if (state) state.dispatchReservations = [...records.values()].filter((r) => r.runId === runId).map((r) => ({ ...r }));
      return;
    }
    for (const [id, record] of records) if (record.runId === runId) records.delete(id);
    const state = store.getRun(runId);
    if (state) { state.dispatchReservations = []; state.pendingIdleEvidence = []; }
    for (const [id, binding] of bindings) if (!binding.root && binding.runId === runId) bindings.delete(id);
    for (const sessionId of idleEvidence.keys()) if (bindings.get(parents.get(sessionId))?.runId === runId) idleEvidence.delete(sessionId);
  }

  function managed(sessionId) {
    if (runForSession(sessionId) !== null) return true;
    const seen = new Set();
    for (let id = sessionId; typeof id === 'string' && !seen.has(id) && seen.size < 32; id = parents.get(id)) {
      seen.add(id);
      if (parents.get(id) === null) return false;
    }
    // Only a complete host-verified native ancestry can exempt a descendant.
    return [...bindings.values()].some((binding) => binding.root);
  }

  // Read-only lookup: which run does a session belong to? Managed children
  // without their own binding (rejected or finished dispatches) resolve
  // through the host-verified parent chain to the root orchestrator's run.
  function runForSession(sessionId) {
    const seen = new Set();
    for (let id = sessionId; typeof id === 'string' && !seen.has(id) && seen.size < 32; id = parents.get(id)) {
      seen.add(id);
      const binding = bindings.get(id);
      if (binding) return binding.runId;
      const record = [...records.values()].find((r) => r.sessionId === id);
      if (record) return record.runId;
    }
    return null;
  }

  async function resolveSession(sessionId) {
    if (bindings.has(sessionId)) {
      // A stale inactive binding must not mask an admitted reservation that
      // is still waiting to bind this session: only short-circuit when the
      // session has nothing pending.
      const pendingReservation = [...records.values()].some((r) => r.sessionId === sessionId && !r.bound && !r.terminal);
      if (!pendingReservation) return true;
    }
    if (!client?.session?.get || !client?.session?.messages) return false;
    try {
      const signal = AbortSignal.timeout(2000);
      const response = await client.session.get({ path: { id: sessionId }, signal });
      const info = response.data;
      if (info?.id !== sessionId) return false;
      if (info.parentID != null && !identityString(info.parentID)) return false;
      if (parents.has(sessionId) && parents.get(sessionId) !== (info.parentID ?? null)) return false;
      parents.set(sessionId, typeof info.parentID === 'string' ? info.parentID : null);
      const visited = new Set([sessionId]);
      for (let parent = info.parentID; typeof parent === 'string' && !runForSession(parent); parent = parents.get(parent)) {
        if (visited.has(parent) || visited.size >= 32) return false;
        visited.add(parent);
        if (parents.has(parent)) continue;
        const ancestor = (await client.session.get({ path: { id: parent }, signal })).data;
        if (ancestor?.id !== parent || ancestor.parentID != null && !identityString(ancestor.parentID)) return false;
        parents.set(parent, ancestor.parentID ?? null);
      }
      if (!runForSession(info.parentID)) return false;
      await onSession(info);
      const messages = await client.session.messages({ path: { id: info.parentID }, query: { limit: 64 }, signal });
      if (!Array.isArray(messages.data)) return false;
      for (const message of messages.data.slice(-64)) {
        if (!Array.isArray(message.parts)) continue;
        for (const part of message.parts.slice(0, 256)) {
          if (part.state?.metadata?.sessionId === sessionId) await onPart(part);
        }
      }
      return bindings.has(sessionId);
    } catch {
      return false;
    }
  }

  async function ensureSession(sessionId) {
    let flight = resolutions.get(sessionId);
    if (!flight) {
      flight = resolveSession(sessionId);
      resolutions.set(sessionId, flight);
    }
    try { return await flight; }
    finally { if (resolutions.get(sessionId) === flight) resolutions.delete(sessionId); }
  }

  function inspect(runId) {
    const state = store.getRun(runId);
    const issues = Array.isArray(state?.dispatchRecoveryIssues) ? state.dispatchRecoveryIssues
      : hasRecoveryIssues(state) ? [{ code: 'INVALID_RECOVERY_ISSUES' }] : [];
    return [...[...records.values()].filter((r) => r.runId === runId).map((r) => ({
      callID: r.callID, nodeId: r.nodeId, agent: r.agent, sessionId: r.sessionId, bound: r.bound, continuation: r.continuation,
      callerSessionId: callerOf(r), nested: r.nested === true, ...(r.nested ? { callerDispatchId: r.callerDispatchId } : {}),
      resumed: r.resumed === true, targeted: r.targeted === true,
      ...(r.repairRevoked ? { repairRevoked: true } : {}),
      ...(r.settlementOnly ? { settlementOnly: true } : {}),
      ...(r.recoveryBlocked ? { recoveryBlocked: r.recoveryBlocked } : {}),
      errorCode: r.errorCode ?? null,
    })), ...issues.map((issue, issueIndex) => ({ issueIndex, bound: false, settlementOnly: true,
      recoveryBlocked: issue?.code ?? 'INVALID_RECOVERY_ISSUE',
      callID: identityString(issue?.reservation?.callID) ? issue.reservation.callID : null,
      nodeId: typeof issue?.reservation?.nodeId === 'string' ? issue.reservation.nodeId : null,
      errorCode: 'DISPATCH_RECOVERY_UNRESOLVED' }))];
  }

  // Called only while rebinding a root after restart. Paused ownership and
  // plan-revoked lifetimes grant settlement, never execution. Revoked calls
  // must also survive a restart BEFORE the replacement graph reaches a pause.
  async function recoverPaused(state) {
    const paused = state.status === 'AWAITING_USER_DECISION';
    if (!paused && !hasRecoveryIssues(state) && !state.dispatchReservations?.some((r) => r?.settlementOnly || r?.nested)) return;
    const idleEventIds = [...new Set((state.idleEventIds ?? []).slice(-256))];
    const recoveryRecords = new Map();
    const recoveryBindings = new Map();
    const recoveryParents = new Map();
    const recoveryIdle = new Map([...idleEvidence].map(([session, entries]) => [session,
      entries.filter((entry) => entry.runId === state.runId)]).filter(([, entries]) => entries.length));
    const parentFor = (session) => recoveryParents.get(session) ?? parents.get(session);
    // A single lifetime ledger is persisted for the run. Restoring revoked
    // calls must not discard newer active consultations from that same ledger.
    // Outside a pause, crash recovery restores only settlement capability;
    // explicit resume still owns ordinary attempt refund/reconciliation.
    const { restored, issues, settled } = partitionReservations(state);
    for (const node of Object.values(state.nodes)) {
      if (!paused || node.state !== 'RUNNING' || !node.sessionId || !node.dispatchId
        || restored.some((r) => r.dispatchId === node.dispatchId)
        || issues.some((issue) => issue?.reservation?.nodeId === node.spec.id && issue.reservation.sessionId === node.sessionId)) continue;
      // Compatibility with pre-lifetime-ledger runs: a persisted node identity
      // is sufficient to restore a blocker, not to infer an idle event's lifetime
      // or re-dispatch. Without the original per-call correlation token a legacy
      // identity cannot be discharged just because native status says idle.
      issues.push({ code: 'LEGACY_LIFETIME_WITHOUT_ADMISSION', reservation: { runId: state.runId, rootSessionId: state.rootSessionId, callID: `recovery:${node.dispatchId}`,
        nodeId: node.spec.id, agent: node.spec.agent, sessionId: node.sessionId, dispatchId: node.dispatchId,
        bound: true, started: true, acknowledged: true, terminal: false, idleSeen: false,
        planVersion: state.artifacts.plan?.version ?? 0, recovery: true } });
    }
    const recoveryFields = issues.length || state.dispatchRecoveryIssues !== undefined ? { dispatchRecoveryIssues: issues } : {};
    const callOrder = new Map((Array.isArray(state.dispatchCallIds) ? state.dispatchCallIds : []).map((id, index) => [id, index]));
    const dispatchOrder = new Map();
    for (const record of [...restored, ...settled]) {
      if (record.runId !== state.runId || record.rootSessionId !== state.rootSessionId) continue;
      const order = callOrder.get(key(callerOf(record), record.callID));
      if (order !== undefined && order > (dispatchOrder.get(record.dispatchId) ?? -1)) dispatchOrder.set(record.dispatchId, order);
    }
    const exactOwner = (identity) => {
      const node = state.nodes[identity.nodeId];
      return !!node && node.sessionId === identity.sessionId && node.dispatchId === identity.dispatchId;
    };
    function restoreBinding(record, active) {
      if (record.recoveryBlocked) return;
      const order = dispatchOrder.get(record.dispatchId) ?? -1;
      // Free sessions have no node identity fallback for missing admission proof.
      if (!record.nodeId && order < 0) return;
      const existing = recoveryBindings.get(record.sessionId) ?? bindings.get(record.sessionId);
      if (existing) {
        if (existing.root || existing.runId !== state.runId) return;
        const exact = exactOwner(record);
        const existingExact = exactOwner(existing);
        if (existingExact && !exact) return;
        // Neither settlement arrival nor an older still-active lifetime defines
        // the latest free binding. Continuations share one dispatch identity.
        if (exact === existingExact && order <= (dispatchOrder.get(existing.dispatchId) ?? -1)) return;
      }
      recoveryBindings.set(record.sessionId, { runId: record.runId, root: false, agent: record.agent, nodeId: record.nodeId,
        sessionId: record.sessionId, dispatchId: record.dispatchId, active, ...(!active ? { settled: true } : {}), settlementOnly: record.settlementOnly === true, ...provenance(record) });
    }
    for (const record of restored) {
      const recordKey = key(callerOf(record), record.callID);
      recoveryRecords.set(recordKey, { ...record });
      if (record.sessionId && (record.bound || record.started)) {
        if (parentFor(record.sessionId) !== undefined && parentFor(record.sessionId) !== callerOf(record)) continue;
        recoveryParents.set(record.sessionId, callerOf(record));
        restoreBinding(record, true);
        recoveryRecords.get(recordKey).bound = true;
      }
    }
    for (const record of settled) {
      if (!paused && !record.settlementOnly || record.runId !== state.runId || record.rootSessionId !== state.rootSessionId) continue;
      restoreBinding(record, false);
    }
    for (const evidence of (state.pendingIdleEvidence ?? []).slice(0, 128)) {
      if (evidence.runId !== state.runId || evidence.rootSessionId !== state.rootSessionId
        || typeof evidence.sessionId !== 'string' || !Array.isArray(evidence.owners)) continue;
      const owners = evidence.owners.slice(0, 128).filter((owner) => {
        const record = [...recoveryRecords.values()].find((r) => r.callID === owner.callID && r.dispatchId === owner.dispatchId);
        return record?.dispatchId === owner.dispatchId && (!record.sessionId || record.sessionId === evidence.sessionId);
      });
      const caller = [...recoveryRecords.values()].find((r) => owners.some((o) => o.dispatchId === r.dispatchId && o.callID === r.callID));
      if (!owners.length || !caller || parentFor(evidence.sessionId) !== undefined && parentFor(evidence.sessionId) !== callerOf(caller)) continue;
      recoveryParents.set(evidence.sessionId, callerOf(caller));
      const pending = recoveryIdle.get(evidence.sessionId) ?? [];
      if (!pending.some((entry) => entry.identity === evidence.identity)) pending.push({ ...evidence, owners });
      recoveryIdle.set(evidence.sessionId, pending);
    }

    // Save the COMPLETE scoped projection before publishing any private state.
    // Calling persist here would derive the ledger from the live registry and
    // require destructive pre-save mutation; an EIO followed by another event
    // could then serialize that partial registry and erase unproven work.
    const dispatchReservations = [...recoveryRecords.values()];
    const pendingIdleEvidence = projectIdleEvidence(state.runId, dispatchReservations, [...recoveryIdle.values()].flat());
    const candidate = structuredClone({ ...state, ...recoveryFields, dispatchReservations, idleEventIds, pendingIdleEvidence });
    sanitizeRun(candidate); // No truncation to fit recovery/issues into the run.
    await store.saveRun(candidate);

    // No await between durable save and publication. Merge only this run's
    // records and staged keys: other runs may have changed while save awaited.
    Object.assign(state, {
      dispatchReservations: candidate.dispatchReservations, idleEventIds: candidate.idleEventIds,
      pendingIdleEvidence: candidate.pendingIdleEvidence, updatedAt: candidate.updatedAt,
      ...(Object.hasOwn(recoveryFields, 'dispatchRecoveryIssues') ? { dispatchRecoveryIssues: candidate.dispatchRecoveryIssues } : {}),
    });
    for (const [id, record] of records) if (record.runId === state.runId) records.delete(id);
    for (const [id, record] of recoveryRecords) records.set(id, record);
    for (const [session, binding] of recoveryBindings) {
      const existing = bindings.get(session);
      if (!existing || !existing.root && existing.runId === state.runId) bindings.set(session, binding);
    }
    for (const [session, parent] of recoveryParents) {
      if (!parents.has(session) || parents.get(session) === parent) parents.set(session, parent);
    }
    publishIdleHistory(state.runId, candidate.idleEventIds, candidate.pendingIdleEvidence);

    for (const sessionId of idleEvidence.keys()) {
      if (bindings.get(sessionId)?.runId === state.runId) await consumeIdle(sessionId);
    }
    if (client?.session?.messages) {
      for (const callerSessionId of new Set([state.rootSessionId, ...restored.map(callerOf)])) {
        let messages;
        try { messages = (await client.session.messages({ path: { id: callerSessionId }, query: { limit: 64 }, signal: AbortSignal.timeout(2000) })).data; }
        catch { messages = null; }
        for (const message of Array.isArray(messages) ? messages.slice(-64) : []) {
          for (const part of Array.isArray(message.parts) ? message.parts.slice(0, 256) : []) {
            if (part?.type !== 'tool' || part.tool !== 'task' || part.sessionID !== callerSessionId) continue;
            const recordKey = key(part.sessionID, part.callID);
            const record = records.get(recordKey);
            if (!record || record.runId !== state.runId) continue;
            const sessionId = part.state?.metadata?.sessionId;
            if (typeof sessionId === 'string' && !parents.has(sessionId) && client.session.get) {
              try {
                const info = (await client.session.get({ path: { id: sessionId }, signal: AbortSignal.timeout(2000) })).data;
                if (info?.id === sessionId && info.parentID === callerSessionId) parents.set(sessionId, info.parentID);
              } catch { /* Unknown parentage remains unbound and cannot execute. */ }
            }
            await applyPart(part, recordKey, record);
          }
        }
      }
    }
    for (const sessionId of new Set([...records.values()].filter((r) => r.runId === state.runId && r.sessionId).map((r) => r.sessionId))) {
      await consumeIdle(sessionId);
    }
  }

  return Object.freeze({ admit, onSession, onPart, onIdle, onMessage, onUserPrompt, reconcileSession, ensureSession, invalidate, revokeExecution, exclusive, managed, owns, current, runForSession, inspect, recoverPaused });
}
