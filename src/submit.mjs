// Structured handoff tools. Each graph role must deliver its work through the
// matching graph_submit_* call; free-text task results alone never advance a
// run. Tools verify the caller's agent and session binding before touching
// run state, so a specialist cannot forge another role's submission.

import { tool } from '@opencode-ai/plugin/tool';
import { cleanJson } from './json-safe.mjs';
import { validateTaskGraph } from './task-spec.mjs';

const z = tool.schema;
const NOW = () => new Date().toISOString();

function reply(payload) {
  return JSON.stringify(payload);
}
function rejected(code, detail, hint = null) {
  return reply({ ok: false, code, detail, ...(hint ? { hint } : {}) });
}

export function createSubmitTools({ store, runner, bindings, worktree }) {
  function runFor(context) {
    const binding = bindings.get(context.sessionID);
    if (!binding) return { error: rejected('NOT_GRAPH_SESSION', 'this session is not part of a graph run; work is dispatched by graph-orchestrator through native task') };
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
    if (!node || node.sessionId !== context.sessionID) {
      return { error: rejected('NOT_DISPATCHED_NODE', 'no in-flight node is bound to this session; deliver work only for the task you received') };
    }
    return { node };
  }

  const graph_submit_plan = tool({
    description: 'Planner delivers the task graph: an intent (plan-only or change) plus an array of TaskSpec nodes. The runner validates ids, dependencies, cycles, write-scope disjointness and mandatory gates before accepting it.',
    args: {
      intent: z.enum(['plan-only', 'change']),
      specs: z.array(z.record(z.string(), z.unknown())).min(1).max(64),
      basedOn: z.array(z.string()).max(16).optional(),
      parallel: z.object({ suggested: z.number().int().min(1).max(4), reason: z.string().max(2000) }).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-planner');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const graph = validateTaskGraph(args.specs, { planOnly: args.intent === 'plan-only', maxAttemptsCeiling: 10 });
      if (!graph.ok) {
        return rejected('INVALID_GRAPH', graph.errors.join('; '), 'fix the listed TaskSpec problems and submit again');
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
        return reply({ ok: true, planVersion: result.version, mode: result.mode, order: graph.order, next: args.intent === 'plan-only' ? 'await plan critique; no implementation will be admitted' : 'await plan critique before implementation' });
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
      const result = runner.submitReview(located.state, { ...args, now: NOW() });
      if (!result.ok) return rejected(result.code, result.detail, result.code === 'STALE_PLAN_VERSION' ? 'the planner resubmitted; review the current plan version instead' : null);
      await store.saveRun(located.state);
      return reply({ ok: true, effect: result.effect, ...(result.detail ? { detail: result.detail } : {}) });
    },
  });

  const graph_submit_change = tool({
    description: 'Implementer reports a completed node. filesTouched is cross-checked against the runner side-effect ledger and the assigned writeScope; undisclosed or out-of-scope files fail the node.',
    args: {
      nodeId: z.string().min(1).max(128),
      filesTouched: z.array(z.string().min(1).max(512)).max(32),
      summary: z.string().min(1).max(2000),
      checksRun: z.array(z.string().max(2000)).max(16).default([]),
      unresolved: z.array(z.string().max(2000)).max(16).default([]),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-implementer');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const bound = boundNode(context, located);
      if (bound.error) return bound.error;
      const snapshot = await store.hashFiles(bound.node.spec.writeScope ?? []);
      const result = runner.submitChange(located.state, { ...args, snapshot, now: NOW() });
      if (!result.ok) return rejected(result.code, result.detail, result.code === 'LEDGER_MISMATCH' ? 'report every file you actually edited, exactly as recorded' : null);
      await store.saveRun(located.state);
      return reply({ ok: true, changeVersion: result.version, next: 'verification follows' });
    },
  });

  const graph_submit_verification = tool({
    description: 'Verifier submits evidence-bound verification. PASS requires at least one command with exitCode 0 and binds to the current change versions; FAIL returns work to the implementer (capped); UNVERIFIED blocks the run honestly.',
    args: {
      nodeId: z.string().min(1).max(128),
      verdict: z.enum(['PASS', 'FAIL', 'UNVERIFIED']),
      commands: z.array(z.object({ command: z.string().min(1).max(2000), exitCode: z.number().int() })).max(32).default([]),
      summary: z.string().max(2000).optional(),
    },
    async execute(args, context) {
      const wrong = requireRole(context, 'graph-verifier');
      if (wrong) return wrong;
      const located = runFor(context);
      if (located.error) return located.error;
      const bound = boundNode(context, located);
      if (bound.error) return bound.error;
      const files = (bound.node.spec.dependsOn ?? []).flatMap((dep) => located.state.artifacts[`change:${dep}`]?.payload?.filesTouched ?? []);
      const snapshot = await store.hashFiles(files);
      const result = runner.submitVerification(located.state, { ...args, snapshot, now: NOW() });
      if (!result.ok) return rejected(result.code, result.detail, result.code === 'INSUFFICIENT_EVIDENCE' ? 'cite the actual commands and their exit codes' : null);
      await store.saveRun(located.state);
      return reply({ ok: true, effect: result.effect, ...(result.detail ? { detail: result.detail } : {}) });
    },
  });

  const graph_submit_findings = tool({
    description: 'Explorer or multimodal analyst registers versioned findings the planner can reference as inputs (artifact name "findings").',
    args: {
      nodeId: z.string().min(1).max(128).optional(),
      summary: z.string().min(1).max(4000),
      evidence: z.array(z.string().max(2000)).max(32).default([]),
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
          basedOn: [], payload: cleanJson({ summary: args.summary, evidence: args.evidence }),
          status: 'valid', createdAt: NOW(),
        };
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
      if (!binding) return rejected('NOT_GRAPH_SESSION', 'this session is not part of a graph run');
      const state = store.getRun(binding.runId);
      if (!state) return rejected('RUN_GONE', 'the owning run no longer exists');
      return reply(runner.inspect(state));
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
      return reply({ ok: true, ...resume, next: 'continue the workflow; attempts and counters were preserved and reconcile context will be attached to affected dispatches' });
    },
  });

  return Object.freeze({
    tools: Object.freeze({
      graph_submit_plan, graph_submit_review, graph_submit_change, graph_submit_verification,
      graph_submit_findings, graph_inspect, graph_run_resume,
    }),
  });
}
