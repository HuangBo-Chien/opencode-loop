// Enforcement wiring: the gate layer between the model-driven native task
// flow and the runner. Dispatch legality, write-scope confinement and shell
// deferral are decided here; durable permission prompts remain native and are
// never answered on the user's behalf except to DENY rule violations.

import { isAbsolute, relative, sep } from 'node:path';
import { captureRequest } from './journal-text.mjs';
import { matchScopePath, normalizeScopePath } from './task-spec.mjs';
import { createDispatchBindings } from './dispatch-bindings.mjs';

const SUBMIT_TOOLS = new Set(['graph_submit_plan', 'graph_submit_review', 'graph_submit_change', 'graph_submit_verification', 'graph_submit_findings', 'graph_inspect', 'graph_run_resume']);
const NOW = () => new Date().toISOString();

function rejectionPrompt(decision) {
  return [
    'RUNNER_REJECTED:這項派遣在執行前已被 runner 拒絕,不要進行任何工作。',
    `原因(${decision.code}):${decision.detail}`,
    '請只回覆:「RUNNER_REJECTED(${decision.code}):{原因}」並結束;協調者會修正流程後重新派遣。',
  ].join('\n');
}

function reconcilePrompt(state, nodeId) {
  const effects = state.sideEffects.filter((effect) => effect.nodeId === nodeId).map((effect) => `${effect.tool}: ${effect.target}`);
  return [
    '[RUNNER 資訊] 此節點先前中斷且已有副作用紀錄;不可盲目重做。',
    `已紀錄的副作用:${effects.join('; ') || '(無)'}`,
    '請先核對這些檔案的目前實際狀態,決定保留或修正,再以 graph_submit_change 如實回報;filesTouched 必須涵蓋所有實際存在的修改。',
  ].join('\n');
}

export function createEnforcement({ settings, store, runner, bindings, client, dispatches = createDispatchBindings({ store, runner, bindings, client }) }) {
  const deniedCalls = new Map();

  function toWorkspaceRelative(target) {
    if (typeof target !== 'string' || !target.length) return null;
    if (!settings.worktree || !isAbsolute(target)) return normalizeScopePath(target) ?? target.replace(/\\/g, '/');
    const relativePath = relative(settings.worktree, target);
    if (!relativePath.length || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
    return relativePath.split(sep).join('/');
  }

  async function mutate(runId, mutation) {
    const state = store.getRun(runId);
    if (!state) return null;
    const result = mutation(state);
    await store.saveRun(state);
    return { state, result };
  }

  async function onChatMessage(input, output) {
    const { sessionID, agent: inputAgent } = input ?? {};
    const agent = inputAgent ?? output?.message?.agent;
    if (agent !== 'graph-orchestrator' || typeof sessionID !== 'string' || !sessionID.length) return;
    let state;
    const binding = bindings.get(sessionID);
    if (binding) {
      if (!binding.root) return;
      state = store.getRun(binding.runId);
    } else {
      state = await store.loadRun(sessionID);
      if (state) {
        // Restart recovery: in-flight nodes cannot be trusted; resume classifies.
        if (Object.values(state.nodes).some((node) => node.state === 'RUNNING') && state.status === 'RUNNING') {
          state.status = 'RECOVERY_REQUIRED';
          await store.saveRun(state);
        }
        bindings.set(sessionID, { runId: state.runId, agent, nodeId: null, root: true });
      } else {
        const capturedAt = NOW();
        const captured = captureRequest(output?.parts, settings.journal);
        const request = captured ? { ...captured, capturedAt } : null;
        state = await store.createRun({
          runId: sessionID,
          rootSessionId: sessionID,
          now: capturedAt,
          request,
          requestCaptureCompleted: true,
        });
        bindings.set(sessionID, { runId: sessionID, agent, nodeId: null, root: true });
        return;
      }
    }
    if (state?.requestCaptureCompleted === false) {
      const captured = captureRequest(output?.parts, settings.journal);
      const capturedAt = NOW();
      const result = captured
        ? runner.captureRequest(state, { ...captured, capturedAt })
        : runner.completeRequestCapture(state, { now: capturedAt });
      if (result.changed) await store.saveRun(state);
    }
  }

  function decideWriteBinding(sessionID, tool, args) {
    const binding = bindings.get(sessionID);
    if (!binding || binding.root) return null;
    const state = store.getRun(binding.runId);
    if (!state) return null;
    const node = binding.nodeId ? state.nodes[binding.nodeId] : null;
    if (!node || node.spec.kind !== 'implement') return null;
    if (tool === 'edit') {
      const target = toWorkspaceRelative(args?.filePath ?? args?.path);
      const patterns = node.spec.writeScope ?? [];
      const allowed = typeof target === 'string' && patterns.length > 0 && patterns.some((pattern) => matchScopePath(pattern, target));
      return { state, node, target, allowed, reason: `edit target ${target} is outside the writeScope [${patterns.join(', ')}] of ${node.spec.id}` };
    }
    if (tool === 'bash') {
      const allowed = node.spec.allowShell === true;
      return { state, node, target: typeof args?.command === 'string' ? args.command.slice(0, 200) : '(unknown)', allowed, reason: `implementer bash is deferred to verification (${node.spec.id} declares allowShell=false)` };
    }
    return null;
  }

  async function onToolBefore(input, output) {
    const { tool, sessionID, callID } = input ?? {};
    if (tool === 'task') {
      const binding = bindings.get(sessionID);
      if (!binding?.root) return;
      const state = store.getRun(binding.runId);
      if (!state) return;
      const args = output.args ?? {};
      const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : null;
       const decision = await dispatches.admit(sessionID, callID, args);
      if (!decision.allowed) {
        await dispatches.exclusive(binding.runId, async () => {
          runner.recordViolation(state, { nodeId: null, kind: 'gate-blocked-dispatch', detail: `${subagentType}: ${decision.code} — ${decision.detail}`, now: NOW() });
          await store.saveRun(state);
        });
        const { task_id: _oldSession, ...freshArgs } = args;
        output.args = { ...freshArgs, description: args.description ?? 'runner-rejected dispatch', prompt: rejectionPrompt(decision), subagent_type: subagentType ?? 'graph-explorer' };
        return;
      }
      let prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (decision.nodeId) {
        prompt = `[RUNNER] Assigned nodeId: ${decision.nodeId}. Submit only this node.\n${prompt}`;
        if (decision.reconcile) prompt = `${reconcilePrompt(state, decision.nodeId)}\n\n${prompt}`;
      }
      output.args = { ...args, prompt };
      return;
    }
    if (tool === 'edit' || tool === 'bash') {
      const decision = decideWriteBinding(sessionID, tool, output.args);
      if (!decision || decision.allowed) return;
      deniedCalls.set(`${sessionID}:${callID}`, { tool, target: decision.target, callID });
      runner.recordViolation(decision.state, { nodeId: decision.node.spec.id, kind: tool === 'edit' ? 'out-of-scope-edit' : 'blocked-bash', detail: decision.reason, now: NOW() });
      await store.saveRun(decision.state);
    }
  }

  async function onPermissionAsk(input, output) {
    const { type, sessionID, callID } = input ?? {};
    const tool = type;
    if (tool !== 'edit' && tool !== 'bash') return;
    const key = `${sessionID}:${callID}`;
    const preDecided = deniedCalls.get(key);
    if (preDecided) {
      output.status = 'deny';
      return;
    }
    // Independent re-check: the ask may fire without a matching before-hook.
    const args = input.pattern ? { filePath: Array.isArray(input.pattern) ? input.pattern[input.pattern.length - 1] : input.pattern } : {};
    const decision = decideWriteBinding(sessionID, tool, tool === 'edit' ? args : {});
    if (decision && !decision.allowed) {
      output.status = 'deny';
      runner.recordViolation(decision.state, { nodeId: decision.node.spec.id, kind: tool === 'edit' ? 'out-of-scope-edit' : 'blocked-bash', detail: `${decision.reason} (denied at permission prompt)`, now: NOW() });
      await store.saveRun(decision.state);
    }
  }

  async function onToolAfter(input, output) {
    const { tool, sessionID, callID } = input ?? {};
    if (tool === 'task') {
      // The running metadata event normally arrives before child work. This is
      // also a cleanup path for hosts that deliver terminal metadata via after.
      await dispatches.onPart({ type: 'tool', tool, sessionID, callID,
        state: { status: 'completed', input: input.args, metadata: output?.metadata } });
      return;
    }
    if (tool !== 'edit' && tool !== 'bash') return;
    const binding = bindings.get(sessionID);
    if (!binding || binding.root || !binding.nodeId) return;
    const key = `${sessionID}:${callID}`;
    if (deniedCalls.has(key)) {
      deniedCalls.delete(key);
      await mutate(binding.runId, (state) => runner.recordViolation(state, { nodeId: binding.nodeId, kind: 'executed-despite-deny', detail: `${tool} ran even though the runner denied it`, now: NOW() }));
      return;
    }
    const args = input.args ?? {};
    const target = tool === 'edit' ? toWorkspaceRelative(args.filePath ?? args.path) : (typeof args.command === 'string' ? args.command.slice(0, 200) : null);
    if (target === null && tool === 'edit') return;
    await mutate(binding.runId, (state) => runner.recordSideEffect(state, { nodeId: binding.nodeId, tool, target, now: NOW() }));
  }

  async function onEvent(input) {
    const event = input?.event;
    if (!event || typeof event.type !== 'string') return;
    const { type, properties } = event;

    if (type === 'session.created' || type === 'session.updated') return dispatches.onSession(properties?.info);
    if (type === 'message.part.updated') return dispatches.onPart(properties?.part);
    // Pinned host emits both status(idle) and idle for one transition. Consume
    // only the latter or a continuation would be completed twice.
    if (type === 'session.idle') return dispatches.onIdle(properties?.sessionID, event.id);
  }

  async function childOperation(input, output, operation, requireActive = false) {
    const sessionID = input?.sessionID;
    await dispatches.ensureSession(sessionID);
    const binding = bindings.get(sessionID);
    const work = () => {
      if (requireActive && !binding?.root && dispatches.managed(sessionID) && !dispatches.current(binding)) {
        throw new Error('BINDING_UNAVAILABLE: managed child must have an active, verified dispatch before work');
      }
      return operation(input, output);
    };
    return binding ? dispatches.exclusive(binding.runId, work) : work();
  }

  return Object.freeze({
    onChatMessage: (input, output) => dispatches.exclusive(bindings.get(input?.sessionID)?.runId ?? input?.sessionID, () => onChatMessage(input, output)),
    onToolBefore: (input, output) => input?.tool === 'task' ? onToolBefore(input, output) : childOperation(input, output, onToolBefore, true),
    onToolAfter: (input, output) => input?.tool === 'task' ? onToolAfter(input, output) : childOperation(input, output, onToolAfter),
    onPermissionAsk: (input, output) => childOperation(input, output, async (i, o) => {
      if (dispatches.managed(i?.sessionID) && !bindings.get(i.sessionID)?.root && !dispatches.current(bindings.get(i.sessionID))) { o.status = 'deny'; return; }
      return onPermissionAsk(i, o);
    }),
    onEvent, dispatches,
    internals: Object.freeze({ bindings, deniedCalls, decideWriteBinding, toWorkspaceRelative }),
  });
}
