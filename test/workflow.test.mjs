import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../src/index.mjs';

const JOURNAL_TOOL_NAMES = [
  'graph_journal_search',
  'graph_journal_read',
  'graph_journal_write_insight',
  'graph_journal_promote',
];

async function agents(options) {
  const config = {};
  await (await plugin({}, options)).config(config);
  return config.agent;
}

test('native permissions restrict writes, delegation and submit tools by role', async () => {
  const definitions = await agents();
  const journalReaders = new Set(['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic']);
  for (const [name, agent] of Object.entries(definitions)) {
    const p = agent.permission;
    assert.equal(p['*'], 'deny');
    assert.deepEqual(p.read, { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' });
    for (const tool of ['glob', 'grep', 'list', 'graph_status', 'graph_inspect']) assert.equal(p[tool], 'allow');
    assert.equal(p.external_directory, 'ask');
    assert.equal(p.doom_loop, 'ask');
    assert.equal(p.edit ?? p['*'], name === 'graph-implementer' ? 'ask' : 'deny');
    assert.equal(p.write ?? p['*'], name === 'graph-implementer' ? 'ask' : 'deny');
    assert.equal(p.bash ?? p['*'], ['graph-implementer', 'graph-verifier', 'graph-explorer'].includes(name) ? 'ask' : 'deny');
    if (name !== 'graph-orchestrator') assert.equal(p.task ?? p['*'], 'deny');
    assert.equal(p.graph_submit_plan ?? p['*'], name === 'graph-planner' ? 'allow' : 'deny');
    assert.equal(p.graph_submit_review ?? p['*'], name === 'graph-plan-critic' ? 'allow' : 'deny');
    assert.equal(p.graph_submit_change ?? p['*'], name === 'graph-implementer' ? 'allow' : 'deny');
    assert.equal(p.graph_submit_verification ?? p['*'], name === 'graph-verifier' ? 'allow' : 'deny');
    assert.equal(p.graph_run_resume ?? p['*'], name === 'graph-orchestrator' ? 'allow' : 'deny');
    assert.equal(p.graph_run_new ?? p['*'], name === 'graph-orchestrator' ? 'allow' : 'deny');
    assert.equal(p.graph_run_decide ?? p['*'], name === 'graph-orchestrator' ? 'ask' : 'deny');
    assert.equal(p.graph_journal_search ?? p['*'], journalReaders.has(name) ? 'allow' : 'deny');
    assert.equal(p.graph_journal_read ?? p['*'], journalReaders.has(name) ? 'allow' : 'deny');
    assert.equal(p.graph_journal_write_insight ?? p['*'], name === 'graph-orchestrator' ? 'allow' : 'deny');
    assert.equal(p.graph_journal_promote ?? p['*'], name === 'graph-orchestrator' ? 'ask' : 'deny');
    if (['graph-explorer', 'graph-multimodal'].includes(name)) assert.equal(p.graph_submit_findings, 'allow');
  }
  const coordinator = definitions['graph-orchestrator'].permission;
  assert.deepEqual(coordinator.task, { '*': 'deny', ...Object.fromEntries(Object.keys(definitions).filter(n => n !== 'graph-orchestrator').map(n => [n, 'allow'])) });
  assert.equal(coordinator.question, 'allow');
  assert.equal(coordinator.todowrite, 'allow');
});

test('orchestrator prompt states gated handoffs, runner rejections, recovery and bounded repair', async () => {
  const definitions = await agents({ maxAttempts: 2, maxParallel: 5, maxImplementerParallel: 3 });
  const p = definitions['graph-orchestrator'].prompt;
  for (const field of ['description', 'prompt', 'subagent_type', 'task_id']) assert.ok(p.includes(field), field);
  const chain = p.replace(/\([^)]*\)/g, '');
  assert.match(chain, /graph-explorer\s*→\s*graph-planner\s*→\s*graph-plan-critic\s*→\s*graph-implementer\s*→\s*graph-verifier/);
  assert.match(p, /RUNNER_REJECTED/);
  assert.match(p, /graph_run_resume/);
  assert.match(p, /DISPATCH_PENDING/);
  assert.match(p, /同一 RUNNING attempt/);
  assert.match(p, /graph_inspect/);
  assert.match(p, /maxAttempts=2/);
  assert.match(p, /maxPlanRevisions=2/);
  assert.match(p, /maxParallel=5/);
  assert.match(p, /READER_CAPACITY/);
  assert.match(p, /同一回合/);
  assert.match(p, /maxImplementerParallel=3/);
  assert.match(p, /寫入節點也可平行/);
  assert.match(p, /WRITER_CAPACITY/);
  assert.match(p, /plan-only/);
  assert.match(p, /不宣稱成功/);
});

test('roles provide distinct evidence contracts, submit duties and capability limits', async () => {
  const definitions = await agents();
  assert.equal(new Set(Object.values(definitions).map(a => a.prompt)).size, 7);
  for (const [name, { prompt }] of Object.entries(definitions)) {
    assert.ok(prompt.includes(name));
    assert.match(prompt, /runner-gated/);
    assert.match(prompt, /證據/);
    assert.match(prompt, /禁止捏造/);
  }
  assert.match(definitions['graph-planner'].prompt, /graph_submit_plan/);
  assert.match(definitions['graph-planner'].prompt, /writeScope/);
  assert.match(definitions['graph-planner'].prompt, /deliverables/);
  assert.match(definitions['graph-planner'].prompt, /\{\{run\}\}/);
  assert.match(definitions['graph-planner'].prompt, /嚴禁自創/);
  assert.match(definitions['graph-planner'].prompt, /暫存根/);
  assert.match(definitions['graph-planner'].prompt, /拆成多個小 implement 節點/);
  assert.match(definitions['graph-planner'].prompt, /maxImplementerParallel=2/);
  assert.match(definitions['graph-implementer'].prompt, /RUNNER_DENIED/);
  assert.match(definitions['graph-implementer'].prompt, /EXECUTED_DESPITE_DENY/);
  assert.match(definitions['graph-verifier'].prompt, /申報位置與用途/);
  assert.match(definitions['graph-plan-critic'].prompt, /graph_submit_review/);
  assert.match(definitions['graph-plan-critic'].prompt, /FAIL/);
  assert.match(definitions['graph-plan-critic'].prompt, /REVISE/);
  assert.match(definitions['graph-implementer'].prompt, /graph_submit_change/);
  for (const field of ['filesDeleted', 'INVALID_FILE_CLAIM', 'UV_CACHE_DIR', 'PIP_CACHE_DIR']) assert.ok(definitions['graph-implementer'].prompt.includes(field), field);
  assert.match(definitions['graph-implementer'].prompt, /writeScope/);
  assert.match(definitions['graph-verifier'].prompt, /graph_submit_verification/);
  assert.match(definitions['graph-verifier'].prompt, /exitCode/);
  assert.match(definitions['graph-verifier'].prompt, /UNVERIFIED/);
  assert.match(definitions['graph-explorer'].prompt, /graph_submit_findings/);
  assert.match(definitions['graph-multimodal'].prompt, /不支援/);
  for (const { prompt } of Object.values(definitions)) {
    assert.match(prompt, /journal.*非權威.*歷史/i);
    assert.match(prompt, /journal.*不能.*閘門/i);
  }
  const orchestrator = definitions['graph-orchestrator'].prompt;
  for (const name of JOURNAL_TOOL_NAMES) assert.match(orchestrator, new RegExp(name));
  assert.match(orchestrator, /終止|terminal/i);
  assert.match(orchestrator, /明確.*promot|explicit.*promot/i);
  assert.match(definitions['graph-explorer'].prompt, /journal.*目前.*原始碼|revalidate.*current source/i);
  for (const name of ['graph-planner', 'graph-plan-critic']) {
    assert.match(definitions[name].prompt, /journal ID/i);
    assert.match(definitions[name].prompt, /假設|assumption/i);
  }
  assert.match(definitions['graph-verifier'].prompt, /journal.*PASS/i);
  for (const name of ['graph-implementer', 'graph-multimodal']) assert.doesNotMatch(definitions[name].prompt, /graph_journal_/);
  const { createAgentPrompt } = await import('../src/prompts.mjs');
  assert.equal(createAgentPrompt('graph-orchestrator', { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 2, maxPlanRevisions: 3 }), definitions['graph-orchestrator'].prompt);
  assert.throws(() => createAgentPrompt('unknown', { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 2, maxPlanRevisions: 3 }), /unknown/i);
});
