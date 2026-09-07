import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../src/index.mjs';

async function agents(options) {
  const config = {};
  await (await plugin({}, options)).config(config);
  return config.agent;
}

test('native permissions restrict writes and delegation by role', async () => {
  const definitions = await agents();
  for (const [name, agent] of Object.entries(definitions)) {
    const p = agent.permission;
    assert.equal(p['*'], 'deny');
    assert.deepEqual(p.read, { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' });
    for (const tool of ['glob', 'grep', 'list', 'graph_status']) assert.equal(p[tool], 'allow');
    assert.equal(p.external_directory, 'ask');
    assert.equal(p.doom_loop, 'ask');
    assert.equal(p.edit ?? p['*'], name === 'graph-implementer' ? 'ask' : 'deny');
    assert.equal(p.bash ?? p['*'], ['graph-implementer', 'graph-verifier'].includes(name) ? 'ask' : 'deny');
    if (name !== 'graph-orchestrator') assert.equal(p.task ?? p['*'], 'deny');
  }
  const coordinator = definitions['graph-orchestrator'].permission;
  assert.deepEqual(coordinator.task, { '*': 'deny', ...Object.fromEntries(Object.keys(definitions).filter(n => n !== 'graph-orchestrator').map(n => [n, 'allow'])) });
  assert.equal(coordinator.question, 'allow');
  assert.equal(coordinator.todowrite, 'allow');
});

test('orchestrator specifies native handoffs, workflow paths and bounded repair', async () => {
  const definitions = await agents({ maxAttempts: 2, maxParallel: 5, maxImplementerParallel: 3 });
  const p = definitions['graph-orchestrator'].prompt;
  for (const field of ['description', 'prompt', 'subagent_type', 'task_id']) assert.ok(p.includes(field), field);
  assert.match(p, /graph-explorer → graph-planner → graph-plan-critic → graph-implementer → graph-verifier/);
  assert.match(p, /graph-plan-critic → graph-planner/);
  assert.match(p, /graph-verifier → graph-implementer/);
  assert.match(p, /maxAttempts=2/);
  assert.match(p, /maxParallel=5/);
  assert.match(p, /maxImplementerParallel=3/);
  assert.match(p, /work package/);
  assert.match(p, /唯讀/);
  assert.match(p, /單一寫入者/);
  assert.match(p, /plan-only/);
  assert.match(p, /不重複要求確認/);
  assert.doesNotMatch(p, /workflow execution is blocked/);
});

test('roles provide distinct evidence contracts and capability limits', async () => {
  const definitions = await agents();
  assert.equal(new Set(Object.values(definitions).map(a => a.prompt)).size, 7);
  for (const [name, { prompt }] of Object.entries(definitions)) {
    assert.ok(prompt.includes(name));
    assert.match(prompt, /advisory/);
    assert.match(prompt, /證據/);
    assert.match(prompt, /禁止捏造/);
  }
  assert.match(definitions['graph-verifier'].prompt, /shell.*寫入/);
  assert.match(definitions['graph-verifier'].prompt, /重疊/);
  assert.match(definitions['graph-multimodal'].prompt, /不支援/);
  assert.match(definitions['graph-planner'].prompt, /並行建議/);
  assert.match(definitions['graph-planner'].prompt, /maxImplementerParallel=1/);
  assert.match(definitions['graph-plan-critic'].prompt, /分區/);
  assert.match(definitions['graph-plan-critic'].prompt, /循序/);
  assert.match(definitions['graph-implementer'].prompt, /專屬檔案清單/);
  const { createAgentPrompt } = await import('../src/prompts.mjs');
  assert.equal(createAgentPrompt('graph-orchestrator', { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 1 }), definitions['graph-orchestrator'].prompt);
  assert.throws(() => createAgentPrompt('unknown', { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 1 }), /unknown/i);
});
