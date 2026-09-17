import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createJournalStore, stableJournalId } from '../src/journal-store.mjs';
import { createRunStore, newRun } from '../src/run-state.mjs';
import { createJournalService, createJournaledRunStore } from '../src/journal.mjs';
import { createLessonService, formatLessonsBlock, LESSON_KINDS, normalizeLessonText } from '../src/lessons.mjs';
import { createLessonTools } from '../src/lesson-tools.mjs';

const CREATED_AT = '2026-09-10T10:00:00.000Z';
const FINISHED_AT = '2026-09-10T10:30:00.000Z';
const LATER_AT = '2026-09-11T09:00:00.000Z';

async function roots(t, prefix = 'loop-lessons-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const worktree = join(root, 'project');
  const globalDirectory = join(root, 'global', 'lessons', 'entries');
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, globalDirectory };
}

function searchStub(overrides = {}) {
  return {
    async search(args) { return { mode: 'metadata', hits: [], delegated: args }; },
    status() { return { mode: 'test', lastError: null }; },
    ...overrides,
  };
}

function projectKey(worktree) {
  return stableJournalId('project', resolve(worktree));
}

function observationId(worktree, runId, text) {
  return stableJournalId('lesson-observation', projectKey(worktree), runId, stableJournalId(normalizeLessonText(text)));
}

function lessonRun({ runId = 'run-with-lessons', status = 'SUCCEEDED', learnings = [], verification = null, violations = [], updatedAt = FINISHED_AT } = {}) {
  const state = newRun({ runId, rootSessionId: runId, now: CREATED_AT, request: null, requestCaptureCompleted: true });
  state.mode = 'change';
  state.status = status;
  state.updatedAt = updatedAt;
  state.artifacts = {};
  if (learnings.length) {
    state.artifacts.findings = {
      kind: 'findings', nodeId: 'free', version: 1, basedOn: [],
      payload: { summary: 'explored', evidence: [], learnings },
      status: 'valid', createdAt: CREATED_AT,
    };
  }
  if (verification !== null) {
    state.artifacts['verification:verify-1'] = {
      kind: 'verification', nodeId: 'verify-1', version: 1, basedOn: [],
      payload: verification, status: 'valid', createdAt: updatedAt,
    };
  }
  state.violations = violations;
  return state;
}

async function persistRun(runStore, state) {
  const registered = await runStore.createRun({
    runId: state.runId,
    rootSessionId: state.rootSessionId,
    now: state.createdAt,
    request: state.request,
    requestCaptureCompleted: true,
  });
  Object.assign(registered, structuredClone(state));
  await runStore.saveRun(registered);
  await runStore.releaseRun(state.runId);
}

async function lessonHarness(t, { enabled = true } = {}) {
  const { worktree, globalDirectory } = await roots(t);
  const runStore = createRunStore({ worktree });
  const lessonStore = createJournalStore({ worktree, globalDirectory, subdirectory: 'lessons', kinds: LESSON_KINDS });
  const service = createLessonService({ runStore, lessonStore, lessonSearch: searchStub(), enabled, worktree });
  return { worktree, globalDirectory, runStore, lessonStore, service };
}

test('lesson store instance writes under a separate directory and rejects foreign kinds', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const journalStore = createJournalStore({ worktree });
  const lessonStore = createJournalStore({ worktree, globalDirectory, subdirectory: 'lessons', kinds: LESSON_KINDS });

  const entry = {
    schemaVersion: 1,
    id: stableJournalId('lesson-observation', projectKey(worktree), 'run-x', 'fingerprint'),
    scope: 'project',
    kind: 'lesson-observation',
    title: 'Observation',
    createdAt: FINISHED_AT,
    tags: ['failure'],
    sourceIds: [],
    metadata: { category: 'failure' },
    body: 'Something failed',
  };
  await lessonStore.write('project', entry);
  await assert.rejects(() => lessonStore.write('project', { ...entry, id: stableJournalId('x', 'run-summary'), kind: 'run-summary' }), /not permitted/);
  await assert.rejects(() => journalStore.write('project', entry), /not permitted/);

  const journalNames = await readdir(join(worktree, '.opencode-loop', 'journal', 'entries')).catch(() => []);
  const lessonNames = await readdir(join(worktree, '.opencode-loop', 'lessons', 'entries')).catch(() => []);
  assert.equal(journalNames.length, 0);
  assert.equal(lessonNames.length, 1);
  assert.equal(lessonNames[0], `${entry.id}.md`);
});

test('projection harvests learnings, failed verifications and violations, and is idempotent', async (t) => {
  const { worktree, runStore, lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({
    runId: 'harvest-run',
    learnings: ['Cache directory must be pinned before uv runs', 'Second durable lesson'],
    verification: {
      verdict: 'FAIL',
      commands: [{ command: 'npm test', exitCode: 1 }],
      summary: 'suite failed after change',
      artifacts: [], probed: [], skipped: [],
    },
    violations: [{ nodeId: 'impl-1', kind: 'out-of-scope-edit', detail: 'write outside scope', at: FINISHED_AT }],
  });
  await persistRun(runStore, state);

  const first = await service.projectLessons(state);
  assert.equal(first.created, 4);
  assert.equal(first.reason, 'projected');

  const second = await service.projectLessons(state);
  assert.equal(second.created, 0);

  const observation = await lessonStore.read('project', observationId(worktree, 'harvest-run', 'Cache directory must be pinned before uv runs'));
  assert.equal(observation.kind, 'lesson-observation');
  assert.equal(observation.metadata.category, 'learning');
  assert.equal(observation.metadata.source, 'findings');
  assert.deepEqual(observation.sourceIds, [stableJournalId('run-summary', projectKey(worktree), 'harvest-run')]);

  const failure = await lessonStore.read('project', observationId(worktree, 'harvest-run', 'Verification FAIL on node verify-1: suite failed after change — failing commands: npm test'));
  assert.equal(failure.metadata.category, 'failure');
  assert.equal(failure.metadata.source, 'verification:verification:verify-1');

  const violation = await lessonStore.read('project', observationId(worktree, 'harvest-run', 'out-of-scope-edit: write outside scope'));
  assert.equal(violation.metadata.category, 'violation');
});

test('projection skips nonterminal runs and redacts secrets in observation text', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const running = lessonRun({ runId: 'running-run', status: 'RUNNING', learnings: ['lesson while running'] });
  assert.equal((await service.projectLessons(running)).reason, 'nonterminal');

  const secretRun = lessonRun({ runId: 'secret-run', learnings: ['Deploy token=super-secret-value must rotate monthly'] });
  await service.projectLessons(secretRun);
  const observation = await lessonStore.read('project', observationId(worktree, 'secret-run', 'Deploy token=[REDACTED]'));
  assert.ok(observation.body.includes('[REDACTED]'));
  assert.ok(!observation.body.includes('super-secret-value'));
});

test('identical normalized lessons consolidate across runs with occurrence counts', async (t) => {
  const { worktree, runStore, service } = await lessonHarness(t);
  const text = 'UV cache must   be pinned inside writeScope';
  const firstRun = lessonRun({ runId: 'run-a', learnings: [text], updatedAt: FINISHED_AT });
  const secondRun = lessonRun({ runId: 'run-b', learnings: [normalizeLessonText(text)], updatedAt: LATER_AT });
  await service.projectLessons(firstRun);
  await service.projectLessons(secondRun);
  void runStore;

  const relevant = await service.relevantLessons({ text: 'uv cache pinned', paths: [], limit: 4 });
  const match = relevant.find((lesson) => lesson.occurrences === 2);
  assert.ok(match, 'consolidated lesson appears with two occurrences');
  assert.equal(match.kind, 'lesson-observation');
  assert.deepEqual(match.text, 'UV cache must be pinned inside writeScope');

  const search = await service.search({});
  assert.equal(search.consolidated.length, 1);
  assert.equal(search.consolidated[0].occurrences, 2);
  assert.deepEqual([...search.consolidated[0].runIds].sort(), ['run-a', 'run-b']);
  assert.equal(search.consolidated[0].firstSeen, FINISHED_AT);
  assert.equal(search.consolidated[0].lastSeen, LATER_AT);
  void worktree;
});

test('relevantLessons ranks write-scope path overlap and respects the limit', async (t) => {
  const { service } = await lessonHarness(t);
  await service.projectLessons(lessonRun({ runId: 'rank-1', learnings: ['The src/legacy/auth.py module rejects tokens without clock skew'], updatedAt: FINISHED_AT }));
  await service.projectLessons(lessonRun({ runId: 'rank-2', learnings: ['Documentation should stay terse'], updatedAt: LATER_AT }));

  const ranked = await service.relevantLessons({ text: 'refresh the auth flow', paths: ['src/legacy/auth.py'], limit: 1 });
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].text.includes('src/legacy/auth.py'));
});

test('formatLessonsBlock renders bounded historical context with occurrence markers', () => {
  const block = formatLessonsBlock([
    { category: 'pitfall', text: 'A'.repeat(400), occurrences: 3 },
    { category: 'surprise', text: 'short lesson', occurrences: 1 },
  ]);
  assert.ok(block.startsWith('[RUNNER] Known project lessons'));
  assert.ok(block.includes('[pitfall x3]'));
  assert.ok(block.includes('[surprise]'));
  assert.ok(block.includes('re-validate'));
  const padded = block.split('\n')[1];
  assert.ok(padded.length <= 240 + '- [pitfall x3] '.length + 3, 'injection lines stay bounded');
  assert.equal(formatLessonsBlock([]), null);
});

test('curated lessons validate category and observation links, terminal runs only', async (t) => {
  const { worktree, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'curate-run', learnings: ['repeated mistake observed'] });
  await service.projectLessons(state);

  const observation = observationId(worktree, 'curate-run', 'repeated mistake observed');
  const result = await service.recordLesson(state, {
    title: 'Auth token refresh needs clock skew',
    body: 'Rule: always allow 30s skew when refreshing tokens.\nTrigger: legacy auth module.',
    category: 'repeated-mistake',
    tags: ['auth'],
    observationIds: [observation],
  });
  assert.equal(result.created, true);
  const stored = await (async () => {
    const listed = await service.search({ kinds: ['lesson'] });
    return listed;
  })();
  assert.equal(stored.delegated.kinds.length, 1);

  await assert.rejects(() => service.recordLesson(state, { title: 'x', body: 'y', category: 'unknown', tags: [] }), (error) => error.code === 'LESSON_INVALID_CATEGORY');
  await assert.rejects(() => service.recordLesson(state, { title: 'x', body: 'y', category: 'pitfall', tags: [], observationIds: ['z'.repeat(64)] }), (error) => error.code === 'LESSON_NOT_FOUND');
  const running = lessonRun({ runId: 'running', status: 'RUNNING' });
  await assert.rejects(() => service.recordLesson(running, { title: 'x', body: 'y', category: 'pitfall', tags: [] }), (error) => error.code === 'LESSON_RUN_NOT_TERMINAL');
});

test('promotion refuses project leakage and writes neutral content globally', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'promote-run', learnings: ['something about src/private/module.py'] });
  await service.projectLessons(state);
  const lesson = await service.recordLesson(state, {
    title: 'Private project lesson',
    body: 'The src/private/module.py path breaks imports',
    category: 'pitfall',
    tags: [],
  });
  assert.equal(lesson.created, true);

  await assert.rejects(() => service.promoteLesson({
    lessonId: lesson.entry.id,
    title: 'Generic lesson',
    body: 'Avoid the file at src/private/module.py',
    tags: [],
  }), (error) => error.code === 'LESSON_METADATA_LEAK');

  const promoted = await service.promoteLesson({
    lessonId: lesson.entry.id,
    title: 'Watch for path-dependent imports',
    body: 'Modules resolved through private paths can break imports; verify resolution from a clean checkout.',
    tags: ['imports'],
  });
  assert.equal(promoted.created, true);
  const global = await lessonStore.read('global', promoted.entry.id);
  assert.equal(global.kind, 'promoted-lesson');
  assert.equal(global.metadata.originKind, 'lesson');
  await assert.rejects(() => service.promoteLesson({ lessonId: 'c'.repeat(64), title: 'x', body: 'y', tags: [] }), (error) => error.code === 'LESSON_NOT_FOUND');
});

test('journaled run store projects lessons alongside run summaries on terminal saves', async (t) => {
  const { worktree, globalDirectory } = await roots(t);
  const runStore = createRunStore({ worktree });
  const journalStore = createJournalStore({ worktree, globalDirectory });
  const lessonStore = createJournalStore({ worktree, globalDirectory, subdirectory: 'lessons', kinds: LESSON_KINDS });
  const journalService = createJournalService({ runStore, journalStore, journalSearch: searchStub(), worktree });
  const lessonService = createLessonService({ runStore, lessonStore, lessonSearch: searchStub(), worktree });
  const store = createJournaledRunStore(runStore, journalService, lessonService);

  const state = await store.createRun({ runId: 'wired-run', rootSessionId: 'wired-run', now: CREATED_AT, request: null, requestCaptureCompleted: true });
  state.status = 'SUCCEEDED';
  state.updatedAt = FINISHED_AT;
  state.artifacts.findings = {
    kind: 'findings', nodeId: 'free', version: 1, basedOn: [],
    payload: { summary: 'explored', evidence: [], learnings: ['wired lesson'] },
    status: 'valid', createdAt: CREATED_AT,
  };
  await store.saveRun(state);

  const observation = await lessonStore.read('project', observationId(worktree, 'wired-run', 'wired lesson'));
  assert.equal(observation.kind, 'lesson-observation');
  const summary = await journalStore.read('project', stableJournalId('run-summary', projectKey(worktree), 'wired-run'));
  assert.equal(summary.kind, 'run-summary');
});

test('lesson tools enforce roles, root binding and terminal state', async (t) => {
  const { worktree, runStore, lessonStore, service } = await lessonHarness(t);
  const state = await runStore.createRun({ runId: 'tools-run', rootSessionId: 'tools-run', now: CREATED_AT, request: null, requestCaptureCompleted: true });
  state.status = 'SUCCEEDED';
  state.updatedAt = FINISHED_AT;
  // Persist the terminal transition: the explorer search below backfills
  // from disk, and a loadRun of the stale RUNNING state would shadow the
  // live registration.
  await runStore.saveRun(state);
  const bindings = new Map([
    ['tools-run', { runId: 'tools-run', agent: 'graph-orchestrator', nodeId: null, root: true }],
    ['explorer-session', { runId: 'tools-run', agent: 'graph-explorer', nodeId: null, root: false }],
  ]);
  const tools = createLessonTools({ lessonService: service, store: runStore, bindings, enabled: true });

  const context = (sessionID, agent) => ({ sessionID, agent });
  const denied = JSON.parse(await tools.graph_lesson_search.execute({}, context('other-session', 'graph-orchestrator')));
  assert.equal(denied.code, 'NOT_GRAPH_SESSION');
  const wrongRole = JSON.parse(await tools.graph_lesson_search.execute({}, context('tools-run', 'graph-implementer')));
  assert.equal(wrongRole.code, 'WRONG_ROLE');
  const explorer = JSON.parse(await tools.graph_lesson_search.execute({ kinds: ['lesson'] }, context('explorer-session', 'graph-explorer')));
  assert.equal(explorer.ok, true);

  const terminal = JSON.parse(await tools.graph_lesson_record.execute(
    { title: 'Title', body: 'Body', category: 'surprise', tags: [], observationIds: [] },
    context('tools-run', 'graph-orchestrator'),
  ));
  assert.equal(terminal.ok, true);

  const running = await runStore.createRun({ runId: 'tools-running', rootSessionId: 'tools-running', now: CREATED_AT, request: null, requestCaptureCompleted: true });
  running.status = 'RUNNING';
  bindings.set('tools-running', { runId: 'tools-running', agent: 'graph-orchestrator', nodeId: null, root: true });
  const notTerminal = JSON.parse(await tools.graph_lesson_record.execute(
    { title: 'Title', body: 'Body', category: 'surprise', tags: [], observationIds: [] },
    context('tools-running', 'graph-orchestrator'),
  ));
  assert.equal(notTerminal.code, 'LESSON_RUN_NOT_TERMINAL');
  void lessonStore;
  void worktree;
});
