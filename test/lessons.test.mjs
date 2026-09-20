import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tool } from '@opencode-ai/plugin/tool';
import { createJournalStore, JOURNAL_SCHEMA_VERSION, stableJournalId } from '../src/journal-store.mjs';
import { MAX_AUTHORED_BODY_INPUT_CHARS, MAX_INDEXED_TEXT_CHARS } from '../src/journal-text.mjs';
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

function legacyEntry(kind, partial) {
  return { ...partial, id: stableJournalId(kind, partial) };
}

function redactionExpandedAstralBoundary(limit) {
  const inputPrefix = 'token=x,';
  const redactedPrefix = 'token=[REDACTED],';
  const filler = 't'.repeat(limit - redactedPrefix.length - 1);
  return {
    input: `${inputPrefix}${filler}😀`,
    safe: `${redactedPrefix}${filler}`,
    legacy: `${redactedPrefix}${filler}\uD83D`,
  };
}

function legacyObservation(worktree, {
  runId,
  body,
  category,
  source,
  createdAt = FINISHED_AT,
}) {
  const fingerprint = stableJournalId(normalizeLessonText(body));
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: stableJournalId('lesson-observation', projectKey(worktree), runId, fingerprint),
    scope: 'project',
    kind: 'lesson-observation',
    title: body.slice(0, 200).replace(/\s+/g, ' ').trim(),
    createdAt,
    tags: [category],
    sourceIds: [stableJournalId('run-summary', projectKey(worktree), runId)],
    metadata: { projectKey: projectKey(worktree), runId, category, fingerprint, source },
    body,
  };
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

async function lessonToolHarness(t, runId) {
  const harness = await lessonHarness(t);
  const state = await harness.runStore.createRun({
    runId,
    rootSessionId: runId,
    now: CREATED_AT,
    request: null,
    requestCaptureCompleted: true,
  });
  state.mode = 'change';
  state.status = 'SUCCEEDED';
  state.updatedAt = FINISHED_AT;
  const bindings = new Map([[runId, { runId, agent: 'graph-orchestrator', nodeId: null, root: true }]]);
  const tools = createLessonTools({ lessonService: harness.service, store: harness.runStore, bindings, enabled: true });
  return { ...harness, state, tools, context: { sessionID: runId, agent: 'graph-orchestrator' } };
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
  for (const entry of await lessonStore.list('project')) {
    assert.ok(`${entry.title}\n\n${entry.body}`.length <= MAX_INDEXED_TEXT_CHARS, `${entry.id} exceeded the indexed-text boundary`);
  }
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

test('lesson projection skips an ill-formed optional learning without losing valid observations', async (t) => {
  const { lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'ill-formed-optional-learning', learnings: ['valid lesson', 'bad\uD800'] });

  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');

  assert.equal(result.created, 1);
  assert.equal(result.failed, undefined);
  assert.deepEqual(entries.map((entry) => entry.body), ['valid lesson']);
});

test('lesson verification command truncation preserves astral characters and fingerprint identity', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const command = `${'c'.repeat(199)}😀`;
  const state = lessonRun({
    runId: 'astral-command-observation',
    learnings: ['unrelated valid lesson'],
    verification: {
      verdict: 'FAIL',
      commands: [{ command, exitCode: 1 }],
      summary: 'boundary failure',
    },
  });
  state.artifacts['verification:verify-bad'] = {
    kind: 'verification', nodeId: 'verify-bad', version: 1, basedOn: [],
    payload: {
      verdict: 'FAIL',
      commands: [{ command: 'bad\uD800', exitCode: 1 }],
      summary: 'malformed optional command',
    },
    status: 'valid', createdAt: FINISHED_AT,
  };
  const expectedBody = `Verification FAIL on node verify-1: boundary failure — failing commands: ${'c'.repeat(199)}`;

  const result = await service.projectLessons(state);
  const observation = await lessonStore.read(
    'project',
    observationId(worktree, state.runId, expectedBody),
  );

  assert.equal(result.created, 2);
  assert.ok(observation);
  assert.equal(observation.body, expectedBody);
  assert.equal(observation.body.isWellFormed(), true);
  assert.equal(observation.metadata.fingerprint, stableJournalId(normalizeLessonText(observation.body)));
  assert.deepEqual(
    (await lessonStore.list('project')).map((entry) => entry.body).sort(),
    [expectedBody, 'unrelated valid lesson'].sort(),
  );
});

test('lesson projection reuses the exact pre-fix unsafe command observation without duplicating consolidation', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const command = `${'c'.repeat(199)}😀`;
  const state = lessonRun({
    runId: 'legacy-command-observation',
    learnings: ['unrelated valid lesson'],
    verification: {
      verdict: 'FAIL',
      commands: [{ command, exitCode: 1 }],
      summary: 'boundary failure',
    },
  });
  const prefix = 'Verification FAIL on node verify-1: boundary failure — failing commands: ';
  const legacyBody = `${prefix}${command.slice(0, 200)}`;
  const persistedLegacyBody = legacyBody.toWellFormed();
  const legacyFingerprint = stableJournalId(normalizeLessonText(legacyBody));
  const legacy = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: stableJournalId('lesson-observation', projectKey(worktree), state.runId, legacyFingerprint),
    scope: 'project',
    kind: 'lesson-observation',
    title: legacyBody.slice(0, 200),
    createdAt: FINISHED_AT,
    tags: ['failure'],
    sourceIds: [stableJournalId('run-summary', projectKey(worktree), state.runId)],
    metadata: {
      projectKey: projectKey(worktree),
      runId: state.runId,
      category: 'failure',
      fingerprint: legacyFingerprint,
      source: 'verification:verification:verify-1',
    },
    body: legacyBody,
  };
  assert.equal(legacyBody.isWellFormed(), false);
  await lessonStore.write('project', legacy);
  assert.equal((await lessonStore.read('project', legacy.id)).body, persistedLegacyBody);

  const currentBody = `${prefix}${'c'.repeat(199)}`;
  const currentId = observationId(worktree, state.runId, currentBody);
  assert.notEqual(currentId, legacy.id);

  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');
  const failures = entries.filter((entry) => entry.metadata?.category === 'failure');
  const consolidated = await service.consolidatedTop();
  const consolidatedFailures = consolidated.filter((entry) => entry.category === 'failure');

  assert.equal(result.created, 1, 'only the unrelated valid lesson is new');
  assert.deepEqual(failures.map((entry) => entry.id), [legacy.id]);
  assert.equal(failures[0].body, persistedLegacyBody);
  assert.equal(await lessonStore.read('project', currentId), null);
  assert.equal(consolidatedFailures.length, 1);
  assert.equal(consolidatedFailures[0].fingerprint, legacyFingerprint);
  assert.equal(consolidatedFailures[0].occurrences, 1);
  assert.ok(entries.some((entry) => entry.body === 'unrelated valid lesson'));
});

test('lesson projection reuses a historical learning truncated through an astral pair', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const learning = `${'l'.repeat(999)}😀`;
  const state = lessonRun({ runId: 'legacy-learning-observation', learnings: [learning] });
  const legacyBody = learning.slice(0, 1000);
  const legacy = legacyObservation(worktree, {
    runId: state.runId,
    body: legacyBody,
    category: 'learning',
    source: 'findings',
  });
  assert.equal(legacyBody.isWellFormed(), false);
  await lessonStore.write('project', legacy);
  assert.equal((await lessonStore.read('project', legacy.id)).body, legacyBody.toWellFormed());

  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');
  const consolidated = await service.consolidatedTop();

  assert.equal(result.created, 0);
  assert.deepEqual(entries.map((entry) => entry.id), [legacy.id]);
  assert.equal(await lessonStore.read('project', observationId(worktree, state.runId, 'l'.repeat(999))), null);
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].fingerprint, legacy.metadata.fingerprint);
  assert.equal(consolidated[0].occurrences, 1);
});

test('lesson projection reconstructs historical verification summary and final-body truncation fingerprints', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const summary = redactionExpandedAstralBoundary(400);
  const state = lessonRun({
    runId: 'legacy-verification-sanitizers',
    verification: { verdict: 'FAIL', commands: [], summary: summary.input },
  });
  const summaryBody = `Verification FAIL on node verify-1: ${summary.legacy}`;
  const summaryLegacy = legacyObservation(worktree, {
    runId: state.runId,
    body: summaryBody,
    category: 'failure',
    source: 'verification:verification:verify-1',
  });

  const capSummary = 's'.repeat(400);
  const capPrefix = `Verification FAIL on node verify-cap: ${capSummary} — failing commands: `;
  const capFillerLength = 999 - (capPrefix.length + 200 + 2 + 200 + 2);
  const capCommands = [
    'a'.repeat(200),
    'b'.repeat(200),
    `${'c'.repeat(capFillerLength)}😀`,
  ];
  const unboundedCapBody = `${capPrefix}${capCommands.join('; ')}`;
  assert.equal(unboundedCapBody.length, 1001);
  const capBody = unboundedCapBody.slice(0, 1000);
  const capLegacy = legacyObservation(worktree, {
    runId: state.runId,
    body: capBody,
    category: 'failure',
    source: 'verification:verification:verify-cap',
  });
  state.artifacts['verification:verify-cap'] = {
    kind: 'verification', nodeId: 'verify-cap', version: 1, basedOn: [],
    payload: { verdict: 'FAIL', commands: capCommands.map((command) => ({ command, exitCode: 1 })), summary: capSummary },
    status: 'valid', createdAt: FINISHED_AT,
  };

  for (const entry of [summaryLegacy, capLegacy]) await lessonStore.write('project', entry);
  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');

  assert.equal(result.created, 0);
  assert.deepEqual(entries.map((entry) => entry.id).sort(), [summaryLegacy.id, capLegacy.id].sort());
  assert.equal((await service.consolidatedTop()).length, 2);
});

test('lesson projection replays an exact multi-replacement violation but excludes it from consolidation', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const kind = redactionExpandedAstralBoundary(128);
  const detail = redactionExpandedAstralBoundary(600);
  const state = lessonRun({
    runId: 'legacy-violation-sanitizers',
    violations: [{ nodeId: 'impl-1', kind: kind.input, detail: detail.input, at: FINISHED_AT }],
  });
  const legacyBody = `${kind.legacy}: ${detail.legacy}`;
  const legacy = legacyObservation(worktree, {
    runId: state.runId,
    body: legacyBody,
    category: 'violation',
    source: 'violations',
  });
  await lessonStore.write('project', legacy);

  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');

  assert.equal(result.created, 0);
  assert.deepEqual(entries.map((entry) => entry.id), [legacy.id]);
  assert.equal(entries[0].body.split('\uFFFD').length - 1, 2);
  assert.equal((await service.consolidatedTop()).length, 0);
});

test('legacy fingerprint aliases consolidate a historical and corrected learning across runs', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const learning = `${'l'.repeat(999)}😀`;
  const firstRun = lessonRun({ runId: 'legacy-alias-run-a', learnings: [learning], updatedAt: FINISHED_AT });
  const secondRun = lessonRun({ runId: 'legacy-alias-run-b', learnings: [learning], updatedAt: LATER_AT });
  const legacy = legacyObservation(worktree, {
    runId: firstRun.runId,
    body: learning.slice(0, 1000),
    category: 'learning',
    source: 'findings',
    createdAt: FINISHED_AT,
  });
  await lessonStore.write('project', legacy);

  const result = await service.projectLessons(secondRun);
  const current = await lessonStore.read('project', observationId(worktree, secondRun.runId, 'l'.repeat(999)));
  const consolidated = await service.consolidatedTop();

  assert.equal(result.created, 1);
  assert.ok(current);
  assert.equal(current.metadata.legacyFingerprint, legacy.metadata.fingerprint);
  assert.equal(current.metadata.fingerprint, stableJournalId(normalizeLessonText(current.body)));
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].fingerprint, legacy.metadata.fingerprint);
  assert.equal(consolidated[0].occurrences, 2);
  assert.deepEqual([...consolidated[0].runIds].sort(), [firstRun.runId, secondRun.runId].sort());
});

test('consolidation ignores a forged legacy fingerprint alias on a valid current observation', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const alpha = legacyObservation(worktree, {
    runId: 'forged-alias-alpha',
    body: 'alpha',
    category: 'learning',
    source: 'findings',
    createdAt: FINISHED_AT,
  });
  const betaBase = legacyObservation(worktree, {
    runId: 'forged-alias-beta',
    body: 'beta',
    category: 'learning',
    source: 'findings',
    createdAt: LATER_AT,
  });
  const beta = {
    ...betaBase,
    metadata: { ...betaBase.metadata, legacyFingerprint: alpha.metadata.fingerprint },
  };
  await lessonStore.write('project', alpha);
  await lessonStore.write('project', beta);

  const consolidated = await service.consolidatedTop();
  const byText = new Map(consolidated.map((entry) => [entry.text, entry]));

  assert.equal(consolidated.length, 2);
  assert.equal(byText.get('alpha')?.occurrences, 1);
  assert.equal(byText.get('beta')?.occurrences, 1);
});

test('consolidation proves one-surrogate history and ignores a forged replacement fingerprint', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const alpha = legacyObservation(worktree, {
    runId: 'replacement-proof-alpha',
    body: 'alpha',
    category: 'learning',
    source: 'findings',
    createdAt: FINISHED_AT,
  });
  const beta = legacyObservation(worktree, {
    runId: 'replacement-proof-beta',
    body: 'beta',
    category: 'learning',
    source: 'findings',
    createdAt: LATER_AT,
  });
  const forgedBase = legacyObservation(worktree, {
    runId: 'replacement-proof-forged',
    body: 'alpha\uFFFD',
    category: 'learning',
    source: 'findings',
    createdAt: LATER_AT,
  });
  const forged = {
    ...forgedBase,
    id: stableJournalId(
      'lesson-observation',
      projectKey(worktree),
      forgedBase.metadata.runId,
      beta.metadata.fingerprint,
    ),
    metadata: { ...forgedBase.metadata, fingerprint: beta.metadata.fingerprint },
  };

  const unsafeHistoricalBody = 'gamma\uD83D';
  const historical = legacyObservation(worktree, {
    runId: 'replacement-proof-historical',
    body: unsafeHistoricalBody,
    category: 'learning',
    source: 'findings',
    createdAt: FINISHED_AT,
  });
  const corrected = legacyObservation(worktree, {
    runId: 'replacement-proof-corrected',
    body: 'gamma',
    category: 'learning',
    source: 'findings',
    createdAt: LATER_AT,
  });

  for (const entry of [alpha, beta, forged, historical, corrected]) {
    await lessonStore.write('project', entry);
  }
  assert.equal((await lessonStore.read('project', historical.id)).body, 'gamma\uFFFD');

  const consolidated = await service.consolidatedTop();
  const relevant = await service.relevantLessons({ text: 'alpha beta gamma', limit: 8 });
  const consolidatedIds = consolidated.map((entry) => entry.fingerprint);
  const relevantIds = relevant.map((entry) => entry.id);

  assert.equal(consolidated.length, 3);
  assert.equal(new Set(consolidatedIds).size, 3);
  assert.equal(new Set(relevantIds).size, 3);
  assert.deepEqual(
    consolidatedIds.sort(),
    [alpha.metadata.fingerprint, beta.metadata.fingerprint, historical.metadata.fingerprint].sort(),
  );
  assert.deepEqual([...relevantIds].sort(), [...consolidatedIds].sort());
  assert.equal(consolidated.find((entry) => entry.fingerprint === alpha.metadata.fingerprint)?.occurrences, 1);
  assert.equal(consolidated.find((entry) => entry.fingerprint === beta.metadata.fingerprint)?.occurrences, 1);
  assert.equal(consolidated.find((entry) => entry.fingerprint === historical.metadata.fingerprint)?.occurrences, 2);
});

test('legacy fingerprint equivalence does not fragment identical corrected observations', async (t) => {
  const { lessonStore, service } = await lessonHarness(t);
  const safeBody = 'l'.repeat(999);
  const firstLearning = `${safeBody}😀`;
  const secondLearning = `${safeBody}\u{10000}`;
  const firstRun = lessonRun({ runId: 'legacy-equivalence-run-a', learnings: [firstLearning], updatedAt: FINISHED_AT });
  const secondRun = lessonRun({ runId: 'legacy-equivalence-run-b', learnings: [secondLearning], updatedAt: LATER_AT });
  assert.equal(firstLearning.isWellFormed(), true);
  assert.equal(secondLearning.isWellFormed(), true);

  await service.projectLessons(firstRun);
  await service.projectLessons(secondRun);

  const entries = await lessonStore.list('project');
  const currentFingerprint = stableJournalId(normalizeLessonText(safeBody));
  const aliases = entries.map((entry) => entry.metadata.legacyFingerprint).sort();
  const expectedAliases = [
    stableJournalId(normalizeLessonText(firstLearning.slice(0, 1000))),
    stableJournalId(normalizeLessonText(secondLearning.slice(0, 1000))),
  ].sort();
  const consolidated = await service.consolidatedTop();

  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.body === safeBody));
  assert.ok(entries.every((entry) => entry.metadata.fingerprint === currentFingerprint));
  assert.deepEqual(aliases, expectedAliases);
  assert.notEqual(aliases[0], aliases[1]);
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].fingerprint, currentFingerprint);
  assert.equal(consolidated[0].occurrences, 2);
  assert.equal(consolidated[0].firstSeen, FINISHED_AT);
  assert.equal(consolidated[0].lastSeen, LATER_AT);
  assert.deepEqual([...consolidated[0].runIds].sort(), [firstRun.runId, secondRun.runId].sort());
});

test('lesson projection rejects mismatched content at the expected current observation ID', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const expectedBody = 'Expected exact observation content';
  const state = lessonRun({ runId: 'poisoned-current-observation', learnings: [expectedBody] });
  const expectedId = observationId(worktree, state.runId, expectedBody);
  const forged = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: expectedId,
    scope: 'project',
    kind: 'lesson-observation',
    title: 'Different forged title',
    createdAt: FINISHED_AT,
    tags: ['failure'],
    sourceIds: [],
    metadata: {
      projectKey: projectKey(worktree),
      runId: state.runId,
      category: 'failure',
      fingerprint: stableJournalId(normalizeLessonText('Different forged body')),
      legacyFingerprint: 'a'.repeat(64),
      source: 'forged',
    },
    body: 'Different forged body',
  };
  await lessonStore.write('project', forged);

  const result = await service.projectLessons(state);

  assert.equal(result.created, 0);
  assert.equal(result.failed, true);
  assert.equal(result.reason, 'projection-failed');
  assert.deepEqual(await lessonStore.read('project', expectedId), forged);
  assert.deepEqual((await lessonStore.list('project')).map((entry) => entry.id), [expectedId]);
});

test('lesson projection replays an exact same-ID observation with its historical unsafe derived title', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const learning = `${'a'.repeat(199)}😀`;
  const state = lessonRun({ runId: 'legacy-same-id-title', learnings: [learning] });
  const legacy = legacyObservation(worktree, {
    runId: state.runId,
    body: learning,
    category: 'learning',
    source: 'findings',
  });
  const safeTitle = 'a'.repeat(199);
  assert.equal(legacy.id, observationId(worktree, state.runId, learning));
  assert.equal(legacy.body.isWellFormed(), true);
  assert.equal(legacy.title.isWellFormed(), false);
  assert.notEqual(legacy.title, safeTitle);
  await lessonStore.write('project', legacy);
  const persisted = await lessonStore.read('project', legacy.id);
  assert.equal(persisted.title, legacy.title);
  assert.equal(persisted.title.isWellFormed(), false);

  const result = await service.projectLessons(state);
  const entries = await lessonStore.list('project');
  const consolidated = await service.consolidatedTop();

  assert.equal(result.created, 0);
  assert.equal(result.failed, undefined);
  assert.equal(result.reason, 'none');
  assert.deepEqual(entries, [persisted]);
  assert.equal(consolidated.length, 1);
  assert.equal(consolidated[0].fingerprint, legacy.metadata.fingerprint);
  assert.equal(consolidated[0].occurrences, 1);
  assert.deepEqual([...consolidated[0].runIds], [state.runId]);
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

test('curated and promoted lessons preserve content at the combined boundary and reject truncation', async (t) => {
  const { lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'bounded-lessons-run' });
  const curatedTitle = 'L'.repeat(512);
  const curatedInput = {
    title: curatedTitle,
    body: 'l'.repeat(MAX_INDEXED_TEXT_CHARS - curatedTitle.length - 2),
    category: 'pitfall',
    tags: ['bounded'],
  };

  const first = await service.recordLesson(state, curatedInput);
  const second = await service.recordLesson(state, curatedInput);
  const curated = await lessonStore.read('project', first.entry.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.entry, first.entry);
  assert.equal(`${curated.title}\n\n${curated.body}`.length, MAX_INDEXED_TEXT_CHARS);
  assert.equal(curated.body, curatedInput.body);
  assert.ok(curated.body.length > 0);

  const promotedTitle = 'P'.repeat(512);
  const promoted = await service.promoteLesson({
    lessonId: curated.id,
    title: promotedTitle,
    body: 'p'.repeat(MAX_INDEXED_TEXT_CHARS - promotedTitle.length - 2),
    tags: ['portable'],
  });
  const global = await lessonStore.read('global', promoted.entry.id);
  assert.equal(`${global.title}\n\n${global.body}`.length, MAX_INDEXED_TEXT_CHARS);
  assert.equal(global.body, promoted.entry.body);
  assert.ok(global.body.length > 0);

  for (const body of ['a'.repeat(MAX_INDEXED_TEXT_CHARS), 'a'.repeat(34_000)]) {
    await assert.rejects(() => service.recordLesson(state, {
      title: 'Title', body, category: 'pitfall', tags: [],
    }), TypeError);
    await assert.rejects(() => service.promoteLesson({
      lessonId: curated.id, title: 'Title', body, tags: [],
    }), TypeError);
  }
});

test('lesson public write rejects lone surrogates before hashing or persistence', async (t) => {
  const cases = [
    { title: 'Title', body: 'bad\uD800' },
    { title: '\uDC00bad', body: 'Body' },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const h = await lessonToolHarness(t, `ill-formed-lesson-${index}`);
    const schema = tool.schema.object(h.tools.graph_lesson_record.args);
    const input = schema.parse({ ...cases[index], category: 'pitfall', tags: [], observationIds: [] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = JSON.parse(await h.tools.graph_lesson_record.execute(input, h.context));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'LESSON_ERROR');
    }
    assert.deepEqual(await h.lessonStore.list('project'), []);
  }
});

test('recordLesson rejects over-limit raw prefixes instead of replaying legacy entries', async (t) => {
  const { worktree, lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'raw-prefix-curated-lesson' });
  const bodyPrefix = 'b'.repeat(MAX_AUTHORED_BODY_INPUT_CHARS);
  const titlePrefix = 'T'.repeat(512);
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'project',
    kind: 'lesson',
    createdAt: FINISHED_AT,
    tags: ['pitfall'],
    sourceIds: [stableJournalId('run-summary', projectKey(worktree), state.runId)],
    metadata: {
      projectKey: projectKey(worktree), runId: state.runId, status: 'SUCCEEDED', category: 'pitfall',
    },
  };
  const bodyLegacy = legacyEntry('lesson', { ...base, title: 'Body prefix', body: bodyPrefix });
  const titleLegacy = legacyEntry('lesson', { ...base, title: titlePrefix, body: 'Title prefix body' });
  await lessonStore.write('project', bodyLegacy);
  await lessonStore.write('project', titleLegacy);
  const before = await lessonStore.list('project');

  const attempts = await Promise.allSettled([
    service.recordLesson(state, {
      title: bodyLegacy.title, body: `${bodyPrefix}trailing data`, category: 'pitfall', tags: [],
    }),
    service.recordLesson(state, {
      title: `${titlePrefix}trailing data`, body: titleLegacy.body, category: 'pitfall', tags: [],
    }),
  ]);

  assert.deepEqual(attempts.map((attempt) => attempt.status), ['rejected', 'rejected']);
  assert.ok(attempts.every((attempt) => attempt.reason instanceof TypeError));
  assert.deepEqual(await lessonStore.list('project'), before);
});

test('promoteLesson rejects over-limit raw prefixes instead of replaying legacy entries', async (t) => {
  const { lessonStore, service } = await lessonHarness(t);
  const state = lessonRun({ runId: 'raw-prefix-promoted-lesson' });
  const source = await service.recordLesson(state, {
    title: 'Source lesson', body: 'Source body', category: 'pitfall', tags: [],
  });
  const bodyPrefix = 'b'.repeat(MAX_AUTHORED_BODY_INPUT_CHARS);
  const titlePrefix = 'T'.repeat(512);
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'global',
    kind: 'promoted-lesson',
    createdAt: source.entry.createdAt,
    tags: [],
    sourceIds: [],
    metadata: { originKind: 'lesson' },
  };
  const bodyLegacy = legacyEntry('promoted-lesson', { ...base, title: 'Body prefix', body: bodyPrefix });
  const titleLegacy = legacyEntry('promoted-lesson', { ...base, title: titlePrefix, body: 'Title prefix body' });
  await lessonStore.write('global', bodyLegacy);
  await lessonStore.write('global', titleLegacy);
  const projectBefore = await lessonStore.list('project');
  const globalBefore = await lessonStore.list('global');

  const attempts = await Promise.allSettled([
    service.promoteLesson({
      lessonId: source.entry.id, title: bodyLegacy.title, body: `${bodyPrefix}trailing data`, tags: [],
    }),
    service.promoteLesson({
      lessonId: source.entry.id, title: `${titlePrefix}trailing data`, body: titleLegacy.body, tags: [],
    }),
  ]);

  assert.deepEqual(attempts.map((attempt) => attempt.status), ['rejected', 'rejected']);
  assert.ok(attempts.every((attempt) => attempt.reason instanceof TypeError));
  assert.deepEqual(await lessonStore.list('project'), projectBefore);
  assert.deepEqual(await lessonStore.list('global'), globalBefore);
});

test('curated lesson replays a 20000-character legacy entry through its public tool only when the ID exists', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-curated-lesson-run');
  const input = {
    title: 'Title',
    body: 'a'.repeat(20_000),
    category: 'pitfall',
    tags: ['legacy'],
  };
  const partial = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'project',
    kind: 'lesson',
    title: input.title,
    createdAt: FINISHED_AT,
    tags: ['pitfall', 'legacy'],
    sourceIds: [stableJournalId('run-summary', projectKey(h.worktree), h.state.runId)],
    metadata: {
      projectKey: projectKey(h.worktree),
      runId: h.state.runId,
      status: 'SUCCEEDED',
      category: 'pitfall',
    },
    body: input.body,
  };
  const legacy = legacyEntry('lesson', partial);
  await h.lessonStore.write('project', legacy);

  const schema = tool.schema.object(h.tools.graph_lesson_record.args);
  const replay = JSON.parse(await h.tools.graph_lesson_record.execute(
    schema.parse({ ...input, observationIds: [] }),
    h.context,
  ));
  const rejected = JSON.parse(await h.tools.graph_lesson_record.execute(
    schema.parse({ ...input, body: 'b'.repeat(20_000), observationIds: [] }),
    h.context,
  ));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, legacy);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LESSON_ERROR');
  assert.deepEqual(
    (await h.lessonStore.list('project')).filter((entry) => entry.kind === 'lesson').map((entry) => entry.id),
    [legacy.id],
  );
});

test('lesson promotion replays a 20000-character legacy entry through its public tool only when the ID exists', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-promoted-lesson-run');
  const source = await h.service.recordLesson(h.state, {
    title: 'Source lesson', body: 'Source body', category: 'pitfall', tags: [],
  });
  const input = {
    lessonId: source.entry.id,
    title: 'Title',
    body: 'a'.repeat(20_000),
    tags: ['legacy'],
  };
  const partial = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'global',
    kind: 'promoted-lesson',
    title: input.title,
    createdAt: source.entry.createdAt,
    tags: input.tags,
    sourceIds: [],
    metadata: { originKind: 'lesson' },
    body: input.body,
  };
  const legacy = legacyEntry('promoted-lesson', partial);
  await h.lessonStore.write('global', legacy);

  const schema = tool.schema.object(h.tools.graph_lesson_promote.args);
  const replay = JSON.parse(await h.tools.graph_lesson_promote.execute(schema.parse(input), h.context));
  const rejected = JSON.parse(await h.tools.graph_lesson_promote.execute(
    schema.parse({ ...input, body: 'b'.repeat(20_000) }),
    h.context,
  ));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, legacy);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LESSON_ERROR');
  assert.deepEqual((await h.lessonStore.list('global')).map((entry) => entry.id), [legacy.id]);
});

test('curated lesson replays an exact legacy body after raw Markdown persistence repairs its surrogate', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-persisted-body-lesson-run');
  const body = redactionExpandedAstralBoundary(MAX_AUTHORED_BODY_INPUT_CHARS);
  const input = {
    title: 'Legacy body lesson', body: body.input, category: 'pitfall', tags: ['legacy'],
  };
  const schema = tool.schema.object(h.tools.graph_lesson_record.args);
  const parsed = schema.parse({ ...input, observationIds: [] });
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'project',
    kind: 'lesson',
    title: input.title,
    createdAt: FINISHED_AT,
    tags: ['pitfall', 'legacy'],
    sourceIds: [stableJournalId('run-summary', projectKey(h.worktree), h.state.runId)],
    metadata: {
      projectKey: projectKey(h.worktree), runId: h.state.runId, status: 'SUCCEEDED', category: 'pitfall',
    },
  };
  const legacy = legacyEntry('lesson', { ...base, body: body.legacy });
  const current = legacyEntry('lesson', { ...base, body: body.safe });
  await h.lessonStore.write('project', legacy);
  const persisted = await h.lessonStore.read('project', legacy.id);
  assert.equal(persisted.body, body.legacy.toWellFormed());

  const replay = JSON.parse(await h.tools.graph_lesson_record.execute(parsed, h.context));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, persisted);
  assert.deepEqual(
    (await h.lessonStore.list('project')).filter((entry) => entry.kind === 'lesson').map((entry) => entry.id),
    [legacy.id],
  );
  assert.equal(await h.lessonStore.read('project', current.id), null);
});

test('lesson promotion replays an exact legacy body after raw Markdown persistence repairs its surrogate', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-persisted-body-promoted-lesson-run');
  const source = await h.service.recordLesson(h.state, {
    title: 'Source lesson', body: 'Source body', category: 'pitfall', tags: [],
  });
  const body = redactionExpandedAstralBoundary(MAX_AUTHORED_BODY_INPUT_CHARS);
  const input = {
    lessonId: source.entry.id,
    title: 'Legacy body promoted lesson',
    body: body.input,
    tags: ['legacy'],
  };
  const schema = tool.schema.object(h.tools.graph_lesson_promote.args);
  const parsed = schema.parse(input);
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'global',
    kind: 'promoted-lesson',
    title: input.title,
    createdAt: source.entry.createdAt,
    tags: input.tags,
    sourceIds: [],
    metadata: { originKind: 'lesson' },
  };
  const legacy = legacyEntry('promoted-lesson', { ...base, body: body.legacy });
  const current = legacyEntry('promoted-lesson', { ...base, body: body.safe });
  await h.lessonStore.write('global', legacy);
  const persisted = await h.lessonStore.read('global', legacy.id);
  assert.equal(persisted.body, body.legacy.toWellFormed());

  const replay = JSON.parse(await h.tools.graph_lesson_promote.execute(parsed, h.context));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, persisted);
  assert.deepEqual((await h.lessonStore.list('global')).map((entry) => entry.id), [legacy.id]);
  assert.equal(await h.lessonStore.read('global', current.id), null);
});

test('curated lesson replays an in-limit legacy ID after redaction expands across an astral boundary', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-in-limit-curated-run');
  const title = redactionExpandedAstralBoundary(512);
  const tag = redactionExpandedAstralBoundary(128);
  const input = {
    title: title.input,
    body: 'Short legacy lesson body',
    category: 'pitfall',
    tags: [tag.input],
  };
  const schema = tool.schema.object(h.tools.graph_lesson_record.args);
  const parsed = schema.parse({ ...input, observationIds: [] });
  assert.equal(title.legacy.isWellFormed(), false);
  assert.equal(tag.legacy.isWellFormed(), false);
  assert.ok(`${title.safe}\n\n${input.body}`.length <= MAX_INDEXED_TEXT_CHARS);
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'project',
    kind: 'lesson',
    createdAt: FINISHED_AT,
    sourceIds: [stableJournalId('run-summary', projectKey(h.worktree), h.state.runId)],
    metadata: {
      projectKey: projectKey(h.worktree), runId: h.state.runId, status: 'SUCCEEDED', category: 'pitfall',
    },
    body: input.body,
  };
  const legacy = legacyEntry('lesson', { ...base, title: title.legacy, tags: ['pitfall', tag.legacy] });
  const current = legacyEntry('lesson', { ...base, title: title.safe, tags: ['pitfall', tag.safe] });
  assert.notEqual(current.id, legacy.id);
  await h.lessonStore.write('project', legacy);

  const replay = JSON.parse(await h.tools.graph_lesson_record.execute(parsed, h.context));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, legacy);
  assert.deepEqual(
    (await h.lessonStore.list('project')).filter((entry) => entry.kind === 'lesson').map((entry) => entry.id),
    [legacy.id],
  );
  assert.equal(await h.lessonStore.read('project', current.id), null);
});

test('lesson promotion replays an in-limit legacy ID after redaction expands across an astral boundary', async (t) => {
  const h = await lessonToolHarness(t, 'legacy-in-limit-promoted-run');
  const source = await h.service.recordLesson(h.state, {
    title: 'Source lesson', body: 'Source body', category: 'pitfall', tags: [],
  });
  const title = redactionExpandedAstralBoundary(512);
  const tag = redactionExpandedAstralBoundary(128);
  const input = {
    lessonId: source.entry.id,
    title: title.input,
    body: 'Short legacy promoted lesson body',
    tags: [tag.input],
  };
  const schema = tool.schema.object(h.tools.graph_lesson_promote.args);
  const parsed = schema.parse(input);
  const base = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'global',
    kind: 'promoted-lesson',
    createdAt: source.entry.createdAt,
    sourceIds: [],
    metadata: { originKind: 'lesson' },
    body: input.body,
  };
  const legacy = legacyEntry('promoted-lesson', { ...base, title: title.legacy, tags: [tag.legacy] });
  const current = legacyEntry('promoted-lesson', { ...base, title: title.safe, tags: [tag.safe] });
  assert.notEqual(current.id, legacy.id);
  await h.lessonStore.write('global', legacy);

  const replay = JSON.parse(await h.tools.graph_lesson_promote.execute(parsed, h.context));

  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.deepEqual(replay.entry, legacy);
  assert.deepEqual((await h.lessonStore.list('global')).map((entry) => entry.id), [legacy.id]);
  assert.equal(await h.lessonStore.read('global', current.id), null);
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

  const overflow = JSON.parse(await tools.graph_lesson_record.execute(
    { title: 'Title', body: 'a'.repeat(MAX_INDEXED_TEXT_CHARS), category: 'pitfall', tags: [], observationIds: [] },
    context('tools-run', 'graph-orchestrator'),
  ));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.code, 'LESSON_ERROR');
  const withinBody = 'a'.repeat(MAX_INDEXED_TEXT_CHARS - 'Title'.length - 2);
  const within = JSON.parse(await tools.graph_lesson_record.execute(
    { title: 'Title', body: withinBody, category: 'pitfall', tags: [], observationIds: [] },
    context('tools-run', 'graph-orchestrator'),
  ));
  assert.equal(within.ok, true);
  assert.equal(within.entry.body, withinBody);

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

test('lesson tool schemas accept 20000 and 32000-character bodies and reject 32001', () => {
  const tools = createLessonTools({ lessonService: {}, store: {}, bindings: new Map(), enabled: true });
  const schema = (name) => tool.schema.object(tools[name].args);
  const inputs = [
    ['graph_lesson_record', { title: 'Title', category: 'pitfall' }],
    ['graph_lesson_promote', { lessonId: 'a'.repeat(64), title: 'Title' }],
  ];

  for (const [name, input] of inputs) {
    for (const length of [20_000, MAX_AUTHORED_BODY_INPUT_CHARS]) {
      assert.equal(schema(name).parse({
        ...input,
        body: 'b'.repeat(length),
      }).body.length, length);
    }
    assert.throws(() => schema(name).parse({
      ...input,
      body: 'b'.repeat(MAX_AUTHORED_BODY_INPUT_CHARS + 1),
    }));
  }
});
