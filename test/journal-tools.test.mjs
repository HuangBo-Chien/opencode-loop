import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tool } from '@opencode-ai/plugin/tool';
import { createJournalService } from '../src/journal.mjs';
import { createJournalStore, stableJournalId } from '../src/journal-store.mjs';
import { createRunStore } from '../src/run-state.mjs';

const CREATED_AT = '2026-09-10T10:00:00.000Z';
const FINISHED_AT = '2026-09-10T10:30:00.000Z';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const JOURNAL_TOOL_NAMES = [
  'graph_journal_search',
  'graph_journal_read',
  'graph_journal_write_insight',
  'graph_journal_promote',
];

async function loadJournalTools(options) {
  const { createJournalTools } = await import('../src/journal-tools.mjs');
  return createJournalTools(options);
}

function context(sessionID, agent) {
  return {
    sessionID,
    messageID: 'message',
    agent,
    directory: '/workspace',
    worktree: '/workspace',
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

async function execute(definition, args, sessionID, agent) {
  return JSON.parse(await definition.execute(args, context(sessionID, agent)));
}

async function roots(t, prefix = 'loop-journal-tools-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const worktree = join(root, 'project');
  const globalDirectory = join(root, 'global', 'entries');
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { worktree, globalDirectory };
}

function searchStub(overrides = {}) {
  return {
    async search(args) { return { mode: 'metadata', hits: [], delegated: args }; },
    status() { return { mode: 'test' }; },
    ...overrides,
  };
}

async function realHarness(t, {
  runId = 'journal-run-001',
  status = 'SUCCEEDED',
  files = [],
  enabled = true,
} = {}) {
  const { worktree, globalDirectory } = await roots(t);
  const runStore = createRunStore({ worktree });
  const state = await runStore.createRun({
    runId,
    rootSessionId: runId,
    now: CREATED_AT,
    request: null,
    requestCaptureCompleted: true,
  });
  state.mode = 'change';
  state.status = status;
  state.updatedAt = FINISHED_AT;
  if (files.length) {
    state.artifacts['change:impl-1'] = {
      kind: 'change',
      nodeId: 'impl-1',
      version: 1,
      basedOn: [],
      payload: { filesTouched: files, summary: 'Changed project files', unresolved: [] },
      status: 'valid',
      createdAt: FINISHED_AT,
    };
  }
  const journalStore = createJournalStore({ worktree, globalDirectory });
  const journalService = createJournalService({
    runStore,
    journalStore,
    journalSearch: searchStub(),
    enabled,
    worktree,
  });
  const bindings = new Map([[runId, {
    runId,
    agent: 'graph-orchestrator',
    nodeId: null,
    root: true,
  }]]);
  const tools = await loadJournalTools({ journalService, store: runStore, bindings, enabled });
  return { worktree, runStore, state, journalStore, journalService, bindings, tools };
}

function projectKey(worktree) {
  return stableJournalId('project', resolve(worktree));
}

function summaryId(worktree, runId) {
  return stableJournalId('run-summary', projectKey(worktree), runId);
}

function errorCode(code) {
  return (error) => error?.code === code;
}

test('journal tool schemas apply defaults and enforce public bounds', async () => {
  const tools = await loadJournalTools({
    journalService: {},
    store: {},
    bindings: new Map(),
    enabled: true,
  });
  assert.deepEqual(Object.keys(tools), JOURNAL_TOOL_NAMES);

  const schema = (name) => tool.schema.object(tools[name].args);
  assert.deepEqual(schema('graph_journal_search').parse({}), {
    scope: 'both',
    kinds: [],
    statuses: [],
    tags: [],
    files: [],
    limit: 10,
  });
  assert.throws(() => schema('graph_journal_search').parse({ query: 'q'.repeat(8001) }));
  assert.throws(() => schema('graph_journal_search').parse({ scope: 'private' }));
  assert.throws(() => schema('graph_journal_search').parse({ kinds: Array(17).fill('insight') }));
  assert.throws(() => schema('graph_journal_search').parse({ statuses: [''] }));
  assert.throws(() => schema('graph_journal_search').parse({ tags: ['t'.repeat(129)] }));
  assert.throws(() => schema('graph_journal_search').parse({ files: ['f'.repeat(513)] }));
  for (const limit of [0, 51, 1.5]) assert.throws(() => schema('graph_journal_search').parse({ limit }));

  assert.deepEqual(schema('graph_journal_read').parse({ scope: 'project', id: HEX_A }), { scope: 'project', id: HEX_A });
  assert.throws(() => schema('graph_journal_read').parse({ scope: 'both', id: HEX_A }));
  assert.throws(() => schema('graph_journal_read').parse({ scope: 'project', id: 'A'.repeat(64) }));

  assert.deepEqual(schema('graph_journal_write_insight').parse({ title: 'Title', body: 'Body' }), {
    title: 'Title', body: 'Body', tags: [],
  });
  for (const args of [
    { title: '', body: 'Body' },
    { title: 't'.repeat(513), body: 'Body' },
    { title: 'Title', body: '' },
    { title: 'Title', body: 'b'.repeat(32_001) },
    { title: 'Title', body: 'Body', tags: Array(17).fill('tag') },
    { title: 'Title', body: 'Body', tags: [''] },
    { title: 'Title', body: 'Body', tags: ['t'.repeat(129)] },
  ]) assert.throws(() => schema('graph_journal_write_insight').parse(args));

  assert.deepEqual(schema('graph_journal_promote').parse({ insightId: HEX_A, title: 'Title', body: 'Body' }), {
    insightId: HEX_A, title: 'Title', body: 'Body', tags: [],
  });
  assert.throws(() => schema('graph_journal_promote').parse({ insightId: 'A'.repeat(64), title: 'Title', body: 'Body' }));
  assert.throws(() => schema('graph_journal_promote').parse({ insightId: HEX_A, title: '', body: 'Body' }));
});

test('disabled journal tools reject before accessing bindings, stores, or services', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('disabled dependency accessed'); } });
  const tools = await loadJournalTools({
    journalService: forbidden,
    store: forbidden,
    bindings: forbidden,
    enabled: false,
  });
  const calls = [
    ['graph_journal_search', {}],
    ['graph_journal_read', { scope: 'project', id: HEX_A }],
    ['graph_journal_write_insight', { title: 'Title', body: 'Body', tags: [] }],
    ['graph_journal_promote', { insightId: HEX_A, title: 'Title', body: 'Body', tags: [] }],
  ];
  for (const [name, args] of calls) {
    const output = await execute(tools[name], args, 'unbound', 'graph-implementer');
    assert.equal(output.ok, false);
    assert.equal(output.code, 'JOURNAL_DISABLED');
  }
});

test('search and read delegate only for the four matching bound read roles', async () => {
  const state = { runId: 'root', rootSessionId: 'root', status: 'RUNNING' };
  const calls = [];
  const entry = { id: HEX_A, kind: 'insight', scope: 'project' };
  const journalService = {
    async search(args) { calls.push(['search', args]); return { mode: 'metadata', hits: [{ id: HEX_A }] }; },
    async read(scope, id) { calls.push(['read', scope, id]); return entry; },
  };
  const roles = ['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic'];
  const bindings = new Map(roles.map((agent, index) => {
    const sessionID = index === 0 ? 'root' : `child-${index}`;
    return [sessionID, { runId: 'root', agent, nodeId: null, root: index === 0 }];
  }));
  const tools = await loadJournalTools({
    journalService,
    store: { getRun(runId) { return runId === 'root' ? state : null; } },
    bindings,
    enabled: true,
  });

  for (let index = 0; index < roles.length; index += 1) {
    const sessionID = index === 0 ? 'root' : `child-${index}`;
    const search = await execute(tools.graph_journal_search, { query: 'retry', scope: 'both', limit: 3 }, sessionID, roles[index]);
    assert.deepEqual(search, { ok: true, mode: 'metadata', hits: [{ id: HEX_A }] });
    const read = await execute(tools.graph_journal_read, { scope: 'project', id: HEX_A }, sessionID, roles[index]);
    assert.deepEqual(read, { ok: true, entry });
  }
  assert.deepEqual(calls[0], ['search', { query: 'retry', scope: 'both', limit: 3 }]);
  assert.deepEqual(calls[1], ['read', 'project', HEX_A]);

  bindings.set('implementer', { runId: 'root', agent: 'graph-implementer', nodeId: 'impl', root: false });
  for (const name of ['graph_journal_search', 'graph_journal_read']) {
    const args = name.endsWith('read') ? { scope: 'project', id: HEX_A } : {};
    assert.equal((await execute(tools[name], args, 'implementer', 'graph-implementer')).code, 'WRONG_ROLE');
  }
});

test('all journal handlers reject unbound, missing-run, and spoofed session callers', async () => {
  const state = { runId: 'root', rootSessionId: 'root', status: 'SUCCEEDED' };
  const service = {
    async search() { return { hits: [] }; },
    async read() { return { id: HEX_A }; },
    async writeInsight() { return { created: true, entry: { id: HEX_A } }; },
    async promote() { return { created: true, entry: { id: HEX_B } }; },
  };
  const bindings = new Map([
    ['gone', { runId: 'gone-run', agent: 'graph-orchestrator', nodeId: null, root: true }],
    ['spoofed', { runId: 'root', agent: 'graph-explorer', nodeId: null, root: true }],
  ]);
  const tools = await loadJournalTools({
    journalService: service,
    store: { getRun(runId) { return runId === 'root' ? state : null; } },
    bindings,
    enabled: true,
  });
  const calls = [
    ['graph_journal_search', {}],
    ['graph_journal_read', { scope: 'project', id: HEX_A }],
    ['graph_journal_write_insight', { title: 'Title', body: 'Body', tags: [] }],
    ['graph_journal_promote', { insightId: HEX_A, title: 'Title', body: 'Body', tags: [] }],
  ];

  for (const [name, args] of calls) {
    assert.equal((await execute(tools[name], args, 'unbound', 'graph-orchestrator')).code, 'NOT_GRAPH_SESSION');
    assert.equal((await execute(tools[name], args, 'gone', 'graph-orchestrator')).code, 'RUN_GONE');
    assert.equal((await execute(tools[name], args, 'spoofed', 'graph-orchestrator')).code, 'WRONG_ROLE');
  }
});

test('insight and promotion require the root orchestrator, and insight requires a terminal run', async () => {
  let state = { runId: 'root', rootSessionId: 'root', status: 'RUNNING' };
  let writes = 0;
  let promotions = 0;
  const bindings = new Map([
    ['root', { runId: 'root', agent: 'graph-orchestrator', nodeId: null, root: true }],
    ['child-orchestrator', { runId: 'root', agent: 'graph-orchestrator', nodeId: null, root: false }],
    ['explorer', { runId: 'root', agent: 'graph-explorer', nodeId: null, root: false }],
  ]);
  const tools = await loadJournalTools({
    journalService: {
      async writeInsight(_state, args) { writes += 1; return { created: true, entry: { id: HEX_A, ...args } }; },
      async promote(args) { promotions += 1; return { created: true, entry: { id: HEX_B, ...args } }; },
    },
    store: { getRun() { return state; } },
    bindings,
    enabled: true,
  });
  const insightArgs = { title: 'Title', body: 'Body', tags: [] };
  const promoteArgs = { insightId: HEX_A, title: 'Global', body: 'Portable', tags: [] };

  assert.equal((await execute(tools.graph_journal_write_insight, insightArgs, 'root', 'graph-orchestrator')).code, 'JOURNAL_RUN_NOT_TERMINAL');
  assert.equal(writes, 0);
  assert.equal((await execute(tools.graph_journal_write_insight, insightArgs, 'child-orchestrator', 'graph-orchestrator')).code, 'ROOT_REQUIRED');
  assert.equal((await execute(tools.graph_journal_promote, promoteArgs, 'child-orchestrator', 'graph-orchestrator')).code, 'ROOT_REQUIRED');
  assert.equal((await execute(tools.graph_journal_write_insight, insightArgs, 'explorer', 'graph-explorer')).code, 'WRONG_ROLE');
  assert.equal((await execute(tools.graph_journal_promote, promoteArgs, 'explorer', 'graph-explorer')).code, 'WRONG_ROLE');

  state = { ...state, status: 'FAILED' };
  assert.equal((await execute(tools.graph_journal_write_insight, insightArgs, 'root', 'graph-orchestrator')).ok, true);
  assert.equal(writes, 1);
  state = { ...state, status: 'SUCCEEDED' };
  assert.equal((await execute(tools.graph_journal_write_insight, insightArgs, 'root', 'graph-orchestrator')).ok, true);
  assert.equal((await execute(tools.graph_journal_promote, promoteArgs, 'root', 'graph-orchestrator')).ok, true);
  assert.equal(writes, 2);
  assert.equal(promotions, 1);
});

test('read reports not found without changing delegated scope or id', async () => {
  const calls = [];
  const tools = await loadJournalTools({
    journalService: {
      async read(scope, id) { calls.push([scope, id]); return null; },
    },
    store: { getRun() { return { runId: 'root', rootSessionId: 'root', status: 'RUNNING' }; } },
    bindings: new Map([['root', { runId: 'root', agent: 'graph-orchestrator', nodeId: null, root: true }]]),
    enabled: true,
  });

  const output = await execute(tools.graph_journal_read, { scope: 'global', id: HEX_B }, 'root', 'graph-orchestrator');
  assert.equal(output.ok, false);
  assert.equal(output.code, 'JOURNAL_NOT_FOUND');
  assert.deepEqual(calls, [['global', HEX_B]]);
});

test('JournalService insight writes require enabled, available, terminal project state', async (t) => {
  const terminal = { runId: 'run', status: 'SUCCEEDED', createdAt: CREATED_AT, updatedAt: FINISHED_AT };
  const disabled = createJournalService({
    runStore: {}, journalStore: {}, journalSearch: {}, enabled: false, worktree: 'C:/project',
  });
  await assert.rejects(() => disabled.writeInsight(terminal, { title: 'Title', body: 'Body', tags: [] }), errorCode('JOURNAL_DISABLED'));

  const unavailable = createJournalService({
    runStore: {}, journalStore: {}, journalSearch: {}, enabled: true, worktree: null,
  });
  await assert.rejects(() => unavailable.writeInsight(terminal, { title: 'Title', body: 'Body', tags: [] }), errorCode('JOURNAL_PROJECT_UNAVAILABLE'));

  const h = await realHarness(t, { runId: 'nonterminal-run', status: 'RUNNING' });
  await assert.rejects(
    () => h.journalService.writeInsight(h.state, { title: 'Title', body: 'Body', tags: [] }),
    errorCode('JOURNAL_RUN_NOT_TERMINAL'),
  );
  h.state.status = 'SUCCEEDED ';
  await assert.rejects(
    () => h.journalService.writeInsight(h.state, { title: 'Title', body: 'Body', tags: [] }),
    errorCode('JOURNAL_RUN_NOT_TERMINAL'),
  );
  assert.deepEqual(await h.journalStore.list('project'), []);
});

test('project insight projects its summary and is sanitized, bounded, content-stable, and idempotent', async (t) => {
  const h = await realHarness(t, { runId: 'insight-run-001', status: 'SUCCEEDED' });
  const input = {
    title: `Reusable password=title-secret ${'t'.repeat(600)}`,
    body: `Authorization: Bearer body-secret\n${'b'.repeat(34_000)}`,
    tags: [
      ' reusable ',
      'token=tag-secret',
      'x'.repeat(200),
      ...Array.from({ length: 20 }, (_, index) => `tag-${index}`),
    ],
  };

  const first = await h.journalService.writeInsight(h.state, input);
  const second = await h.journalService.writeInsight(h.state, input);
  const changed = await h.journalService.writeInsight(h.state, { title: 'Different insight', body: 'Body', tags: [] });
  const expectedSummaryId = summaryId(h.worktree, h.state.runId);
  const summary = await h.journalStore.read('project', expectedSummaryId);
  const entry = await h.journalStore.read('project', first.entry.id);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.entry.id, first.entry.id);
  assert.notEqual(changed.entry.id, first.entry.id);
  assert.equal(summary.kind, 'run-summary');
  assert.equal(entry.kind, 'insight');
  assert.equal(entry.scope, 'project');
  assert.deepEqual(entry.sourceIds, [expectedSummaryId]);
  assert.deepEqual(entry.metadata, {
    projectKey: projectKey(h.worktree),
    runId: h.state.runId,
    status: 'SUCCEEDED',
  });
  assert.ok(entry.title.length <= 512);
  assert.ok(entry.body.length <= 32_000);
  assert.ok(entry.tags.length <= 16);
  assert.ok(entry.tags.every((tag) => tag.length >= 1 && tag.length <= 128));
  assert.equal(entry.tags[0], 'reusable');
  const serialized = JSON.stringify(entry);
  for (const secret of ['title-secret', 'body-secret', 'tag-secret']) assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /\[REDACTED\]/);
});

test('promotion rejects missing entries and project entries of the wrong kind', async (t) => {
  const h = await realHarness(t, { runId: 'wrong-kind-run', status: 'FAILED' });
  await h.journalService.projectRun(h.state);
  const args = { title: 'Global title', body: 'Global body', tags: [] };

  const missing = await execute(h.tools.graph_journal_promote, { insightId: HEX_A, ...args }, h.state.runId, 'graph-orchestrator');
  assert.equal(missing.code, 'JOURNAL_NOT_FOUND');
  const wrongKind = await execute(h.tools.graph_journal_promote, {
    insightId: summaryId(h.worktree, h.state.runId),
    ...args,
  }, h.state.runId, 'graph-orchestrator');
  assert.equal(wrongKind.code, 'JOURNAL_WRONG_KIND');
  assert.deepEqual(await h.journalStore.list('global'), []);
});

test('promotion stores only separately supplied sanitized project-neutral content', async (t) => {
  const file = 'src/private-project-file.mjs';
  const h = await realHarness(t, { runId: 'promotion-source-run', files: [file] });
  const source = await h.journalService.writeInsight(h.state, {
    title: 'Project-only title',
    body: 'PROJECT_BODY_SENTINEL',
    tags: ['project-only'],
  });
  const supplied = {
    title: ' Portable password=global-secret ',
    body: 'Use bounded retries. Authorization: Bearer promoted-secret',
    tags: [' reusable ', 'token=promoted-tag-secret'],
  };

  const first = await execute(h.tools.graph_journal_promote, {
    insightId: source.entry.id,
    ...supplied,
  }, h.state.runId, 'graph-orchestrator');
  const second = await execute(h.tools.graph_journal_promote, {
    insightId: source.entry.id,
    ...supplied,
  }, h.state.runId, 'graph-orchestrator');
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const global = await h.journalStore.read('global', first.entry.id);
  assert.equal(global.scope, 'global');
  assert.equal(global.kind, 'promoted-insight');
  assert.equal(global.title, 'Portable password=[REDACTED]');
  assert.equal(global.body, 'Use bounded retries. Authorization: Bearer [REDACTED]');
  assert.deepEqual(global.tags, ['reusable', 'token=[REDACTED]']);
  assert.deepEqual(global.sourceIds, []);
  assert.deepEqual(global.metadata, { originKind: 'insight' });

  const serialized = JSON.stringify(global);
  for (const excluded of [
    'PROJECT_BODY_SENTINEL',
    'Project-only title',
    'project-only',
    'global-secret',
    'promoted-secret',
    'promoted-tag-secret',
    projectKey(h.worktree),
    h.state.runId,
    summaryId(h.worktree, h.state.runId),
    source.entry.id,
    file,
  ]) assert.equal(serialized.includes(excluded), false, `global journal leaked ${excluded}`);
});

test('promotion rejects supplied title, body, or tags containing known project metadata', async (t) => {
  const file = 'src/project-private-marker.mjs';
  const h = await realHarness(t, { runId: 'metadata-leak-run-9381', files: [file] });
  const source = await h.journalService.writeInsight(h.state, { title: 'Source', body: 'Source body', tags: [] });
  const linkedSummary = summaryId(h.worktree, h.state.runId);
  const cases = [
    { title: projectKey(h.worktree), body: 'Safe body', tags: [] },
    { title: 'Safe title', body: `Do not retain ${h.state.runId}`, tags: [] },
    { title: 'Safe title', body: 'Safe body', tags: [linkedSummary] },
    { title: 'Safe title', body: `Do not retain ${file}`, tags: [] },
  ];

  for (const supplied of cases) {
    const result = await execute(h.tools.graph_journal_promote, {
      insightId: source.entry.id,
      ...supplied,
    }, h.state.runId, 'graph-orchestrator');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'JOURNAL_METADATA_LEAK');
  }
  assert.deepEqual(await h.journalStore.list('global'), []);
});

test('service and run-store failures return one bounded generic safe journal error', async () => {
  const secret = 'private request text at C:\\users\\secret\\journal.md';
  const state = { runId: 'root', rootSessionId: 'root', status: 'SUCCEEDED' };
  const bindings = new Map([['root', { runId: 'root', agent: 'graph-orchestrator', nodeId: null, root: true }]]);
  const calls = [
    ['graph_journal_search', {}],
    ['graph_journal_read', { scope: 'project', id: HEX_A }],
    ['graph_journal_write_insight', { title: 'Title', body: 'Body', tags: [] }],
    ['graph_journal_promote', { insightId: HEX_A, title: 'Title', body: 'Body', tags: [] }],
  ];
  const failingService = Object.fromEntries(['search', 'read', 'writeInsight', 'promote'].map((name) => [name, async () => {
    throw new Error(`${name}: ${secret}`);
  }]));
  const serviceTools = await loadJournalTools({
    journalService: failingService,
    store: { getRun() { return state; } },
    bindings,
    enabled: true,
  });
  const storeTools = await loadJournalTools({
    journalService: new Proxy({}, { get() { throw new Error(`service: ${secret}`); } }),
    store: { getRun() { throw new Error(`store: ${secret}`); } },
    bindings,
    enabled: true,
  });

  for (const tools of [serviceTools, storeTools]) {
    for (const [name, args] of calls) {
      const raw = await tools[name].execute(args, context('root', 'graph-orchestrator'));
      const output = JSON.parse(raw);
      assert.deepEqual(output, { ok: false, code: 'JOURNAL_ERROR', detail: 'Journal operation failed' });
      assert.ok(raw.length < 256);
      assert.equal(raw.includes(secret), false);
      assert.equal(raw.includes('private request'), false);
    }
  }
});

test('journal read tools resolve a binding-free managed child through its parent run', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const runStore = createRunStore({ worktree });
  const state = await runStore.createRun({ runId: 'root-run', rootSessionId: 'root-run', now: CREATED_AT, request: null, requestCaptureCompleted: true });
  state.status = 'SUCCEEDED';
  state.updatedAt = FINISHED_AT;
  await runStore.saveRun(state);
  const journalStore = createJournalStore({ worktree, globalDirectory });
  const journalService = createJournalService({
    runStore,
    journalStore,
    journalSearch: { async search(args) { return { mode: 'metadata', hits: [], delegated: args }; }, status() { return { mode: 'test' }; } },
    enabled: true,
    worktree,
  });
  const bindings = new Map([['root-run', { runId: 'root-run', root: true, agent: 'graph-orchestrator' }]]);
  const dispatches = {
    runForSession(sessionId) {
      return sessionId === 'late-child' ? 'root-run' : null;
    },
  };
  const tools = await loadJournalTools({ journalService, store: runStore, bindings, dispatches, enabled: true });

  const search = await execute(tools.graph_journal_search, { query: 'weights' }, 'late-child', 'graph-explorer');
  assert.equal(search.ok, true, JSON.stringify(search));
  const read = await execute(tools.graph_journal_read, { scope: 'project', id: HEX_A }, 'late-child', 'graph-explorer');
  assert.equal(read.ok, false);
  assert.equal(read.code, 'JOURNAL_NOT_FOUND');

  // Unmanaged strangers without a parent-run link still fail closed.
  const stranger = await execute(tools.graph_journal_search, { query: 'x' }, 'stranger', 'graph-explorer');
  assert.equal(stranger.code, 'NOT_GRAPH_SESSION');
  // Write tools still require the root binding.
  const write = await execute(tools.graph_journal_write_insight, { title: 'T', body: 'B' }, 'late-child', 'graph-orchestrator');
  assert.equal(write.code, 'ROOT_REQUIRED');
});
