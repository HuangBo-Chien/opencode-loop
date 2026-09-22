import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_NAMES, parseOptions } from '../src/config.mjs';
import { registerAgents } from '../src/agents.mjs';
import plugin from '../src/index.mjs';

const mcp = { codegraph: { enabled: false } };
function configured(toolPermissions, servers = mcp) {
  const config = { mcp: servers };
  registerAgents(config, parseOptions({ toolPermissions }));
  return config;
}

// Model the host's last-matching-rule semantics, independently of the compiler.
function action(permission, tool) {
  let result;
  for (const [pattern, value] of Object.entries(permission)) {
    const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*')}$`, process.platform === 'win32' ? 'si' : 's');
    if (regex.test(tool)) result = value;
  }
  return result;
}

test('tool permissions default to empty, copied and deeply frozen', () => {
  assert.deepEqual(parseOptions().toolPermissions, { shared: {}, agents: {} });
  const input = { shared: { lsp: 'ask' }, agents: { 'graph-verifier': { lsp: 'deny' } } };
  const options = parseOptions({ toolPermissions: input });
  input.shared.lsp = 'allow';
  input.agents['graph-verifier'].lsp = 'allow';
  assert.equal(options.toolPermissions.shared.lsp, 'ask');
  assert.equal(options.toolPermissions.agents['graph-verifier'].lsp, 'deny');
  for (const object of [options.toolPermissions, options.toolPermissions.shared, options.toolPermissions.agents, options.toolPermissions.agents['graph-verifier']]) {
    assert.equal(Object.isFrozen(object), true);
  }
});

test('shared tools reach all seven roles without opening native or graph control tools', () => {
  const config = configured({ shared: { lsp: 'allow', codegraph_codegraph_explore: 'allow' } });
  for (const name of AGENT_NAMES) {
    const p = config.agent[name].permission;
    assert.equal(action(p, 'codegraph_codegraph_explore'), 'allow');
    assert.equal(action(p, 'lsp'), 'allow');
    assert.equal(action(p, 'memory_search_nodes'), 'deny');
    assert.equal(action(p, 'codegraph_delete'), 'deny');
    assert.equal(action(p, 'edit'), name === 'graph-implementer' ? 'ask' : 'deny');
    if (name === 'graph-multimodal') assert.equal(action(p, 'task'), 'deny');
    else if (name !== 'graph-orchestrator') assert.deepEqual(action(p, 'task'), { '*': 'deny', 'graph-multimodal': 'allow' });
    assert.equal(action(p, 'graph_submit_change'), name === 'graph-implementer' ? 'allow' : 'deny');
  }
});

test('role rules are appended even for duplicate keys, preserving last-match order', () => {
  const config = configured({
    shared: { 'codegraph_*': 'allow', codegraph_codegraph_explore: 'ask', lsp: 'ask' },
    agents: { 'graph-verifier': { 'codegraph_*': 'deny', codegraph_query: 'allow', lsp: 'deny' } },
  });
  const verifier = config.agent['graph-verifier'].permission;
  assert.equal(action(verifier, 'codegraph_codegraph_explore'), 'deny');
  assert.equal(action(verifier, 'codegraph_query'), 'allow');
  assert.equal(action(verifier, 'lsp'), 'deny');
  assert.equal(action(config.agent['graph-planner'].permission, 'codegraph_codegraph_explore'), 'ask');
  assert.equal(action(config.agent['graph-planner'].permission, 'codegraph_query'), 'allow');
});

test('role-specific permissions do not leak into siblings or native agents', () => {
  const config = { mcp, agent: { build: { permission: { '*': 'allow' } } }, permission: { bash: 'ask' } };
  registerAgents(config, parseOptions({ toolPermissions: { agents: { 'graph-planner': { 'codegraph_*': 'ask' } } } }));
  assert.equal(action(config.agent['graph-planner'].permission, 'codegraph_query'), 'ask');
  assert.equal(action(config.agent['graph-explorer'].permission, 'codegraph_query'), 'deny');
  assert.deepEqual(config.agent.build, { permission: { '*': 'allow' } });
  assert.deepEqual(config.permission, { bash: 'ask' });
});

test('invalid shapes and reserved rules reject even when disabled, without executing getters', () => {
  const invalid = [null, [], 'allow', { extra: {} }, { shared: null }, { agents: [] },
    { agents: { verifier: {} } }, { shared: { lsp: true } }, { shared: { lsp: { '*': 'allow' } } },
    ...['*', '*_query', 'codegraph*', 'codegraph_?query', 'codegraph_*_query', 'bash', 'edit', 'write', 'task', 'apply_patch', 'external_directory', 'graph_*', 'graph_submit_plan', '__proto__', 'constructor'].map(key => ({ shared: { [key]: 'allow' } })),
    { shared: { [Symbol('tool')]: 'allow' } },
  ];
  let called = false;
  const getter = Object.defineProperty({}, 'lsp', { enumerable: true, get() { called = true; return 'allow'; } });
  invalid.push({ shared: getter }, Object.defineProperty({}, 'shared', { get() { called = true; return {}; } }));
  for (const toolPermissions of invalid) assert.throws(() => parseOptions({ enabled: false, toolPermissions }), /toolPermissions/);
  assert.equal(called, false);
});

test('MCP namespace validation is atomic, uses host sanitization, and never needs a connection', () => {
  const config = { mcp, agent: { build: { prompt: 'native' } }, default_agent: 'build' };
  const before = structuredClone(config);
  assert.throws(() => registerAgents(config, parseOptions({ setDefaultAgent: true, toolPermissions: { shared: { missing_query: 'allow' } } })), /configured MCP/);
  assert.deepEqual(config, before);
  assert.equal(action(configured({ shared: { 'code_graph_*': 'ask' } }, { 'code.graph': { enabled: false } }).agent['graph-planner'].permission, 'code_graph_query'), 'ask');
  for (const servers of [{ 'code.graph': {}, code_graph: {} }, { code: {}, code_graph: {} }]) {
    assert.throws(() => configured({ shared: { 'code_graph_*': 'allow' } }, servers), /ambiguous|collision/);
  }
  assert.throws(() => configured({ shared: { 'code_*': 'allow' } }, { code: {}, code_graph: {} }), /ambiguous|collision/);
});

test('status reports compiled rules as configuration, not MCP health or secrets', async () => {
  const hooks = await plugin({}, { toolPermissions: { shared: { 'codegraph_*': 'ask' }, agents: { 'graph-verifier': { 'codegraph_*': 'deny' } } } });
  const before = JSON.parse(await hooks.tool.graph_status.execute({}));
  assert.equal(before.toolPermissions.validated, false);
  await hooks.config({ mcp: { codegraph: { enabled: false, environment: { SECRET: 'never-print-me' } } } });
  const output = await hooks.tool.graph_status.execute({});
  const status = JSON.parse(output).toolPermissions;
  assert.equal(status.validated, true);
  assert.equal(status.availabilityChecked, false);
  assert.equal(status.agents['graph-planner']['codegraph_*'], 'ask');
  assert.equal(status.agents['graph-verifier']['codegraph_*'], 'deny');
  assert.doesNotMatch(output, /never-print-me|SECRET/);
});

test('rule bounds, non-plain data, hidden properties and getter containers are rejected', () => {
  let called = false;
  const inputs = [
    { shared: new Date() },
    { shared: Object.create({ codegraph_query: 'allow' }) },
    { shared: Object.defineProperty({}, 'lsp', { value: 'allow' }) },
    { shared: { [`codegraph_${'x'.repeat(248)}`]: 'allow' } },
    { shared: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`codegraph_q${i}`, 'allow'])) },
    { shared: { 'external_*': 'allow' } },
    { agents: Object.defineProperty({}, 'graph-planner', { enumerable: true, get() { called = true; return {}; } }) },
  ];
  for (const toolPermissions of inputs) assert.throws(() => parseOptions({ toolPermissions }), /toolPermissions/);
  assert.equal(called, false);
  const limit = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`codegraph_q${i}`, 'ask']));
  assert.equal(Object.keys(parseOptions({ toolPermissions: { shared: limit } }).toolPermissions.shared).length, 128);
});

test('namespace collision and later role validation leave all host config untouched', () => {
  for (const toolPermissions of [
    { shared: { 'code_graph_*': 'allow' } },
    { shared: { lsp: 'allow' }, agents: { 'graph-verifier': { missing_query: 'allow' } } },
  ]) {
    const config = { mcp: { 'code.graph': {}, code_graph: {} }, agent: { build: { prompt: 'keep' } }, default_agent: 'build' };
    const before = structuredClone(config);
    assert.throws(() => registerAgents(config, parseOptions({ toolPermissions, setDefaultAgent: true })), /MCP/);
    assert.deepEqual(config, before);
  }
});

test('plugin config hook wires compiled policy into root MCP admission', async () => {
  const hooks = await plugin({}, { toolPermissions: { shared: { codegraph_query: 'ask' } } });
  await hooks.config({ mcp });
  await hooks['chat.message']({ sessionID: 'root', agent: 'graph-orchestrator' }, {});
  await hooks['tool.execute.before']({ sessionID: 'root', tool: 'codegraph_query', callID: 'before-abort' }, { args: {} });
  const result = JSON.parse(await hooks.tool.graph_run_decide.execute({ action: 'abort', reason: 'test fixture finished' }, { sessionID: 'root', agent: 'graph-orchestrator' }));
  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(hooks['tool.execute.before']({ sessionID: 'root', tool: 'codegraph_query', callID: 'after-abort' }, { args: {} }), /BINDING_UNAVAILABLE/);
  const permission = { status: 'ask' };
  await hooks['permission.ask']({ sessionID: 'root', type: 'codegraph_query' }, permission);
  assert.equal(permission.status, 'deny');
});

test('Windows matching cannot bypass MCP run fences through case-variant tool names', { skip: process.platform !== 'win32' }, async () => {
  const hooks = await plugin({}, { toolPermissions: { shared: { codegraph_query: 'allow' } } });
  await hooks.config({ mcp });
  await hooks['chat.message']({ sessionID: 'root', agent: 'graph-orchestrator' }, {});
  await hooks['tool.execute.before']({ sessionID: 'root', tool: 'CODEGRAPH_QUERY' }, { args: {} });
  const result = JSON.parse(await hooks.tool.graph_run_decide.execute({ action: 'abort', reason: 'case test' }, { sessionID: 'root', agent: 'graph-orchestrator' }));
  assert.equal(result.ok, true);
  await assert.rejects(hooks['tool.execute.before']({ sessionID: 'root', tool: 'CODEGRAPH_QUERY' }, { args: {} }), /BINDING_UNAVAILABLE/);
});

test('Windows reserved names, normalized namespaces and role rules use native case folding', { skip: process.platform !== 'win32' }, () => {
  for (const pattern of ['GRAPH_*', 'Graph_submit_plan', 'EXTERNAL_*', 'APPLY_PATCH']) {
    assert.throws(() => configured({ shared: { [pattern]: 'allow' } }, { GRAPH: {}, EXTERNAL: {}, APPLY: {} }), /reserved/);
  }
  assert.throws(() => configured({ shared: { 'CODEGRAPH_*': 'allow' } }, { codegraph: {}, CODEGRAPH: {} }), /ambiguous|collision/);
  assert.throws(() => configured({ shared: { 'CODE_*': 'allow' } }, { code: {}, Code_Graph: {} }), /ambiguous|collision/);
  const config = configured({ shared: { 'CODEGRAPH_*': 'allow' }, agents: { 'graph-verifier': { 'codegraph_*': 'deny', CodeGraph_Query: 'ask' } } });
  assert.equal(action(config.agent['graph-verifier'].permission, 'CODEGRAPH_QUERY'), 'ask');
  assert.equal(action(config.agent['graph-verifier'].permission, 'CODEGRAPH_OTHER'), 'deny');
});

test('native MCP resource helpers cannot masquerade as configured server tools', () => {
  for (const pattern of ['read_mcp_resource', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_*', 'list_mcp_*']) {
    assert.throws(() => configured({ shared: { [pattern]: 'ask' } }, { read: {}, list: {} }), /reserved/);
  }
});
