// Native task correlation. Session creation order is not dispatch order.
// Only host task metadata, keyed by parent session + callID, can bind work.
import { randomUUID } from 'node:crypto';

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

export function createDispatchBindings({ store, runner, bindings, client }) {
  const records = new Map();
  const parents = new Map();
  const tails = new Map();
  const resolutions = new Map();
  const idleEvidence = new Map();
  const seenIdleEvents = new Map();

  function exclusive(runId, operation) {
    const result = (tails.get(runId) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(runId, settled);
    void settled.then(() => { if (tails.get(runId) === settled) tails.delete(runId); });
    return result;
  }

  function current(binding) {
    if (!binding || binding.root || binding.active === false) return false;
    if (bindings.get(binding.sessionId) !== binding) return false;
    const state = store.getRun(binding.runId);
    if (!state || state.status !== 'RUNNING') return false;
    if (!binding.nodeId) return true;
    const node = state.nodes[binding.nodeId];
    return node?.state === 'RUNNING' && node.sessionId === binding.sessionId && node.dispatchId === binding.dispatchId;
  }

  async function admit(rootSessionId, callID, args, desiredNodeId = null) {
    const root = bindings.get(rootSessionId);
    if (!root?.root) return denied('NOT_GRAPH_SESSION', 'task dispatch requires the root orchestrator');
    const target = typeof desiredNodeId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(desiredNodeId) ? desiredNodeId : null;
    return exclusive(root.runId, async () => {
      const state = store.getRun(root.runId);
      if (!state) return denied('RUN_GONE', 'owning run is unavailable');
      const recordKey = key(rootSessionId, callID);
      const used = state.dispatchCallIds ??= [];
      if (typeof callID !== 'string' || !callID.length || callID.length > 256 || used.includes(recordKey)) return denied('DUPLICATE_DISPATCH', 'a unique host callID is required, including after recovery');
      if (used.length >= 4096) return denied('DISPATCH_LIMIT', 'run dispatch history reached its bounded limit');
      if ([...records.values()].filter((r) => r.runId === root.runId).length >= 128) return denied('DISPATCH_LIMIT', 'too many outstanding task calls');
      const agent = args.subagent_type;
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
        if (sameRole && current(previous)) {
          records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent,
            nodeId: previous.nodeId, dispatchId: previous.dispatchId, sessionId: args.task_id,
            bound: true, continuation: true, acknowledged: false, idleSeen: false, terminal: false,
            planVersion: state.artifacts.plan?.version ?? 0 });
          used.push(recordKey);
          try { await store.saveRun(state); }
          catch { records.delete(recordKey); return denied('DISPATCH_PERSISTENCE_FAILED', 'could not save dispatch reservation; inspect storage and use a fresh call'); }
          return { allowed: true, nodeId: previous.nodeId, continuation: true };
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
              await store.saveRun(state);
              const passthrough = decision.code === 'RECOVERY_REQUIRED' || decision.code === 'AWAITING_DECISION' || decision.code === 'WRITER_CAPACITY' || decision.code === 'READER_CAPACITY';
              return denied(passthrough ? decision.code : 'FRESH_SESSION_REQUIRED',
                `${previous.nodeId} cannot be continued in this session: ${decision.detail}`);
            }
            const dispatchId = randomUUID();
            records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent,
              nodeId: previous.nodeId, dispatchId, sessionId: args.task_id,
              bound: false, continuation: true, resumed: true, acknowledged: false, idleSeen: false, terminal: false,
              planVersion: state.artifacts.plan?.version ?? 0 });
            bindings.delete(args.task_id); // the inactive entry is superseded by the resumed binding
            used.push(recordKey);
            try { await store.saveRun(state); }
            catch { records.delete(recordKey); return denied('DISPATCH_PERSISTENCE_FAILED', 'could not save dispatch reservation; inspect storage and use a fresh call'); }
            return { allowed: true, nodeId: previous.nodeId, continuation: true, resumed: true,
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
        await store.saveRun(state);
        return decision;
      }
      records.set(recordKey, { runId: root.runId, rootSessionId, callID, agent, nodeId: decision.nodeId,
        dispatchId: randomUUID(), sessionId: continuationSession, bound: false, continuation: continuationSession !== null,
        resumed: continuationSession !== null, acknowledged: false, idleSeen: false, terminal: false, targeted: target !== null,
        planVersion: state.artifacts.plan?.version ?? 0 });
      if (continuationSession) bindings.delete(continuationSession); // the stale free binding must not block the fresh one
      used.push(recordKey);
      try { await store.saveRun(state); }
      catch { records.delete(recordKey); return denied('DISPATCH_PERSISTENCE_FAILED', 'could not save dispatch reservation; inspect storage and use a fresh call'); }
      return continuationSession ? { ...decision, continuation: true } : decision;
    });
  }

  async function bind(record) {
    if (record.bound || !record.sessionId || !parents.has(record.sessionId)) return;
    const state = store.getRun(record.runId);
    // A stale INACTIVE binding (its dispatch finished or was rejected) must
    // not block a freshly admitted reservation for the same session: allow
    // the overwrite. An active binding still refuses the collision.
    const established = bindings.get(record.sessionId);
    if (!state || state.status !== 'RUNNING' || (state.artifacts.plan?.version ?? 0) !== record.planVersion
      || parents.get(record.sessionId) !== record.rootSessionId || (established && established.active !== false)) return;
    if (record.nodeId) {
      const node = state.nodes[record.nodeId];
      if (!record.started) {
        // Re-validate the reserved node specifically. Reservations are
        // authoritative; a re-sorted choice must not silently reassign work.
        const decision = runner.admitDispatch(state, { agent: record.agent, now: NOW(), nodeId: record.nodeId });
        if (!decision.allowed) return;
        runner.beginNode(state, record.nodeId, { now: NOW(), sessionId: record.sessionId, dispatchId: record.dispatchId });
        record.started = true;
      } else if (node?.state !== 'RUNNING' || node.dispatchId !== record.dispatchId || node.sessionId !== record.sessionId) return;
      // Do not publish the binding until authoritative attempt state is saved.
      try {
        await store.saveRun(state);
        record.errorCode = null;
      } catch {
        record.errorCode = 'BINDING_PERSISTENCE_FAILED';
        return; // A repeated metadata event/host lookup retries this same save.
      }
    }
    record.bound = true;
    // A RESUMED session's pre-bind idle evidence belongs to its previous
    // lifetime (the session was demonstrably idle before this dispatch) and
    // must not instantly finish the new attempt. Fresh dispatches keep
    // their pre-bind evidence (delayed-metadata windows); idle events after
    // binding complete both kinds normally.
    if (record.resumed) idleEvidence.delete(record.sessionId);
    bindings.set(record.sessionId, { runId: record.runId, root: false, agent: record.agent,
      nodeId: record.nodeId, sessionId: record.sessionId, dispatchId: record.dispatchId, active: true });
    await consumeIdle(record.sessionId);
    if (record.terminal && ![...records.values()].some((r) => r.sessionId === record.sessionId && !r.terminal && !r.idleSeen)) await finish(record.sessionId);
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

  async function finish(sessionId) {
    const binding = bindings.get(sessionId);
    if (!binding || binding.root) return;
    const state = store.getRun(binding.runId);
    if (current(binding) && binding.nodeId) {
      runner.markIncomplete(state, { nodeId: binding.nodeId, now: NOW() });
      await store.saveRun(state);
    }
    binding.active = false;
    idleEvidence.delete(sessionId);
    for (const [id, record] of records) if (record.sessionId === sessionId) records.delete(id);
  }

  async function consumeIdle(sessionId) {
    const pending = idleEvidence.get(sessionId);
    if (!pending?.length || !bindings.has(sessionId)) return;
    const calls = [...records.values()].filter((r) => r.sessionId === sessionId);
    while (pending.length) {
      const ended = calls.find((r) => r.acknowledged && !r.idleSeen);
      if (!ended) break;
      ended.idleSeen = true;
      pending.shift();
    }
    if (calls.some((r) => !r.idleSeen && !r.terminal)) return;
    await finish(sessionId);
  }

  async function onPart(part) {
    if (part?.type !== 'tool' || part.tool !== 'task') return;
    const recordKey = key(part.sessionID, part.callID);
    const record = records.get(recordKey);
    if (!record) return;
    await exclusive(record.runId, async () => {
      if (records.get(recordKey) !== record) return; // revoked while waiting
      const meta = part.state?.metadata;
      if ((part.state?.status === 'running' || part.state?.status === 'completed' && meta?.background === true) && typeof meta?.sessionId === 'string'
        && meta.parentSessionId === record.rootSessionId && part.state.input?.subagent_type === record.agent) {
        if (record.sessionId && record.sessionId !== meta.sessionId) return;
        record.sessionId = meta.sessionId;
        record.background = meta.background === true;
        record.acknowledged = true;
        await bind(record);
        await consumeIdle(record.sessionId);
      }
      if (part.state?.status === 'error' || part.state?.status === 'completed' && !meta?.background && !record.background) {
        record.terminal = true;
        if (!record.acknowledged) record.idleSeen = true;
        if (!record.bound && record.started) await bind(record);
        else if (!record.bound) records.delete(recordKey);
        else if (![...records.values()].some((r) => r.sessionId === record.sessionId && !r.terminal && !r.idleSeen)) await finish(record.sessionId);
      }
    });
  }

  async function onIdle(sessionId, eventId) {
    const binding = bindings.get(sessionId);
    const runId = binding?.runId ?? bindings.get(parents.get(sessionId))?.runId;
    if (!runId || binding?.root) return;
    await exclusive(runId, async () => {
      const seen = seenIdleEvents.get(runId) ?? new Set();
      // Pinned host supplies event.id. Legacy ID-less notifications are only
      // consumed once per session; terminal task events can still finish work.
      const identity = key(sessionId, typeof eventId === 'string' ? eventId : 'legacy-idle');
      if (seen.has(identity) || seen.size >= 8192) return;
      seen.add(identity);
      seenIdleEvents.set(runId, seen);
      const pending = idleEvidence.get(sessionId) ?? [];
      if (pending.length < 128) pending.push(identity);
      idleEvidence.set(sessionId, pending);
      await consumeIdle(sessionId);
    });
  }

  function invalidate(runId) {
    for (const [id, record] of records) if (record.runId === runId) records.delete(id);
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

  return Object.freeze({ admit, onSession, onPart, onIdle, ensureSession, invalidate, exclusive, managed, current, runForSession, inspect });
}
