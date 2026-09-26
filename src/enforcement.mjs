// Enforcement wiring: the gate layer between the model-driven native task
// flow and the runner. Dispatch legality, write-scope confinement and shell
// deferral are decided here; durable permission prompts remain native and are
// never answered on the user's behalf except to DENY rule violations.

import { isAbsolute, relative, sep } from 'node:path';
import { captureRequest } from './journal-text.mjs';
import { matchScopePath, normalizeScopePath } from './task-spec.mjs';
import { firstOutOfScopeShellWrite } from './shell-scope.mjs';
import { createDispatchBindings } from './dispatch-bindings.mjs';
import { parseNodeIdHint, TARGET_REQUIRED_AGENTS } from './dispatch-target.mjs';
import { formatLessonsBlock } from './lessons.mjs';
import { assertSettlementCapacity, isUncertainEffect } from './runner.mjs';
import { isConfiguredMcpTool, toolPermission } from './tool-permissions.mjs';
import { handoffForCall, renderHandoff, dispatchNotes } from './artifact-handoffs.mjs';
import { dispatchRejection } from './dispatch-rejection.mjs';
import { createBoundedHostReader } from './host-read.mjs';
import { authenticDirectPermission } from './direct.mjs';

const READ_ONLY_ROLES = new Set(['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-multimodal']);
// Tools that never mutate run state or the workspace stay available to graph
// children even when their dispatch binding is gone (rejected dispatch, idle
// session, terminated run). Write paths keep failing closed.
const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'skill', 'lsp', 'graph_status', 'graph_inspect', 'graph_artifact_read', 'graph_journal_search', 'graph_journal_read', 'graph_lesson_search', 'graph_lesson_read']);
const NOW = () => new Date().toISOString();

function reconcilePrompt(state, nodeId) {
  const effects = state.sideEffects.filter((effect) => effect.nodeId === nodeId).map((effect) => `${effect.tool}: ${effect.target}${isUncertainEffect(effect) ? ' (uncertain error outcome; inspect actual effects)' : ''}`);
  effects.push(...(state.pendingEffects ?? []).filter((effect) => effect.nodeId === nodeId).map((effect) => `${effect.tool}: ${effect.target} (outcome unknown; do not replay blindly)`));
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
      evidence.directTarget === false ? '此節點是受影響的下游消費者:依新證據重新執行與驗證本節點,不要重做無關的已成功前置工作。' : '',
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

// Learnings from the most recent findings versions travel into planner
// dispatch prompts: parallel explorers each contribute, newest first, and
// legacy runs without retained history fall back to the latest artifact.
function learningsPrompt(state) {
  const history = Array.isArray(state.findingsLog) ? state.findingsLog.slice(-3).reverse() : [];
  const sources = history.length ? history
    : (Array.isArray(state.artifacts.findings?.payload?.learnings) && state.artifacts.findings.payload.learnings.length
      ? [{ version: state.artifacts.findings.version, learnings: state.artifacts.findings.payload.learnings }] : []);
  const lines = [];
  for (const source of sources) {
    for (const item of Array.isArray(source.learnings) ? source.learnings : []) {
      if (lines.length >= 16) break;
      lines.push(`- (findings@${source.version}) ${String(item)}`);
    }
    if (lines.length >= 16) break;
  }
  if (!lines.length) return null;
  return `[RUNNER] Explorer learnings (incorporate these; re-validate against current state before relying on them):\n${lines.join('\n')}`;
}

export function createEnforcement({ settings, store, runner, bindings, client, getSubagentDepth = () => 2, dispatches = createDispatchBindings({ store, runner, bindings, client, getSubagentDepth }), lessons = null, getToolPermissions = () => null }) {
  const hostReader = createBoundedHostReader(client);
  if (store.transaction) client = hostReader.client;
  const deniedCalls = new Map();
  const startedCalls = new Map();
  const observedToolParts = new Map();
  const recordedCalls = new Set();
  const formattedCalls = new Map();
  const callKey = (sessionID, callID) => JSON.stringify([sessionID, callID]);
  const settlementTools = new Set(['graph_submit_plan', 'graph_submit_review', 'graph_submit_change', 'graph_submit_verification', 'graph_submit_findings']);
  const denialKinds = new Set(['out-of-scope-edit', 'out-of-scope-write', 'out-of-scope-bash', 'blocked-bash', 'unparsed-write-target']);
  function recorded(identity) {
    recordedCalls.add(identity);
    if (recordedCalls.size > 256) recordedCalls.delete(recordedCalls.values().next().value);
  }

  function canCloseout(binding, tool) {
    return settlementTools.has(tool) && store.getRun(binding?.runId)?.status === 'AWAITING_USER_DECISION'
      && !binding?.settlementOnly && dispatches.owns(binding, { settled: true });
  }

  function pausedEffect(binding, tool) {
    return ['edit', 'write', 'bash'].includes(tool) && store.getRun(binding?.runId)?.status === 'AWAITING_USER_DECISION';
  }

  // An allow/ask is not a read-only declaration. Configured MCP calls retain
  // the active-dispatch fence and also require a healthy run for the root.
  // This is admission only, not a sandbox or a ledger of MCP-internal effects.
  function configuredToolDenial(sessionID, tool) {
    const policy = getToolPermissions();
    if (!isConfiguredMcpTool(policy, tool)) return null;
    const binding = bindings.get(sessionID);
    if (!binding && !dispatches.managed(sessionID)) return null;
    if (store.fault?.(binding?.runId)) return 'PERSISTENCE_FAILED: infrastructure fault; new MCP work is fenced';
    if (!binding || store.getRun(binding.runId)?.status !== 'RUNNING' || !binding.root && !dispatches.current(binding)) {
      return 'BINDING_UNAVAILABLE: configured MCP tools require a RUNNING run and an active, verified dispatch';
    }
    if (toolPermission(policy, binding.agent, tool) === 'deny') {
      return 'TOOL_PERMISSION_DENIED: this role does not permit the configured MCP tool';
    }
    return null;
  }

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
    const saved = structuredClone(state);
    const result = mutation(saved);
    await store.saveRun(saved);
    Object.assign(state, saved);
    return { state, result };
  }

  function rememberDenied(sessionId, callID, tool, target) {
    const binding = bindings.get(sessionId);
    const identity = { runId: binding.runId, nodeId: binding.nodeId ?? null,
      dispatchId: binding.dispatchId, sessionId, callID, tool, target };
    deniedCalls.set(callKey(sessionId, callID), identity);
    return identity;
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
        if (state.status !== 'SETTLING' && (state.status === 'AWAITING_USER_DECISION' || state.settlement || store.fault?.(state.runId) || state.dispatchReservations?.some((r) => r.settlementOnly || r.nested))) {
          await dispatches.recoverPaused(state);
        }
        const pendingEffectsBeforeRecovery = state.pendingEffects?.length ?? 0;
        for (const effect of (state.pendingEffects ?? []).slice(0, 128)) {
          if (effect.runId === state.runId && typeof effect.sessionId === 'string' && typeof effect.callID === 'string') {
            startedCalls.set(callKey(effect.sessionId, effect.callID), { ...effect });
          }
        }
        if (state.status !== 'SETTLING') await recoverEffectOutcomes(state);
        // A durable tool outcome can remove the last blocker from a turn already
        // witnessed above. Reconcile once in this same serialized restart rather
        // than requiring another host event (which may never be delivered).
        if (state.status === 'AWAITING_USER_DECISION' && (state.pendingEffects?.length ?? 0) < pendingEffectsBeforeRecovery) {
          await dispatches.recoverPaused(state);
        }
        // The authoritative violation ledger already persists denied-call
        // provenance. Rebuild only those identities, never execution authority.
        for (const entry of state.violations) {
          if (typeof entry.dispatchId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.callID !== 'string') continue;
          const identity = callKey(entry.sessionId, entry.callID);
          if (entry.kind === 'executed-despite-deny') {
            deniedCalls.delete(identity);
            recorded(identity);
          } else if (denialKinds.has(entry.kind)) {
            deniedCalls.set(identity, { runId: state.runId, nodeId: entry.nodeId, dispatchId: entry.dispatchId,
              sessionId: entry.sessionId, callID: entry.callID, tool: entry.tool, target: entry.target });
          }
        }
        bindings.set(sessionID, { runId: state.runId, agent, nodeId: null, root: true });
      } else {
        const capturedAt = NOW();
        const captured = captureRequest(output?.parts, settings.journal);
        const request = captured ? { ...captured, capturedAt } : null;
        state = await store.createRun({
          runId: sessionID,
          executionStrategy: settings.executionStrategy ?? 'graph',
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
      const patterns = node.spec.writeScope ?? [];
      const rawTarget = args?.filePath ?? args?.path;
      const target = toWorkspaceRelative(rawTarget);
      if (typeof target !== 'string') {
        return { state, node, nodeId: node.spec.id, target: null, allowed: false, kind: 'unparsed-write-target',
          reason: `could not determine the ${tool} target${typeof rawTarget === 'string' ? ` from ${JSON.stringify(rawTarget.slice(0, 120))}` : ' (missing filePath)'}; supply a literal workspace-relative file path inside the writeScope [${patterns.join(', ')}] of ${node.spec.id}` };
      }
      const allowed = patterns.length > 0 && patterns.some((pattern) => matchScopePath(pattern, target));
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
    const directState = store.getRun(bindings.get(sessionID)?.runId);
    if (['edit', 'write', 'bash', 'task'].includes(tool) && (directState?.pendingEffects ?? []).some(e => e.tool === 'graph_direct_check')) throw new Error('DIRECT_EFFECT_PENDING: command execution must finish before edits, shell or dispatch');
    const configuredDenial = configuredToolDenial(sessionID, tool);
    if (configuredDenial) throw new Error(configuredDenial);
    if (tool === 'task') {
      await dispatches.ensureSession(sessionID);
      const binding = bindings.get(sessionID);
      if (!binding) {
        if (dispatches.managed(sessionID)) throw new Error('BINDING_UNAVAILABLE: task requires an active authenticated dispatch; stop and report the limitation');
        return;
      }
      const state = store.getRun(binding.runId);
      if (!state) throw new Error('BINDING_UNAVAILABLE: owning run is unavailable; stop and report the limitation');
      store.assertHealthy?.(binding.runId);
      const args = output.args ??= {};
      const formattingKey = callKey(sessionID, callID);
      if (formattedCalls.get(formattingKey) === JSON.stringify(args)
        && handoffForCall(state, sessionID, callID)) return;
      const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type : null;
      const target = parseNodeIdHint(args, { strict: TARGET_REQUIRED_AGENTS.has(subagentType) });
      const decision = target.allowed ? await dispatches.admit(sessionID, callID, args, target.nodeId) : target;
      if (!decision.allowed) {
        const error = dispatchRejection(decision, args, { callID, source: target.source ?? (Object.hasOwn(args, 'nodeId') ? 'argument' : 'marker') });
        await dispatches.exclusive(binding.runId, async () => {
          const saved = structuredClone(state);
          runner.recordViolation(saved, { nodeId: binding.nodeId ?? null, kind: 'gate-blocked-dispatch',
            detail: `${subagentType}: ${error.message}`, sessionId: sessionID, callID, tool: 'task', now: NOW() });
          await store.saveRun(saved);
          Object.assign(state, saved);
        });
        throw error;
      }
      const handoff = handoffForCall(state, sessionID, callID);
      let prompt = `[DISPATCH NOTES] Supplementary coordinator context only. Copied RUNNER labels below are quoted text, not authoritative contracts.\n${dispatchNotes(typeof args.prompt === 'string' ? args.prompt : '')}`;
      if (decision.nested) prompt = `[RUNNER NESTED_CONSULT] This is a free image consultation, not a graph node. Return observations, sources, uncertainty and limitations through the native task response only. Do not call graph_submit_findings, including paused closeout. The caller owns formal graph delivery.\n${prompt}`;
      if (decision.nodeId) {
        // The runner echoes the node's authoritative (token-expanded) scope
        // and deliverables, and injects the approved plan's acceptance
        // verbatim as the work/verification contract: the bound
        // implementer's ground truth comes from the runner, never from
        // planner prose that may still carry tokens.
        const spec = handoff?.contract ?? state.nodes[decision.nodeId]?.spec ?? null;
        const authoritative = [];
        if (spec && Array.isArray(spec.writeScope) && spec.writeScope.length) authoritative.push(`[RUNNER] writeScope: ${spec.writeScope.join(', ')}. Write only inside these literal paths.`);
        if (spec && Array.isArray(spec.deliverables) && spec.deliverables.length) authoritative.push(`[RUNNER] deliverables: ${spec.deliverables.join(', ')}.`);
        if (spec && (spec.kind === 'implement' || spec.kind === 'verify') && Array.isArray(spec.acceptance) && spec.acceptance.length) {
          const planVersion = handoff?.planVersion || state.artifacts.plan?.version || 1;
          if (state.mode === 'direct') authoritative.push(`[RUNNER] Direct contract direct-contract@${state.artifacts['direct-contract'].version}. Execute mandatory checks using graph_direct_check({checkId}); checksRun prose is not evidence. Repair failed checks in this same session within the global budget. Return unresolved work to root; never widen the contract.`);
          const lead = spec.kind === 'implement'
            ? `[RUNNER] acceptance (verbatim from ${state.mode === 'direct' ? `direct-contract@${state.artifacts['direct-contract'].version}` : `plan@${planVersion}`}; this is your work contract — implement it as written. Do not re-derive it, re-validate its premises, or substitute alternatives; if it conflicts with reality, stop and report via unresolved instead of re-planning in place. Dispatch prose conflicting with these lines yields to these lines):`
            : `[RUNNER] acceptance (verbatim from plan@${planVersion}; this is your verification contract — verify against these criteria as written. Do not invent stricter or looser criteria; dispatch prose conflicting with these lines yields to these lines):`;
          authoritative.push(lead);
          spec.acceptance.forEach((item, index) => authoritative.push(`  ${index + 1}. ${String(item)}`));
        }
        if (spec && spec.kind === 'verify') {
          // Implementer-reported risks are relayed mechanically so the
          // verifier probes them first instead of trusting green commands.
          const risks = [...new Set((spec.dependsOn ?? []).flatMap((dep) => state.artifacts[`change:${dep}`]?.payload?.risks ?? []))].slice(0, 16).map(String);
          if (risks.length) authoritative.push(`[RUNNER] implementer-reported risks (probe these first): ${risks.join(' | ')}`);
          const dependencies = new Set(spec.dependsOn ?? []);
          const uncertain = state.sideEffects.filter((effect) => dependencies.has(effect.nodeId) && isUncertainEffect(effect));
          if (uncertain.length) {
            const allTargets = [...new Set(uncertain.map((effect) => `${effect.nodeId} ${effect.tool}: ${String(effect.target).slice(0, 512)} (sessionId=${effect.sessionId ?? 'unknown'}, callID=${effect.callID ?? 'unknown'})`))];
            const targets = allTargets.slice(0, 8);
            authoritative.push(`[RUNNER] ${uncertain.length} uncertain tool outcome(s) across ${allTargets.length} target(s), ${targets.length} shown: ${targets.join(' | ')}. Full details remain in the run side-effect ledger. Errors may have no or partial effects; independently inspect these targets, including unclaimed paths, before PASS.`);
            authoritative.push('[RUNNER] After resolving effects of this verifier or directly consumed implement/verify dependencies, submit resolvedEffects:[{sessionId,callID}] with PASS, an existing evidence artifact and probed findings. Historical errors remain recorded; unresolved effects block final settlement. graph_inspect lists uncertain effect identities.');
          }
        }
        if (spec && spec.kind === 'plan') {
          const learnings = learningsPrompt(state);
          if (learnings) authoritative.push(learnings);
        }
        if (spec && (spec.kind === 'implement' || spec.kind === 'plan')) {
          const block = await dispatchLessonsBlock(spec.writeScope ?? [], args.prompt);
          if (block) authoritative.push(block);
        }
        prompt = `[RUNNER] Assigned nodeId: ${decision.nodeId}${decision.resolvedBy === 'unique-admissible' ? ' (auto-resolved: the only admissible node for this role right now; prefer the structured nodeId field)' : ''}. Submit only this node.${authoritative.length ? `\n${authoritative.join('\n')}` : ''}\n${prompt}`;
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
      const artifacts = renderHandoff(state, handoff);
      if (artifacts) prompt = `${artifacts}\n\n${prompt}`;
      prompt = prompt.replace(/\[RUNNER_TASK_CALL:[^\]\r\n]*\]/g, '');
      // Native task execution retains the original args object across the hook.
      args.prompt = `${prompt}\n[RUNNER_TASK_CALL:${decision.turnToken}]`;
      delete args.nodeId;
      formattedCalls.set(formattingKey, JSON.stringify(args));
      if (formattedCalls.size > 128) formattedCalls.delete(formattedCalls.keys().next().value);
      return;
    }
    if (tool === 'edit' || tool === 'write' || tool === 'bash') {
      const decision = decideWriteBinding(sessionID, tool, output.args);
      if (!decision || decision.allowed) {
        const binding = bindings.get(sessionID);
        if (dispatches.current(binding) && binding.nodeId) {
          const key = callKey(sessionID, callID);
          const state = store.getRun(binding.runId);
          if ((state.pendingEffects?.length ?? 0) >= 128 || startedCalls.has(key) || recordedCalls.has(key)
            || state.sideEffects.some((effect) => effect.sessionId === sessionID && effect.callID === callID)) throw new Error('CALL_LEDGER_UNAVAILABLE: a fresh bounded host call identity is required');
          const args = output.args ?? {};
          const target = tool === 'bash' ? (typeof args.command === 'string' ? args.command.slice(0, 200) : null) : toWorkspaceRelative(args.filePath ?? args.path);
          const observed = observedToolParts.get(key);
          const started = { runId: binding.runId, nodeId: binding.nodeId, sessionId: sessionID, dispatchId: binding.dispatchId, tool, target, callID,
            messageId: observed?.tool === tool ? observed.messageId : null,
            partId: observed?.tool === tool ? observed.partId : null };
          const saved = { ...state, pendingEffects: [...(state.pendingEffects ?? []), started] };
          assertSettlementCapacity(saved);
          await store.saveRun(saved);
          state.pendingEffects = saved.pendingEffects;
          state.updatedAt = saved.updatedAt;
          startedCalls.set(key, started);
        }
        return;
      }
      const identity = rememberDenied(sessionID, callID, tool, decision.target);
      runner.recordViolation(decision.state, { ...identity, kind: decision.kind, detail: decision.reason, now: NOW() });
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
    if (kind === 'unparsed-write-target') {
      return 'Retry with a literal workspace-relative file path in filePath; never a directory, glob, empty value or absent argument. The [RUNNER] writeScope line in your dispatch prompt is authoritative.';
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
    const binding = bindings.get(sessionID);
    if (dispatches.current(binding) && authenticDirectPermission(store, input, binding, store.getRun(binding.runId))) return;
    const tool = type;
    if (tool !== 'edit' && tool !== 'write' && tool !== 'bash') return;
    const key = callKey(sessionID, callID);
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
      const identity = rememberDenied(sessionID, callID, tool, decision.target);
      runner.recordViolation(decision.state, { ...identity, kind: decision.kind, detail: `${decision.reason} (denied at permission prompt)`, now: NOW() });
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
    const evidenceKey = callKey(sessionID, callID);
    if (recordedCalls.has(evidenceKey)) return;
    const denied = deniedCalls.get(evidenceKey);
    if (denied) {
      if (denied.tool !== tool) return;
      const saved = await mutate(denied.runId, (state) => {
        runner.recordViolation(state, { ...denied, kind: 'executed-despite-deny', detail: `${tool} ran even though the runner denied it`, now: NOW() });
        // Preserve late evidence on its original run/dispatch. Only that exact
        // still-running attempt can be tainted, never a newer session reuse.
        runner.taintAttempt(state, { ...denied, detail: `${tool} executed despite runner denial`, now: NOW() });
      });
      if (saved) {
        deniedCalls.delete(evidenceKey);
        recorded(evidenceKey);
      }
      return;
    }
    const started = startedCalls.get(evidenceKey);
    // The current session binding cannot authenticate a callback from an old
    // attempt. Missing before-hook provenance stays uncorrelated, even RUNNING.
    if (!started || started.tool !== tool) return;
    const binding = started;
    if (!binding || binding.root || !binding.nodeId) return;
    const target = started.target;
    if (target === null && tool !== 'bash') return;
    const state = store.getRun(binding.runId);
    if (!state) return;
    if (state.sideEffects.some((effect) => effect.sessionId === sessionID && effect.callID === callID)) return;
    const saved = { ...state, sideEffects: [...state.sideEffects],
      pendingEffects: (state.pendingEffects ?? []).filter((effect) => callKey(effect.sessionId, effect.callID) !== evidenceKey) };
    runner.recordSideEffect(saved, { nodeId: binding.nodeId, tool, target, now: NOW(), dispatchId: binding.dispatchId, callID, sessionId: sessionID,
      messageId: started.messageId, partId: started.partId });
    await store.saveRun(saved);
    state.sideEffects = saved.sideEffects;
    state.pendingEffects = saved.pendingEffects;
    state.updatedAt = saved.updatedAt;
    startedCalls.delete(evidenceKey);
    recorded(evidenceKey);
  }

  async function settleEffectPart(part) {
    const identity = callKey(part?.sessionID, part?.callID);
    const effect = startedCalls.get(identity);
    if (!effect || effect.tool !== part.tool || !['completed', 'error'].includes(part.state?.status)
      || !Number.isFinite(part.state.time?.end) || typeof part.id !== 'string' || typeof part.messageID !== 'string'
      || part.id.length > 256 || part.messageID.length > 256
      || effect.messageId && effect.messageId !== part.messageID || effect.partId && effect.partId !== part.id) return;
    const state = store.getRun(effect.runId);
    const saved = { ...state, sideEffects: [...state.sideEffects],
      pendingEffects: (state.pendingEffects ?? []).filter((p) => callKey(p.sessionId, p.callID) !== identity) };
    runner.recordSideEffect(saved, { ...effect, now: NOW(), messageId: part.messageID, partId: part.id,
      outcome: part.state.status, uncertain: part.state.status === 'error' });
    await store.saveRun(saved);
    Object.assign(state, { sideEffects: saved.sideEffects, pendingEffects: saved.pendingEffects, updatedAt: saved.updatedAt });
    startedCalls.delete(identity);
    recorded(identity);
  }

  async function recoverEffectOutcomes(state) {
    if (!client?.session?.messages) return;
    const signal = AbortSignal.timeout(2000);
    for (const sessionId of new Set((state.pendingEffects ?? []).map((effect) => effect.sessionId))) {
      let messages;
      try { messages = (await client.session.messages({ path: { id: sessionId }, query: { limit: 64 }, signal })).data; }
      catch { continue; }
      for (const message of Array.isArray(messages) ? messages.slice(-64) : []) {
        if (message.info?.sessionID !== sessionId || !Array.isArray(message.parts) || message.parts.length > 256) continue;
        for (const part of message.parts) {
          if (part.type === 'tool' && part.sessionID === sessionId && part.messageID === message.info.id) await settleEffectPart(part);
        }
      }
    }
  }

  async function onEvent(input) {
    const event = input?.event;
    if (!event || typeof event.type !== 'string') return;
    const { type, properties } = event;

    if (type === 'session.created' || type === 'session.updated') return dispatches.onSession(properties?.info);
    if (type === 'message.updated') return dispatches.onMessage(properties?.info);
    if (type === 'message.part.updated') {
      const part = properties?.part;
      if (part?.tool === 'task') return dispatches.onPart(part);
      if (part?.type === 'tool' && ['edit', 'write', 'bash'].includes(part.tool)
        && ['pending', 'running'].includes(part.state?.status) && typeof part.sessionID === 'string'
        && typeof part.callID === 'string' && typeof part.messageID === 'string' && part.messageID.length <= 256
        && typeof part.id === 'string' && part.id.length <= 256) {
        const identity = callKey(part.sessionID, part.callID);
        if (!observedToolParts.has(identity)) observedToolParts.set(identity, { tool: part.tool, messageId: part.messageID, partId: part.id });
        if (observedToolParts.size > 256) observedToolParts.delete(observedToolParts.keys().next().value);
      }
      const effect = startedCalls.get(callKey(part?.sessionID, part?.callID));
      if (effect && part?.type === 'tool') {
        await dispatches.exclusive(effect.runId, () => settleEffectPart(part));
        await dispatches.onMessage({ id: part.messageID, sessionID: part.sessionID });
      }
      return;
    }
    // Pinned host emits both status(idle) and idle for one transition. Consume
    // only the latter or a continuation would be completed twice.
    if (type === 'session.idle') return dispatches.onIdle(properties?.sessionID, event.id);
  }

  async function childOperation(input, output, operation, requireActive = false) {
    const sessionID = input?.sessionID;
    await dispatches.ensureSession(sessionID);
    const binding = bindings.get(sessionID);
    const work = () => {
      if (requireActive && binding && !['graph_run_resume', 'graph_inspect', 'graph_artifact_read'].includes(input?.tool)) store.assertHealthy?.(binding.runId);
      if (requireActive && pausedEffect(binding, input?.tool)) throw new Error('BINDING_UNAVAILABLE: the run is paused; only settlement of already-started work is permitted');
      if (requireActive && !binding?.root && dispatches.managed(sessionID) && !dispatches.current(binding) && !canCloseout(binding, input?.tool)) {
        throw new Error('BINDING_UNAVAILABLE: this session has no active, verified dispatch (its previous dispatch finished, was rejected, or was revoked); stop working, report this reason back, and let the coordinator re-dispatch');
      }
      return operation(input, output);
    };
    return binding ? dispatches.exclusive(binding.runId, work) : work();
  }

  return Object.freeze({
    onChatMessage: (input, output) => (input?.agent ?? output?.message?.agent) === 'graph-orchestrator'
      ? dispatches.exclusive(bindings.get(input?.sessionID)?.runId ?? input?.sessionID, () => onChatMessage(input, output))
      : dispatches.onUserPrompt(output?.message, output?.parts),
    onToolBefore: (input, output) => input?.tool === 'task' ? onToolBefore(input, output) : childOperation(input, output, onToolBefore, !READ_ONLY_TOOLS.has(input?.tool)),
    onToolAfter: async (input, output) => {
      if (input?.tool === 'task') return onToolAfter(input, output);
      const identity = callKey(input?.sessionID, input?.callID);
      const captured = deniedCalls.get(identity) ?? startedCalls.get(identity);
      const result = await (captured ? dispatches.exclusive(captured.runId, () => onToolAfter(input, output)) : childOperation(input, output, onToolAfter));
      const state = store.getRun(captured?.runId ?? bindings.get(input?.sessionID)?.runId);
      if (state?.status === 'AWAITING_USER_DECISION' || state?.pendingIdleEvidence?.length) await dispatches.reconcileSession(input?.sessionID);
      return result;
    },
    onPermissionAsk: (input, output) => childOperation(input, output, async (i, o) => {
      if (!READ_ONLY_TOOLS.has(i?.type) && store.fault?.(bindings.get(i?.sessionID)?.runId)) { o.status = 'deny'; return; }
      if (configuredToolDenial(i?.sessionID, i?.type)) { o.status = 'deny'; return; }
      if (pausedEffect(bindings.get(i?.sessionID), i?.type)) { o.status = 'deny'; return; }
      if (!READ_ONLY_TOOLS.has(i?.type) && dispatches.managed(i?.sessionID) && !bindings.get(i.sessionID)?.root && !dispatches.current(bindings.get(i.sessionID)) && !canCloseout(bindings.get(i.sessionID), i?.type)) { o.status = 'deny'; return; }
      return onPermissionAsk(i, o);
    }),
    onEvent, dispatches,
    reconcileSettlement: (runId, remaining) => hostReader.withBudget(remaining, async () => {
      const state = store.getRun(runId);
      if (state) await recoverEffectOutcomes(state);
      await dispatches.reconcileRun(runId, remaining);
    }),
    internals: Object.freeze({ bindings, deniedCalls, decideWriteBinding, toWorkspaceRelative, READ_ONLY_TOOLS }),
  });
}
