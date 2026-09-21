// Structured handoff tools. Each graph role must deliver its work through the
// matching graph_submit_* call; free-text task results alone never advance a
// run. Tools verify the caller's agent and session binding before touching
// run state, so a specialist cannot forge another role's submission.

import { tool } from '@opencode-ai/plugin/tool';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanJson } from './json-safe.mjs';
import { assertSettlementCapacity, isUncertainEffect } from './runner.mjs';
import { publishArtifact, validateRepairTargets, verificationFiles, repairSettlementPending } from './artifact-dependencies.mjs';
import { validateTaskGraph, expandRunTokens, runToken, validateFileClaim } from './task-spec.mjs';

const z = tool.schema;
const NOW = () => new Date().toISOString();

function reply(payload) {
  return JSON.stringify(payload);
}
function rejected(code, detail, hint = null) {
  return reply({ ok: false, code, detail, ...(hint ? { hint } : {}) });
}

// Artifact paths follow the file-claim rules (literal workspace-relative
// files, no directories or globs) with one exception: the verifier scratch
// root /tmp/ may be referenced absolutely because scratch scripts and their
// outputs legitimately live outside the worktree.
function artifactPathProblem(input) {
  if (typeof input !== 'string' || !input.length) return 'empty artifact path';
  if (input.startsWith('/tmp/')) return null;
  const checked = validateFileClaim(input);
  return checked.ok ? null : checked.detail;
}

export function createSubmitTools({ store, runner, bindings, worktree, dispatches }) {
  function runFor(context) {
    const binding = bindings.get(context.sessionID);
    if (!binding) return { error: rejected('NOT_GRAPH_SESSION', 'this session is not part of a graph run; work is dispatched by graph-orchestrator through native task') };
    if (binding.agent !== context.agent || binding.active === false || binding.settlementOnly) return { error: rejected('NOT_DISPATCHED_NODE', 'caller must match an active dispatch binding') };
    const state = store.getRun(binding.runId);
    if (!state) return { error: rejected('RUN_GONE', 'the owning run no longer exists') };
    return { binding, state };
  }
  function requireRole(context, agent) {
    if (context.agent !== agent) return rejected('WRONG_ROLE', `only ${agent} may call this tool (caller is ${context.agent})`);
    return null;
  }
  function boundNode(context, { binding, state }) {
    const node = binding.nodeId ? state.nodes[binding.nodeId] : null;
    if (!node || node.sessionId !== context.sessionID || dispatches && !dispatches.current(binding)) {
      return { error: rejected('NOT_DISPATCHED_NODE', `no in-flight node is bound to this session${binding.nodeId ? ` (last binding: ${binding.nodeId})` : ''}; deliver work only for the task you received`) };
    }
    return { node };
  }

  const graph_submit_plan = tool({
    description: 'Planner delivers the task graph: an intent (plan-only, change, or light) plus an array of TaskSpec nodes. The runner validates ids, dependencies, cycles, write-scope disjointness and mandatory gates before accepting it. light is a critic-free small-change lane: at most one implement node, review node omitted, all write-scope and evidence gates still enforced.',
    args: {
      intent: z.enum(['plan-only', 'change', 'light']),
      specs: z.array(z.record(z.string(), z.unknown())).min(1).max(64),
      basedOn: z.array(z.string()).max(16).optional(),
      parallel: z.object({ suggested: z.number().int().min(1).max(4), reason: z.string().max(2000) }).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-planner');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      if (Object.values(located.state.nodes).some((node) => node.state === 'RUNNING' && ['review', 'implement', 'verify'].includes(node.spec.kind))) {
        return rejected('RUN_BUSY', 'finish or recover in-flight review/implementation/verification before replacing the plan');
      }
      // {{run}} expands to this run's unique token before validation, so
      // run-unique lanes never depend on the planner guessing the run id.
      const expanded = expandRunTokens(args.specs, located.state.runId);
      const graph = validateTaskGraph(expanded, { planOnly: args.intent === 'plan-only', light: args.intent === 'light', maxAttemptsCeiling: 20 });
      if (!graph.ok) {
        return rejected('INVALID_GRAPH', graph.errors.join('; '), [
          'TaskSpec schema: {id, kind(explore|analyze|plan|review|implement|verify), agent — must be the kind-mapped graph-* specialist (explore→graph-explorer, analyze→graph-multimodal, plan→graph-planner, review→graph-plan-critic, implement→graph-implementer, verify→graph-verifier), dependsOn:[node ids] (required), inputs:[artifact refs like findings@1], outputs:[bare artifact names only — versions are runner-assigned], writeScope:[relative workspace paths/globs] (implement nodes only, non-empty, pairwise disjoint; use the {{run}} token for run-unique lanes — the runner expands it before validation), deliverables:[literal expected files within writeScope] (implement nodes, optional, enables progress reporting), acceptance:[criteria] (implement nodes required), baseline:true (verify nodes only, optional — captures pre-change suite evidence before any implement node runs), maxAttempts?, allowShell?}',
          'Gates: exactly one plan node; review depends on plan; implement depends on review (change) or on the plan node (light — critic-free, at most one implement node); verify depends on implement; a baseline verify node depends on review (or plan in light graphs), never on implement, and every implement node must depend on it when one is declared; plan-only intents contain no implement/verify nodes.',
          'Artifact names are runner-assigned: outputs must be findings (explore/analyze), plan (plan), review (review), change:<own id> (implement), verification:<own id> (verify) or baseline:<own id> (baseline verify nodes) — or omitted; inputs may only reference those names, with an optional @version.',
        ].join(' '));
      }
      try {
        const candidate = structuredClone(located.state);
        const result = runner.submitPlan(candidate, {
          intent: args.intent,
          nodes: graph.nodes,
          basedOn: cleanJson(args.basedOn ?? []),
          parallel: args.parallel ? cleanJson(args.parallel) : null,
          now: NOW(),
        });
        if (!result.ok) return rejected(result.code, result.detail);
        if (dispatches) await dispatches.revokeExecution(candidate);
        else await store.saveRun(candidate);
        Object.assign(located.state, candidate);
        // Echo the expanded literal paths so planner/orchestrator prose
        // (acceptance text, dispatch prompts) quotes real paths, not tokens.
        const lanes = [...graph.nodes.values()].filter((spec) => spec.kind === 'implement')
          .map((spec) => ({ id: spec.id, writeScope: spec.writeScope ?? [], deliverables: spec.deliverables ?? [] }));
        const next = args.intent === 'plan-only' ? 'await plan critique; no implementation will be admitted'
          : args.intent === 'light' ? 'dispatch the implement node directly (critic-free light lane); verification evidence gates still apply' : 'await plan critique before implementation';
        return reply({ ok: true, planVersion: result.version, mode: result.mode, runToken: runToken(located.state.runId), order: graph.order, lanes, next });
      } catch (error) {
        return rejected('PAYLOAD_INVALID', error.message);
      }
    },
  });

  const graph_submit_review = tool({
    description: 'Plan critic submits its verdict bound to a plan version. PASS advances to implementation, REVISE returns to the planner (capped), FAIL pauses the run for a user decision.',
    args: {
      planVersion: z.number().int().min(1),
      verdict: z.enum(['PASS', 'REVISE', 'FAIL']),
      findings: z.array(z.string().max(2000)).max(32).default([]),
      approvedParallel: z.number().int().min(1).max(4).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-plan-critic');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const bound = boundNode(context, located);
      if (bound.error) return bound.error;
      if (bound.node.spec.kind !== 'review') return rejected('NOT_DISPATCHED_NODE', 'caller must be bound to the review node');
      const result = runner.submitReview(located.state, { ...args, now: NOW() });
      if (!result.ok) return rejected(result.code, result.detail, result.code === 'STALE_PLAN_VERSION' ? 'the planner resubmitted; review the current plan version instead' : null);
      await store.saveRun(located.state);
      return reply({ ok: true, effect: result.effect, ...(result.detail ? { detail: result.detail } : {}) });
    },
  });

  const graph_submit_change = tool({
    description: 'Implementer reports its bound node using literal workspace-relative file paths (no directories/globs). filesDeleted is an absent subset of filesTouched. INVALID_FILE_CLAIM is correctable within this attempt; out-of-scope or undisclosed edits fail the node and are persisted.',
    args: {
      nodeId: z.string().min(1).max(128),
      filesTouched: z.array(z.string().min(1).max(512)).max(32),
      filesDeleted: z.array(z.string().min(1).max(512)).max(32).default([]),
      summary: z.string().min(1).max(2000),
      checksRun: z.array(z.string().max(2000)).max(16).default([]),
      unresolved: z.array(z.string().max(2000)).max(16).default([]),
      risks: z.array(z.string().max(2000)).max(16).default([]),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-implementer');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const bound = boundNode(context, located);
      if (bound.error) return bound.error;
      if (args.nodeId !== located.binding.nodeId) {
        return rejected('NOT_DISPATCHED_NODE', `nodeId must match the node bound to this session; this session is bound to ${located.binding.nodeId}`);
      }
      const checked = runner.checkChange(located.state, { ...args, now: NOW() });
      if (!checked.ok) {
        await store.saveRun(located.state);
        return reply(checked);
      }
      const snapshot = await store.hashFiles(checked.claimed);
      const result = runner.submitChange(located.state, { ...args, snapshot, now: NOW() });
      await store.saveRun(located.state);
      if (!result.ok) return reply(result);
      return reply({ ok: true, changeVersion: result.version, next: 'verification follows' });
    },
  });

  const graph_submit_verification = tool({
    description: 'Verifier submits evidence-bound verification. PASS requires at least one command with exitCode 0 (nonzero commands require an exact valid baseline match) and binds to consumed artifact versions. BASELINE records pre-change evidence; UNVERIFIED pauses for a user decision. Nonbaseline FAIL optionally accepts repairTargets: unique, nonempty literal DIRECT implement dependency node IDs; omitted means all direct implement dependencies. FAIL invalidates affected consumers transitively, preserves unrelated work, and remains globally capped. needsPlanRevision/offendingRefs require a revised plan, never silent repinning. Affected host lifetimes/effects must settle before replacement. artifacts are existing evidence file paths; probed and skipped record exercised or ruled-out scenarios. PASS over declared deliverables requires at least one artifact.',
    args: {
      nodeId: z.string().min(1).max(128),
      verdict: z.enum(['PASS', 'FAIL', 'UNVERIFIED', 'BASELINE']),
      repairTargets: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).min(1).max(64)
        .refine((ids) => new Set(ids).size === ids.length, 'repairTargets must be unique').optional(),
      commands: z.array(z.object({ command: z.string().min(1).max(2000), exitCode: z.number().int() })).max(32).default([]),
      artifacts: z.array(z.string().min(1).max(512)).max(32).default([]),
      probed: z.array(z.string().max(2000)).max(16).default([]),
      skipped: z.array(z.string().max(2000)).max(16).default([]),
      summary: z.string().max(2000).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-verifier');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const bound = boundNode(context, located);
      if (bound.error) return bound.error;
      if (args.nodeId !== located.binding.nodeId) {
        return rejected('NOT_DISPATCHED_NODE', `nodeId must match the node bound to this session; this session is bound to ${located.binding.nodeId}`);
      }
      const targets = validateRepairTargets(located.state, args);
      if (!targets.ok) return reply(targets);
      for (const artifact of args.artifacts ?? []) {
        const problem = artifact.startsWith('/tmp/') ? null : artifactPathProblem(artifact);
        if (problem) return rejected('INVALID_FILE_CLAIM', problem, 'artifacts are literal workspace-relative file paths (a /tmp/-prefixed absolute path is also accepted), never directories or globs');
        const resolved = artifact.startsWith('/tmp/') ? artifact : join(worktree, artifact);
        if (!existsSync(resolved)) return rejected('ARTIFACT_MISSING', `${artifact}: cited evidence artifact does not exist at submission time`, 'ARTIFACT_MISSING is correctable within this attempt; check the path and resubmit without redoing verified work');
      }
      const files = verificationFiles(located.state, bound.node);
      const snapshot = await store.hashFiles(files);
      const candidate = structuredClone(located.state);
      const result = runner.submitVerification(candidate, { ...args, snapshot, now: NOW() });
      if (!result.ok) {
        const hints = {
          INSUFFICIENT_EVIDENCE: 'cite the actual commands and their exit codes; nonzero commands are only tolerated on PASS when they match a declared baseline entry (same command and exit code)',
          ARTIFACT_REQUIRED: 'cite at least one existing artifact path (log, output file, screenshot) produced by the verified work',
          REJECTION_LOOP: 'stop resubmitting; the run is paused for a user decision — report the rejection and evidence back',
        };
        // Rejections mutate run state too (rejection streaks; the loop breaker
        // pauses the run), so persist before replying — a crash must not
        // resurrect a RUNNING node from disk and lose the pause.
        if (JSON.stringify(candidate) !== JSON.stringify(located.state)) {
          await store.saveRun(candidate);
          Object.assign(located.state, candidate);
        }
        return rejected(result.code, result.detail, hints[result.code] ?? null);
      }
      if (args.verdict === 'FAIL' && dispatches) await dispatches.revokeExecution(candidate, { nodeIds: result.affectedNodeIds });
      else await store.saveRun(candidate);
      Object.assign(located.state, candidate);
      return reply(result);
    },
  });

  const graph_submit_findings = tool({
    description: 'Explorer or multimodal analyst registers versioned findings the planner can reference as inputs (artifact name "findings"). learnings are durable patterns, pitfalls and principles the planner should incorporate (and later runs may re-derive from), distinct from the evidence trail.',
    args: {
      nodeId: z.string().min(1).max(128).optional(),
      summary: z.string().min(1).max(4000),
      evidence: z.array(z.string().max(2000)).max(32).default([]),
      learnings: z.array(z.string().max(2000)).max(16).default([]),
    },
    async execute(args, context) {
      if (context.agent !== 'graph-explorer' && context.agent !== 'graph-multimodal') {
        return rejected('WRONG_ROLE', 'only graph-explorer or graph-multimodal may call this tool');
      }
      const located = runFor(context);
      if (located.error) return located.error;
      try {
        const candidate = structuredClone(located.state);
        const previous = candidate.artifacts.findings;
        const version = previous ? previous.version + 1 : 1;
        publishArtifact(candidate, 'findings', {
          kind: 'findings', nodeId: located.binding.nodeId ?? 'free', version,
          basedOn: [], payload: cleanJson({ summary: args.summary, evidence: args.evidence ?? [], learnings: args.learnings ?? [] }),
          status: 'valid', createdAt: NOW(),
        });
        // Bounded multi-version retention: parallel explorers each register a
        // version; the latest slot stays authoritative for existing consumers
        // while recent history survives for aggregation and inspection.
        const log = candidate.findingsLog ??= [];
        log.push({ version, nodeId: located.binding.nodeId ?? 'free', summary: args.summary, evidence: (args.evidence ?? []).slice(0, 8), learnings: args.learnings ?? [] });
        if (log.length > 8) log.splice(0, log.length - 8);
        assertSettlementCapacity(candidate);
        await store.saveRun(candidate);
        Object.assign(located.state, candidate);
        return reply({ ok: true, artifact: `findings@${version}` });
      } catch (error) {
        return rejected('PAYLOAD_INVALID', error.message);
      }
    },
  });

  const graph_inspect = tool({
    description: 'Inspect the current graph run: node states, attempts, blockers, artifact versions and validity, plus a Mermaid diagram. Read-only.',
    args: {},
    async execute(_args, context) {
      if (!context.agent?.startsWith('graph-')) return rejected('NOT_GRAPH_AGENT', 'graph inspection is reserved for graph agents');
      const binding = bindings.get(context.sessionID);
      // Read-only and binding-free by design: managed children without their
      // own binding (rejected dispatch, finished work, terminated run) still
      // see the run that owns their parent chain.
      const runId = binding?.runId ?? (dispatches ? dispatches.runForSession(context.sessionID) : null);
      if (!runId) return rejected('NOT_GRAPH_SESSION', 'this session is not part of a graph run');
      const state = store.getRun(runId) ?? (store.loadRun ? await store.loadRun(runId) : null);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      const report = runner.inspect(state);
      // Honest deliverable progress: bash-created artifacts (venv binaries,
      // symlinks, generated checkpoints) never enter the edit/write ledger
      // or the filesTouched claim, so the runner's ledger-only numbers can
      // under-report real progress. A read-only existence check keeps the
      // denominator truthful; the runner itself stays a pure state machine
      // (this mirrors nodeProgress's coverage derivation on purpose).
      for (const node of report.nodes) {
        const spec = state.nodes[node.id]?.spec;
        const declared = Array.isArray(spec?.deliverables) ? spec.deliverables : null;
        if (node.deliverables === undefined || !declared?.length) continue;
        let covered;
        if (node.state === 'SUCCEEDED') {
          const claimed = state.artifacts[`change:${node.id}`]?.payload?.filesTouched;
          covered = new Set(Array.isArray(claimed) ? claimed : []);
        } else {
          covered = new Set(state.sideEffects.filter((effect) => effect.nodeId === node.id && (effect.tool === 'edit' || effect.tool === 'write') && !isUncertainEffect(effect)).map((effect) => effect.target));
        }
        const stillPending = declared.filter((file) => !covered.has(file) && !existsSync(join(worktree, file)));
        node.deliverables = { total: declared.length, done: declared.length - stillPending.length, pending: stillPending.slice(0, 8) };
      }
      return reply({ ...report, ...(dispatches ? { dispatches: dispatches.inspect(state.runId) } : {}) });
    },
  });

  const graph_run_new = tool({
    description: 'Orchestrator starts a fresh gated run in this session after the previous run reached a terminal state (SUCCEEDED/FAILED/ABORTED). Write journal insights for the finished run first; the new run starts empty.',
    args: {},
    async execute(_args, context) {
      const wrong = requireRole(context, 'graph-orchestrator');
      if (wrong) return wrong;
      const binding = bindings.get(context.sessionID);
      if (!binding?.root) return rejected('NOT_GRAPH_SESSION', 'only the root orchestrator of this session may start a new run');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      if (state.status !== 'SUCCEEDED' && state.status !== 'FAILED' && state.status !== 'ABORTED') {
        return rejected('RUN_NOT_TERMINAL', `the current run is ${state.status}; finish, recover or decide it first`);
      }
      dispatches?.invalidate(state.runId);
      let runId = null;
      for (let counter = 2; counter <= 99; counter += 1) {
        const candidate = `${state.rootSessionId}:${counter}`;
        if (store.loadRun && await store.loadRun(candidate)) continue;
        runId = candidate;
        break;
      }
      if (!runId) return rejected('RUN_LIMIT', 'this session reached its successor-run limit');
      await store.createRun({ runId, rootSessionId: state.rootSessionId, now: NOW(), request: null, requestCaptureCompleted: true });
      state.successorRunId = runId;
      await store.saveRun(state);
      bindings.set(context.sessionID, { runId, agent: context.agent, nodeId: null, root: true });
      return reply({ ok: true, runId, previousRun: { runId: state.runId, status: state.status },
        next: 'dispatch read-only exploration/planning for the new goal; the finished run stays on disk for journal history' });
    },
  });

  const graph_run_resume = tool({
    description: 'Orchestrator resumes an interrupted execution after a restart or crash: classifies in-flight nodes, keeps their side-effect ledger, revalidates snapshots and unblocks dispatch. AWAITING_USER_DECISION remains paused and retains existing settlement ownership; use graph_run_decide after host lifetimes end.',
    args: {},
    async execute(_args, context) {
      const wrong = requireRole(context, 'graph-orchestrator');
      if (wrong) return wrong;
      const binding = bindings.get(context.sessionID);
      if (!binding?.root) return rejected('NOT_GRAPH_SESSION', 'only the orchestrator of this run may resume it');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      if (state.status === 'AWAITING_USER_DECISION') return rejected('AWAITING_DECISION', 'the run remains paused; existing children must settle before graph_run_decide');
      if (repairSettlementPending(state)) return rejected('REPAIR_SETTLEMENT_PENDING', 'revoked repair lifetimes and pending effects must settle before resume; inspect the outstanding dispatches');
      if (state.status !== 'SUCCEEDED' && state.status !== 'FAILED' && state.status !== 'ABORTED') dispatches?.invalidate(state.runId);
      const resume = runner.resumeRun(state, { now: NOW() });
      if (!resume.ok) return rejected(resume.code, resume.detail);
      // Auto-reconcile: recovery-required nodes return to PENDING with a
      // reconcile marker; their side-effect ledger travels with the dispatch.
      for (const nodeId of resume.report.recoveryRequired) runner.reconcileNode(state, nodeId, { now: NOW() });
      if (state.status === 'RUNNING') {
        const files = new Set();
        for (const artifact of Object.values(state.artifacts)) {
          for (const file of Object.keys(artifact.snapshot ?? {})) files.add(file);
        }
        if (files.size) {
          const current = await store.hashFiles([...files]);
          const revalidation = runner.revalidateArtifacts(state, { currentSnapshot: current, now: NOW() });
          resume.revalidation = revalidation;
        }
      }
      await store.saveRun(state);
      return reply({ ok: true, ...resume, next: 'continue the workflow: interrupted attempts were refunded at restart; prefer task_id continuation to pick the interrupted session back up (its context and side-effect ledger travel with it), otherwise re-dispatch — reconcile context is injected automatically; if the run is paused, report to the user and use graph_run_decide' });
    },
  });

  const graph_run_decide = tool({
    description: 'Root orchestrator delivers a user-confirmed decision with a required reason; native permission ask applies. abort irreversibly terminates the run, preserving evidence. reset archives it and opens a fresh gated successor. retry requires expectedPauseId from graph_inspect and allows at most ONE same-run verification retry, persisted across restart/replan: only nonbaseline UNVERIFIED or INSUFFICIENT_EVIDENCE/ARTIFACT_REQUIRED/INVALID_VERDICT rejection pauses, with normal attempts left, valid unchanged approval/dependencies and trustworthy equal filesystem snapshots. All host calls and pending effects must settle. Retry preserves original evidence, siblings, counters and rejection streak, clears the active pause, and requires a new ordinary verifier dispatch; it neither grants PASS nor proves an external service healthy. graph_run_resume remains crash recovery.',
    args: {
      action: z.enum(['reset', 'abort', 'retry']),
      reason: z.string().min(1).max(2000),
      expectedPauseId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-orchestrator');
      if (wrong) return wrong;
      if (!['reset', 'abort', 'retry'].includes(args.action) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000
        || args.action !== 'retry' && args.expectedPauseId !== undefined) return rejected('INVALID_DECISION', 'Use abort/reset with a user reason, or retry with a user reason and expectedPauseId');
      const binding = bindings.get(context.sessionID);
      if (!binding?.root) return rejected('NOT_GRAPH_SESSION', 'only the root orchestrator of this run may deliver a user decision');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      if (state.successorRunId) return rejected('RUN_SUPERSEDED', `this run was already reset; its successor ${state.successorRunId} owns the session now`);
      if (state.dispatchRecoveryIssues !== undefined && (!Array.isArray(state.dispatchRecoveryIssues) || state.dispatchRecoveryIssues.length !== 0)) {
        return rejected('DISPATCH_RECOVERY_UNRESOLVED', 'unrestorable outstanding lifetimes are preserved; no decision may assume they completed');
      }
      const running = Object.values(state.nodes).filter((node) => node.state === 'RUNNING');
      if (running.length) return rejected('RUN_BUSY', `nodes are still in flight: ${running.map((node) => node.spec.id).join(', ')}; wait for correlated terminal turn/task evidence (idle or metadata alone is not completion)`);
      const outstanding = dispatches ? dispatches.inspect(state.runId) : [];
      if (outstanding.length || state.dispatchReservations !== undefined && (!Array.isArray(state.dispatchReservations) || state.dispatchReservations.length !== 0)) return rejected('DISPATCH_PENDING', 'task dispatches are still registered for this run; wait for their sessions to finish first');

      if (args.action === 'retry') {
        if (context.sessionID !== state.rootSessionId || binding.agent !== context.agent) return rejected('NOT_GRAPH_SESSION', 'retry requires the owning root orchestrator');
        const observedSnapshot = await store.hashFiles(Object.keys(state.pendingDecision?.proof?.expectedSnapshot ?? {}));
        const checked = runner.prepareRetry(state, { ...args, observedSnapshot, now: NOW() });
        if (!checked.ok) return reply(checked);
        await store.saveRun(checked.candidate);
        Object.assign(state, checked.candidate);
        return reply({ ok: true, action: 'retry', runId: state.runId, status: state.status, nodeId: checked.nodeId,
          next: 'dispatch the original verifier using task_id or a fresh session; normal attempts and PASS evidence gates still apply' });
      }

      if (args.action === 'abort') {
        if (state.status === 'SUCCEEDED') return rejected('RUN_NOT_ABORTABLE', 'a succeeded run has nothing to abort');
        if (state.status === 'ABORTED') return rejected('RUN_NOT_ABORTABLE', 'this run is already aborted');
        dispatches?.invalidate(state.runId);
        runner.abortRun(state, { reason: args.reason, now: NOW() });
        await store.saveRun(state);
        return reply({ ok: true, action: 'abort', runId: state.runId, status: state.status,
          next: 'report the preserved evidence and the user reason back to the user; no further dispatch is possible' });
      }

      dispatches?.invalidate(state.runId);
      let runId = null;
      for (let counter = 2; counter <= 99; counter += 1) {
        const candidate = `${state.rootSessionId}:${counter}`;
        if (store.loadRun && await store.loadRun(candidate)) continue;
        runId = candidate;
        break;
      }
      if (!runId) return rejected('RUN_LIMIT', 'this session reached its successor-run limit');
      const created = await store.createRun({ runId, rootSessionId: state.rootSessionId, now: NOW(), request: null, requestCaptureCompleted: true });
      // Carry a bounded digest of the archived run into the successor so the
      // new explorer/planner start from its lessons (revalidation mandatory)
      // instead of re-deriving everything — and re-collecting the same
      // rejections — from zero.
      const priorReview = state.artifacts.review;
      const carriedFindings = priorReview && ['REVISE', 'FAIL'].includes(priorReview.payload?.verdict) && Array.isArray(priorReview.payload?.findings)
        ? priorReview.payload.findings.slice(0, 8).map((finding) => String(finding).slice(0, 500))
        : [];
      // Invariant: parallel explorers each append a findings version, so the
      // carry-over aggregates the most recent retained versions instead of
      // only the latest artifact — summaries join oldest→newest so the digest
      // reads chronologically, and the freshest learnings win the 8-item cap
      // (newest version first, mirroring learningsPrompt in enforcement.mjs).
      // Legacy runs without retained history fall back to the latest artifact.
      const recentFindings = Array.isArray(state.findingsLog) ? state.findingsLog.slice(-3) : [];
      const digest = recentFindings.length
        ? recentFindings.map((entry) => String(entry.summary ?? '').slice(0, 300)).join(' | ')
        : (typeof state.artifacts.findings?.payload?.summary === 'string'
          ? state.artifacts.findings.payload.summary.slice(0, 400) : null);
      const carriedLearnings = recentFindings.length
        ? recentFindings.slice().reverse()
          .flatMap((entry) => (Array.isArray(entry.learnings) ? entry.learnings : []))
          .slice(0, 8).map((item) => String(item).slice(0, 500))
        : (Array.isArray(state.artifacts.findings?.payload?.learnings)
          ? state.artifacts.findings.payload.learnings.slice(0, 8).map((item) => String(item).slice(0, 500))
          : []);
      created.carryOver = {
        predecessorRunId: state.runId,
        reason: args.reason.slice(0, 2000),
        at: NOW(),
        reviewFindings: carriedFindings,
        findingsDigest: digest,
        learnings: carriedLearnings,
      };
      await store.saveRun(created);
      runner.archiveForReset(state, { reason: args.reason, successorRunId: runId, now: NOW() });
      await store.saveRun(state);
      bindings.set(context.sessionID, { runId, agent: context.agent, nodeId: null, root: true });
      return reply({ ok: true, action: 'reset', runId,
        previousRun: { runId: state.runId, status: state.status, decision: state.decision },
        carryOver: { predecessorRunId: created.carryOver.predecessorRunId, reviewFindings: created.carryOver.reviewFindings.length, learnings: created.carryOver.learnings.length },
        next: 'dispatch read-only exploration/planning for the new goal; counters start fresh, gates re-apply and no side effects are replayed — the successor run carries a bounded digest of this run\'s findings and rejections' });
    },
  });

  const definitions = {
      graph_submit_plan, graph_submit_review, graph_submit_change, graph_submit_verification,
      graph_submit_findings, graph_inspect, graph_run_resume, graph_run_new, graph_run_decide,
  };
  // Paused submissions are validated with the same public schemas and semantic
  // checks, on an isolated state copy. Only bounded, non-gating closeout evidence
  // is persisted; the real node and its host lifetime are never completed here.
  async function settlePaused(name, definition, args, context, binding, state) {
    if (!dispatches.owns(binding, { settled: true }) || binding.settlementOnly || binding.agent !== context.agent) return rejected('NOT_DISPATCHED_NODE', 'closeout requires the exact owned attempt');
    let bounded;
    try { bounded = cleanJson(args, { maxBytes: 8192, maxValues: 1024, maxDepth: 16 }); }
    catch { return rejected('PAYLOAD_INVALID', 'closeout must be plain JSON within 8 KiB, 1024 values and depth 16'); }
    const parsed = z.object(definition.args).safeParse(bounded);
    if (!parsed.success) return rejected('PAYLOAD_INVALID', 'closeout must satisfy the submission schema and bounds');
    const payload = cleanJson(parsed.data);
    if (payload.nodeId !== undefined && payload.nodeId !== binding.nodeId) return rejected('NOT_DISPATCHED_NODE', 'closeout nodeId must match the owned dispatch');
    const previous = (state.closeouts ?? []).find((entry) => entry.dispatchId === binding.dispatchId && entry.tool === name);
    if (previous) return rejected('CLOSEOUT_ALREADY_RECORDED', 'this dispatch already recorded its closeout');
    if ((state.closeouts?.length ?? 0) >= 64) return rejected('CLOSEOUT_LIMIT', 'run closeout history reached its bounded limit');
    const copy = structuredClone(state);
    copy.status = 'RUNNING';
    if (binding.nodeId) copy.nodes[binding.nodeId].state = 'RUNNING';
    // Plan validation must not depend on siblings finishing their host lifetime.
    if (name === 'graph_submit_plan') {
      for (const node of Object.values(copy.nodes)) if (node.spec.id !== binding.nodeId && node.state === 'RUNNING') node.state = 'INCOMPLETE';
    }
    const validationStore = { getRun: () => copy, saveRun: async () => {}, hashFiles: (files) => store.hashFiles(files) };
    const validationBindings = new Map(bindings);
    validationBindings.set(context.sessionID, { ...binding, active: true });
    const validation = createSubmitTools({ store: validationStore, runner, bindings: validationBindings, worktree }).tools[name];
    const result = JSON.parse(await validation.execute(payload, context));
    if (!result.ok) return reply(result);
    const closeout = { nodeId: binding.nodeId, sessionId: binding.sessionId, dispatchId: binding.dispatchId,
      tool: name, payload, at: NOW() };
    // Publish only after a successful save; a failed save remains retryable and
    // cannot masquerade as a durable duplicate on the next submission.
    const saved = { ...state, closeouts: [...(state.closeouts ?? []), closeout] };
    try { assertSettlementCapacity(saved); }
    catch { return rejected('CLOSEOUT_LIMIT', 'closeout would consume reserved settlement persistence capacity'); }
    await store.saveRun(saved);
    state.closeouts = saved.closeouts;
    state.updatedAt = saved.updatedAt;
    return reply({ ok: true, effect: 'settlement', next: 'evidence preserved without graph approval; stop work and let the host session end' });
  }
  const tools = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, !dispatches ? definition : {
    ...definition,
    description: definition.description + (name.startsWith('graph_submit_') ? ' While paused, an owned attempt may submit one bounded closeout (8 KiB JSON) through this tool: effect="settlement" preserves evidence only, grants no approval, and does not end the host lifetime.' : ''),
    async execute(args, context) {
      await dispatches.ensureSession(context.sessionID);
      const binding = bindings.get(context.sessionID);
      return binding ? dispatches.exclusive(binding.runId, () => {
        const state = store.getRun(binding.runId);
        if (name.startsWith('graph_submit_') && state?.status === 'AWAITING_USER_DECISION') {
          return settlePaused(name, definition, args, context, binding, state);
        }
        return definition.execute(args, context);
      }) : definition.execute(args, context);
    },
  }]));
  return Object.freeze({ tools: Object.freeze(tools) });
}
