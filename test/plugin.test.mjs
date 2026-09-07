import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const entry = new URL('../src/index.mjs', import.meta.url);
const names = ['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-implementer', 'graph-verifier', 'graph-multimodal'];
async function load() {
  assert.ok(existsSync(entry), 'standalone plugin entry must exist');
  return import(entry);
}

test('entry exports only the default plugin function', async () => {
  const module = await load();
  assert.deepEqual(Object.keys(module), ['default']);
  assert.equal(typeof module.default, 'function');
});

test('disabled plugin is inert and does not access host context', async () => {
  const { default: plugin } = await load();
  const context = new Proxy({}, { get() { throw new Error('unexpected host access'); } });
  assert.deepEqual(await plugin(context, { enabled: false }), {});
});

test('registers exactly seven runner-gated agents, preserving native definitions and default', async () => {
  const { default: plugin } = await load();
  const hooks = await plugin({});
  const native = Object.fromEntries(['build', 'plan', 'general', 'explore'].map(name => [name, { prompt: name, model: 'vendor/native' }]));
  const before = structuredClone(native);
  const config = { agent: native, default_agent: 'build', permission: { bash: 'ask' } };
  await hooks.config(config);
  assert.deepEqual(Object.keys(config.agent).filter(name => name.startsWith('graph-')), names);
  for (const name of Object.keys(before)) assert.deepEqual(config.agent[name], before[name]);
  assert.equal(config.default_agent, 'build');
  assert.deepEqual(config.permission, { bash: 'ask' });
  for (const name of names) {
    assert.equal(config.agent[name].permission['*'], 'deny');
    assert.equal(config.agent[name].permission.graph_status, 'allow');
    assert.match(config.agent[name].prompt, /runner-gated/);
    assert.equal(config.agent[name].mode, name === 'graph-orchestrator' ? 'primary' : 'subagent');
  }
  assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'config', 'event', 'permission.ask', 'tool', 'tool.execute.after', 'tool.execute.before']);
  assert.deepEqual(Object.keys(hooks.tool).sort(), ['graph_inspect', 'graph_run_resume', 'graph_status', 'graph_submit_change', 'graph_submit_findings', 'graph_submit_plan', 'graph_submit_review', 'graph_submit_verification']);
});

test('explicit settings select default and model without sharing caller-owned options', async () => {
  const { default: plugin } = await load();
  const options = { setDefaultAgent: true, models: { 'graph-planner': 'vendor/model' }, maxAttempts: 1, maxParallel: 16 };
  const hooks = await plugin({}, options);
  options.models['graph-planner'] = 'mutated/model';
  const config = {};
  await hooks.config(config);
  assert.equal(config.default_agent, 'graph-orchestrator');
  assert.equal(config.agent['graph-planner'].model, 'vendor/model');
  assert.equal(config.agent['graph-explorer'].model, undefined);
});

test('namespace collisions reject atomically without replacing existing definitions', async () => {
  const { default: plugin } = await load();
  for (const name of names) {
    const config = { agent: { build: { prompt: 'native' }, [name]: { prompt: 'owned elsewhere' } }, default_agent: 'build' };
    const before = structuredClone(config);
    await assert.rejects((await plugin({}, { setDefaultAgent: true })).config(config), /collision/i);
    assert.deepEqual(config, before);
  }
});

test('invalid options are rejected even when disabled', async () => {
  const { default: plugin } = await load();
  const invalid = [null, [], 'enabled', { extra: true }, { enabled: 'false' }, { setDefaultAgent: 1 }, { maxAttempts: 0 }, { maxAttempts: 11 }, { maxAttempts: 1.2 }, { maxParallel: 0 }, { maxParallel: 17 }, { maxParallel: Infinity }, { maxImplementerParallel: 0 }, { maxImplementerParallel: 5 }, { maxImplementerParallel: 1.5 }, { maxPlanRevisions: 0 }, { maxPlanRevisions: 11 }, { maxPlanRevisions: 2.5 }, { stateDirectory: '../escape' }, { stateDirectory: 'a/b/c/d/e' }, { stateDirectory: '' }, { stateDirectory: 'dir\\win' }, { enforcement: 'strict' }, { enforcement: null }, { models: null }, { models: [] }, { models: { build: 'v/m' } }, { models: { 'graph-planner': '' } }, { models: { 'graph-planner': ' model ' } }, { models: { 'graph-planner': () => {} } }, { enabled: false, injectAuthority() {} }];
  for (const options of invalid) await assert.rejects(plugin({}, options), /option|model|maxAttempts|maxParallel|maxImplementerParallel|maxPlanRevisions|stateDirectory|enforcement|enabled|setDefaultAgent/i);
  const { default: plugin2 } = await load();
  const hooks = await plugin2({}, { maxPlanRevisions: 5 });
  const status = JSON.parse(await hooks.tool.graph_status.execute({}));
  assert.equal(status.limits.maxPlanRevisions, 5);
});

test('status is read-only, truthful, stable and does not expose host secrets or developer paths', async () => {
  const { default: plugin } = await load();
  const hooks = await plugin({ directory: 'C:/private/project', secret: 'host-secret' });
  const output = await hooks.tool.graph_status.execute({}, new Proxy({}, { get() { throw new Error('host effects forbidden'); } }));
  const status = JSON.parse(output);
  assert.equal(status.version, '0.2.0-alpha.1');
  assert.equal(status.enforcementScope, 'GRAPH_MANAGED_SESSIONS');
  assert.equal(status.enforcementAttested, false);
  assert.equal(status.runtimeAvailable, true);
  assert.equal(status.workflowMode, 'gated');
  assert.equal(status.limitsEnforced, true);
  assert.equal(status.managedRuntimeStatus, 'available');
  assert.deepEqual(status.limits, { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 1, maxPlanRevisions: 3 });
  assert.equal(status.stateDirectory, '.opencode-loop');
  assert.match(status.reason, /real-model/i);
  assert.match(status.enforcementDetail, /tool\.execute/i);
  assert.doesNotMatch(output, /private|host-secret|b0420/);
  assert.deepEqual(hooks.tool.graph_status.args, {});
});
