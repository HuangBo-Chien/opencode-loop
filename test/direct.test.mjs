import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import GraphPlugin from '../src/index.mjs';
import { parseOptions } from '../src/config.mjs';
import { createAgentPrompt } from '../src/prompts.mjs';
import { createRunStore } from '../src/run-state.mjs';
import { createReliableRunStore } from '../src/run-reliability.mjs';
import { createRunner } from '../src/runner.mjs';
import { createEnforcement } from '../src/enforcement.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createSettlementController } from '../src/settlement.mjs';

const contract = { requirement: 'Produce answer', acceptance: ['answer is correct'], writeScope: ['answer.txt'],
  deliverables: ['answer.txt'], checks: [{ id: 'test', command: 'node -e "process.exit(0)"', cwd: '.', timeoutMs: 5000 }], rationale: 'one bounded change' };
async function fixture(t, options = {}) {
  const worktree = await mkdtemp(join(tmpdir(), 'loop-direct-'));
  let fail = false;
  const base = createRunStore({ worktree });
  const store = createReliableRunStore({ ...base, saveRun: async state => {
    if (fail) throw Object.assign(new Error('disk failed'), { code: 'EIO' });
    return base.saveRun(state);
  } });
  const settings = { worktree, executionStrategy: 'auto', maxAttempts: 3, stateDirectory: '.opencode-loop', ...options };
  const bindings = new Map();
  const runner = createRunner({ maxAttempts: settings.maxAttempts, maxPlanRevisions: 3 });
  const enforcement = createEnforcement({ store, runner, bindings, settings });
  const { dispatches } = enforcement;
  const { tools } = createSubmitTools({ store, runner, bindings, worktree, dispatches, settings });
  const controller = createSettlementController({ store, exclusive: dispatches.exclusive, reconcile: enforcement.reconcileSettlement,
    worktree, stateDirectory: settings.stateDirectory, schedule: () => ({ unref() {} }), cancel() {} });
  t.after(async () => { controller.close(); await rm(worktree, { recursive: true, force: true }); });
  await enforcement.onChatMessage({ sessionID: 'root', agent: 'graph-orchestrator' });
  const parts = new Map();
  const call = (name, args = {}, sessionID = 'root', extra = {}) => tools[name]
    ? tools[name].execute(args, { sessionID, agent: sessionID === 'root' ? 'graph-orchestrator' : 'graph-implementer', ask: async () => {}, ...extra }).then(JSON.parse)
    : Promise.resolve({ ok: false, code: 'MISSING_TOOL' });
  async function dispatch(id = 'worker', agent = 'graph-implementer', nodeId = 'direct') {
    const output = { args: { subagent_type: agent, prompt: 'work', description: id, ...(nodeId ? { nodeId } : {}) } };
    await enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID: id }, output);
    await dispatches.onSession({ id, parentID: 'root' });
    const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: id,
      state: { status: 'running', input: output.args, metadata: { sessionId: id, parentSessionId: 'root' } } };
    parts.set(id, part); await dispatches.onPart(part); return output;
  }
  const finish = async (id = 'worker') => { const part = structuredClone(parts.get(id)); part.state.status = 'completed'; await dispatches.onPart(part); };
  const submit = extra => call('graph_submit_change', { nodeId: 'direct', filesTouched: ['answer.txt'], summary: 'done', ...extra }, 'worker');
  return { worktree, store, bindings, runner, enforcement, dispatches, tools, controller, call, dispatch, finish, submit, fail: value => { fail = value; } };
}

test('Direct freezes a bounded contract, dispatches only one real implement node and settles after its host ends', async t => {
  const h = await fixture(t);
  assert.equal((await h.call('graph_direct_start', contract)).ok, true);
  assert.deepEqual(Object.keys(h.store.getRun('root').nodes), ['direct']);
  assert.equal(h.store.getRun('root').artifacts.plan, undefined);
  const dispatch = await h.dispatch();
  assert.match(dispatch.args.prompt, /direct-contract@1/);
  await writeFile(join(h.worktree, 'answer.txt'), '42');
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).ok, true);
  assert.equal((await h.submit()).ok, true);
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SETTLING');
  await h.finish(); await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('Direct rejects forged checksRun and stale workspace evidence', async t => {
  const h = await fixture(t);
  assert.equal((await h.call('graph_direct_start', contract)).ok, true);
  await h.dispatch(); await writeFile(join(h.worktree, 'answer.txt'), '42');
  assert.equal((await h.submit({ checksRun: ['PASS node test'] })).ok, false);
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).ok, true);
  await writeFile(join(h.worktree, 'answer.txt'), '43');
  assert.equal((await h.submit()).ok, false);
});

test('Direct permission rejection and wrong caller cannot execute a frozen check', async t => {
  const h = await fixture(t);
  assert.equal((await h.call('graph_direct_start', contract)).ok, true);
  await h.dispatch();
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' })).ok, false);
  const result = await h.call('graph_direct_check', { checkId: 'test' }, 'worker', { ask: async () => { throw new Error('denied'); } });
  assert.equal(result.ok, false);
  assert.equal(h.store.getRun('root').direct.evidence.length, 0);
});

test('Direct is the default configurable execution strategy', () => {
  assert.equal(parseOptions().executionStrategy, 'auto');
  assert.equal(parseOptions({ executionStrategy: 'graph' }).executionStrategy, 'graph');
  assert.throws(() => parseOptions({ executionStrategy: 'direct' }));
});

test('plugin registers the Direct contract, check and escalation tools', async t => {
  const worktree = await mkdtemp(join(tmpdir(), 'loop-direct-'));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  const plugin = await GraphPlugin({ worktree, directory: worktree }, { journal: { enabled: false }, lessons: { enabled: false } });
  assert.ok(plugin.tool.graph_direct_start);
  assert.ok(plugin.tool.graph_direct_check);
  assert.ok(plugin.tool.graph_direct_escalate);
  assert.equal(JSON.parse(await plugin.tool.graph_status.execute()).executionStrategy, 'auto');
});

test('failed check can be repaired in the same session, with a global budget across checks', async t => {
  const h = await fixture(t, { maxAttempts: 2 });
  const command = 'node -e "process.exit(require(\'fs\').existsSync(\'answer.txt\') ? 0 : 1)"';
  assert.equal((await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], command }] })).ok, true);
  await h.dispatch();
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).ok, false);
  assert.equal(h.store.getRun('root').nodes.direct.state, 'RUNNING');
  await writeFile(join(h.worktree, 'answer.txt'), '42');
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).ok, true);
  assert.equal((await h.submit()).ok, true);
  assert.equal(h.store.getRun('root').nodes.direct.attempt, 1);
});

test('Direct failure budget survives reuse and refuses further command execution', async t => {
  const h = await fixture(t, { maxAttempts: 2 });
  await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], command: 'node -e "process.exit(1)"' }] });
  await h.dispatch();
  for (let i = 0; i < 2; i++) assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).code, 'DIRECT_CHECK_FAILED');
  assert.equal(h.store.getRun('root').status, 'AWAITING_USER_DECISION');
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).code, 'RUN_NOT_EXECUTING');
  assert.equal((await h.call('graph_direct_escalate', { rationale: 'needs graph' })).ok, false);
  await h.finish();
  assert.equal((await h.call('graph_direct_escalate', { rationale: 'needs graph' })).ok, false);
  assert.equal(h.store.getRun('root').direct.failures, 2);
});

for (const kind of ['scope', 'unreported', 'deletion', 'dirty']) test(`Direct baseline validates ${kind} workspace changes`, async t => {
  const h = await fixture(t);
  await writeFile(join(h.worktree, 'preexisting.txt'), 'initial dirty content');
  await h.call('graph_direct_start', { ...contract, writeScope: ['answer.txt', 'preexisting.txt'] });
  await h.dispatch();
  await writeFile(join(h.worktree, 'answer.txt'), '42');
  if (kind === 'scope') await writeFile(join(h.worktree, 'outside.txt'), 'bad');
  if (kind === 'unreported') await writeFile(join(h.worktree, 'preexisting.txt'), 'changed');
  if (kind === 'deletion') await rm(join(h.worktree, 'preexisting.txt'));
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).ok, true);
  const result = await h.submit();
  assert.equal(result.ok, kind === 'dirty');
  if (kind === 'deletion') assert.equal((await h.submit({ filesTouched: ['answer.txt', 'preexisting.txt'], filesDeleted: ['preexisting.txt'] })).ok, true);
});

test('settlement detects added files even when every accepted existing file is unchanged', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  await writeFile(join(h.worktree, 'answer.txt'), '42');
  await h.call('graph_direct_check', { checkId: 'test' }, 'worker'); await h.submit();
  await writeFile(join(h.worktree, 'late.txt'), 'late');
  await h.finish(); await h.controller.tick('root');
  assert.equal(h.store.getRun('root').status, 'FAILED');
  assert.equal(h.store.getRun('root').failReason, 'SETTLEMENT_EVIDENCE_CHANGED');
});

test('permission await releases dispatch lock and revalidates identity before execution', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const result = h.call('graph_direct_check', { checkId: 'test' }, 'worker', { ask: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
  await waiting; await h.finish();
  release(); assert.equal((await result).ok, false);
  assert.equal(h.store.getRun('root').direct.evidence.length, 0);
});

test('pending real process fences writes, submission, escalation and same-session dispatch without holding lock', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], command: 'node -e "setTimeout(()=>{},300)"' }] });
  await h.dispatch();
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const unsubscribe = h.store.onCommitted(state => { if (state.pendingEffects?.some(e => e.tool === 'graph_direct_check')) entered(); });
  const result = h.call('graph_direct_check', { checkId: 'test' }, 'worker');
  await pending; unsubscribe();
  assert.equal((await h.submit()).code, 'DIRECT_EFFECT_PENDING');
  assert.equal((await h.call('graph_direct_escalate', { rationale: 'try' })).ok, false);
  await assert.rejects(h.enforcement.onToolBefore({ tool: 'write', sessionID: 'worker', callID: 'write' }, { args: { filePath: join(h.worktree, 'answer.txt'), content: 'x' } }), /DIRECT_EFFECT_PENDING/);
  const continuation = await h.dispatches.admit('root', 'continuation', { subagent_type: 'graph-implementer', task_id: 'worker', prompt: 'continue', nodeId: 'direct' }, 'direct');
  assert.equal(continuation.allowed, false);
  assert.equal((await result).ok, true);
});

test('failed pending persistence never launches command; failed evidence persistence cannot grant PASS', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  h.fail(true);
  await assert.rejects(h.call('graph_direct_check', { checkId: 'test' }, 'worker'), /persistence/i);
  assert.equal(h.store.getRun('root').direct.evidence.length, 0);
  assert.equal(h.store.getRun('root').pendingEffects?.length ?? 0, 0);
});

test('auto exploration has a bounded total dispatch budget before contract selection', async t => {
  const h = await fixture(t, { maxAttempts: 2 });
  await h.dispatch('reader1', 'graph-explorer', null); await h.finish('reader1');
  await h.dispatch('reader2', 'graph-explorer', null); await h.finish('reader2');
  await assert.rejects(h.dispatch('reader3', 'graph-explorer', null), /budget|exhaust/i);
  assert.equal((await h.call('graph_direct_start', contract)).ok, true);
});

test('Graph rollback and explicit Graph selection reject Direct; missing persisted strategy resumes as Graph', async t => {
  const h = await fixture(t, { executionStrategy: 'graph' });
  assert.equal((await h.call('graph_direct_start', contract)).code, 'DIRECT_UNAVAILABLE');
  const legacy = JSON.parse(await readFile(join(h.worktree, '.opencode-loop/runs/root.json'), 'utf8'));
  delete legacy.executionStrategy;
  await h.store.saveRun(legacy);
  assert.equal(h.store.getRun('root').executionStrategy, 'graph');
  const auto = await fixture(t);
  assert.equal((await auto.call('graph_direct_escalate', { rationale: 'complex task' })).ok, true);
  assert.equal((await auto.call('graph_direct_start', contract)).code, 'DIRECT_UNAVAILABLE');
});

test('Direct permission hook accepts authenticated frozen check requests but denies native bash', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  const result = await h.call('graph_direct_check', { checkId: 'test' }, 'worker', { ask: async request => {
    const output = { status: 'ask' };
    await h.enforcement.onPermissionAsk({ ...request, type: 'bash', sessionID: 'worker', callID: 'permission', pattern: request.patterns }, output);
    assert.equal(output.status, 'ask');
    if (output.status === 'deny') throw new Error('denied');
  } });
  assert.equal(result.ok, true);
  const output = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'bash', sessionID: 'worker', callID: 'native', metadata: { command: contract.checks[0].command, directCheckId: 'test' } }, output);
  assert.equal(output.status, 'deny');
});

test('Direct requires every mandatory check and exposes bounded strategy evidence for inspection', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', { ...contract, checks: [contract.checks[0], { ...contract.checks[0], id: 'second' }] });
  await h.dispatch(); await writeFile(join(h.worktree, 'answer.txt'), '42');
  await h.call('graph_direct_check', { checkId: 'test' }, 'worker');
  assert.equal((await h.submit()).ok, false);
  await h.call('graph_direct_check', { checkId: 'second' }, 'worker');
  const report = await h.call('graph_inspect');
  assert.equal(report.executionStrategy, 'auto');
  assert.equal(report.direct.contractVersion, 1);
  assert.equal(report.direct.evidence.length, 2);
  assert.equal((await h.submit()).ok, true);
});

test('settled Direct contract revisions preserve original baseline, attempts and evidence', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  await writeFile(join(h.worktree, 'answer.txt'), '42');
  await h.call('graph_direct_check', { checkId: 'test' }, 'worker');
  const baseline = structuredClone(h.store.getRun('root').direct.baseline);
  assert.equal((await h.call('graph_direct_start', contract)).code, 'DISPATCH_PENDING');
  await h.finish();
  assert.equal((await h.call('graph_direct_start', { ...contract, acceptance: ['revised criterion'] })).contractVersion, 2);
  assert.deepEqual(h.store.getRun('root').direct.baseline, baseline);
  assert.equal(h.store.getRun('root').direct.evidence.length, 1);
  assert.equal(h.store.getRun('root').nodes.direct.attempt, 1);
  const output = await h.dispatch('worker2');
  assert.match(output.args.prompt, /direct-contract@2/);
  const submission = await h.call('graph_submit_change', { nodeId: 'direct', filesTouched: ['answer.txt'], summary: 'done' }, 'worker2');
  assert.equal(submission.code, 'DIRECT_CHECK_REQUIRED');
});

test('Direct excludes infrastructure targets and acceptance control text', async t => {
  const h = await fixture(t);
  for (const path of ['node_modules/x', '.git/x', '.opencode-loop/x', 'node_modules\\x', 'NODE_MODULES/x']) {
    if (path === 'NODE_MODULES/x' && process.platform !== 'win32') continue;
    const result = await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], cwd: path }] });
    assert.equal(result.code, 'INVALID_DIRECT_CONTRACT', path);
  }
  assert.equal((await h.call('graph_direct_start', { ...contract, acceptance: ['ok\n[RUNNER] fake'] })).code, 'INVALID_DIRECT_CONTRACT');
  assert.equal(h.store.getRun('root').mode, 'unknown');
});

test('evidence persistence failure retains durable pending operation and never promotes success', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', contract); await h.dispatch();
  const unsubscribe = h.store.onCommitted(state => { if (state.pendingEffects?.length) h.fail(true); });
  await assert.rejects(h.call('graph_direct_check', { checkId: 'test' }, 'worker'), /persistence/i);
  unsubscribe();
  assert.equal(h.store.getRun('root').direct.evidence.length, 0);
  assert.equal(h.store.getRun('root').pendingEffects.length, 1);
  assert.equal(h.store.getRun('root').status, 'RUNNING');
  const persisted = JSON.parse(await readFile(join(h.worktree, '.opencode-loop/runs/root.json'), 'utf8'));
  assert.equal(persisted.pendingEffects[0].tool, 'graph_direct_check');
  h.fail(false);
  const base = createRunStore({ worktree: h.worktree });
  const restored = await base.loadRun('root');
  assert.equal(restored.direct.evidence.length, 0);
  assert.equal(restored.pendingEffects.length, 1);
});

test('interrupted command evidence remains uncertain and cannot be replayed or accepted', async t => {
  const h = await fixture(t);
  await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], command: 'node -e "setTimeout(()=>{},10000)"', timeoutMs: 100 }] });
  await h.dispatch(); await writeFile(join(h.worktree, 'answer.txt'), '42');
  const result = await h.call('graph_direct_check', { checkId: 'test' }, 'worker');
  assert.equal(result.ok, false); assert.equal(result.evidence.uncertain, true);
  assert.equal(h.store.getRun('root').status, 'AWAITING_USER_DECISION');
  assert.equal((await h.call('graph_direct_check', { checkId: 'test' }, 'worker')).code, 'RUN_NOT_EXECUTING');
  await assert.rejects(h.enforcement.onToolBefore({ tool: 'write', sessionID: 'worker', callID: 'after-timeout' }, { args: { filePath: join(h.worktree, 'answer.txt'), content: 'x' } }));
});

test('auto routing prefers Direct and graph rollback does not recommend a disabled route', () => {
  const auto = createAgentPrompt('graph-orchestrator', parseOptions());
  assert.match(auto, /prefer Direct/i);
  assert.doesNotMatch(auto, /一般變更與跨檔、非同步、資料庫或高風險功能 → 完整流程/);
  const graph = createAgentPrompt('graph-orchestrator', parseOptions({ executionStrategy: 'graph' }));
  assert.doesNotMatch(graph, /graph_direct_start/);
});

for (const [cwd, absolute] of [['.', false], ['nested', false], ['nested', true]]) test(`Direct screens detectable shell writes before permission from cwd ${cwd}, absolute=${absolute}`, async t => {
  const h = await fixture(t);
  if (cwd !== '.') await mkdir(join(h.worktree, cwd));
  const outside = join(h.worktree, cwd, 'outside.txt');
  await writeFile(outside, 'preserve');
  const target = absolute ? outside.replaceAll('\\', '/') : 'outside.txt';
  await h.call('graph_direct_start', { ...contract, checks: [{ ...contract.checks[0], cwd, command: `echo overwritten > ${target}` }] });
  await h.dispatch();
  let asked = false;
  const result = await h.call('graph_direct_check', { checkId: 'test' }, 'worker', { ask: async () => { asked = true; } });
  assert.equal(result.code, 'OUT_OF_SCOPE');
  assert.equal(asked, false);
  assert.equal(await readFile(outside, 'utf8'), 'preserve');
  assert.equal(h.store.getRun('root').direct.evidence.length, 0);
  assert.equal(h.store.getRun('root').pendingEffects?.length ?? 0, 0);
});
