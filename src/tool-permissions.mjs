// Configuration-time policy only: no MCP connection, discovery or side effects.
// Tool names follow OpenCode 1.18.25 mcp/catalog.ts (sanitize(server) + '_' + sanitize(tool)).
const EMPTY = Object.freeze({});
const ACTIONS = new Set(['allow', 'ask', 'deny']);
const RESERVED = new Set([
  'read', 'edit', 'write', 'apply_patch', 'glob', 'grep', 'list', 'bash', 'task',
  'external_directory', 'doom_loop', 'skill', 'question', 'todowrite', 'todoread',
  'webfetch', 'websearch', 'codesearch', 'batch', 'multiedit', 'plan_enter', 'plan_exit',
  'read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates',
  'lsp', '__proto__', 'constructor', 'prototype',
]);

// Match the pinned host's util/wildcard.ts: Windows permissions ignore case.
// Use the same comparison for runtime admission, reserved names and namespaces.
const comparisonName = value => process.platform === 'win32' ? value.toLowerCase() : value;

function entries(value, path, limit = 128) {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > limit) throw new TypeError(`${path} exceeds ${limit} entries`);
  return keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${path} must contain enumerable string keys and data values, not getters`);
    }
    return [key, descriptor.value];
  });
}

// Supported glob subset: exact name or one trailing '*'. Keeping the subset
// small makes namespace confinement and native last-match behavior unambiguous.
export function matchesTool(pattern, tool) {
  if (typeof tool !== 'string') return false;
  pattern = comparisonName(pattern);
  tool = comparisonName(tool);
  return pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern;
}

function rules(value, path) {
  return Object.freeze(Object.fromEntries(entries(value, path).map(([pattern, action]) => {
    if (pattern !== 'lsp' && (pattern.length > 256 || !/^[A-Za-z0-9_-]+_(?:[A-Za-z0-9_-]+\*?|\*)$/.test(pattern)
      || comparisonName(pattern).startsWith('graph_') || [...RESERVED].some(name => matchesTool(pattern, name)))) {
      throw new TypeError(`${path}: invalid or reserved tool pattern ${pattern}`);
    }
    if (!ACTIONS.has(action)) throw new TypeError(`${path}.${pattern} must be allow, ask or deny`);
    return [pattern, action];
  })));
}

export function parseToolPermissions(input, agentNames) {
  const fields = Object.fromEntries(entries(input, 'toolPermissions', 2));
  for (const key of Object.keys(fields)) {
    if (!['shared', 'agents'].includes(key)) throw new TypeError(`Unknown toolPermissions field: ${key}`);
  }
  const shared = rules(Object.hasOwn(fields, 'shared') ? fields.shared : {}, 'toolPermissions.shared');
  const agents = Object.fromEntries(entries(Object.hasOwn(fields, 'agents') ? fields.agents : {}, 'toolPermissions.agents', agentNames.length).map(([agent, value]) => {
    if (!agentNames.includes(agent)) throw new TypeError(`Unknown toolPermissions agent: ${agent}`);
    return [agent, rules(value, `toolPermissions.agents.${agent}`)];
  }));
  return Object.freeze({ shared, agents: Object.freeze(agents) });
}

export function resolveToolPermissions(options, agentNames) {
  return Object.freeze(Object.fromEntries(agentNames.map(name => {
    const rules = new Map(Object.entries(options?.shared ?? EMPTY));
    for (const [pattern, action] of Object.entries(options?.agents?.[name] ?? EMPTY)) {
      // Map.set/object spread alone retains the old position of duplicate keys.
      rules.delete(pattern);
      rules.set(pattern, action);
    }
    return [name, Object.freeze(Object.fromEntries(rules))];
  })));
}

export function validateMcpToolPermissions(agents, mcp = {}) {
  const prefixes = Object.keys(mcp).map(name => comparisonName(`${name.replace(/[^a-zA-Z0-9_-]/g, '_')}_`));
  const patterns = new Set(Object.values(agents).flatMap(rules => Object.keys(rules)));
  for (const pattern of patterns) {
    if (pattern === 'lsp') continue;
    const fixed = comparisonName(pattern.endsWith('*') ? pattern.slice(0, -1) : pattern);
    const owners = prefixes.filter(prefix => fixed.startsWith(prefix));
    if (owners.length === 0) throw new TypeError(`toolPermissions.${pattern} must name a configured MCP server namespace`);
    const overlaps = prefixes.filter(prefix => fixed.startsWith(prefix) || pattern.endsWith('*') && prefix.startsWith(fixed));
    if (overlaps.length !== 1) throw new TypeError(`toolPermissions.${pattern} has an ambiguous MCP namespace collision`);
  }
}

export function toolPermission(agents, agent, tool) {
  let action = 'deny';
  for (const [pattern, value] of Object.entries(agents?.[agent] ?? EMPTY)) {
    if (matchesTool(pattern, tool)) action = value;
  }
  return action;
}

export function isConfiguredMcpTool(agents, tool) {
  return tool !== 'lsp' && Object.values(agents ?? EMPTY).some(rules => Object.keys(rules).some(pattern => matchesTool(pattern, tool)));
}
