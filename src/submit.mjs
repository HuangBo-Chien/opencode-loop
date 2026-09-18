// Structured handoff tools. Each graph role must deliver its work through the
// matching graph_submit_* call; free-text task results alone never advance a
// run. Tools verify the caller's agent and session binding before touching
// run state, so a specialist cannot forge another role's submission.

import { tool } from '@opencode-ai/plugin/tool';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanJson } from './json-safe.mjs';
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
    if (binding.agent !== context.agent || binding.active === false) return { error: rejected('NOT_DISPATCHED_NODE', 'caller must match an active dispatch binding') };
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
        const result = runner.submitPlan(located.state, {
          intent: args.intent,
          nodes: graph.nodes,
          basedOn: cleanJson(args.basedOn ?? []),
          parallel: args.parallel ? cleanJson(args.parallel) : null,
          now: NOW(),
        });
        if (!result.ok) return rejected(result.code, result.detail);
        await store.saveRun(located.state);
        dispatches?.invalidate(located.state.runId);
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
    description: 'Plan critic submits its verdict bound to a plan version. PASS advances to implementation, REVISE returns to the planner (capped), FAIL terminates the run.',
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
    description: 'Verifier submits evidence-bound verification. PASS requires at least one command with exitCode 0 (nonzero commands are tolerated only when they match a declared baseline entry — same command and exit code) and binds to the current change versions; BASELINE records pre-change suite evidence on baseline verify nodes; FAIL returns work to the implementer (capped); UNVERIFIED blocks the run honestly. artifacts are existing evidence file paths (logs, output files, screenshots); probed records adversarial scenarios exercised with their observed results; skipped records scenarios ruled out with a one-line reason. When the verified implement nodes declared deliverables, PASS additionally requires at least one artifact.',
    args: {
      nodeId: z.string().min(1).max(128),
      verdict: z.enum(['PASS', 'FAIL', 'UNVERIFIED', 'BASELINE']),
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
      for (const artifact of args.artifacts ?? []) {
        const problem = artifact.startsWith('/tmp/') ? null : artifactPathProblem(artifact);
        if (problem) return rejected('INVALID_FILE_CLAIM', problem, 'artifacts are literal workspace-relative file paths (a /tmp/-prefixed absolute path is also accepted), never directories or globs');
        const resolved = artifact.startsWith('/tmp/') ? artifact : join(worktree, artifact);
        if (!existsSync(resolved)) return rejected('ARTIFACT_MISSING', `${artifact}: cited evidence artifact does not exist at submission time`, 'ARTIFACT_MISSING is correctable within this attempt; check the path and resubmit without redoing verified work');
      }
      const files = (bound.node.spec.dependsOn ?? []).flatMap((dep) => located.state.artifacts[`change:${dep}`]?.payload?.filesTouched ?? []);
      const snapshot = await store.hashFiles(files);
      const result = runner.submitVerification(located.state, { ...args, snapshot, now: NOW() });
      if (!result.ok) {
        const hints = {
          INSUFFICIENT_EVIDENCE: 'cite the actual commands and their exit codes; nonzero commands are only tolerated on PASS when they match a declared baseline entry (same command and exit code)',
          ARTIFACT_REQUIRED: 'cite at least one existing artifact path (log, output file, screenshot) produced by the verified work',
        };
        return rejected(result.code, result.detail, hints[result.code] ?? null);
      }
      await store.saveRun(located.state);
      return reply({ ok: true, effect: result.effect, ...(result.detail ? { detail: result.detail } : {}) });
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
        const previous = located.state.artifacts.findings;
        const version = previous ? previous.version + 1 : 1;
        if (previous && previous.status === 'valid') previous.status = 'superseded';
        located.state.artifacts.findings = {
          kind: 'findings', nodeId: located.binding.nodeId ?? 'free', version,
          basedOn: [], payload: cleanJson({ summary: args.summary, evidence: args.evidence ?? [], learnings: args.learnings ?? [] }),
          status: 'valid', createdAt: NOW(),
        };
        // Bounded multi-version retention: parallel explorers each register a
        // version; the latest slot stays authoritative for existing consumers
        // while recent history survives for aggregation and inspection.
        const log = located.state.findingsLog ??= [];
        log.push({ version, nodeId: located.binding.nodeId ?? 'free', summary: args.summary, evidence: (args.evidence ?? []).slice(0, 8), learnings: args.learnings ?? [] });
        if (log.length > 8) log.splice(0, log.length - 8);
        await store.saveRun(located.state);
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
          covered = new Set(state.sideEffects.filter((effect) => effect.nodeId === node.id && (effect.tool === 'edit' || effect.tool === 'write')).map((effect) => effect.target));
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
    description: 'Orchestrator resumes a run after a restart or crash: classifies in-flight nodes (recovery-required nodes keep their side-effect ledger), revalidates artifact snapshots against the workspace, and unblocks dispatch.',
    args: {},
    async execute(_args, context) {
      const wrong = requireRole(context, 'graph-orchestrator');
      if (wrong) return wrong;
      const binding = bindings.get(context.sessionID);
      if (!binding?.root) return rejected('NOT_GRAPH_SESSION', 'only the orchestrator of this run may resume it');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
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
    description: 'Orchestrator delivers the user\'s decision for a run paused by exhaustion (AWAITING_USER_DECISION) or deliberately rotates/terminates a run. action="abort" irreversibly marks the run ABORTED (all findings, plans, reviews, violations and dispatch history preserved; dispatch closed). action="reset" archives the run in place (decision + successorRunId, original status and evidence untouched) and starts a fresh successor run with reset counters that re-walks the explorer → planner → critic gates without replaying any implementer work or side effects. A user-provided reason is required; native permission ask enforces user confirmation.',
    args: {
      action: z.enum(['reset', 'abort']),
      reason: z.string().min(1).max(2000),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-orchestrator');
      if (wrong) return wrong;
      const binding = bindings.get(context.sessionID);
      if (!binding?.root) return rejected('NOT_GRAPH_SESSION', 'only the root orchestrator of this run may deliver a user decision');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      if (state.successorRunId) return rejected('RUN_SUPERSEDED', `this run was already reset; its successor ${state.successorRunId} owns the session now`);
      const running = Object.values(state.nodes).filter((node) => node.state === 'RUNNING');
      if (running.length) return rejected('RUN_BUSY', `nodes are still in flight: ${running.map((node) => node.spec.id).join(', ')}; let them finish or idle first`);
      const outstanding = dispatches ? dispatches.inspect(state.runId) : [];
      if (outstanding.length) return rejected('DISPATCH_PENDING', 'task dispatches are still registered for this run; wait for their sessions to finish first');

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
  const tools = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, !dispatches ? definition : {
    ...definition,
    async execute(args, context) {
      await dispatches.ensureSession(context.sessionID);
      const binding = bindings.get(context.sessionID);
      return binding ? dispatches.exclusive(binding.runId, () => definition.execute(args, context)) : definition.execute(args, context);
    },
  }]));
  return Object.freeze({ tools: Object.freeze(tools) });
}
