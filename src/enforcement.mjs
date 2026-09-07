// Enforcement wiring: the gate layer between the model-driven native task
// flow and the runner. Dispatch legality, write-scope confinement and shell
// deferral are decided here; durable permission prompts remain native and are
// never answered on the user's behalf except to DENY rule violations.

import { isAbsolute, relative, sep } from 'node:path';
import { matchScopePath, normalizeScopePath } from './task-spec.mjs';

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

export function createEnforcement({ settings, store, runner, bindings, pendingDispatches = null }) {
  const queues = pendingDispatches ?? new Map();
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

  async function onChatMessage(input) {
    const { sessionID, agent } = input ?? {};
    if (agent !== 'graph-orchestrator' || typeof sessionID !== 'string' || !sessionID.length) return;
    if (bindings.has(sessionID)) return;
    const existing = await store.loadRun(sessionID);
    if (existing) {
      // Restart recovery: in-flight nodes cannot be trusted; resume classifies.
      if (Object.values(existing.nodes).some((node) => node.state === 'RUNNING') && existing.status === 'RUNNING') {
        existing.status = 'RECOVERY_REQUIRED';
        await store.saveRun(existing);
      }
      bindings.set(sessionID, { runId: existing.runId, agent, nodeId: null, root: true });
      return;
    }
    await store.createRun({ runId: sessionID, rootSessionId: sessionID, now: NOW() });
    bindings.set(sessionID, { runId: sessionID, agent, nodeId: null, root: true });
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
      const decision = runner.admitDispatch(state, { agent: subagentType, now: NOW() });
      if (!decision.allowed) {
        runner.recordViolation(state, { nodeId: null, kind: 'gate-blocked-dispatch', detail: `${subagentType}: ${decision.code} — ${decision.detail}`, now: NOW() });
        await store.saveRun(state);
        output.args = { ...args, description: args.description ?? 'runner-rejected dispatch', prompt: rejectionPrompt(decision), subagent_type: subagentType ?? 'graph-explorer' };
        return;
      }
      let prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (decision.nodeId) {
        runner.beginNode(state, decision.nodeId, { now: NOW() });
        if (decision.reconcile) prompt = `${reconcilePrompt(state, decision.nodeId)}\n\n${prompt}`;
        await store.saveRun(state);
      }
      const queue = queues.get(binding.runId) ?? [];
      queue.push({ agent: subagentType, nodeId: decision.nodeId });
      queues.set(binding.runId, queue);
      if (decision.reconcile) output.args = { ...args, prompt };
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

    if (type === 'session.created' || type === 'session.updated') {
      const info = properties?.info;
      const sessionId = info?.id;
      const parentId = info?.parentID;
      if (typeof sessionId !== 'string' || !parentId || bindings.has(sessionId)) return;
      const parentBinding = bindings.get(parentId);
      if (!parentBinding?.root) return;
      const queue = queues.get(parentBinding.runId);
      if (!queue || !queue.length) return;
      const dispatch = queue.shift();
      bindings.set(sessionId, { runId: parentBinding.runId, agent: dispatch.agent, nodeId: dispatch.nodeId, root: false });
      if (dispatch.nodeId) {
        await mutate(parentBinding.runId, (state) => runner.attachSession(state, dispatch.nodeId, sessionId));
      }
      return;
    }

    if (type === 'session.idle') {
      const sessionId = properties?.sessionID;
      const binding = bindings.get(sessionId);
      if (!binding || binding.root || !binding.nodeId) return;
      const state = store.getRun(binding.runId);
      if (!state) return;
      const node = state.nodes[binding.nodeId];
      if (!node || node.state !== 'RUNNING' || node.sessionId !== sessionId) return;
      const result = runner.markIncomplete(state, { nodeId: binding.nodeId, now: NOW() });
      if (result.changed) await store.saveRun(state);
    }
  }

  return Object.freeze({
    onChatMessage, onToolBefore, onToolAfter, onPermissionAsk, onEvent,
    internals: Object.freeze({ bindings, queues, deniedCalls, decideWriteBinding, toWorkspaceRelative }),
  });
}
