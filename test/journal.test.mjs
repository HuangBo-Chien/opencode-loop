import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import GraphPlugin from '../src/index.mjs';
import { createJournalService, createJournaledRunStore } from '../src/journal.mjs';
import { createJournalStore, stableJournalId } from '../src/journal-store.mjs';
import { createRunStore, newRun } from '../src/run-state.mjs';

const CREATED_AT = '2026-09-10T10:00:00.000Z';
const FINISHED_AT = '2026-09-10T10:30:00.000Z';

async function roots(t, prefix = 'loop-journal-service-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const worktree = join(root, 'project');
  const globalDirectory = join(root, 'global', 'entries');
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, globalDirectory };
}

function journalSearch(overrides = {}) {
  return Object.freeze({
    async search(args) { return { delegated: args }; },
    status() { return { mode: 'test', lastError: null }; },
    ...overrides,
  });
}

function projectKey(worktree) {
  return stableJournalId('project', resolve(worktree));
}

function summaryId(worktree, runId) {
  return stableJournalId('run-summary', projectKey(worktree), runId);
}

function terminalRun({ runId = 'run-success', status = 'SUCCEEDED', request = undefined } = {}) {
  const initialRequest = request === undefined ? {
    text: 'Implement journal summaries\ntoken=request-secret',
    truncated: true,
    redactions: 0,
    capturedAt: CREATED_AT,
  } : request;
  const state = newRun({
    runId,
    rootSessionId: runId,
    now: CREATED_AT,
    request: initialRequest,
    requestCaptureCompleted: true,
  });
  state.mode = 'change';
  state.status = status;
  state.updatedAt = FINISHED_AT;
  state.nodes = {
    'impl-1': {
      spec: { id: 'impl-1', kind: 'implement', agent: 'graph-implementer' },
      state: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'SKIPPED',
      attempt: 2,
      sessionId: 'private-session',
      startedAt: CREATED_AT,
      finishedAt: FINISHED_AT,
      reconcile: false,
    },
    'verify-1': {
      spec: { id: 'verify-1', kind: 'verify', agent: 'graph-verifier' },
      state: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'SKIPPED',
      attempt: 1,
      sessionId: 'private-verifier-session',
      startedAt: CREATED_AT,
      finishedAt: FINISHED_AT,
      reconcile: false,
    },
  };
  state.artifacts = {
    plan: {
      kind: 'plan',
      nodeId: 'plan-1',
      version: 1,
      basedOn: [],
      payload: { source: 'SOURCE_SENTINEL', transcript: 'TRANSCRIPT_SENTINEL' },
      status: 'valid',
      createdAt: CREATED_AT,
    },
    'change:impl-1': {
      kind: 'change',
      nodeId: 'impl-1',
      version: 2,
      basedOn: ['review@1'],
      payload: {
        filesTouched: ['src/journal.mjs', 'src/run-state.mjs'],
        summary: 'Implemented projection with password=change-secret',
        checksRun: ['TOOL_OUTPUT_SENTINEL'],
        unresolved: ['Follow up token=unresolved-secret'],
        diff: 'DIFF_SENTINEL',
      },
      snapshot: { 'src/journal.mjs': 'SOURCE_HASH_SENTINEL' },
      status: 'valid',
      createdAt: FINISHED_AT,
    },
    'verification:verify-1': {
      kind: 'verification',
      nodeId: 'verify-1',
      version: 1,
      basedOn: ['change:impl-1@2'],
      payload: {
        verdict: 'PASS',
        commands: [{ command: 'node --test token=command-secret', exitCode: 0, output: 'COMMAND_OUTPUT_SENTINEL' }],
        summary: 'All checks passed with Authorization: Bearer verification-secret',
        environment: { PRIVATE_VALUE: 'ENV_VALUE_SENTINEL' },
      },
      snapshot: { 'src/journal.mjs': 'SOURCE_HASH_SENTINEL' },
      status: 'valid',
      createdAt: FINISHED_AT,
    },
  };
  state.violations = [{
    nodeId: 'impl-1',
    kind: 'scope-warning',
    detail: 'Reviewed token=violation-secret',
    at: FINISHED_AT,
  }];
  return state;
}

async function serviceWithRealStore(t) {
  const { worktree, globalDirectory } = await roots(t);
  const runStore = createRunStore({ worktree });
  const store = createJournalStore({ worktree, globalDirectory });
  const service = createJournalService({
    runStore,
    journalStore: store,
    journalSearch: journalSearch(),
    worktree,
  });
  return { worktree, runStore, store, service };
}

async function persistRun(store, state) {
  const registered = await store.createRun({
    runId: state.runId,
    rootSessionId: state.rootSessionId,
    now: state.createdAt,
    request: state.request,
    requestCaptureCompleted: state.requestCaptureCompleted,
  });
  Object.assign(registered, structuredClone(state));
  await store.saveRun(registered);
  await store.releaseRun(state.runId);
}

test('listRunIds bounds memory results and validates limit', async () => {
  const store = createRunStore();
  for (let index = 0; index < 70; index += 1) {
    const runId = `memory-${String(index).padStart(3, '0')}`;
    await store.createRun({ runId, rootSessionId: runId, now: CREATED_AT });
  }

  assert.equal((await store.listRunIds()).length, 64);
  assert.equal((await store.listRunIds({ limit: 1 })).length, 1);
  assert.equal((await store.listRunIds({ limit: 1000 })).length, 70);
  for (const limit of [0, 1001, 1.5, '1', null]) {
    await assert.rejects(() => store.listRunIds({ limit }), TypeError);
  }
  await assert.rejects(() => store.listRunIds(null), TypeError);
});

test('persistent listRunIds iterates valid JSON run files without loading contents', async (t) => {
  const { worktree } = await roots(t, 'loop-run-list-');
  const runsDirectory = join(worktree, '.opencode-loop', 'runs');
  await mkdir(runsDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(runsDirectory, 'alpha.json'), '{not JSON and intentionally unreadable as run state'),
    writeFile(join(runsDirectory, 'bravo-2.json'), 'x'.repeat(100_000)),
    writeFile(join(runsDirectory, 'invalid name.json'), '{}'),
    writeFile(join(runsDirectory, 'locked.json.lock'), '{}'),
    writeFile(join(runsDirectory, 'temporary.json.tmp-1'), '{}'),
    writeFile(join(runsDirectory, 'noise.txt'), '{}'),
    mkdir(join(runsDirectory, 'directory.json')),
  ]);
  const store = createRunStore({ worktree });

  assert.deepEqual(new Set(await store.listRunIds({ limit: 64 })), new Set(['alpha', 'bravo-2']));
  const bounded = await store.listRunIds({ limit: 1 });
  assert.equal(bounded.length, 1);
  assert.ok(['alpha', 'bravo-2'].includes(bounded[0]));
});

test('SUCCEEDED projection writes bounded sanitized metadata and Markdown evidence', async (t) => {
  const { worktree, store, service } = await serviceWithRealStore(t);
  const state = terminalRun();

  await service.projectRun(state);

  const entry = await store.read('project', summaryId(worktree, state.runId));
  assert.equal(entry.id, summaryId(worktree, state.runId));
  assert.equal(entry.scope, 'project');
  assert.equal(entry.kind, 'run-summary');
  assert.equal(entry.title, 'Implement journal summaries');
  assert.equal(entry.createdAt, FINISHED_AT);
  assert.deepEqual(entry.sourceIds, []);
  assert.ok(entry.tags.includes('change'));
  assert.ok(entry.tags.includes('SUCCEEDED'));
  assert.equal(entry.metadata.projectKey, projectKey(worktree));
  assert.equal(entry.metadata.runId, state.runId);
  assert.equal(entry.metadata.intent, 'change');
  assert.equal(entry.metadata.status, 'SUCCEEDED');
  assert.equal(entry.metadata.createdAt, CREATED_AT);
  assert.equal(entry.metadata.updatedAt, FINISHED_AT);
  assert.equal(entry.metadata.request.available, true);
  assert.equal(entry.metadata.request.truncated, true);
  assert.match(entry.metadata.request.text, /token=\[REDACTED\]/);
  assert.deepEqual(entry.metadata.files, ['src/journal.mjs', 'src/run-state.mjs']);
  assert.ok(entry.metadata.nodes.some((node) => node.id === 'impl-1'
    && node.kind === 'implement' && node.state === 'SUCCEEDED' && node.attempt === 2));
  assert.ok(entry.metadata.artifacts.some((artifact) => artifact.ref === 'change:impl-1@2'
    && artifact.kind === 'change' && artifact.version === 2 && artifact.status === 'valid'));
  assert.deepEqual(entry.metadata.verifications[0].commands, [{
    command: 'node --test token=[REDACTED]',
    exitCode: 0,
  }]);
  assert.match(entry.body, /## Initial request[\s\S]*Implement journal summaries/);
  assert.match(entry.body, /\[truncated\]/i);
  assert.match(entry.body, /impl-1[\s\S]*implement[\s\S]*SUCCEEDED[\s\S]*2/);
  assert.match(entry.body, /change:impl-1@2[\s\S]*change[\s\S]*valid/);
  assert.match(entry.body, /src\/journal\.mjs/);
  assert.match(entry.body, /Follow up token=\[REDACTED\]/);
  assert.match(entry.body, /node --test token=\[REDACTED\][\s\S]*exit 0/i);
  assert.match(entry.body, /scope-warning[\s\S]*Reviewed token=\[REDACTED\]/);
  assert.ok(entry.body.length <= 32_000);
  assert.ok(entry.metadata.request.text.length <= 8000);

  const serialized = JSON.stringify(entry);
  for (const excluded of [
    'SOURCE_SENTINEL',
    'TRANSCRIPT_SENTINEL',
    'TOOL_OUTPUT_SENTINEL',
    'DIFF_SENTINEL',
    'COMMAND_OUTPUT_SENTINEL',
    'ENV_VALUE_SENTINEL',
    'SOURCE_HASH_SENTINEL',
    'request-secret',
    'change-secret',
    'unresolved-secret',
    'command-secret',
    'verification-secret',
    'violation-secret',
    'private-session',
  ]) assert.equal(serialized.includes(excluded), false, `journal leaked ${excluded}`);
});

test('FAILED projection records unavailable request, failure reason, and violations', async (t) => {
  const { worktree, store, service } = await serviceWithRealStore(t);
  const state = terminalRun({ runId: 'run-failed', status: 'FAILED', request: null });
  state.artifacts = { plan: state.artifacts.plan };
  state.failReason = 'Plan rejected because token=failure-secret';
  state.violations = [{
    nodeId: null,
    kind: 'plan-rejected',
    detail: 'Authorization: Bearer violation-secret',
    at: FINISHED_AT,
  }];

  await service.projectRun(state);

  const entry = await store.read('project', summaryId(worktree, state.runId));
  assert.equal(entry.title, 'Run summary');
  assert.ok(entry.tags.includes('FAILED'));
  assert.equal(entry.metadata.status, 'FAILED');
  assert.deepEqual(entry.metadata.request, {
    available: false,
    redactions: 0,
    text: null,
    truncated: false,
  });
  assert.equal(entry.metadata.failReason, 'Plan rejected because token=[REDACTED]');
  assert.equal(entry.metadata.violations[0].detail, 'Authorization: Bearer [REDACTED]');
  assert.match(entry.body, /## Initial request[\s\S]*\[unavailable\]/i);
  assert.match(entry.body, /## Failure[\s\S]*Plan rejected because token=\[REDACTED\]/);
  assert.match(entry.body, /plan-rejected[\s\S]*Bearer \[REDACTED\]/);
  assert.equal(JSON.stringify(entry).includes('failure-secret'), false);
  assert.equal(JSON.stringify(entry).includes('violation-secret'), false);
});

test('projection bounds aggregate metadata for large valid run evidence', async (t) => {
  const { worktree, store, service } = await serviceWithRealStore(t);
  const state = terminalRun({ runId: 'run-bounded' });
  state.artifacts = {};
  for (let artifactIndex = 0; artifactIndex < 16; artifactIndex += 1) {
    const changeName = `change:impl-${artifactIndex}`;
    state.artifacts[changeName] = {
      kind: 'change',
      nodeId: `impl-${artifactIndex}`,
      version: 1,
      status: 'valid',
      payload: {
        filesTouched: Array.from(
          { length: 8 },
          (_, fileIndex) => `src/${artifactIndex}/${fileIndex}-${'f'.repeat(470)}.mjs`,
        ),
        summary: `Change ${artifactIndex} ${'s'.repeat(4000)}`,
        unresolved: Array.from(
          { length: 8 },
          (_, itemIndex) => `Unresolved ${artifactIndex}-${itemIndex} ${'u'.repeat(4000)}`,
        ),
      },
    };
    const verificationName = `verification:verify-${artifactIndex}`;
    state.artifacts[verificationName] = {
      kind: 'verification',
      nodeId: `verify-${artifactIndex}`,
      version: 1,
      status: 'valid',
      payload: {
        commands: Array.from(
          { length: 8 },
          (_, commandIndex) => ({ command: `node check-${artifactIndex}-${commandIndex} ${'c'.repeat(4000)}`, exitCode: 0 }),
        ),
        summary: `Verification ${artifactIndex} ${'v'.repeat(4000)}`,
      },
    };
  }
  state.violations = Array.from({ length: 32 }, (_, index) => ({
    nodeId: `impl-${index}`,
    kind: 'bounded-warning',
    detail: `Violation ${index} ${'d'.repeat(4000)}`,
    at: FINISHED_AT,
  }));

  await service.projectRun(state);

  const entry = await store.read('project', summaryId(worktree, state.runId));
  assert.ok(entry, 'large bounded evidence should still project');
  assert.ok(Buffer.byteLength(JSON.stringify(entry.metadata), 'utf8') <= 262_144);
  assert.ok(entry.body.length <= 32_000);
  assert.ok(entry.metadata.changes.length > 0 && entry.metadata.changes.length < 16);
  assert.ok(entry.metadata.verifications.length > 0 && entry.metadata.verifications.length < 16);
  assert.ok(entry.metadata.violations.length > 0 && entry.metadata.violations.length < 32);
});

test('projection does not inspect malformed list items beyond its cap', async (t) => {
  const { worktree, store, service } = await serviceWithRealStore(t);
  const state = terminalRun({ runId: 'run-inspection-bound' });
  const filesTouched = [null, null, null, null];
  Object.defineProperty(filesTouched, 4, {
    enumerable: true,
    get() { throw new Error('evidence beyond the list cap was inspected'); },
  });
  state.artifacts = {
    'change:bounded': {
      kind: 'change',
      nodeId: 'impl-bounded',
      version: 1,
      status: 'valid',
      payload: { filesTouched, summary: 'Bounded change', unresolved: [] },
    },
  };

  await service.projectRun(state);

  const entry = await store.read('project', summaryId(worktree, state.runId));
  assert.ok(entry, 'items after the inspection cap must remain unread');
  assert.deepEqual(entry.metadata.files, []);
});

test('nonterminal and disabled services do not project run summaries', async (t) => {
  const { worktree, runStore, store, service } = await serviceWithRealStore(t);
  for (const status of ['RUNNING', 'BLOCKED', 'RECOVERY_REQUIRED']) {
    await service.projectRun(terminalRun({ runId: `run-${status.toLowerCase()}`, status }));
  }
  const disabled = createJournalService({
    runStore,
    journalStore: store,
    journalSearch: journalSearch(),
    enabled: false,
    worktree,
  });
  await disabled.projectRun(terminalRun({ runId: 'run-disabled' }));

  assert.deepEqual(await store.list('project'), []);
});

test('repeated and concurrent projection publishes one identical entry', async (t) => {
  const { worktree, globalDirectory } = await roots(t, 'loop-journal-concurrent-');
  const runStore = createRunStore({ worktree });
  const realStore = createJournalStore({ worktree, globalDirectory });
  let writeCalls = 0;
  const store = {
    ...realStore,
    async write(...args) {
      writeCalls += 1;
      return realStore.write(...args);
    },
  };
  const service = createJournalService({
    runStore,
    journalStore: store,
    journalSearch: journalSearch(),
    worktree,
  });
  const state = terminalRun({ runId: 'run-concurrent' });

  await Promise.all(Array.from({ length: 32 }, () => service.projectRun(structuredClone(state))));
  const first = await realStore.read('project', summaryId(worktree, state.runId));
  await service.projectRun(structuredClone(state));
  const second = await realStore.read('project', summaryId(worktree, state.runId));

  assert.equal(writeCalls, 1);
  assert.deepEqual(await realStore.list('project'), [first]);
  assert.deepEqual(second, first);
});

test('decorated save persists first and isolates projection errors', async () => {
  const calls = [];
  let persistent = true;
  const runStore = {
    async createRun(value) { calls.push(['createRun', value]); return 'created'; },
    async loadRun(value) { calls.push(['loadRun', value]); return 'loaded'; },
    getRun(value) { calls.push(['getRun', value]); return 'current'; },
    async saveRun(value) {
      calls.push(['saveRun', value]);
      return { ...value, authoritative: true };
    },
    async releaseRun(value) { calls.push(['releaseRun', value]); return 'released'; },
    async hashFiles(value) { calls.push(['hashFiles', value]); return { hashed: true }; },
    async listRunIds(value) { calls.push(['listRunIds', value]); return ['run']; },
    get persistent() { return persistent; },
  };
  const journalService = {
    async projectRun(value) {
      calls.push(['projectRun', value]);
      assert.equal(value.authoritative, true);
      throw new Error('projection failed at C:\\private\\journal');
    },
  };
  const store = createJournaledRunStore(runStore, journalService);

  const state = { runId: 'run', status: 'SUCCEEDED' };
  assert.deepEqual(await store.saveRun(state), { ...state, authoritative: true });
  assert.deepEqual(calls.slice(0, 2).map(([name]) => name), ['saveRun', 'projectRun']);
  assert.equal(await store.createRun('create'), 'created');
  assert.equal(await store.loadRun('load'), 'loaded');
  assert.equal(store.getRun('get'), 'current');
  assert.equal(await store.releaseRun('release'), 'released');
  assert.deepEqual(await store.hashFiles(['file']), { hashed: true });
  assert.deepEqual(await store.listRunIds({ limit: 1 }), ['run']);
  assert.equal(store.persistent, true);
  persistent = false;
  assert.equal(store.persistent, false);
});

test('decorated save does not project when authoritative persistence rejects', async () => {
  let projections = 0;
  const store = createJournaledRunStore({
    async saveRun() { throw new Error('authoritative save failed'); },
  }, {
    async projectRun() { projections += 1; },
  });

  await assert.rejects(() => store.saveRun({ runId: 'run' }), /authoritative save failed/);
  assert.equal(projections, 0);
});

test('backfill projects prior terminal runs and continues past corrupt and nonterminal files', async (t) => {
  const { worktree, globalDirectory } = await roots(t, 'loop-journal-backfill-');
  const runStore = createRunStore({ worktree });
  const succeeded = terminalRun({ runId: 'before-success' });
  const failed = terminalRun({ runId: 'before-failed', status: 'FAILED', request: null });
  failed.failReason = 'Expected failure';
  const running = terminalRun({ runId: 'before-running', status: 'RUNNING' });
  await persistRun(runStore, succeeded);
  await persistRun(runStore, failed);
  await persistRun(runStore, running);
  const runsDirectory = join(worktree, '.opencode-loop', 'runs');
  await Promise.all([
    writeFile(join(runsDirectory, 'corrupt-run.json'), '{not JSON'),
    writeFile(join(runsDirectory, 'invalid run.json'), JSON.stringify(succeeded)),
    writeFile(join(runsDirectory, 'temp-run.json.tmp-1'), JSON.stringify(succeeded)),
    writeFile(join(runsDirectory, 'lock-run.json.lock'), ''),
  ]);
  const store = createJournalStore({ worktree, globalDirectory });
  const service = createJournalService({
    runStore,
    journalStore: store,
    journalSearch: journalSearch(),
    worktree,
  });

  await service.backfill();
  const first = await store.list('project');
  assert.deepEqual(new Set(first.map((entry) => entry.id)), new Set([
    summaryId(worktree, succeeded.runId),
    summaryId(worktree, failed.runId),
  ]));
  assert.equal(await store.read('project', summaryId(worktree, running.runId)), null);
  let status = await service.status();
  assert.equal(status.projected, 2);
  assert.equal(status.backfilled, 2);
  assert.equal(status.failures, 1);

  await service.backfill();
  assert.deepEqual(await store.list('project'), first);
  status = await service.status();
  assert.equal(status.projected, 2);
  assert.equal(status.backfilled, 2);
  assert.equal(status.failures, 2);
});

test('two bounded backfill passes project 65 terminal runs from successive pages', async () => {
  const runIds = Array.from({ length: 65 }, (_, index) => `paged-${String(index).padStart(3, '0')}`);
  const states = new Map(runIds.map((runId) => [runId, terminalRun({ runId })]));
  const entries = new Map();
  const offsets = [];
  const service = createJournalService({
    runStore: {
      async listRunIds(options) {
        const offset = options.offset ?? 0;
        offsets.push(offset);
        return runIds.slice(offset, offset + options.limit);
      },
      async loadRun(runId) { return states.get(runId) ?? null; },
    },
    journalStore: {
      async exists(scope, id) { return entries.has(`${scope}:${id}`); },
      async write(scope, entry) {
        entries.set(`${scope}:${entry.id}`, entry);
        return { created: true, entry };
      },
    },
    journalSearch: journalSearch(),
    worktree: 'C:\\workspace\\paged-project',
  });

  assert.deepEqual(await service.backfill(), { inspected: 64, projected: 64, skipped: 0, failures: 0 });
  assert.deepEqual(await service.backfill(), { inspected: 1, projected: 1, skipped: 0, failures: 0 });
  assert.deepEqual(offsets, [0, 64]);
  assert.equal(entries.size, 65);
  const status = await service.status();
  assert.equal(status.projected, 65);
  assert.equal(status.backfilled, 65);
});

test('backfill cursor ignores status scans and resets after listing errors and short pages', async () => {
  const fullPage = Array.from({ length: 64 }, (_, index) => `cursor-${String(index).padStart(3, '0')}`);
  const offsets = [];
  const statusOptions = [];
  let page = 0;
  const service = createJournalService({
    runStore: {
      async listRunIds(options) {
        if (!Object.hasOwn(options, 'offset')) {
          statusOptions.push(options);
          return [];
        }
        offsets.push(options.offset);
        page += 1;
        if (page === 1) return fullPage;
        if (page === 2) throw new Error('private listing failure');
        if (page === 3) return ['cursor-short'];
        return [];
      },
      async loadRun() { throw new Error('existing summaries must not load runs'); },
    },
    journalStore: {
      async exists() { return true; },
      async status() { return { project: { available: true } }; },
    },
    journalSearch: journalSearch(),
    worktree: 'C:\\workspace\\cursor-project',
  });

  assert.deepEqual(await service.backfill(), { inspected: 64, projected: 0, skipped: 64, failures: 0 });
  await service.status();
  assert.deepEqual(await service.backfill(), { inspected: 0, projected: 0, skipped: 0, failures: 1 });
  assert.deepEqual(await service.backfill(), { inspected: 1, projected: 0, skipped: 1, failures: 0 });
  assert.deepEqual(await service.backfill(), { inspected: 0, projected: 0, skipped: 0, failures: 0 });

  assert.deepEqual(offsets, [0, 64, 0, 0]);
  assert.deepEqual(statusOptions, [{ limit: 64 }]);
});

test('concurrent backfills single-flight one cursor page', async () => {
  let releaseListing;
  let markListingStarted;
  const listingStarted = new Promise((resolve) => { markListingStarted = resolve; });
  const listingGate = new Promise((resolve) => { releaseListing = resolve; });
  const offsets = [];
  const service = createJournalService({
    runStore: {
      async listRunIds(options) {
        offsets.push(options.offset ?? 0);
        markListingStarted();
        await listingGate;
        return [];
      },
      async loadRun() { return null; },
    },
    journalStore: {
      async exists() { return false; },
    },
    journalSearch: journalSearch(),
    worktree: 'C:\\workspace\\single-flight-project',
  });

  const first = service.backfill();
  await listingStarted;
  const second = service.backfill();
  releaseListing();
  const reports = await Promise.all([first, second]);

  assert.deepEqual(offsets, [0]);
  assert.deepEqual(reports, [
    { inspected: 0, projected: 0, skipped: 0, failures: 0 },
    { inspected: 0, projected: 0, skipped: 0, failures: 0 },
  ]);
});

test('search runs bounded backfill before delegating and read delegates directly', async () => {
  const state = terminalRun({ runId: 'search-backfill' });
  const calls = [];
  const runStore = {
    async listRunIds(options) { calls.push(['listRunIds', options]); return [state.runId, 'corrupt']; },
    async loadRun(runId) {
      calls.push(['loadRun', runId]);
      if (runId === 'corrupt') throw new Error('private request text at C:\\private\\run.json');
      return state;
    },
  };
  const entries = new Map();
  const journalStore = {
    async exists(scope, id) { calls.push(['exists', scope, id]); return entries.has(id); },
    async write(scope, entry) { calls.push(['write', scope, entry.id]); entries.set(entry.id, entry); return { created: true, entry }; },
    async read(scope, id) { calls.push(['read', scope, id]); return { scope, id }; },
    async status() { return { project: { available: true } }; },
  };
  const expected = { mode: 'metadata', hits: [] };
  const search = journalSearch({
    async search(args) { calls.push(['search', args]); return expected; },
  });
  const service = createJournalService({
    runStore,
    journalStore,
    journalSearch: search,
    worktree: 'C:\\workspace\\project',
  });
  const args = { scope: 'project', limit: 5 };

  assert.equal(await service.search(args), expected);
  assert.deepEqual(calls[0], ['listRunIds', { limit: 64, offset: 0 }]);
  assert.equal(calls.at(-1)[0], 'search');
  assert.equal(calls.at(-1)[1], args);
  assert.deepEqual(await service.read('project', 'a'.repeat(64)), { scope: 'project', id: 'a'.repeat(64) });
  const status = await service.status();
  assert.equal(status.backfilled, 1);
  assert.equal(status.failures, 1);
  assert.equal(JSON.stringify(status).includes('private request text'), false);
  assert.equal(JSON.stringify(status).includes('C:\\private'), false);
});

test('status bounds pending-backfill inspection, counts only missing terminal runs, and never projects', async () => {
  const secretRequest = 'pending-request-secret';
  const secretPath = 'C:\\private\\pending-run.json';
  const runIds = Array.from({ length: 65 }, (_, index) => `pending-${String(index).padStart(2, '0')}`);
  const loaded = [];
  let existenceChecks = 0;
  let writes = 0;
  const service = createJournalService({
    runStore: {
      async listRunIds(options) {
        assert.deepEqual(options, { limit: 64 });
        return runIds;
      },
      async loadRun(runId) {
        loaded.push(runId);
        if (runId === runIds[0]) throw new Error(`${secretRequest} at ${secretPath}`);
        return { runId, status: runId === runIds[2] ? 'RUNNING' : 'SUCCEEDED' };
      },
    },
    journalStore: {
      async exists() {
        const exists = existenceChecks === 1;
        existenceChecks += 1;
        return exists;
      },
      async write() { writes += 1; throw new Error('status projected a run'); },
      async status() {
        return {
          project: { available: true, entries: 1, corrupt: 0 },
          global: { available: true, entries: 0, corrupt: 0 },
          corruptionCount: 0,
        };
      },
    },
    journalSearch: journalSearch({ status() { return { semanticSearch: true, lastError: null }; } }),
    worktree: 'C:\\workspace\\pending-project',
  });

  const statusPromise = service.status();
  await assert.doesNotReject(statusPromise);
  const status = await statusPromise;
  const serialized = JSON.stringify(status);

  assert.deepEqual(status.pendingBackfill, { count: 61, inspected: 64, truncated: true });
  assert.equal(Object.isFrozen(status.pendingBackfill), true);
  assert.equal(Object.isFrozen(status), true);
  assert.equal(existenceChecks, 64);
  assert.equal(loaded.length, 63);
  assert.equal(loaded.includes(runIds[1]), false, 'an existing summary must not load its run');
  assert.equal(loaded.includes(runIds[64]), false, 'status must not inspect beyond 64 run ids');
  assert.equal(writes, 0);
  assert.equal(status.projected, 0);
  assert.equal(status.backfilled, 0);
  assert.equal(status.failures, 0);
  assert.equal(status.lastError, 'Journal pending backfill status unavailable');
  assert.equal(serialized.includes(secretRequest), false);
  assert.equal(serialized.includes(secretPath), false);
});

test('status safely degrades when the pending run listing has an invalid result', async () => {
  const secret = 'invalid-listing-request-secret at C:\\private\\runs';
  const service = createJournalService({
    runStore: {
      async listRunIds() { return null; },
      async loadRun() { throw new Error(secret); },
    },
    journalStore: {
      async exists() { throw new Error(secret); },
      async status() {
        return {
          project: { available: true, entries: 0, corrupt: 0 },
          global: { available: true, entries: 0, corrupt: 0 },
          corruptionCount: 0,
        };
      },
    },
    journalSearch: journalSearch(),
    worktree: 'C:\\workspace\\pending-project',
  });

  const status = await service.status();

  assert.deepEqual(status.pendingBackfill, { count: 0, inspected: 0, truncated: false });
  assert.equal(status.lastError, 'Journal pending backfill status unavailable');
  assert.equal(JSON.stringify(status).includes(secret), false);
});

test('graph status reports a pending terminal run without creating its summary or leaking run data', async (t) => {
  const { root, worktree, globalDirectory } = await roots(t, 'loop-journal-pending-status-');
  const runStore = createRunStore({ worktree });
  const request = 'pending terminal request must stay private';
  const state = terminalRun({ runId: 'pending-terminal', request: {
    text: request,
    truncated: false,
    redactions: 0,
    capturedAt: CREATED_AT,
  } });
  await persistRun(runStore, state);
  const hooks = await GraphPlugin({ worktree });

  const output = await hooks.tool.graph_status.execute({});
  const status = JSON.parse(output);

  assert.equal(status.journal.projectAvailable, true);
  assert.deepEqual(status.journal.pendingBackfill, { count: 1, inspected: 1, truncated: false });
  assert.equal(status.journal.project.entries, 0);
  assert.equal(status.journal.projected, 0);
  assert.equal(status.journal.backfilled, 0);
  const store = createJournalStore({ worktree, globalDirectory });
  assert.equal(await store.read('project', summaryId(worktree, state.runId)), null);
  assert.equal(output.includes(request), false);
  assert.equal(output.includes(root), false);
  assert.equal(output.includes(root.replaceAll('\\', '\\\\')), false);
});

test('worktree-unavailable journal service degrades without paths or request text', async () => {
  const secretPath = 'C:\\private\\missing-worktree';
  const secretRequest = 'Do not expose this request';
  let runListings = 0;
  let writes = 0;
  let searches = 0;
  const service = createJournalService({
    runStore: {
      async listRunIds() { runListings += 1; throw new Error(secretPath); },
      async loadRun() { throw new Error(secretRequest); },
    },
    journalStore: {
      async exists() { throw new Error(secretPath); },
      async write() { writes += 1; throw new Error(secretRequest); },
      async read(scope, id) { return { scope, id }; },
      async status() { throw new Error(`${secretPath}: ${secretRequest}`); },
    },
    journalSearch: {
      async search(args) { searches += 1; return { args }; },
      status() { throw new Error(`${secretRequest}: ${secretPath}`); },
    },
    worktree: null,
  });
  const terminal = terminalRun({
    runId: 'unavailable-worktree',
    request: {
      text: secretRequest,
      truncated: false,
      redactions: 0,
      capturedAt: CREATED_AT,
    },
  });

  await assert.doesNotReject(() => service.projectRun(terminal));
  await assert.doesNotReject(() => service.backfill());
  assert.deepEqual(await service.search({ scope: 'global' }), { args: { scope: 'global' } });
  const status = await service.status();

  assert.equal(runListings, 0);
  assert.equal(writes, 0);
  assert.equal(searches, 1);
  assert.equal(status.enabled, true);
  assert.equal(status.projectAvailable, false);
  assert.equal(typeof status.projected, 'number');
  assert.equal(typeof status.backfilled, 'number');
  assert.equal(typeof status.failures, 'number');
  assert.ok(Object.hasOwn(status, 'lastError'));
  assert.ok(Object.hasOwn(status, 'store'));
  assert.ok(Object.hasOwn(status, 'search'));
  assert.deepEqual(status.pendingBackfill, { count: 0, inspected: 0, truncated: false });
  assert.equal(JSON.stringify(status).includes(secretPath), false);
  assert.equal(JSON.stringify(status).includes(secretRequest), false);
});

test('plugin composition projects terminal saves and exposes Task 5 journal tools', async (t) => {
  const { worktree, globalDirectory } = await roots(t, 'loop-journal-plugin-');
  const hooks = await GraphPlugin({ worktree });
  const sessionID = 'plugin-root';
  const specs = [
    { id: 'explore-1', kind: 'explore', agent: 'graph-explorer', dependsOn: [], inputs: [], outputs: [], acceptance: ['evidence'] },
    { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: ['explore-1'], inputs: [], outputs: [], acceptance: ['plan'] },
    { id: 'review-1', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['plan-1'], inputs: [], outputs: [], acceptance: ['review'] },
  ];
  const context = (child, agent) => ({
    sessionID: child,
    messageID: 'message',
    agent,
    directory: worktree,
    worktree,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  });
  async function dispatch(agent, child) {
    const output = { args: { description: `dispatch ${agent}`, prompt: 'work', subagent_type: agent } };
    await hooks['tool.execute.before']({ tool: 'task', sessionID, callID: `call-${agent}` }, output);
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: child, parentID: sessionID } } } });
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: {
      type: 'tool', tool: 'task', sessionID, callID: `call-${agent}`,
      state: { status: 'running', input: { subagent_type: agent }, metadata: { parentSessionId: sessionID, sessionId: child } },
    } } } });
  }

  await hooks['chat.message'](
    { sessionID, agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'Produce a reviewed plan' }] },
  );
  await dispatch('graph-planner', 'plugin-planner');
  const plan = JSON.parse(await hooks.tool.graph_submit_plan.execute(
    { intent: 'plan-only', specs },
    context('plugin-planner', 'graph-planner'),
  ));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch('graph-plan-critic', 'plugin-critic');
  const review = JSON.parse(await hooks.tool.graph_submit_review.execute(
    { planVersion: 1, verdict: 'PASS', findings: [] },
    context('plugin-critic', 'graph-plan-critic'),
  ));
  assert.equal(review.ok, true, JSON.stringify(review));

  const store = createJournalStore({ worktree, globalDirectory });
  const entry = await store.read('project', summaryId(worktree, sessionID));
  assert.equal(entry.metadata.status, 'SUCCEEDED');
  assert.equal(entry.metadata.intent, 'plan-only');
  assert.equal(entry.title, 'Produce a reviewed plan');
  assert.deepEqual(Object.keys(hooks.tool).filter((name) => name.startsWith('graph_journal_')).sort(), [
    'graph_journal_promote',
    'graph_journal_read',
    'graph_journal_search',
    'graph_journal_write_insight',
  ]);
  assert.deepEqual(await readdir(join(worktree, '.opencode-loop', 'journal', 'entries')), [`${entry.id}.md`]);
  assert.match(await readFile(join(worktree, '.opencode-loop', 'runs', `${sessionID}.json`), 'utf8'), /"status": "SUCCEEDED"/);
});
