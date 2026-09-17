// Enforcement wiring: the gate layer between the model-driven native task
// flow and the runner. Dispatch legality, write-scope confinement and shell
// deferral are decided here; durable permission prompts remain native and are
// never answered on the user's behalf except to DENY rule violations.

import { isAbsolute, relative, sep } from 'node:path';
import { captureRequest } from './journal-text.mjs';
import { matchScopePath, normalizeScopePath } from './task-spec.mjs';
import { firstOutOfScopeShellWrite } from './shell-scope.mjs';
import { createDispatchBindings } from './dispatch-bindings.mjs';
import { formatLessonsBlock } from './lessons.mjs';

const READ_ONLY_ROLES = new Set(['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-multimodal']);
// Tools that never mutate run state or the workspace stay available to graph
// children even when their dispatch binding is gone (rejected dispatch, idle
// session, terminated run). Write paths keep failing closed.
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'graph_status', 'graph_inspect', 'graph_journal_search', 'graph_journal_read', 'graph_lesson_search', 'graph_lesson_read']);
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

// Mechanical relay of the latest critic verdict or verifier failure so every
// dispatch (fresh session or continuation) sees the same revision evidence.
function revisionPrompt(decision) {
  if (Array.isArray(decision.reviseFindings) && decision.reviseFindings.length) {
    return `[RUNNER 修訂要求] 前次審查退件意見,新版本必須逐項處理:\n${decision.reviseFindings.map((finding) => `- ${finding}`).join('\n')}`;
  }
  if (decision.repairEvidence) {
    const evidence = decision.repairEvidence;
    const commands = (evidence.commands ?? []).join('; ');
    return [
      `[RUNNER 修復要求] 前次驗證失敗(verifier ${evidence.verifier}):${evidence.summary || '(未附摘要)'}`,
      commands ? `失敗命令:${commands}` : '',
    ].filter(Boolean).join('\n');
  }
  return null;
}

// A successor run created by a user reset starts with a bounded digest of the
// archived run so the new explorer/planner build on its lessons, not from zero.
function carryOverPrompt(state) {
  const carry = state.carryOver;
  if (!carry || typeof carry !== 'object') return null;
  const findings = Array.isArray(carry.reviewFindings) && carry.reviewFindings.length
    ? `前次審查退件意見(新計畫必須逐項處理,不得重蹈):\n${carry.reviewFindings.map((finding) => `- ${String(finding)}`).join('\n')}`
    : '';
  return [
    `[RUNNER 前次 run 資訊] 此 run 由 ${carry.predecessorRunId} 因使用者 reset 而來(原因:${String(carry.reason ?? '').slice(0, 300)})。`,
    findings,
    typeof carry.findingsDigest === 'string' && carry.findingsDigest.length ? `前次探索摘要:${carry.findingsDigest}` : '',
    Array.isArray(carry.learnings) && carry.learnings.length
      ? `前次探索 learnings(採納前必須對目前工作樹重新驗證):\n${carry.learnings.map((item) => `- ${String(item)}`).join('\n')}`
      : '',
    '可用 graph_journal_read/graph_journal_search 查前次完整紀錄;所有引用都必須對目前工作樹重新驗證後才能採用。',
  ].filter(Boolean).join('\n');
}

// Durable explorer lessons travel with the findings artifact: the planner
// (and a successor run via carry-over) incorporates them instead of
// re-deriving the same pitfalls from zero.
function learningsPrompt(state) {
  const artifact = state.artifacts.findings;
  const learnings = Array.isArray(artifact?.payload?.learnings) ? artifact.payload.learnings : [];
  if (!learnings.length) return null;
  return `[RUNNER] Explorer learnings from findings@${artifact.version} (incorporate these; re-validate against current state before relying on them):\n${learnings.slice(0, 16).map((item) => `- ${String(item)}`).join('\n')}`;
}

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Coordinator steering: an explicit `nodeId` task argument wins; otherwise a
// single `[nodeId: implement-setup]` marker on the first prompt line names the
// intended node. Without a hint the runner picks a ready node itself.
function parseNodeIdHint(args) {
  if (typeof args?.nodeId === 'string' && NODE_ID_PATTERN.test(args.nodeId)) return args.nodeId;
  const prompt = typeof args?.prompt === 'string' ? args.prompt : '';
  const firstLine = prompt.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/^\s*\[nodeId:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]\s*$/);
  return match ? match[1] : null;
}

export function createEnforcement({ settings, store, runner, bindings, client, dispatches = createDispatchBindings({ store, runner, bindings, client }), lessons = null }) {
  const deniedCalls = new Map();

  // Known project lessons ride into explorer/planner/implementer dispatches.
  // The hot path stays embedding-free (ranking is mechanical: path overlap,
  // tags, occurrence counts, recency) and every failure is fail-open — a
  // lesson-store problem must never block or even delay a dispatch.
  async function dispatchLessonsBlock(paths, promptExcerpt) {
    if (lessons === null) return null;
    if (settings.lessons?.enabled === false || !(settings.lessons?.injectMax > 0)) return null;
    try {
      const relevant = await lessons.relevantLessons({
        text: typeof promptExcerpt === 'string' ? promptExcerpt.slice(0, 500) : '',
        paths: Array.isArray(paths) ? paths : [],
        limit: settings.lessons.injectMax,
      });
      return formatLessonsBlock(relevant);
    } catch {
      return null;
    }
  }

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
        // A run may have an explicit successor started through graph_run_new
        // or a user reset decision; follow the recorded chain so a restart
        // rebinds to the newest run of this session, whatever the archived
        // status of its predecessors is.
        for (let hops = 0; hops < 32 && typeof state.successorRunId === 'string' && state.successorRunId.length; hops += 1) {
          const successor = await store.loadRun(state.successorRunId);
          if (!successor) break;
          state = successor;
        }
        // Restart recovery: in-flight nodes cannot be trusted; resume
        // classifies. A process restart interrupted these nodes mid-attempt,
        // so the crash must not consume their budget — refund the charged
        // attempt now (the reconcile re-dispatch charges a fresh one, making
        // the net cost of the crash zero). This path only runs after real
        // plugin restarts; live runs keep their root binding and never
        // reach it, so the refund cannot be farmed mid-run.
        if (Object.values(state.nodes).some((node) => node.state === 'RUNNING') && state.status === 'RUNNING') {
          for (const node of Object.values(state.nodes)) {
            if (node.state === 'RUNNING' && node.attempt > 0) node.attempt -= 1;
          }
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
    if (tool === 'edit' || tool === 'write') {
      if (!node || node.spec.kind !== 'implement') return null;
      const target = toWorkspaceRelative(args?.filePath ?? args?.path);
      const patterns = node.spec.writeScope ?? [];
      const allowed = typeof target === 'string' && patterns.length > 0 && patterns.some((pattern) => matchScopePath(pattern, target));
      return { state, node, nodeId: node.spec.id, target, allowed, kind: tool === 'edit' ? 'out-of-scope-edit' : 'out-of-scope-write',
        reason: `${tool} target ${target} is outside the writeScope [${patterns.join(', ')}] of ${node.spec.id}` };
    }
    if (tool === 'bash') {
      const command = typeof args?.command === 'string' ? args.command : '';
      const target = command.slice(0, 200);
      if (node && node.spec.kind === 'implement') {
        if (node.spec.allowShell !== true) {
          return { state, node, nodeId: node.spec.id, target, allowed: false, kind: 'blocked-bash',
            reason: `implementer bash is deferred to verification (${node.spec.id} declares allowShell=false)` };
        }
        const escape = firstOutOfScopeShellWrite(command, node.spec.writeScope ?? [], toWorkspaceRelative);
        if (escape !== null) {
          return { state, node, nodeId: node.spec.id, target, allowed: false, kind: 'out-of-scope-bash',
            reason: `bash write target ${escape} is outside the writeScope [${(node.spec.writeScope ?? []).join(', ')}] of ${node.spec.id}` };
        }
        return { state, node, nodeId: node.spec.id, target, allowed: true };
      }
      if (READ_ONLY_ROLES.has(binding.agent)) {
        // Read-only specialists may run non-mutating checks (e.g. tool
        // availability) but never write workspace files through the shell.
        const escape = firstOutOfScopeShellWrite(command, [], toWorkspaceRelative);
        if (escape !== null) {
          return { state, node, nodeId: binding.nodeId, target, allowed: false, kind: 'out-of-scope-bash',
            reason: `read-only specialist ${binding.agent} may not write workspace files (bash target ${escape})` };
        }
      }
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
       const decision = await dispatches.admit(sessionID, callID, args, parseNodeIdHint(args));
      if (!decision.allowed) {
        await dispatches.exclusive(binding.runId, async () => {
          runner.recordViolation(state, { nodeId: null, kind: 'gate-blocked-dispatch', detail: `${subagentType}: ${decision.code} — ${decision.detail}`, now: NOW() });
          await store.saveRun(state);
        });
        const { task_id: _oldSession, nodeId: _nodeId, ...freshArgs } = args;
        output.args = { ...freshArgs, description: args.description ?? 'runner-rejected dispatch', prompt: rejectionPrompt(decision), subagent_type: subagentType ?? 'graph-explorer' };
        return;
      }
      let prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (decision.nodeId) {
        // The runner echoes the node's authoritative (token-expanded) scope
        // and deliverables: the bound implementer's ground truth comes from
        // the runner, never from planner prose that may still carry tokens.
        const spec = state.nodes[decision.nodeId]?.spec ?? null;
        const authoritative = [];
        if (spec && Array.isArray(spec.writeScope) && spec.writeScope.length) authoritative.push(`[RUNNER] writeScope: ${spec.writeScope.join(', ')}. Write only inside these literal paths.`);
        if (spec && Array.isArray(spec.deliverables) && spec.deliverables.length) authoritative.push(`[RUNNER] deliverables: ${spec.deliverables.join(', ')}.`);
        if (spec && spec.kind === 'verify') {
          // Implementer-reported risks are relayed mechanically so the
          // verifier probes them first instead of trusting green commands.
          const risks = [...new Set((spec.dependsOn ?? []).flatMap((dep) => state.artifacts[`change:${dep}`]?.payload?.risks ?? []))].slice(0, 16).map(String);
          if (risks.length) authoritative.push(`[RUNNER] implementer-reported risks (probe these first): ${risks.join(' | ')}`);
        }
        if (spec && spec.kind === 'plan') {
          const learnings = learningsPrompt(state);
          if (learnings) authoritative.push(learnings);
        }
        if (spec && (spec.kind === 'implement' || spec.kind === 'plan')) {
          const block = await dispatchLessonsBlock(spec.writeScope ?? [], args.prompt);
          if (block) authoritative.push(block);
        }
        prompt = `[RUNNER] Assigned nodeId: ${decision.nodeId}. Submit only this node.${authoritative.length ? `\n${authoritative.join('\n')}` : ''}\n${prompt}`;
        if (decision.reconcile) prompt = `${reconcilePrompt(state, decision.nodeId)}\n\n${prompt}`;
        const guidance = revisionPrompt(decision);
        if (guidance) prompt = `${guidance}\n\n${prompt}`;
      } else if (decision.free && (subagentType === 'graph-explorer' || subagentType === 'graph-planner')) {
        const carry = carryOverPrompt(state);
        if (carry) prompt = `${carry}\n\n${prompt}`;
        if (subagentType === 'graph-planner') {
          const learnings = learningsPrompt(state);
          if (learnings) prompt = `${learnings}\n\n${prompt}`;
        }
        const block = await dispatchLessonsBlock([], args.prompt);
        if (block) prompt = `${block}\n\n${prompt}`;
      }
      output.args = { ...args, prompt };
      return;
    }
    if (tool === 'edit' || tool === 'write' || tool === 'bash') {
      const decision = decideWriteBinding(sessionID, tool, output.args);
      if (!decision || decision.allowed) return;
      deniedCalls.set(`${sessionID}:${callID}`, { tool, target: decision.target, callID });
      runner.recordViolation(decision.state, { nodeId: decision.nodeId, kind: decision.kind, detail: decision.reason, now: NOW() });
      await store.saveRun(decision.state);
      // Hard block: the host's permission flow may auto-allow this call
      // (config defaults or manual approval at the native prompt), so the
      // only deny that cannot be bypassed is throwing from the before-hook.
      // The serialized queue swallows the rejection (tails settle to
      // undefined), so this cannot poison subsequent operations.
      throw new Error(`RUNNER_DENIED(${decision.kind}): ${decision.reason} ${denyGuidance(decision.kind)}`);
    }
  }

  function denyGuidance(kind) {
    if (kind === 'blocked-bash') {
      return 'Do not retry bash. Complete the work with edit/write; if it genuinely requires shell (installs, builds), wrap up and report via graph_submit_change unresolved (or your final task report) that the coordinator must revise the plan: set allowShell=true for this node or split out an install node with its own lane.';
    }
    if (kind === 'out-of-scope-bash') {
      return 'Retarget or remove the out-of-scope write (redirections, tee/cp/mv/rm/sed -i, ...) so every write lands inside your writeScope; the [RUNNER] writeScope line in your dispatch prompt is authoritative.';
    }
    if (kind === 'out-of-scope-edit' || kind === 'out-of-scope-write') {
      return 'Write only inside your declared writeScope; the [RUNNER] writeScope line in your dispatch prompt is authoritative.';
    }
    return 'Read-only specialists may not write workspace files; report findings through the structured submit tool instead.';
  }

  async function onPermissionAsk(input, output) {
    const { type, sessionID, callID } = input ?? {};
    const tool = type;
    if (tool !== 'edit' && tool !== 'write' && tool !== 'bash') return;
    const key = `${sessionID}:${callID}`;
    const preDecided = deniedCalls.get(key);
    if (preDecided) {
      output.status = 'deny';
      return;
    }
    // Independent re-check: the ask may fire without a matching before-hook.
    const args = input.pattern ? { filePath: Array.isArray(input.pattern) ? input.pattern[input.pattern.length - 1] : input.pattern } : {};
    const decision = decideWriteBinding(sessionID, tool, tool === 'bash' ? {} : args);
    if (decision && !decision.allowed) {
      output.status = 'deny';
      runner.recordViolation(decision.state, { nodeId: decision.nodeId, kind: decision.kind, detail: `${decision.reason} (denied at permission prompt)`, now: NOW() });
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
    if (tool !== 'edit' && tool !== 'write' && tool !== 'bash') return;
    const binding = bindings.get(sessionID);
    if (!binding || binding.root || !binding.nodeId) return;
    const key = `${sessionID}:${callID}`;
    if (deniedCalls.has(key)) {
      deniedCalls.delete(key);
      await mutate(binding.runId, (state) => {
        runner.recordViolation(state, { nodeId: binding.nodeId, kind: 'executed-despite-deny', detail: `${tool} ran even though the runner denied it`, now: NOW() });
        // A denied call that ran anyway taints the attempt: strict failure,
        // the same class as out-of-scope claims. Recovery is a fresh
        // attempt (or a plan revision), never a resubmission of this one,
        // so tainted work can never reach SUCCEEDED.
        runner.taintAttempt(state, { nodeId: binding.nodeId, detail: `${tool} executed despite runner denial`, now: NOW() });
      });
      return;
    }
    const args = input.args ?? {};
    const target = tool === 'bash'
      ? (typeof args.command === 'string' ? args.command.slice(0, 200) : null)
      : toWorkspaceRelative(args.filePath ?? args.path);
    if (target === null && tool !== 'bash') return;
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
        throw new Error('BINDING_UNAVAILABLE: this session has no active, verified dispatch (its previous dispatch finished, was rejected, or was revoked); stop working, report this reason back, and let the coordinator re-dispatch');
      }
      return operation(input, output);
    };
    return binding ? dispatches.exclusive(binding.runId, work) : work();
  }

  return Object.freeze({
    onChatMessage: (input, output) => dispatches.exclusive(bindings.get(input?.sessionID)?.runId ?? input?.sessionID, () => onChatMessage(input, output)),
    onToolBefore: (input, output) => input?.tool === 'task' ? onToolBefore(input, output) : childOperation(input, output, onToolBefore, !READ_ONLY_TOOLS.has(input?.tool)),
    onToolAfter: (input, output) => input?.tool === 'task' ? onToolAfter(input, output) : childOperation(input, output, onToolAfter),
    onPermissionAsk: (input, output) => childOperation(input, output, async (i, o) => {
      if (!READ_ONLY_TOOLS.has(i?.type) && dispatches.managed(i?.sessionID) && !bindings.get(i.sessionID)?.root && !dispatches.current(bindings.get(i.sessionID))) { o.status = 'deny'; return; }
      return onPermissionAsk(i, o);
    }),
    onEvent, dispatches,
    internals: Object.freeze({ bindings, deniedCalls, decideWriteBinding, toWorkspaceRelative, READ_ONLY_TOOLS }),
  });
}
