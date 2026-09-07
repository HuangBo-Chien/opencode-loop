import { readFileSync } from 'node:fs';
import { tool } from '@opencode-ai/plugin/tool';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function createStatusTool(options) {
  return tool({
    description: 'Report plugin capabilities and enforcement scope. Does not start, inspect, or mutate graph runs (use graph_inspect / graph_run_resume).',
    args: {},
    async execute() {
      return JSON.stringify({
        package: 'opencode-loop', version,
        workflowMode: 'gated',
        enforcement: 'tool-execute-hooks',
        enforcementScope: 'GRAPH_MANAGED_SESSIONS',
        enforcementDetail: 'Dispatch admission, write-scope confinement, bash deferral, attempt counters, verdict gates (PASS/REVISE/FAIL/BLOCKED) and version-bound evidence are enforced mechanically via tool.execute.before/after, permission.ask and session events. Reads remain unrestricted; a rejected task dispatch is rewritten into an explicit RUNNER_REJECTED child turn instead of aborting the tool call.',
        enforcementAttested: false,
        runtimeAvailable: true,
        managedRuntimeStatus: 'available',
        limitsEnforced: true,
        reason: 'Mechanical gates are active for graph-managed sessions and covered by unit and hook-simulation tests; real-model workflow acceptance on a locked host build is separate evidence.',
        limits: {
          maxAttempts: options.maxAttempts, maxParallel: options.maxParallel,
          maxImplementerParallel: options.maxImplementerParallel, maxPlanRevisions: options.maxPlanRevisions,
        },
        stateDirectory: options.stateDirectory,
      });
    },
  });
}
