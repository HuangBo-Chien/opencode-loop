import { parseOptions } from './config.mjs';
import { registerAgents } from './agents.mjs';
import { createStatusTool } from './status.mjs';
import { createRunStore } from './run-state.mjs';
import { createRunner } from './runner.mjs';
import { createSubmitTools } from './submit.mjs';
import { createEnforcement } from './enforcement.mjs';

export default async function GraphPlugin(context, options = {}) {
  const settings = parseOptions(options);
  if (!settings.enabled) return {};
  const worktree = typeof context?.worktree === 'string' && context.worktree
    ? context.worktree
    : (typeof context?.directory === 'string' && context.directory ? context.directory : null);

  const store = createRunStore({ worktree, stateDirectory: settings.stateDirectory });
  const runner = createRunner({ maxAttempts: settings.maxAttempts, maxPlanRevisions: settings.maxPlanRevisions });
  const bindings = new Map();
  const enforcement = createEnforcement({ settings: { worktree }, store, runner, bindings });
  const { tools } = createSubmitTools({ store, runner, bindings, worktree });

  return {
    async config(config) { registerAgents(config, settings); },
    tool: { graph_status: createStatusTool(settings), ...tools },
    'chat.message': enforcement.onChatMessage,
    'tool.execute.before': enforcement.onToolBefore,
    'tool.execute.after': enforcement.onToolAfter,
    'permission.ask': enforcement.onPermissionAsk,
    event: enforcement.onEvent,
  };
}
