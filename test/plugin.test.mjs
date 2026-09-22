import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions } from '../src/config.mjs';
import { MODEL_DTYPE, MODEL_NAME, MODEL_REVISION } from '../src/embeddings.mjs';
import { createStatusTool } from '../src/status.mjs';

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

test('SDK-shaped chat hook uses output.message.agent when input.agent is omitted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-sdk-chat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { default: plugin } = await load();
  const hooks = await plugin({ worktree: dir });
  const sessionID = 'sdk-root';
  const messageID = 'message-1';

  await hooks['chat.message'](
    { sessionID, messageID },
    {
      message: {
        id: messageID,
        sessionID,
        role: 'user',
        time: { created: Date.now() },
        agent: 'graph-orchestrator',
        model: { providerID: 'fixture', modelID: 'fixture-model' },
      },
      parts: [{ id: 'part-1', sessionID, messageID, type: 'text', text: 'Capture from the SDK hook shape.' }],
    },
  );

  const run = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', `${sessionID}.json`), 'utf8'));
  assert.equal(run.request.text, 'Capture from the SDK hook shape.');
  assert.equal(run.requestCaptureCompleted, true);
  const inspected = JSON.parse(await hooks.tool.graph_inspect.execute({}, { sessionID, agent: 'graph-orchestrator' }));
  assert.equal(inspected.runId, sessionID);
});

test('disabled plugin is inert and does not access host context', async () => {
  const { default: plugin } = await load();
  const context = new Proxy({}, { get() { throw new Error('unexpected host access'); } });
  assert.deepEqual(await plugin(context, { enabled: false }), {});
});

for (const explicit of [undefined, 0, 1, 2, 4]) test(`native subagent depth default/preservation and admission (${explicit})`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-depth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { default: plugin } = await load();
  const hooks = await plugin({ worktree: dir });
  const config = explicit === undefined ? {} : { subagent_depth: explicit };
  await hooks.config(config);
  assert.equal(config.subagent_depth, explicit ?? 2);
  await hooks['chat.message']({ sessionID: 'root', agent: 'graph-orchestrator' }, { parts: [] });
  const args = { subagent_type: 'graph-explorer', prompt: 'Explore' };
  await hooks['tool.execute.before']({ tool: 'task', sessionID: 'root', callID: 'owner' }, { args });
  if (explicit !== 0) {
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'caller', parentID: 'root' } } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID: 'root', callID: 'owner', state: { status: 'running', input: args, metadata: { sessionId: 'caller', parentSessionId: 'root' } },
    } } } });
    const call = () => hooks['tool.execute.before']({ tool: 'task', sessionID: 'caller', callID: 'nested' }, { args: { subagent_type: 'graph-multimodal', prompt: 'Read PNG' } });
    if (explicit === 1) await assert.rejects(call(), /SUBAGENT_DEPTH_LIMIT/);
    else await call();
  }
  const state = JSON.parse(await readFile(join(dir, '.opencode-loop/runs/root.json'), 'utf8'));
  assert.equal(state.dispatchReservations?.length ?? 0, explicit === 0 ? 0 : explicit === 1 ? 1 : 2);
  assert.equal(state.dispatchCallIds?.length ?? 0, explicit === 0 ? 0 : explicit === 1 ? 1 : 2);
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
  assert.deepEqual(Object.keys(hooks.tool).sort(), [
    'graph_inspect',
    'graph_journal_promote',
    'graph_journal_read',
    'graph_journal_search',
    'graph_journal_write_insight',
    'graph_lesson_promote',
    'graph_lesson_read',
    'graph_lesson_record',
    'graph_lesson_search',
    'graph_run_decide',
    'graph_run_new',
    'graph_run_resume',
    'graph_status',
    'graph_submit_change',
    'graph_submit_findings',
    'graph_submit_plan',
    'graph_submit_review',
    'graph_submit_verification',
  ]);
});

test('lesson tools stay registered in disabled mode and reject safely', async () => {
  const { default: plugin } = await load();
  const hooks = await plugin({}, { lessons: { enabled: false } });
  const calls = [
    ['graph_lesson_search', {}],
    ['graph_lesson_read', { scope: 'project', id: 'a'.repeat(64) }],
    ['graph_lesson_record', { title: 'Title', body: 'Body', category: 'pitfall', tags: [], observationIds: [] }],
    ['graph_lesson_promote', { lessonId: 'a'.repeat(64), title: 'Title', body: 'Body', tags: [] }],
  ];
  for (const [name, args] of calls) {
    assert.equal(typeof hooks.tool[name]?.execute, 'function');
    const result = JSON.parse(await hooks.tool[name].execute(args, { sessionID: 'unbound', agent: 'graph-implementer' }));
    assert.deepEqual(result, { ok: false, code: 'LESSON_DISABLED', detail: 'Lesson knowledge base is disabled' });
  }
});

test('journal tools stay registered in disabled mode and reject safely', async () => {
  const { default: plugin } = await load();
  const hooks = await plugin({}, { journal: { enabled: false } });
  const calls = [
    ['graph_journal_search', {}],
    ['graph_journal_read', { scope: 'project', id: 'a'.repeat(64) }],
    ['graph_journal_write_insight', { title: 'Title', body: 'Body', tags: [] }],
    ['graph_journal_promote', { insightId: 'a'.repeat(64), title: 'Title', body: 'Body', tags: [] }],
  ];
  for (const [name, args] of calls) {
    assert.equal(typeof hooks.tool[name]?.execute, 'function');
    const result = JSON.parse(await hooks.tool[name].execute(args, { sessionID: 'unbound', agent: 'graph-implementer' }));
    assert.deepEqual(result, { ok: false, code: 'JOURNAL_DISABLED', detail: 'Journal is disabled' });
  }
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

test('journal settings have deeply frozen defaults', () => {
  const settings = parseOptions();
  assert.deepEqual(settings.journal, {
    enabled: true,
    includeUserRequest: true,
    semanticSearch: true,
    maxUserRequestChars: 8000,
  });
  assert.equal(Object.isFrozen(settings.journal), true);
  assert.throws(() => { settings.journal.enabled = false; }, TypeError);
});

test('journal settings merge partial overrides without sharing caller-owned options', () => {
  const journal = { enabled: false, maxUserRequestChars: 12000 };
  const settings = parseOptions({ journal });
  journal.enabled = true;
  journal.maxUserRequestChars = 1;
  assert.deepEqual(settings.journal, {
    enabled: false,
    includeUserRequest: true,
    semanticSearch: true,
    maxUserRequestChars: 12000,
  });
  assert.notEqual(settings.journal, journal);
  assert.equal(Object.isFrozen(settings.journal), true);
});

test('journal settings are strictly validated even when the plugin is disabled', () => {
  const symbolKey = { [Symbol('extra')]: true };
  let getterCalled = false;
  const getter = {};
  Object.defineProperty(getter, 'enabled', {
    enumerable: true,
    get() {
      getterCalled = true;
      return true;
    },
  });
  const invalid = [
    [null, /journal options must be a plain object/],
    [[], /journal options must be a plain object/],
    [new Date(), /journal options must be a plain object/],
    [{ extra: true }, /Unknown journal option/],
    [symbolKey, /Unknown journal option/],
    [{ enabled: 'true' }, /journal\.enabled must be a boolean/],
    [{ includeUserRequest: 1 }, /journal\.includeUserRequest must be a boolean/],
    [{ semanticSearch: null }, /journal\.semanticSearch must be a boolean/],
    [{ maxUserRequestChars: 0 }, /journal\.maxUserRequestChars must be an integer from 1 to 32000/],
    [{ maxUserRequestChars: 32001 }, /journal\.maxUserRequestChars must be an integer from 1 to 32000/],
    [{ maxUserRequestChars: 1.5 }, /journal\.maxUserRequestChars must be an integer from 1 to 32000/],
    [getter, /Journal options must contain values, not getters/],
  ];
  for (const [journal, expected] of invalid) {
    assert.throws(() => parseOptions({ enabled: false, journal }), expected);
  }
  assert.equal(getterCalled, false);
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
  const invalid = [null, [], 'enabled', { extra: true }, { enabled: 'false' }, { setDefaultAgent: 1 }, { maxAttempts: 0 }, { maxAttempts: 21 }, { maxAttempts: 1.2 }, { maxParallel: 0 }, { maxParallel: 17 }, { maxParallel: Infinity }, { maxImplementerParallel: 0 }, { maxImplementerParallel: 5 }, { maxImplementerParallel: 1.5 }, { maxPlanRevisions: 0 }, { maxPlanRevisions: 21 }, { maxPlanRevisions: 2.5 }, { stateDirectory: '../escape' }, { stateDirectory: 'a/b/c/d/e' }, { stateDirectory: '' }, { stateDirectory: 'dir\\win' }, { enforcement: 'strict' }, { enforcement: null }, { models: null }, { models: [] }, { models: { build: 'v/m' } }, { models: { 'graph-planner': '' } }, { models: { 'graph-planner': ' model ' } }, { models: { 'graph-planner': () => {} } }, { enabled: false, injectAuthority() {} }];
  for (const options of invalid) await assert.rejects(plugin({}, options), /option|model|maxAttempts|maxParallel|maxImplementerParallel|maxPlanRevisions|stateDirectory|enforcement|enabled|setDefaultAgent/i);
  const { default: plugin2 } = await load();
  const hooks = await plugin2({}, { maxPlanRevisions: 5 });
  const status = JSON.parse(await hooks.tool.graph_status.execute({}));
  assert.equal(status.limits.maxPlanRevisions, 5);
});

test('status projects healthy journal capabilities and dynamic counts without service data leaks', async () => {
  const secretRequest = 'request-status-secret';
  const secretPath = 'C:\\private\\status-journal';
  let calls = 0;
  const settings = parseOptions({
    stateDirectory: 'runtime-state',
    journal: { includeUserRequest: false },
  });
  const journalService = {
    async status() {
      calls += 1;
      return {
        enabled: true,
        projectAvailable: true,
        projected: 7,
        backfilled: 3,
        failures: 2,
        lastError: null,
        pendingBackfill: { count: 4, inspected: 9, truncated: false },
        store: {
          project: { available: true, entries: 5, corrupt: 1, path: secretPath },
          global: { available: true, entries: 2, corrupt: 2 },
          corruptionCount: 3,
        },
        search: { semanticSearch: true, lastError: null, query: secretRequest },
        request: secretRequest,
      };
    },
  };

  const output = await createStatusTool(settings, journalService).execute({});
  const status = JSON.parse(output);

  assert.equal(calls, 1);
  assert.equal(status.workflowMode, 'gated');
  assert.deepEqual(status.limits, { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 2, maxPlanRevisions: 3 });
  assert.equal(status.stateDirectory, 'runtime-state');
  assert.equal(status.journal.enabled, true);
  assert.equal(status.journal.includeUserRequest, false);
  assert.equal(status.journal.rawRequestsRetained, false);
  assert.equal(status.journal.semanticSearch, true);
  assert.equal(status.journal.model, MODEL_NAME);
  assert.equal(status.journal.revision, MODEL_REVISION);
  assert.equal(status.journal.dtype, MODEL_DTYPE);
  assert.equal(status.journal.searchMode, 'hybrid');
  assert.equal(status.journal.projectAvailable, true);
  assert.deepEqual(status.journal.project, { entries: 5, corrupt: 1 });
  assert.deepEqual(status.journal.global, { entries: 2, corrupt: 2 });
  assert.equal(status.journal.corruptionCount, 3);
  assert.deepEqual(status.journal.pendingBackfill, { count: 4, inspected: 9, truncated: false });
  assert.equal(status.journal.projected, 7);
  assert.equal(status.journal.backfilled, 3);
  assert.equal(status.journal.failures, 2);
  assert.equal(status.journal.lastError, null);
  assert.deepEqual(status.journal.storage, {
    project: 'runtime-state/journal',
    global: '~/.config/opencode/opencode-loop/journal',
  });
  assert.doesNotMatch(output, /request-status-secret|private|b0420/);
});

test('status reports disabled journal configuration with bounded zero pending work', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-status-disabled-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { default: plugin } = await load();
  const hooks = await plugin({ worktree: dir }, { journal: { enabled: false } });

  const status = JSON.parse(await hooks.tool.graph_status.execute({}));

  assert.equal(status.journal.enabled, false);
  assert.equal(status.journal.includeUserRequest, true);
  assert.equal(status.journal.rawRequestsRetained, false);
  assert.equal(status.journal.semanticSearch, true);
  assert.equal(status.journal.searchMode, 'disabled');
  assert.deepEqual(status.journal.pendingBackfill, { count: 0, inspected: 0, truncated: false });
});

test('status survives journal service failure with fixed degraded output', async () => {
  const secretRequest = 'degraded-request-secret';
  const secretPath = 'C:\\private\\degraded-journal';
  const settings = parseOptions();
  const statusTool = createStatusTool(settings, {
    async status() { throw new Error(`${secretRequest} at ${secretPath}`); },
  });

  const statusPromise = statusTool.execute({});
  await assert.doesNotReject(statusPromise);
  const output = await statusPromise;
  const status = JSON.parse(output);

  assert.equal(status.runtimeAvailable, true);
  assert.equal(status.journal.enabled, true);
  assert.equal(status.journal.searchMode, 'text-fallback');
  assert.equal(status.journal.projectAvailable, false);
  assert.deepEqual(status.journal.project, { entries: 0, corrupt: 0 });
  assert.deepEqual(status.journal.global, { entries: 0, corrupt: 0 });
  assert.deepEqual(status.journal.pendingBackfill, { count: 0, inspected: 0, truncated: false });
  assert.equal(status.journal.projected, 0);
  assert.equal(status.journal.backfilled, 0);
  assert.equal(status.journal.failures, 0);
  assert.equal(status.journal.lastError, 'Journal status unavailable');
  assert.doesNotMatch(output, /degraded-request-secret|private|b0420/);
});

test('status is read-only, truthful, stable and does not expose host secrets or developer paths', async () => {
  const { default: plugin } = await load();
  const hooks = await plugin({ directory: 'C:/private/project', secret: 'host-secret' });
  const output = await hooks.tool.graph_status.execute({}, new Proxy({}, { get() { throw new Error('host effects forbidden'); } }));
  const status = JSON.parse(output);
  assert.equal(status.version, '0.3.0-alpha.18');
  assert.equal(status.enforcementScope, 'GRAPH_MANAGED_SESSIONS');
  assert.equal(status.enforcementAttested, false);
  assert.equal(status.runtimeAvailable, true);
  assert.equal(status.workflowMode, 'gated');
  assert.equal(status.limitsEnforced, true);
  assert.equal(status.managedRuntimeStatus, 'available');
  assert.deepEqual(status.limits, { maxAttempts: 3, maxParallel: 4, maxImplementerParallel: 2, maxPlanRevisions: 3 });
  assert.equal(status.stateDirectory, '.opencode-loop');
  assert.match(status.reason, /real-model/i);
  assert.match(status.enforcementDetail, /tool\.execute/i);
  assert.equal(status.journal.model, MODEL_NAME);
  assert.equal(status.journal.revision, MODEL_REVISION);
  assert.equal(status.journal.dtype, MODEL_DTYPE);
  assert.equal(status.journal.searchMode, 'hybrid');
  assert.equal(status.journal.projectAvailable, false);
  assert.deepEqual(status.journal.pendingBackfill, { count: 0, inspected: 0, truncated: false });
  assert.deepEqual(status.journal.storage, {
    project: '.opencode-loop/journal',
    global: '~/.config/opencode/opencode-loop/journal',
  });
  assert.doesNotMatch(output, /private|host-secret|b0420/);
  assert.deepEqual(hooks.tool.graph_status.args, {});
});

test('resolveWorktree avoids the filesystem root outside git repositories', async () => {
  const { resolveWorktree } = await import('../src/config.mjs');
  assert.equal(resolveWorktree({ worktree: '/', directory: '/proj' }), '/proj');
  assert.equal(resolveWorktree({ worktree: '/wt', directory: '/proj' }), '/wt');
  assert.equal(resolveWorktree({ worktree: '', directory: '/proj' }), '/proj');
  assert.equal(resolveWorktree({ directory: '/proj' }), '/proj');
  assert.equal(resolveWorktree({ worktree: '/' }), null);
  assert.equal(resolveWorktree({}), null);
});

test('root worktree falls back to directory so a fresh session stores state without a server error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-root-wt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { default: plugin } = await load();
  const hooks = await plugin({ worktree: '/', directory: dir });
  const sessionID = 'non-git-root';

  await hooks['chat.message'](
    { sessionID, messageID: 'message-1', agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'First message in a non-git project.' }] },
  );

  const runFile = join(dir, '.opencode-loop', 'runs', `${sessionID}.json`);
  const run = JSON.parse(await readFile(runFile, 'utf8'));
  assert.equal(run.runId, sessionID);
  assert.equal(run.request.text, 'First message in a non-git project.');
});
