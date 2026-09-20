// Lesson knowledge base: a project-local (and promotable-to-global) store of
// "lessons learnt" — unexpected behavior and repeated mistakes — harvested
// mechanically from terminal runs. Three append-only observation sources per
// run: explorer learnings, failed/UNVERIFIED verification summaries, and
// recorded rule violations. Curated `lesson` entries may be authored by the
// orchestrator after a run ends; promotion to the global scope requires
// separately supplied project-neutral content (same trust rules as the
// journal). Everything here is historical, non-authoritative context: it can
// never satisfy a runner, review or verification gate, and consumers must
// re-validate claims against the current worktree.

import { resolve } from 'node:path';
import { JOURNAL_SCHEMA_VERSION, stableJournalId } from './journal-store.mjs';
import {
  codePointSafePrefix,
  MAX_INDEXED_TEXT_CHARS,
  sanitizeIndexedEntryText,
  sanitizeJournalText,
  sanitizeJournalTextForLegacyReplay,
} from './journal-text.mjs';
import { safeJournalStage } from './journal-errors.mjs';

export const LESSON_KINDS = Object.freeze({
  project: Object.freeze(['lesson', 'lesson-observation']),
  global: Object.freeze(['promoted-lesson']),
});

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED']);
const LESSON_CATEGORIES = new Set(['pitfall', 'surprise', 'repeated-mistake']);
const MAX_OBSERVATION_TEXT_CHARS = 1000;
const MAX_OBSERVATIONS_PER_SOURCE = 8;
const MAX_OBSERVATION_LINKS = 8;
const MAX_TEXT_CHARS = 1000;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 128;
const MAX_RELEVANT_CANDIDATES = 64;
const MAX_RELEVANT_PATHS = 8;
const MAX_CONSOLIDATED = 16;
const MAX_RUN_IDS = 8;
const MAX_PENDING_BACKFILL_RUNS = 64;
const MAX_BACKFILL_OFFSET = 1_000_000;
const INJECTION_TEXT_CHARS = 240;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const REPLACEMENT_CHARACTER = '\uFFFD';
const HIGH_SURROGATE_START = 0xD800;
const HIGH_SURROGATE_END = 0xDBFF;

function sanitizedText(value, limit = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || !value.isWellFormed()) return null;
  const result = sanitizeJournalText(value, limit);
  return result.text.length ? result : null;
}

function oneLine(value, limit = MAX_IDENTIFIER_CHARS) {
  const sanitized = sanitizedText(value, limit);
  if (sanitized === null) return null;
  const text = sanitized.text.replace(/\s+/g, ' ').trim();
  return text.length ? text.slice(0, limit) : null;
}

function oneLineForLegacyReplay(value, limit = MAX_IDENTIFIER_CHARS) {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeJournalTextForLegacyReplay(value, limit);
  const text = sanitized.text.replace(/\s+/g, ' ').trim();
  return text.length ? text.slice(0, limit) : null;
}

function journalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Exact-normalized-text matching: identical lessons (after whitespace
// collapse and lowercasing) share a fingerprint and consolidate into one
// occurrence count. Near-duplicates phrased differently stay separate — an
// honest, documented limitation, not a semantic clusterer.
export function normalizeLessonText(value) {
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function fingerprintOf(text) {
  return stableJournalId(normalizeLessonText(text));
}

function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

function stableContentId(kind, entry) {
  const { id: _id, ...content } = entry;
  return stableJournalId(kind, content);
}

function persistedEntryForLegacyReplay(entry) {
  return { ...entry, body: entry.body.toWellFormed() };
}

async function legacyReplay(store, scope, kind, expected) {
  const existing = await store.read(scope, expected.id);
  if (existing === null || existing.id !== expected.id) return null;
  const existingHash = stableContentId(kind, existing);
  const persistedHash = stableContentId(kind, persistedEntryForLegacyReplay(expected));
  if (existingHash !== expected.id && existingHash !== persistedHash) return null;
  return { created: false, entry: existing };
}

function legacyEntry(kind, partial, content, tags = content.legacyTags) {
  const legacy = {
    ...partial,
    title: content.legacyTitle,
    tags,
    body: content.legacyBody,
  };
  return { ...legacy, id: stableContentId(kind, legacy) };
}

function observationText(source, limit = MAX_OBSERVATION_TEXT_CHARS) {
  const sanitized = sanitizedText(source, MAX_OBSERVATION_TEXT_CHARS);
  return sanitized === null ? null : sanitized.text;
}

function commandPrefixForLegacyReplay(value) {
  return value.slice(0, 200);
}

function collectObservations(state) {
  const observations = [];
  const seen = new Set();
  function push(category, text, source, legacyText = text) {
    const body = observationText(text);
    if (body === null) return;
    const fingerprint = fingerprintOf(body);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    let legacy = null;
    if (typeof legacyText === 'string') {
      const legacyBody = sanitizeJournalTextForLegacyReplay(legacyText, MAX_OBSERVATION_TEXT_CHARS).text;
      const legacyFingerprint = legacyBody.length ? fingerprintOf(legacyBody) : null;
      const currentTitle = oneLine(body, 200) ?? 'Run observation';
      const legacyTitle = legacyBody.length
        ? oneLineForLegacyReplay(legacyBody, 200) ?? 'Run observation'
        : null;
      if (legacyFingerprint !== null
        && (legacyFingerprint !== fingerprint || legacyBody !== body || legacyTitle !== currentTitle)) {
        legacy = { body: legacyBody, fingerprint: legacyFingerprint };
      }
    }
    observations.push({ body, category, fingerprint, source, legacy });
  }

  const learnings = state?.artifacts?.findings?.payload?.learnings;
  if (Array.isArray(learnings)) {
    for (let index = 0; index < learnings.length && index < MAX_OBSERVATIONS_PER_SOURCE; index += 1) {
      push('learning', String(learnings[index]), 'findings');
    }
  }

  const artifacts = state?.artifacts;
  if (artifacts !== null && typeof artifacts === 'object' && !Array.isArray(artifacts)) {
    for (const name of Object.keys(artifacts).sort()) {
      const artifact = artifacts[name];
      if (artifact?.kind !== 'verification') continue;
      const verdict = artifact.payload?.verdict;
      if (verdict !== 'FAIL' && verdict !== 'UNVERIFIED') continue;
      const suppliedSummary = artifact.payload?.summary;
      const currentSummary = oneLine(suppliedSummary, 400);
      const summary = currentSummary ?? 'no summary supplied';
      const legacySummary = currentSummary === null
        ? 'no summary supplied'
        : oneLineForLegacyReplay(suppliedSummary, 400) ?? 'no summary supplied';
      const failing = (Array.isArray(artifact.payload?.commands) ? artifact.payload.commands : [])
        .filter((command) => command && Number.isInteger(command.exitCode) && command.exitCode !== 0)
        .slice(0, 4)
        .map((command) => {
          const value = String(command.command ?? '');
          return {
            current: codePointSafePrefix(value, 200),
            legacy: commandPrefixForLegacyReplay(value),
          };
        })
        .filter((command) => command.current.length);
      const currentCommands = failing.map((command) => command.current);
      const legacyCommands = failing.map((command) => command.legacy);
      const currentPrefix = `Verification ${verdict} on node ${artifact.nodeId ?? '[unknown]'}: ${summary}`;
      const legacyPrefix = `Verification ${verdict} on node ${artifact.nodeId ?? '[unknown]'}: ${legacySummary}`;
      const currentText = `${currentPrefix}${currentCommands.length ? ` — failing commands: ${currentCommands.join('; ')}` : ''}`;
      const legacyText = `${legacyPrefix}${legacyCommands.length ? ` — failing commands: ${legacyCommands.join('; ')}` : ''}`;
      push('failure', currentText, `verification:${name}`, legacyText);
    }
  }

  if (Array.isArray(state?.violations)) {
    for (let index = 0; index < state.violations.length && index < MAX_OBSERVATIONS_PER_SOURCE; index += 1) {
      const violation = state.violations[index];
      const suppliedKind = violation?.kind;
      const kind = oneLine(suppliedKind, 128);
      if (kind === null) continue;
      const legacyKind = oneLineForLegacyReplay(suppliedKind, 128) ?? kind;
      const suppliedDetail = violation?.detail;
      const currentDetail = sanitizedText(suppliedDetail, 600);
      const detail = currentDetail?.text ?? '';
      const legacyDetail = currentDetail === null
        ? ''
        : sanitizeJournalTextForLegacyReplay(suppliedDetail, 600).text;
      const currentText = `${kind}${detail ? `: ${detail}` : ''}`;
      const legacyText = `${legacyKind}${legacyDetail ? `: ${legacyDetail}` : ''}`;
      push('violation', currentText, 'violations', legacyText);
    }
  }
  return observations;
}

function observationEntry({ projectKey, runId, createdAt, body, category, fingerprint, source, legacyFingerprint = null }) {
  if (!isFingerprint(fingerprint)) throw new TypeError('Lesson observation fingerprint must be a lowercase SHA-256 digest');
  if (legacyFingerprint !== null && !isFingerprint(legacyFingerprint)) {
    throw new TypeError('Lesson observation legacy fingerprint must be a lowercase SHA-256 digest');
  }
  const metadata = { projectKey, runId, category, fingerprint, source };
  if (legacyFingerprint !== null) metadata.legacyFingerprint = legacyFingerprint;
  const partial = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    scope: 'project',
    kind: 'lesson-observation',
    title: oneLine(body, 200) ?? 'Run observation',
    createdAt,
    tags: [category],
    sourceIds: [stableJournalId('run-summary', projectKey, runId)],
    metadata,
    body,
  };
  return { ...partial, id: stableJournalId('lesson-observation', projectKey, runId, fingerprint) };
}

function observationEntryForLegacyReplay(input) {
  const entry = observationEntry(input);
  return { ...entry, title: oneLineForLegacyReplay(input.body, 200) ?? 'Run observation' };
}

function sanitizedEntryContent({ title, body, tags = [] } = {}) {
  const text = sanitizeIndexedEntryText({ title, body });
  if (text === null) throw new TypeError('Lesson title and body must be nonempty strings');
  if (!Array.isArray(tags)) throw new TypeError('Lesson tags must be an array');
  const sanitizedTags = [];
  const legacyTags = [];
  for (let index = 0; index < tags.length && index < MAX_TAGS; index += 1) {
    const tag = oneLine(tags[index], MAX_TAG_CHARS);
    if (tag === null) throw new TypeError('Lesson tags must contain nonempty strings');
    if (!sanitizedTags.includes(tag)) sanitizedTags.push(tag);
    const legacyTag = oneLineForLegacyReplay(tags[index], MAX_TAG_CHARS);
    if (legacyTag === null) throw new TypeError('Lesson tags must contain nonempty strings');
    if (!legacyTags.includes(legacyTag)) legacyTags.push(legacyTag);
  }
  return { ...text, tags: sanitizedTags, legacyTags };
}

function historicalRepairFingerprint(body, storedFingerprint) {
  const replacementIndex = body.indexOf(REPLACEMENT_CHARACTER);
  if (replacementIndex < 0 || replacementIndex !== body.lastIndexOf(REPLACEMENT_CHARACTER)) return null;
  const prefix = body.slice(0, replacementIndex);
  const suffix = body.slice(replacementIndex + REPLACEMENT_CHARACTER.length);
  const repairedBody = `${prefix}${suffix}`;
  if (!repairedBody.isWellFormed() || !normalizeLessonText(repairedBody).length) return null;

  for (let codeUnit = HIGH_SURROGATE_START; codeUnit <= HIGH_SURROGATE_END; codeUnit += 1) {
    const historicalBody = `${prefix}${String.fromCharCode(codeUnit)}${suffix}`;
    if (historicalBody.toWellFormed() === body && fingerprintOf(historicalBody) === storedFingerprint) {
      return fingerprintOf(repairedBody);
    }
  }
  return null;
}

function verifiedObservation(entry, projectKey) {
  if (entry.kind !== 'lesson-observation' || entry.metadata?.projectKey !== projectKey) return null;
  const runId = typeof entry.metadata?.runId === 'string' && entry.metadata.runId.length
    ? entry.metadata.runId
    : null;
  const storedFingerprint = isFingerprint(entry.metadata?.fingerprint)
    ? entry.metadata.fingerprint
    : null;
  if (runId === null || storedFingerprint === null
    || entry.id !== stableJournalId('lesson-observation', projectKey, runId, storedFingerprint)
    || typeof entry.body !== 'string' || !entry.body.length || !entry.body.isWellFormed()) return null;

  const bodyFingerprint = fingerprintOf(entry.body);
  if (storedFingerprint === bodyFingerprint) {
    return { entry, fingerprint: bodyFingerprint, historicalFingerprint: null };
  }
  const repairedFingerprint = historicalRepairFingerprint(entry.body, storedFingerprint);
  if (repairedFingerprint === null) return null;
  return {
    entry,
    fingerprint: repairedFingerprint,
    historicalFingerprint: storedFingerprint,
  };
}

function consolidateObservations(entries, projectKey) {
  const groups = new Map();
  for (const candidate of entries) {
    const observation = verifiedObservation(candidate, projectKey);
    if (observation === null) continue;
    const { entry, fingerprint, historicalFingerprint } = observation;
    let group = groups.get(fingerprint);
    if (group === undefined) {
      group = {
        fingerprint,
        historicalFingerprints: new Set(),
        text: entry.body,
        category: typeof entry.metadata?.category === 'string' ? entry.metadata.category : null,
        occurrences: 0,
        firstSeen: entry.createdAt,
        lastSeen: entry.createdAt,
        runIds: [],
      };
      groups.set(fingerprint, group);
    }
    if (historicalFingerprint !== null) group.historicalFingerprints.add(historicalFingerprint);
    group.occurrences += 1;
    if (entry.createdAt < group.firstSeen) {
      group.firstSeen = entry.createdAt;
      // Canonical text comes from the earliest phrasing so a later
      // lowercased/normalized echo does not overwrite the original wording.
      group.text = entry.body;
      group.category = typeof entry.metadata?.category === 'string' ? entry.metadata.category : null;
    }
    if (entry.createdAt > group.lastSeen) group.lastSeen = entry.createdAt;
    const runId = typeof entry.metadata?.runId === 'string' ? entry.metadata.runId : null;
    if (runId !== null && group.runIds.length < MAX_RUN_IDS && !group.runIds.includes(runId)) group.runIds.push(runId);
  }
  return [...groups.values()].map(({ historicalFingerprints, ...group }) => ({
    ...group,
    fingerprint: historicalFingerprints.size
      ? [...historicalFingerprints].sort()[0]
      : group.fingerprint,
  }));
}

function pathTokens(paths) {
  const tokens = [];
  for (const path of paths.slice(0, MAX_RELEVANT_PATHS)) {
    const value = String(path ?? '').toLowerCase().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!value.length || value.includes('..')) continue;
    tokens.push(value);
    const segment = value.split('/').pop() ?? '';
    const base = segment.replace(/\.[^.]+$/, '');
    if (base.length >= 4) tokens.push(base);
  }
  return tokens;
}

function queryTokens(text) {
  if (typeof text !== 'string' || !text.length) return [];
  return [...new Set(text.toLowerCase().split(/[^a-z0-9_-]+/).filter((word) => word.length >= 4))].slice(0, 24);
}

function scoreCandidate(candidate, tokens) {
  const haystack = candidate.text.toLowerCase();
  let score = Math.min(candidate.occurrences, 5);
  for (const token of tokens.paths) {
    if (haystack.includes(token.token)) score += token.weight;
  }
  for (const word of tokens.words) {
    if (haystack.includes(word)) score += 0.5;
  }
  const tagSet = tokens.tags;
  for (const tag of candidate.tags ?? []) {
    if (tagSet.has(String(tag).toLowerCase())) score += 1;
  }
  return score;
}

function injectionText(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > INJECTION_TEXT_CHARS ? `${flat.slice(0, INJECTION_TEXT_CHARS - 3)}...` : flat;
}

export function formatLessonsBlock(lessons) {
  if (!Array.isArray(lessons) || !lessons.length) return null;
  const lines = lessons.map((lesson) => {
    const occurrences = Number.isInteger(lesson.occurrences) && lesson.occurrences > 1 ? ` x${Math.min(lesson.occurrences, 99)}` : '';
    const category = typeof lesson.category === 'string' && lesson.category.length ? lesson.category : 'lesson';
    return `- [${category}${occurrences}] ${injectionText(lesson.text)}`;
  });
  return `[RUNNER] Known project lessons (historical; re-validate against the current worktree before applying):\n${lines.join('\n')}`;
}

// Project-specific values promotion must never echo: identity metadata plus
// path-like tokens lifted from the lesson's own body and its linked
// observations (the run-summary file list is added when a journal store is
// wired). Bounded and heuristic on purpose — a second opinion, not a sandbox.
const PATH_TOKEN_PATTERN = /(?:[A-Za-z0-9._-]+\/){1,6}[A-Za-z0-9._-]+/g;
const MAX_PATH_TOKENS = 16;

function pathTokensIn(text) {
  if (typeof text !== 'string') return [];
  const tokens = [];
  for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
    if (match[0].length >= 6 && !tokens.includes(match[0])) tokens.push(match[0]);
    if (tokens.length >= MAX_PATH_TOKENS) break;
  }
  return tokens;
}

export function createLessonService({ runStore, lessonStore, lessonSearch, journalStore = null, enabled = true, worktree } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const resolvedWorktree = typeof worktree === 'string' && worktree.length ? resolve(worktree) : null;
  const projectKey = resolvedWorktree === null ? null : stableJournalId('project', resolvedWorktree);
  const flights = new Map();
  let projectAvailable = projectKey !== null;
  let projected = 0;
  let backfilled = 0;
  let failures = 0;
  let backfillOffset = 0;
  let backfillFlight = null;
  let lastError = enabled && projectKey === null ? 'Lesson project store unavailable' : null;
  let errorCode = null;

  function recordFailure(message, error, stage = null) {
    failures += 1;
    lastError = message;
    errorCode = safeJournalStage(stage);
    if (error?.code === 'PROJECT_WORKTREE_UNAVAILABLE') projectAvailable = false;
  }

  async function writeObserved(entry, legacy = null) {
    let flight = flights.get(entry.id);
    let owner = false;
    if (flight === undefined) {
      owner = true;
      flight = (async () => {
        try {
          if (legacy !== null) {
            const existing = await lessonStore.read('project', legacy.id);
            const persisted = persistedEntryForLegacyReplay(legacy);
            if (existing !== null
              && existing.id === legacy.id
              && stableContentId('lesson-observation', existing) === stableContentId('lesson-observation', persisted)) {
              projectAvailable = true;
              return false;
            }
          }
          const result = await lessonStore.write('project', entry);
          projectAvailable = true;
          return result?.created !== false;
        } catch (error) {
          recordFailure('Lesson observation write failed', error);
          return null;
        }
      })();
      flights.set(entry.id, flight);
    }
    try {
      return await flight;
    } finally {
      if (owner && flights.get(entry.id) === flight) flights.delete(entry.id);
    }
  }

  async function projectLessons(state) {
    try {
      if (!enabled) return Object.freeze({ created: 0, reason: 'disabled' });
      if (projectKey === null || !projectAvailable) return Object.freeze({ created: 0, reason: 'project-unavailable' });
      if (!TERMINAL_STATUSES.has(state?.status)) return Object.freeze({ created: 0, reason: 'nonterminal' });
      const runId = oneLine(state?.runId, MAX_IDENTIFIER_CHARS);
      if (runId === null) throw new TypeError('Lesson projection requires a run id');
      const createdAt = oneLine(state?.updatedAt ?? state?.createdAt, MAX_IDENTIFIER_CHARS) ?? new Date().toISOString();
      const observations = collectObservations(state);
      let created = 0;
      for (const observation of observations) {
        const input = {
          projectKey, runId, createdAt,
          body: observation.body, category: observation.category,
          fingerprint: observation.fingerprint, source: observation.source,
          legacyFingerprint: observation.legacy !== null
            && observation.legacy.fingerprint !== observation.fingerprint
            ? observation.legacy.fingerprint
            : null,
        };
        const legacy = observation.legacy === null ? null : observationEntryForLegacyReplay({
          projectKey, runId, createdAt,
          body: observation.legacy.body,
          category: observation.category,
          fingerprint: observation.legacy.fingerprint,
          source: observation.source,
        });
        const result = await writeObserved(observationEntry(input), legacy);
        if (result === null) return Object.freeze({ created, failed: true, reason: 'projection-failed' });
        if (result) { created += 1; projected += 1; }
      }
      projectAvailable = true;
      return Object.freeze({ created, reason: created ? 'projected' : 'none' });
    } catch (error) {
      recordFailure('Lesson projection failed', error);
      return Object.freeze({ created: 0, failed: true, reason: 'projection-failed' });
    }
  }

  async function runBackfill(limit) {
    const report = { inspected: 0, projected: 0, skipped: 0, failures: 0 };
    if (!enabled || projectKey === null) return Object.freeze(report);
    const offset = backfillOffset;
    let runIds;
    try {
      runIds = await runStore.listRunIds({ limit, offset });
      if (!Array.isArray(runIds)) throw new TypeError('Run store must return run ids');
    } catch (error) {
      backfillOffset = 0;
      recordFailure('Lesson backfill failed', error, 'JOURNAL_BACKFILL_FAILED');
      report.failures += 1;
      return Object.freeze(report);
    }
    const pageLength = Math.min(runIds.length, limit);
    if (errorCode === 'JOURNAL_BACKFILL_FAILED') { errorCode = null; lastError = null; }
    for (let index = 0; index < pageLength; index += 1) {
      report.inspected += 1;
      try {
        const runId = runIds[index];
        const state = await runStore.loadRun(runId);
        if (state === null || !TERMINAL_STATUSES.has(state.status)) {
          report.skipped += 1;
          continue;
        }
        // Runs that legitimately produce zero observations are re-inspected
        // on later backfill passes: the exists() checks make this a bounded
        // read with no writes, so idempotency holds without a marker entry.
        const result = await projectLessons(state);
        if (result.failed) report.failures += 1;
        else if (result.created) {
          report.projected += 1;
          backfilled += 1;
        } else report.skipped += 1;
      } catch (error) {
        recordFailure('Lesson backfill failed', error);
        report.failures += 1;
      }
    }
    const nextOffset = offset + pageLength;
    backfillOffset = pageLength < limit || nextOffset > MAX_BACKFILL_OFFSET ? 0 : nextOffset;
    return Object.freeze(report);
  }

  async function backfill({ limit = 64 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
    if (backfillFlight !== null) return backfillFlight;
    const flight = runBackfill(limit);
    backfillFlight = flight;
    try {
      return await flight;
    } finally {
      if (backfillFlight === flight) backfillFlight = null;
    }
  }

  function lessonCandidates(entries) {
    const candidates = consolidateObservations(entries, projectKey).map((group) => ({
      kind: 'lesson-observation',
      id: group.fingerprint,
      category: group.category,
      text: group.text,
      occurrences: group.occurrences,
      lastSeen: group.lastSeen,
      firstSeen: group.firstSeen,
      runIds: group.runIds,
      tags: [],
    }));
    for (const entry of entries) {
      if (entry.kind !== 'lesson') continue;
      candidates.push({
        kind: 'lesson',
        id: entry.id,
        category: typeof entry.metadata?.category === 'string' ? entry.metadata.category : null,
        text: entry.body,
        occurrences: 1,
        lastSeen: entry.createdAt,
        firstSeen: entry.createdAt,
        runIds: [],
        tags: entry.tags,
      });
    }
    return candidates;
  }

  async function listedProjectEntries() {
    const listed = await lessonStore.listBounded('project', { maxCandidates: MAX_RELEVANT_CANDIDATES });
    if (listed === null || typeof listed !== 'object' || Array.isArray(listed) || !Array.isArray(listed.entries)) {
      throw new TypeError('Lesson store bounded list must return entries');
    }
    return listed.entries;
  }

  async function relevantLessons({ text, paths = [], tags = [], limit = 4 } = {}) {
    if (!enabled || projectKey === null || !projectAvailable) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new TypeError('limit must be an integer from 1 to 8');
    await backfill();
    const entries = await listedProjectEntries();
    const tokens = {
      paths: pathTokens(Array.isArray(paths) ? paths : []).map((token) => ({ token, weight: token.includes('/') ? 2 : 1 })),
      words: queryTokens(typeof text === 'string' ? text : ''),
      tags: new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag).toLowerCase())),
    };
    const ranked = lessonCandidates(entries)
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, tokens) }))
      .sort((left, right) => right.score - left.score
        || right.candidate.occurrences - left.candidate.occurrences
        || right.candidate.lastSeen.localeCompare(left.candidate.lastSeen));
    return ranked.slice(0, limit).map(({ candidate }) => Object.freeze({
      kind: candidate.kind,
      id: candidate.id,
      category: candidate.category,
      text: injectionText(candidate.text),
      occurrences: candidate.occurrences,
      lastSeen: candidate.lastSeen,
    }));
  }

  async function consolidatedTop(limit = MAX_CONSOLIDATED) {
    const entries = await listedProjectEntries();
    const ranked = consolidateObservations(entries, projectKey)
      .sort((left, right) => right.occurrences - left.occurrences || right.lastSeen.localeCompare(left.lastSeen));
    return ranked.slice(0, limit).map((group) => Object.freeze({
      fingerprint: group.fingerprint,
      category: group.category,
      text: injectionText(group.text),
      occurrences: group.occurrences,
      firstSeen: group.firstSeen,
      lastSeen: group.lastSeen,
      runIds: Object.freeze([...group.runIds]),
    }));
  }

  async function search(args) {
    await backfill();
    const result = await lessonSearch.search(args);
    let consolidated = [];
    try {
      consolidated = await consolidatedTop();
    } catch (error) {
      recordFailure('Lesson consolidation failed', error);
    }
    return Object.freeze({ ...result, consolidated: Object.freeze(consolidated) });
  }

  function read(scope, id) {
    return lessonStore.read(scope, id);
  }

  async function recordLesson(state, input) {
    if (!enabled) throw journalError('LESSON_DISABLED');
    if (projectKey === null || !projectAvailable) throw journalError('LESSON_PROJECT_UNAVAILABLE');
    const status = state?.status;
    if (!TERMINAL_STATUSES.has(status)) throw journalError('LESSON_RUN_NOT_TERMINAL');
    const runId = oneLine(state?.runId, MAX_IDENTIFIER_CHARS);
    if (runId === null) throw new TypeError('Curated lesson requires a run id');
    const category = typeof input?.category === 'string' && LESSON_CATEGORIES.has(input.category) ? input.category : null;
    if (category === null) throw journalError('LESSON_INVALID_CATEGORY');
    const content = sanitizedEntryContent(input);
    const observationIds = Array.isArray(input?.observationIds) ? input.observationIds.slice(0, MAX_OBSERVATION_LINKS) : [];
    for (const observationId of observationIds) {
      if (typeof observationId !== 'string' || !/^[a-f0-9]{64}$/.test(observationId)) throw journalError('LESSON_NOT_FOUND');
      const observation = await lessonStore.read('project', observationId);
      if (observation?.kind !== 'lesson-observation') throw journalError('LESSON_WRONG_KIND');
    }
    const createdAt = oneLine(state?.updatedAt ?? state?.createdAt, MAX_IDENTIFIER_CHARS);
    if (createdAt === null) throw new TypeError('Curated lesson requires a timestamp');
    const sourceId = stableJournalId('run-summary', projectKey, runId);
    const metadata = { projectKey, runId, status, category, ...(observationIds.length ? { observationIds } : {}) };
    const partial = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      scope: 'project',
      kind: 'lesson',
      title: content.title,
      createdAt,
      tags: [...new Set([category, ...content.tags])],
      sourceIds: [sourceId, ...observationIds],
      metadata,
      body: content.body,
    };
    const entry = { ...partial, id: stableContentId('lesson', partial) };
    if (content.withinRawInputLimits) {
      const legacy = legacyEntry(
        'lesson',
        partial,
        content,
        [...new Set([category, ...content.legacyTags])],
      );
      if (!content.withinLimit || legacy.id !== entry.id) {
        const replay = await legacyReplay(lessonStore, 'project', 'lesson', legacy);
        if (replay !== null) return replay;
      }
    }
    if (!content.withinLimit) {
      throw new TypeError(`Lesson indexed text must not exceed ${MAX_INDEXED_TEXT_CHARS} characters`);
    }
    try {
      const result = await lessonStore.write('project', entry);
      projectAvailable = true;
      return result;
    } catch (error) {
      recordFailure('Curated lesson write failed', error);
      throw error;
    }
  }

  async function promoteLesson(input = {}) {
    if (!enabled) throw journalError('LESSON_DISABLED');
    if (projectKey === null || !projectAvailable) throw journalError('LESSON_PROJECT_UNAVAILABLE');
    const source = await lessonStore.read('project', input.lessonId);
    if (source === null) throw journalError('LESSON_NOT_FOUND');
    if (source.kind !== 'lesson') throw journalError('LESSON_WRONG_KIND');

    const content = sanitizedEntryContent(input);
    const knownProjectValues = new Set([source.id]);
    function addKnown(value) {
      if (typeof value === 'string' && value.length) knownProjectValues.add(value);
    }
    function addMetadata(entry) {
      addKnown(entry?.metadata?.projectKey);
      addKnown(entry?.metadata?.runId);
      if (Array.isArray(entry?.metadata?.observationIds)) {
        for (const observationId of entry.metadata.observationIds) addKnown(observationId);
      }
      if (Array.isArray(entry?.metadata?.files)) {
        for (const file of entry.metadata.files) addKnown(file);
      }
    }
    addMetadata(source);
    for (const path of pathTokensIn(source.body)) addKnown(path);
    for (const id of source.sourceIds) {
      addKnown(id);
      const linked = await lessonStore.read('project', id);
      if (linked?.kind === 'lesson-observation') {
        addMetadata(linked);
        for (const path of pathTokensIn(linked.body)) addKnown(path);
      }
      if (journalStore !== null && typeof journalStore.read === 'function') {
        const summary = await journalStore.read('project', id);
        if (summary?.kind === 'run-summary') addMetadata(summary);
      }
    }
    const supplied = [content.title, content.body, ...content.tags];
    if ([...knownProjectValues].some((value) => supplied.some((text) => text.includes(value)))) {
      throw journalError('LESSON_METADATA_LEAK');
    }

    const createdAt = oneLine(source.createdAt, MAX_IDENTIFIER_CHARS);
    if (createdAt === null) throw new TypeError('Promoted lesson requires a timestamp');
    const partial = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      scope: 'global',
      kind: 'promoted-lesson',
      title: content.title,
      createdAt,
      tags: content.tags,
      sourceIds: [],
      metadata: { originKind: source.kind },
      body: content.body,
    };
    const entry = { ...partial, id: stableContentId('promoted-lesson', partial) };
    if (content.withinRawInputLimits) {
      const legacy = legacyEntry('promoted-lesson', partial, content);
      if (!content.withinLimit || legacy.id !== entry.id) {
        const replay = await legacyReplay(lessonStore, 'global', 'promoted-lesson', legacy);
        if (replay !== null) return replay;
      }
    }
    if (!content.withinLimit) {
      throw new TypeError(`Lesson indexed text must not exceed ${MAX_INDEXED_TEXT_CHARS} characters`);
    }
    try {
      return await lessonStore.write('global', entry);
    } catch (error) {
      recordFailure('Lesson promotion failed', error);
      throw error;
    }
  }

  async function status() {
    let storeStatus = null;
    let searchStatus = null;
    let statusError = null;
    try {
      storeStatus = await lessonStore.status();
      if (typeof storeStatus?.project?.available === 'boolean') projectAvailable = storeStatus.project.available;
    } catch {
      statusError = 'Lesson store status unavailable';
      projectAvailable = false;
    }
    try {
      searchStatus = lessonSearch.status();
    } catch {
      statusError ??= 'Lesson search status unavailable';
    }
    return Object.freeze({
      enabled,
      projectAvailable,
      projected,
      backfilled,
      failures,
      lastError: statusError ?? lastError,
      errorCode,
      store: storeStatus,
      search: searchStatus,
    });
  }

  return Object.freeze({ projectLessons, recordLesson, promoteLesson, search, read, relevantLessons, consolidatedTop, backfill, status });
}
