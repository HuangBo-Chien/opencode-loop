import { AGENT_NAMES } from './config.mjs';
import { createAgentPrompt } from './prompts.mjs';
import { resolveToolPermissions, validateMcpToolPermissions } from './tool-permissions.mjs';

const SUBMIT_TOOL_BY_AGENT = Object.freeze({
  'graph-orchestrator': ['graph_run_resume', 'graph_run_new', 'graph_run_decide'],
  'graph-explorer': ['graph_submit_findings'],
  'graph-planner': ['graph_submit_plan'],
  'graph-plan-critic': ['graph_submit_review'],
  'graph-implementer': ['graph_submit_change'],
  'graph-verifier': ['graph_submit_verification'],
  'graph-multimodal': ['graph_submit_findings'],
});
const JOURNAL_READ_AGENTS = new Set(['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic']);

function createPermission(name) {
  const permission = {
    '*': 'deny',
    read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' },
    glob: 'allow', grep: 'allow', list: 'allow', graph_status: 'allow', graph_inspect: 'allow', graph_artifact_read: 'allow', skill: 'allow',
    external_directory: 'ask', doom_loop: 'ask',
  };
  if (name === 'graph-orchestrator') {
    permission.question = 'allow';
    permission.todowrite = 'allow';
    permission.task = { '*': 'deny', ...Object.fromEntries(AGENT_NAMES.filter(agent => agent !== name).map(agent => [agent, 'allow'])) };
  } else {
    permission.task = name === 'graph-multimodal' ? 'deny' : { '*': 'deny', 'graph-multimodal': 'allow' };
  }
  for (const tool of SUBMIT_TOOL_BY_AGENT[name] ?? []) permission[tool] = 'allow';
  if (JOURNAL_READ_AGENTS.has(name)) {
    permission.graph_journal_search = 'allow';
    permission.graph_journal_read = 'allow';
    permission.graph_lesson_search = 'allow';
    permission.graph_lesson_read = 'allow';
  }
  if (name === 'graph-orchestrator') {
    permission.graph_journal_write_insight = 'allow';
    permission.graph_journal_promote = 'ask';
    permission.graph_lesson_record = 'allow';
    permission.graph_lesson_promote = 'ask';
    permission.graph_run_decide = 'ask';
  }
  if (name === 'graph-implementer') {
    permission.edit = 'ask';
    permission.write = 'ask';
  }
  if (['graph-implementer', 'graph-verifier', 'graph-explorer'].includes(name)) permission.bash = 'ask';
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
  const toolPermissions = resolveToolPermissions(options.toolPermissions, AGENT_NAMES);
  validateMcpToolPermissions(toolPermissions, config.mcp);
  const additions = Object.fromEntries(AGENT_NAMES.map(name => [name, {
    description: `${name.slice(6)} role for the runner-gated graph workflow`,
    mode: name === 'graph-orchestrator' ? 'primary' : 'subagent',
    prompt: createAgentPrompt(name, options),
    permission: { ...createPermission(name), ...toolPermissions[name] },
    ...(options.models[name] ? { model: options.models[name] } : {}),
  }]));
  config.agent = { ...existing, ...additions };
  if (options.setDefaultAgent) config.default_agent = 'graph-orchestrator';
  return toolPermissions;
}
