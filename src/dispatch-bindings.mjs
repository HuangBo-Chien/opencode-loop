// Native task correlation. Session creation order is not dispatch order.
// Only host task metadata, keyed by parent session + callID, can bind work.
import { createHash, randomUUID } from 'node:crypto';
import { resolveNodeIdHint, TARGET_REQUIRED_AGENTS } from './dispatch-target.mjs';
import { cleanJson } from './json-safe.mjs';
import { assertSettlementCapacity } from './runner.mjs';

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
// Pinned native v1.18.25 compaction.ts creates this text with its internal
// compaction_continue marker. Text alone is never a lineage witness.
const COMPACTION_CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const COMPACTION_OVERFLOW = "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n";
export function createDispatchBindings({ store, runner, bindings, client }) {
  const records = new Map();
  const parents = new Map();
  const tails = new Map();
  const resolutions = new Map();
  const idleEvidence = new Map();
  const seenIdleEvents = new Map();

  // Persist host lifetimes as well as node state. A delivered node and a free
  // consultation may still have an active host child when a sibling pauses.
  async function persist(state, omit = () => false, extra = {}, reserve = false) {
    const dispatchReservations = [...records.values()].filter((r) => r.runId === state.runId && !omit(r)).map((r) => ({ ...r }));
    const idleEventIds = [...(seenIdleEvents.get(state.runId) ?? new Set(state.idleEventIds ?? []))].slice(-256);
    const live = new Set(dispatchReservations.map((r) => key(r.callID, r.dispatchId)));
    // Receipts are hints, not completion authority. Bound total ownership refs
    // (not just each array), and discard references as reservations retire.
    let remaining = 256;
    const pendingIdleEvidence = (extra.pendingIdleEvidence ?? [...idleEvidence.values()].flat())
      .filter((entry) => entry.runId === state.runId).slice(-128).reverse().map((entry) => {
        const owners = entry.owners.filter((owner) => live.has(key(owner.callID, owner.dispatchId))).slice(0, remaining);
        remaining -= owners.length;
        return { ...entry, owners };
      }).filter((entry) => entry.owners.length).reverse();
    const saved = { ...state, ...extra, dispatchReservations, idleEventIds, pendingIdleEvidence };
    if (reserve) assertSettlementCapacity(saved);
    cleanJson(saved, { maxBytes: 1_048_576, maxValues: 20_000, maxDepth: 32 });
    await store.saveRun(saved);
    state.dispatchReservations = dispatchReservations;
    state.idleEventIds = idleEventIds;
    state.pendingIdleEvidence = saved.pendingIdleEvidence;
    state.updatedAt = saved.updatedAt;
    Object.assign(state, extra, { pendingIdleEvidence });
    seenIdleEvents.set(state.runId, new Set(idleEventIds));
    for (const [session, entries] of idleEvidence) if (entries.some((entry) => entry.runId === state.runId)) idleEvidence.delete(session);
    for (const entry of pendingIdleEvidence) {
      const entries = idleEvidence.get(entry.sessionId) ?? [];
      entries.push(entry);
      idleEvidence.set(entry.sessionId, entries);
    }
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
    if (!record) return false;
    if (binding.settlementOnly) return !record.started && (state.artifacts.plan?.version ?? 0) === record.planVersion;
    if (!binding.nodeId) return true;
    const node = state.nodes[binding.nodeId];
    return node?.sessionId === binding.sessionId && node.dispatchId === binding.dispatchId;
  }

  function current(binding) {
    if (!owns(binding)) return false;
    const state = store.getRun(binding.runId);
    return !binding.settlementOnly && state.status === 'RUNNING' && (!binding.nodeId || state.nodes[binding.nodeId]?.state === 'RUNNING');
  }

  async function admit(rootSessionId, callID, args, desiredNodeId = null) {
    const root = bindings.get(rootSessionId);
    if (!root?.root) return denied('NOT_GRAPH_SESSION', 'task dispatch requires the root orchestrator');
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
      const recordKey = key(rootSessionId, callID);
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
          else if (CONTINUABLE_ROLES.has(agent)) continuationSession = args.task_id; // identity unverifiable here (e.g. the binding was invalidated after a plan submission); parentage is re-verified before the reservation binds
        }
        const sameRole = previous && !previous.root && previous.runId === root.runId && previous.agent === agent;
        if (sameRole && previous.nodeId && target !== null && target !== previous.nodeId) {
          return denied('TASK_NODE_MISMATCH', `requested node ${target} conflicts with this task_id's node ${previous.nodeId}; continue ${previous.nodeId} with its matching marker, or dispatch ${target} with its own session or a fresh session`);
        }
        if (sameRole && current(previous)) {
          records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent, turnToken,
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
            records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent, turnToken,
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
        if (sameRole && !previous.nodeId) continuationSession = args.task_id;
        if (!continuationSession) return denied('FRESH_SESSION_REQUIRED', 'task_id may only continue an active attempt, resume the unfinished node this session last worked on, or continue a session of the same role in this run; other nodes and foreign sessions need a fresh session');
      }
      // Free consultations never appear as nodes, so the runner-side reader
      // gate cannot see them: this layer counts them directly and holds them
      // to the same shared ceiling as RUNNING explore/analyze nodes. Only new
      // work reaches here — active-attempt continuations returned above.
      if (READ_CONSULT_AGENTS.has(agent)) {
        const capacity = runner.readerCapacity(state);
        const freeInFlight = [...records.values()].filter((r) => r.runId === root.runId && READ_CONSULT_AGENTS.has(r.agent) && !r.terminal && !r.nodeId).length;
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
      const reserved = new Set([...records.values()].filter((r) => r.runId === root.runId && !r.bound && !r.terminal && r.nodeId && r.agent === agent).map((r) => r.nodeId));
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
      records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent, turnToken, nodeId: decision.nodeId,
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
    if (record.bound || !record.sessionId || !parents.has(record.sessionId)) return;
    if (!record.acknowledged && !record.started) return;
    const state = store.getRun(record.runId);
    // A stale INACTIVE binding (its dispatch finished or was rejected) must
    // not block a freshly admitted reservation for the same session: allow
    // the overwrite. An active binding still refuses the collision.
    const established = bindings.get(record.sessionId);
    if (!state || !['RUNNING', 'AWAITING_USER_DECISION'].includes(state.status) || (state.artifacts.plan?.version ?? 0) !== record.planVersion
      || parents.get(record.sessionId) !== record.rootSessionId || (established && established.active !== false)) return;
    const settlementOnly = state.status === 'AWAITING_USER_DECISION' && !record.started && !!record.nodeId;
    if (record.nodeId) {
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
      nodeId: record.nodeId, sessionId: record.sessionId, dispatchId: record.dispatchId, active: true, settlementOnly });
    await consumeIdle(record.sessionId);
    if (record.terminal && ![...records.values()].some((r) => r.sessionId === record.sessionId && !r.terminal && !r.idleSeen)) await finish(record.sessionId, record.dispatchId);
  }

  async function onSession(info) {
    if (typeof info?.id !== 'string' || typeof info.parentID !== 'string') return;
    if (parents.has(info.id) && parents.get(info.id) !== info.parentID) return;
    parents.set(info.id, info.parentID);
    const root = bindings.get(info.parentID);
    if (!root?.root) return;
    await exclusive(root.runId, async () => {
      for (const record of records.values()) {
        if (record.rootSessionId === info.parentID && record.sessionId === info.id) await bind(record);
      }
    });
  }

  async function finish(sessionId, dispatchId = bindings.get(sessionId)?.dispatchId) {
    const binding = bindings.get(sessionId);
    if (!binding || binding.root || binding.dispatchId !== dispatchId) return;
    const state = store.getRun(binding.runId);
    if (!owns(binding)) return;
    if (binding.nodeId && !binding.settlementOnly) runner.markIncomplete(state, { nodeId: binding.nodeId, now: NOW() });
    // Always retry persistence before releasing the lifetime, including when
    // an earlier save failed after mutating the node in memory.
    const ended = (r) => r.sessionId === sessionId && r.dispatchId === dispatchId;
    const completed = [...records.values()].filter(ended).map((record) => ({ ...record }));
    const settledDispatches = [...(state.settledDispatches ?? []).filter((r) => r.sessionId !== sessionId), ...completed].slice(-128);
    await persist(state, ended, { settledDispatches,
      pendingIdleEvidence: [...idleEvidence.values()].flat().filter((entry) => entry.runId === state.runId && entry.sessionId !== sessionId) });
    binding.active = false;
    binding.settled = true;
    idleEvidence.delete(sessionId);
    for (const [id, record] of records) if (ended(record)) records.delete(id);
  }

  async function consumeIdle(sessionId, observed = null) {
    const pending = idleEvidence.get(sessionId) ?? [];
    if (!bindings.has(sessionId)) return;
    const calls = [...records.values()].filter((r) => r.sessionId === sessionId && r.dispatchId === bindings.get(sessionId)?.dispatchId);
    if (!calls.length) return;
    const state = store.getRun(bindings.get(sessionId).runId);
    await refreshTurns(sessionId, calls[0].rootSessionId, observed);
    // Metadata is published before start/extend, and idle occurs before and
    // between queued prompts. Only a terminal child turn for EACH call proves
    // completion. Idle/status is secondary corroboration, never a substitute.
    const accounted = calls.every((r) => r.terminal || r.acknowledged && r.userAnchorSource === 'chat.message'
      && r.userMessageId && r.terminalMessageId && !r.anchorConflict && !r.turnConflict && !r.compactionPending && !r.lineageOverflow);
    const pendingEffects = (state.pendingEffects ?? []).some((effect) => effect.sessionId === sessionId);
    if (!accounted || pendingEffects && !calls.every((r) => r.terminal)) {
      if (calls.some((r) => {
        const saved = state.dispatchReservations?.find((entry) => entry.callID === r.callID);
        return saved?.idleSeen !== r.idleSeen || saved?.acknowledged !== r.acknowledged || saved?.terminal !== r.terminal;
      })) await persist(state);
      return;
    }
    if (!calls.every((r) => r.terminal)) {
      const idle = client?.session?.status ? await hostIsIdle(sessionId, calls[0].rootSessionId) : pending.length > 0;
      if (!idle) return;
    }
    await finish(sessionId);
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

  function captureTurns(sessionId, rootSessionId, messages, scan, promptMessage = null) {
    let changed = false;
    const mine = [...records.values()].filter((r) => r.rootSessionId === rootSessionId && (!r.sessionId || r.sessionId === sessionId) && r.turnToken);
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

  async function refreshTurns(sessionId, rootSessionId, observed = null, fromPrompt = false) {
    const signal = AbortSignal.timeout(2000);
    let messages = [];
    let scan = [];
    if (client?.session?.get && client?.session?.messages) {
      try {
        const info = (await client.session.get({ path: { id: sessionId }, signal })).data;
        if (info?.id !== sessionId || info.parentID !== rootSessionId) return;
        parents.set(sessionId, rootSessionId);
        const response = (await client.session.messages({ path: { id: sessionId }, query: { limit: 64 }, signal })).data;
        if (Array.isArray(response)) { scan = response.slice(-64); messages = [...scan]; }
      } catch { /* No scan result is not proof of completion. */ }
    }
    if (parents.get(sessionId) !== rootSessionId) return;
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
    const mine = [...records.values()].filter((r) => r.rootSessionId === rootSessionId && r.sessionId === sessionId);
    const candidates = [...records.values()].filter((r) => r.rootSessionId === rootSessionId && (!r.sessionId || r.sessionId === sessionId));
    if (!candidates.length) return;
    const before = candidates.map((record) => [record, structuredClone(record)]);
    const changed = captureTurns(sessionId, rootSessionId, messages, scan, fromPrompt ? observed : null);
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
        if (session?.id === info.sessionID && root?.root) {
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
      const state = store.getRun(runId);
      await refreshTurns(info.sessionID, state.rootSessionId, message, fromPrompt);
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

  async function hostIsIdle(sessionId, rootSessionId) {
    if (!client?.session?.get || !client?.session?.status) return false;
    const signal = AbortSignal.timeout(2000);
    try {
      const info = (await client.session.get({ path: { id: sessionId }, signal })).data;
      if (info?.id !== sessionId || info.parentID !== rootSessionId) return false;
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
    if (records.get(recordKey) !== record) return; // revoked while waiting
    const meta = part.state?.metadata;
    // The host call key is authoritative. Optional metadata may strengthen
    // it, but contradictory identity must never retire that call's owner.
    if (part.state?.input?.subagent_type !== undefined && part.state.input.subagent_type !== record.agent
      || meta?.parentSessionId !== undefined && meta.parentSessionId !== record.rootSessionId
      || record.sessionId && meta?.sessionId !== undefined && meta.sessionId !== record.sessionId) return;
    if ((part.state?.status === 'running' || part.state?.status === 'completed' && meta?.background === true) && typeof meta?.sessionId === 'string'
      && meta.parentSessionId === record.rootSessionId && part.state.input?.subagent_type === record.agent) {
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
    const runId = binding?.runId ?? bindings.get(parents.get(sessionId))?.runId;
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

  function invalidate(runId) {
    for (const [id, record] of records) if (record.runId === runId) records.delete(id);
    const state = store.getRun(runId);
    if (state) { state.dispatchReservations = []; state.pendingIdleEvidence = []; }
    for (const [id, binding] of bindings) if (!binding.root && binding.runId === runId) bindings.delete(id);
    for (const sessionId of idleEvidence.keys()) if (bindings.get(parents.get(sessionId))?.runId === runId) idleEvidence.delete(sessionId);
  }

  function managed(sessionId) {
    return bindings.has(sessionId) || bindings.get(parents.get(sessionId))?.root === true
      // Lookup failure is not evidence that an unknown session is unmanaged.
      || !parents.has(sessionId) && [...bindings.values()].some((binding) => binding.root);
  }

  // Read-only lookup: which run does a session belong to? Managed children
  // without their own binding (rejected or finished dispatches) resolve
  // through the host-verified parent chain to the root orchestrator's run.
  function runForSession(sessionId) {
    const binding = bindings.get(sessionId);
    if (binding) return binding.runId;
    const parent = parents.get(sessionId);
    const rootBinding = parent === undefined ? undefined : bindings.get(parent);
    return rootBinding?.root === true ? rootBinding.runId : null;
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
      parents.set(sessionId, typeof info.parentID === 'string' ? info.parentID : null);
      if (!bindings.get(info.parentID)?.root) return false;
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
    return [...records.values()].filter((r) => r.runId === runId).map((r) => ({
      callID: r.callID, nodeId: r.nodeId, agent: r.agent, sessionId: r.sessionId, bound: r.bound, continuation: r.continuation,
      resumed: r.resumed === true, targeted: r.targeted === true,
      errorCode: r.errorCode ?? null,
    }));
  }

  // Called only while rebinding a root after restart. These identities grant
  // settlement, never execution. Busy/unknown host status keeps decisions closed.
  async function recoverPaused(state) {
    if (state.status !== 'AWAITING_USER_DECISION') return;
    seenIdleEvents.set(state.runId, new Set((state.idleEventIds ?? []).slice(-256)));
    const restored = (state.dispatchReservations ?? []).slice(0, 128);
    for (const node of Object.values(state.nodes)) {
      if (node.state !== 'RUNNING' || !node.sessionId || !node.dispatchId
        || restored.some((r) => r.dispatchId === node.dispatchId)) continue;
      // Compatibility with pre-lifetime-ledger runs: a persisted node identity
      // is sufficient to restore a blocker, not to infer an idle event's lifetime
      // or re-dispatch. Without the original per-call correlation token a legacy
      // identity cannot be discharged just because native status says idle.
      restored.push({ runId: state.runId, rootSessionId: state.rootSessionId, callID: `recovery:${node.dispatchId}`,
        nodeId: node.spec.id, agent: node.spec.agent, sessionId: node.sessionId, dispatchId: node.dispatchId,
        bound: true, started: true, acknowledged: true, terminal: false, idleSeen: false,
        planVersion: state.artifacts.plan?.version ?? 0, recovery: true });
    }
    for (const record of restored) {
      if (record.runId !== state.runId || record.rootSessionId !== state.rootSessionId || typeof record.dispatchId !== 'string') continue;
      const recordKey = key(record.rootSessionId, record.callID);
      if (!record.recovery && !(state.dispatchCallIds ?? []).includes(recordKey)) continue;
      records.set(recordKey, { ...record });
      if (record.sessionId && (record.bound || record.started)) {
        parents.set(record.sessionId, record.rootSessionId);
        bindings.set(record.sessionId, { runId: record.runId, root: false, agent: record.agent, nodeId: record.nodeId,
          sessionId: record.sessionId, dispatchId: record.dispatchId, active: true, settlementOnly: record.settlementOnly === true });
        records.get(recordKey).bound = true;
      }
    }
    for (const record of (state.settledDispatches ?? []).slice(-128)) {
      if (record.runId !== state.runId || record.rootSessionId !== state.rootSessionId || bindings.has(record.sessionId)) continue;
      bindings.set(record.sessionId, { runId: record.runId, root: false, agent: record.agent, nodeId: record.nodeId,
        sessionId: record.sessionId, dispatchId: record.dispatchId, active: false, settled: true, settlementOnly: record.settlementOnly === true });
    }
    for (const evidence of (state.pendingIdleEvidence ?? []).slice(0, 128)) {
      if (evidence.runId !== state.runId || evidence.rootSessionId !== state.rootSessionId
        || typeof evidence.sessionId !== 'string' || !Array.isArray(evidence.owners)) continue;
      const owners = evidence.owners.slice(0, 128).filter((owner) => {
        const record = records.get(key(state.rootSessionId, owner.callID));
        return record?.dispatchId === owner.dispatchId && (!record.sessionId || record.sessionId === evidence.sessionId);
      });
      if (!owners.length || parents.has(evidence.sessionId) && parents.get(evidence.sessionId) !== state.rootSessionId) continue;
      parents.set(evidence.sessionId, state.rootSessionId);
      const pending = idleEvidence.get(evidence.sessionId) ?? [];
      if (!pending.some((entry) => entry.identity === evidence.identity)) pending.push({ ...evidence, owners });
      idleEvidence.set(evidence.sessionId, pending);
    }
    await persist(state);
    for (const sessionId of idleEvidence.keys()) {
      if (bindings.get(sessionId)?.runId === state.runId) await consumeIdle(sessionId);
    }
    if (client?.session?.messages) {
      let messages;
      try { messages = (await client.session.messages({ path: { id: state.rootSessionId }, query: { limit: 64 }, signal: AbortSignal.timeout(2000) })).data; }
      catch { messages = null; }
      for (const message of Array.isArray(messages) ? messages.slice(-64) : []) {
        for (const part of Array.isArray(message.parts) ? message.parts.slice(0, 256) : []) {
          if (part?.type !== 'tool' || part.tool !== 'task' || part.sessionID !== state.rootSessionId) continue;
          const recordKey = key(part.sessionID, part.callID);
          const record = records.get(recordKey);
          if (!record || record.runId !== state.runId) continue;
          const sessionId = part.state?.metadata?.sessionId;
          if (typeof sessionId === 'string' && !parents.has(sessionId) && client.session.get) {
            try {
              const info = (await client.session.get({ path: { id: sessionId }, signal: AbortSignal.timeout(2000) })).data;
              if (info?.id === sessionId && info.parentID === state.rootSessionId) parents.set(sessionId, info.parentID);
            } catch { /* Unknown parentage remains unbound and cannot execute. */ }
          }
          await applyPart(part, recordKey, record);
        }
      }
    }
    for (const sessionId of new Set([...records.values()].filter((r) => r.runId === state.runId && r.sessionId).map((r) => r.sessionId))) {
      await consumeIdle(sessionId);
    }
  }

  return Object.freeze({ admit, onSession, onPart, onIdle, onMessage, onUserPrompt, reconcileSession, ensureSession, invalidate, exclusive, managed, owns, current, runForSession, inspect, recoverPaused });
}
