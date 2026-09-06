import { AGENT_NAMES } from './config.mjs';
import { createAgentPrompt } from './prompts.mjs';

function createPermission(name) {
  const permission = {
    '*': 'deny',
    read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' },
    glob: 'allow', grep: 'allow', list: 'allow', graph_status: 'allow',
    external_directory: 'ask', doom_loop: 'ask',
  };
  if (name === 'graph-orchestrator') {
    permission.question = 'allow';
    permission.todowrite = 'allow';
    permission.task = { '*': 'deny', ...Object.fromEntries(AGENT_NAMES.filter(agent => agent !== name).map(agent => [agent, 'allow'])) };
  } else {
    permission.task = 'deny';
  }
  if (name === 'graph-implementer') permission.edit = 'ask';
  if (['graph-implementer', 'graph-verifier'].includes(name)) permission.bash = 'ask';
  if (['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-multimodal'].includes(name)) {
    permission.webfetch = 'ask';
    permission.websearch = 'ask';
  }
  return permission;
}

export function registerAgents(config, options) {
  const existing = config.agent ?? {};
  for (const name of AGENT_NAMES) {
    if (name in existing) throw new Error(`Graph agent namespace collision: ${name}`);
  }
  const additions = Object.fromEntries(AGENT_NAMES.map(name => [name, {
    description: `${name.slice(6)} role for the advisory graph workflow`,
    mode: name === 'graph-orchestrator' ? 'primary' : 'subagent',
    prompt: createAgentPrompt(name, options),
    permission: createPermission(name),
    ...(options.models[name] ? { model: options.models[name] } : {}),
  }]));
  config.agent = { ...existing, ...additions };
  if (options.setDefaultAgent) config.default_agent = 'graph-orchestrator';
}
