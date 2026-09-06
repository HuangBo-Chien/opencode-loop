import { parseOptions } from './config.mjs';
import { registerAgents } from './agents.mjs';
import { createStatusTool } from './status.mjs';

export default async function GraphPlugin(context, options = {}) {
  const settings = parseOptions(options);
  if (!settings.enabled) return {};
  return {
    async config(config) { registerAgents(config, settings); },
    tool: { graph_status: createStatusTool(settings) },
  };
}
