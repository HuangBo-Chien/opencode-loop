import { readFileSync } from 'node:fs';
import { tool } from '@opencode-ai/plugin/tool';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function createStatusTool(options) {
  return tool({
    description: 'Report plugin alpha availability. Does not start, inspect, or mutate graph runs.',
    args: {},
    async execute() {
      return JSON.stringify({
        package: 'opencode-loop', version,
        enforcementScope: 'GRAPH_MANAGED_SESSIONS',
        enforcementAttested: false,
        workflowMode: 'advisory',
        runtimeAvailable: true,
        managedRuntimeStatus: 'unavailable',
        reason: 'Native task advisory workflow is available. The strict production run adapter is unavailable; workflow order and limits are prompt-guided, not mechanically enforced. Scope is a design target, not an attested enforcement guarantee.',
        limitsEnforced: false,
        limits: { maxAttempts: options.maxAttempts, maxParallel: options.maxParallel, maxImplementerParallel: options.maxImplementerParallel },
      });
    },
  });
}
