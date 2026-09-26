import { tool } from '@opencode-ai/plugin/tool';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import { captureWorkspace } from './direct-workspace.mjs';
import { runDirectCommand } from './direct-check.mjs';
import { assertSettlementCapacity, pauseForDecision } from './runner.mjs';
import { unresolvedEffects } from './effect-resolution.mjs';
import { directSettled, installDirect, registerDirectPermission, validateDirectContract } from './direct.mjs';
import { firstOutOfScopeShellWrite } from './shell-scope.mjs';

const z = tool.schema;
const now = () => new Date().toISOString();
const reply = value => JSON.stringify(value);
const reject = (code, detail) => ({ ok: false, code, detail });

export function createDirectTools({ store, bindings, dispatches, worktree, settings = {} }) {
  const exclusive = (id, fn) => dispatches ? dispatches.exclusive(id, fn) : fn();
  const maxAttempts = settings.maxAttempts ?? 3;
  function locate(context, root = false) {
    const binding = bindings.get(context.sessionID);
    const state = binding && store.getRun(binding.runId);
    if (!state || binding.agent !== context.agent || binding.active === false || binding.settlementOnly) return { error: reject('NOT_DISPATCHED_NODE', 'Authenticated active run binding required') };
    if (store.fault?.(binding.runId)) return { error: reject('PERSISTENCE_FAILED', 'Execution is fenced after persistence failure') };
    if (state.status !== 'RUNNING') return { error: reject('RUN_NOT_EXECUTING', 'Run must be RUNNING') };
    if (root ? !binding.root || context.agent !== 'graph-orchestrator' || context.sessionID !== state.rootSessionId
      : binding.root || context.agent !== 'graph-implementer' || binding.nodeId !== 'direct' || state.mode !== 'direct'
        || state.nodes.direct?.state !== 'RUNNING' || state.nodes.direct.sessionId !== context.sessionID
        || state.nodes.direct.dispatchId !== binding.dispatchId || !dispatches?.current(binding)) return { error: reject('WRONG_ROLE', root ? 'Only the root orchestrator may change the contract' : 'Only the current Direct implementer may execute a check') };
    return { state, binding };
  }
  async function executeRoot(context, operation) {
    await dispatches?.ensureSession(context.sessionID);
    const binding = bindings.get(context.sessionID);
    if (!binding) return reply(reject('NOT_GRAPH_SESSION', 'No run binding'));
    return exclusive(binding.runId, async () => {
      const located = locate(context, true);
      return reply(located.error ?? await operation(located.state));
    });
  }
  const graph_direct_start = tool({
    description: 'Root freezes a bounded Direct contract before any writes. One implementer runs all mandatory frozen foreground commands via graph_direct_check. Commands MUST finish all work in foreground; detached/background processes are unsupported. Literal file scopes only. Existing Direct contract revision requires all prior host lifetimes/effects settled and preserves original baseline and counters. Use Graph for broad work or unsupported inventory.',
    args: { requirement: z.string().min(1).max(8000), acceptance: z.array(z.string().min(1).max(2000)).min(1).max(16),
      writeScope: z.array(z.string().min(1).max(512)).min(1).max(32), deliverables: z.array(z.string().min(1).max(512)).min(1).max(32),
      checks: z.array(z.object({ id: z.string().min(1).max(64), command: z.string().min(1).max(2000), cwd: z.string().min(1).max(512), timeoutMs: z.number().int().min(1).max(300000) })).min(1).max(8),
      rationale: z.string().min(1).max(2000) },
    async execute(args, context) {
      return executeRoot(context, async state => {
        if (state.executionStrategy !== 'auto' || !['unknown', 'direct'].includes(state.mode)) return reject('DIRECT_UNAVAILABLE', 'This run uses Graph; strategy is persistent');
        if (!directSettled(state)) return reject('DISPATCH_PENDING', 'Settle existing host lifetimes and effects before contract selection or revision');
        if ((state.direct?.revisions ?? 0) >= (settings.maxPlanRevisions ?? maxAttempts) || (state.direct?.failures ?? 0) >= maxAttempts) return reject('DIRECT_BUDGET_EXHAUSTED', 'Escalate to Graph; Direct budgets are retained across revisions');
        const problem = validateDirectContract(args, settings);
        if (problem) return reject('INVALID_DIRECT_CONTRACT', problem);
        let baseline;
        try { baseline = await captureWorkspace(worktree, settings); }
        catch (error) { return reject('DIRECT_WORKSPACE_UNSUPPORTED', `${error.message}; select Graph`); }
        const rechecked = locate(context, true);
        if (rechecked.error) return rechecked.error;
        const candidate = structuredClone(rechecked.state);
        const version = installDirect(candidate, structuredClone(args), baseline, now());
        candidate.direct.stateDirectory = settings.stateDirectory ?? '.opencode-loop';
        assertSettlementCapacity(candidate);
        await store.saveRun(candidate);
        return { ok: true, nodeId: 'direct', contractVersion: version, next: 'dispatch graph-implementer nodeId direct' };
      });
    },
  });
  const graph_direct_escalate = tool({
    description: 'Root explicitly selects Graph or escalates a settled Direct attempt. Preserves Direct evidence, baseline and counters. No worker may widen its contract.',
    args: { rationale: z.string().min(1).max(2000) },
    async execute(args, context) {
      return executeRoot(context, async state => {
        if (typeof args.rationale !== 'string' || !args.rationale.trim() || args.rationale.length > 2000) return reject('INVALID_RATIONALE', 'A bounded rationale is required');
        if (!directSettled(state)) return reject('DISPATCH_PENDING', 'Settle all host lifetimes and effects first');
        if (!['unknown', 'direct'].includes(state.mode)) return reject('GRAPH_ALREADY_SELECTED', 'Graph is already selected');
        state.executionStrategy = 'graph';
        state.strategyDecision = { strategy: 'graph', rationale: args.rationale, at: now() };
        if (state.mode === 'direct') { state.nodes.direct.state = 'SKIPPED'; state.mode = 'unknown'; }
        await store.saveRun(state);
        return { ok: true, next: 'dispatch graph-planner; existing Direct evidence and counters remain retained' };
      });
    },
  });
  const graph_direct_check = tool({
    description: 'Current Direct implementer executes one frozen foreground check with host bash permission. checkId resolves the runner-owned command; caller-supplied commands or reported checksRun are not evidence. Pending work fences writes/submission/dispatch. A failed complete check may be repaired in the same session within the global failure budget; interrupted work cannot auto-pass.',
    args: { checkId: z.string().min(1).max(64) },
    async execute(args, context) {
      await dispatches?.ensureSession(context.sessionID);
      const first = locate(context);
      if (first.error) return reply(first.error);
      const id = first.state.runId;
      const preflight = () => {
        const located = locate(context);
        if (located.error) return located;
        const { state, binding } = located;
        if (state.pendingEffects?.length || unresolvedEffects(state).length) return { error: reject('DIRECT_EFFECT_PENDING', 'Pending or uncertain effects require settlement') };
        if (state.direct.failures >= maxAttempts) return { error: reject('DIRECT_BUDGET_EXHAUSTED', 'Direct global failure budget exhausted; return to root for settled escalation') };
        if (state.direct.evidence.length >= Math.min(128, maxAttempts * 16)) return { error: reject('DIRECT_CHECK_LIMIT', 'Direct check history reached its bounded run limit; return to root for settled escalation') };
        const contract = state.artifacts['direct-contract'];
        if (contract?.status !== 'valid' || !(state.nodes.direct.consumedRefs ?? []).includes(`direct-contract@${contract.version}`)) return { error: reject('DIRECT_CONTRACT_STALE', 'Consumed contract version is no longer valid') };
        const check = contract.payload.checks.find(c => c.id === args.checkId);
        if (!check) return { error: reject('UNKNOWN_DIRECT_CHECK', 'Use a checkId from the frozen contract') };
        // Same best-effort screen as native bash, with the frozen command cwd.
        // Permission and post-command inventory checks still apply to parse misses.
        const outside = firstOutOfScopeShellWrite(check.command, state.nodes.direct.spec.writeScope, target => {
          const path = relative(worktree, target);
          return !path || path.startsWith('..') || isAbsolute(path) ? null : path.split(sep).join('/');
        }, check.cwd === '.' ? '' : check.cwd);
        if (outside !== null) return { error: reject('OUT_OF_SCOPE', `${outside}: frozen check has a detectable write outside its contract`) };
        return { state, binding, check, version: contract.version };
      };
      const initial = await exclusive(id, preflight);
      if (initial.error) return reply(initial.error);
      const identity = { sessionId: context.sessionID, dispatchId: initial.binding.dispatchId, attempt: initial.state.nodes.direct.attempt, contractVersion: initial.version };
      const nonce = randomUUID();
      const releasePermission = registerDirectPermission(store, { ...identity, runId: id, nonce, command: initial.check.command, checkId: args.checkId });
      try {
        if (typeof context.ask !== 'function') throw new Error('Host permission API unavailable');
        await context.ask({ permission: 'bash', patterns: [initial.check.command], always: [initial.check.command], metadata: { command: initial.check.command, cwd: join(worktree, initial.check.cwd), directCheckId: args.checkId, directPermissionNonce: nonce } });
      } catch { return reply(reject('DIRECT_PERMISSION_DENIED', 'Check was not executed because host bash permission was unavailable or denied')); }
      finally { releasePermission(); }
      const operationId = randomUUID();
      const prepared = await exclusive(id, async () => {
        const located = preflight();
        if (located.error) return located;
        const { state, check, binding, version } = located;
        if (binding.dispatchId !== identity.dispatchId || version !== identity.contractVersion || state.nodes.direct.attempt !== identity.attempt || context.abort?.aborted) return { error: reject('DIRECT_CHECK_REVOKED', 'Dispatch or contract changed while awaiting permission') };
        let inventory;
        try { inventory = await captureWorkspace(worktree, settings); }
        catch (error) { return { error: reject('DIRECT_WORKSPACE_UNSUPPORTED', error.message) }; }
        const pending = { runId: id, nodeId: 'direct', ...identity, callID: operationId, tool: 'graph_direct_check', target: check.command, checkId: check.id, beforeRevision: inventory.revision, at: now() };
        const candidate = structuredClone(state);
        candidate.pendingEffects = [...(candidate.pendingEffects ?? []), pending];
        assertSettlementCapacity(candidate);
        await store.saveRun(candidate);
        return { pending, check: structuredClone(check), beforeRevision: inventory.revision };
      });
      if (prepared.error) return reply(prepared.error);
      let result;
      try { result = await runDirectCommand({ ...prepared.check, cwd: join(worktree, prepared.check.cwd), signal: context.abort }); }
      catch (error) { result = { status: 'error', exitCode: null, output: String(error.message), uncertain: true }; }
      let after;
      try { after = await captureWorkspace(worktree, settings); }
      catch (error) { result = { ...result, status: 'error', uncertain: true, output: `${result.output}\nInventory unavailable: ${error.message}` }; }
      return exclusive(id, async () => {
        const state = store.getRun(id);
        const pending = state?.pendingEffects?.find(e => e.callID === operationId && e.tool === 'graph_direct_check');
        if (!pending) return reply(reject('DIRECT_EFFECT_LOST', 'Execution occurred but pending operation was lost; recovery required'));
        const located = locate(context);
        const valid = !located.error && located.binding.dispatchId === identity.dispatchId && state.artifacts['direct-contract'].version === identity.contractVersion;
        const stable = after?.revision === prepared.beforeRevision;
        const evidence = { ...identity, runId: id, operationId, checkId: prepared.check.id, command: prepared.check.command, cwd: prepared.check.cwd,
          ...result, output: result.output.slice(0, 2000), beforeRevision: prepared.beforeRevision, revision: after?.revision ?? null,
          status: !valid ? 'revoked' : result.status === 'passed' && !stable ? 'workspace-changed' : result.status, at: now() };
        state.direct.evidence.push(evidence);
        if (evidence.status !== 'passed' || evidence.uncertain) state.direct.failures += 1;
        if (evidence.uncertain) {
          pauseForDecision(state, 'direct-check-uncertain', 'Direct command outcome is uncertain; stop new effects and preserve evidence for a user decision', now(), { nodeId: 'direct' });
        } else if (state.direct.failures >= maxAttempts || state.direct.evidence.length >= Math.min(128, maxAttempts * 16)) {
          pauseForDecision(state, 'direct-budget-exhausted', 'Direct check or failure budget exhausted; evidence retained for a user decision', now(), { nodeId: 'direct' });
        }
        state.pendingEffects = state.pendingEffects.filter(e => e.callID !== operationId);
        state.sideEffects.push({ ...pending, outcome: evidence.uncertain ? 'error' : 'completed', uncertain: evidence.uncertain === true, at: now() });
        await store.saveRun(state);
        return reply({ ok: evidence.status === 'passed' && !evidence.uncertain, code: evidence.status === 'passed' ? 'DIRECT_CHECK_PASSED' : 'DIRECT_CHECK_FAILED',
          evidence, remainingFailures: Math.max(0, maxAttempts - state.direct.failures) });
      });
    },
  });
  return { graph_direct_start, graph_direct_check, graph_direct_escalate };
}
