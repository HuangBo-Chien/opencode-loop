import { resolve } from 'node:path';
import { JOURNAL_SCHEMA_VERSION, stableJournalId } from './journal-store.mjs';
import { sanitizeJournalText } from './journal-text.mjs';

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED']);
const MAX_REQUEST_CHARS = 8000;
const MAX_BODY_CHARS = 32_000;
const MAX_TITLE_CHARS = 512;
const MAX_TEXT_CHARS = 1000;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_TAGS = 16;
const MAX_TAG_CHARS = 128;
const MAX_FILE_CHARS = 512;
const MAX_RECORDS = 64;
const MAX_DETAILS = 8;
const MAX_DETAIL_ITEMS = 4;
const MAX_VIOLATIONS = 16;
const MAX_PENDING_BACKFILL_RUNS = 64;
const MAX_BACKFILL_OFFSET = 1_000_000;

function sanitizedText(value, limit = MAX_TEXT_CHARS) {
  if (typeof value !== 'string') return null;
  const result = sanitizeJournalText(value, limit);
  return result.text.length ? result : null;
}

function oneLine(value, limit = MAX_IDENTIFIER_CHARS) {
  const sanitized = sanitizedText(value, limit);
  if (sanitized === null) return null;
  const text = sanitized.text.replace(/\s+/g, ' ').trim();
  return text.length ? text.slice(0, limit) : null;
}

function boundedStrings(value, { limit = MAX_DETAIL_ITEMS, textLimit = MAX_TEXT_CHARS } = {}) {
  if (!Array.isArray(value)) return [];
  const values = [];
  for (let index = 0; index < value.length && index < limit; index += 1) {
    const sanitized = sanitizedText(value[index], textLimit);
    if (sanitized !== null) values.push(sanitized.text);
  }
  return values;
}

function requestSummary(state) {
  const request = state?.request;
  const sanitized = sanitizedText(request?.text, MAX_REQUEST_CHARS);
  if (sanitized === null) {
    return { available: false, redactions: 0, text: null, truncated: false };
  }
  return {
    available: true,
    redactions: (Number.isInteger(request?.redactions) && request.redactions >= 0 ? request.redactions : 0) + sanitized.redactions,
    text: sanitized.text,
    truncated: request?.truncated === true || sanitized.truncated,
  };
}

function nodeSummaries(state) {
  const summaries = [];
  const nodes = state?.nodes;
  if (nodes === null || typeof nodes !== 'object' || Array.isArray(nodes)) return summaries;
  let inspected = 0;
  for (const key in nodes) {
    if (!Object.hasOwn(nodes, key)) continue;
    if (inspected >= MAX_RECORDS) break;
    inspected += 1;
    const node = nodes[key];
    const id = oneLine(node?.spec?.id ?? key);
    const kind = oneLine(node?.spec?.kind);
    const nodeState = oneLine(node?.state);
    if (id === null || kind === null || nodeState === null) continue;
    summaries.push({
      attempt: Number.isInteger(node?.attempt) && node.attempt >= 0 ? node.attempt : 0,
      id,
      kind,
      state: nodeState,
    });
  }
  summaries.sort((left, right) => left.id.localeCompare(right.id));
  return summaries;
}

function artifactSummaries(state) {
  const artifacts = [];
  const changes = [];
  const verifications = [];
  const files = new Set();
  const source = state?.artifacts;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return { artifacts, changes, files: [], verifications };
  }

  let inspected = 0;
  for (const name in source) {
    if (!Object.hasOwn(source, name)) continue;
    if (inspected >= MAX_RECORDS) break;
    inspected += 1;
    const artifact = source[name];
    const boundedName = oneLine(name);
    const kind = oneLine(artifact?.kind);
    const status = oneLine(artifact?.status);
    const version = Number.isInteger(artifact?.version) && artifact.version >= 0 ? artifact.version : 0;
    if (boundedName === null || kind === null || status === null) continue;
    const ref = oneLine(`${boundedName}@${version}`);
    if (ref === null) continue;
    artifacts.push({ kind, ref, status, version });

    if (kind === 'change' && changes.length < MAX_DETAILS) {
      const changeFiles = boundedStrings(artifact?.payload?.filesTouched, {
        limit: MAX_DETAIL_ITEMS,
        textLimit: MAX_FILE_CHARS,
      });
      for (const file of changeFiles) {
        if (files.size < MAX_RECORDS) files.add(file);
      }
      changes.push({
        files: changeFiles,
        nodeId: oneLine(artifact?.nodeId),
        ref,
        summary: sanitizedText(artifact?.payload?.summary)?.text ?? null,
        unresolved: boundedStrings(artifact?.payload?.unresolved),
      });
    }

    if (kind === 'verification' && verifications.length < MAX_DETAILS) {
      const commands = [];
      const sourceCommands = artifact?.payload?.commands;
      if (Array.isArray(sourceCommands)) {
        for (let index = 0; index < sourceCommands.length && index < MAX_DETAIL_ITEMS; index += 1) {
          const command = sanitizedText(sourceCommands[index]?.command)?.text;
          if (command === undefined) continue;
          commands.push({
            command,
            exitCode: Number.isInteger(sourceCommands[index]?.exitCode) ? sourceCommands[index].exitCode : null,
          });
        }
      }
      verifications.push({
        commands,
        nodeId: oneLine(artifact?.nodeId),
        ref,
        summary: sanitizedText(artifact?.payload?.summary)?.text ?? null,
      });
    }
  }

  artifacts.sort((left, right) => left.ref.localeCompare(right.ref));
  changes.sort((left, right) => left.ref.localeCompare(right.ref));
  verifications.sort((left, right) => left.ref.localeCompare(right.ref));
  return { artifacts, changes, files: [...files].sort(), verifications };
}

function violationSummaries(state) {
  if (!Array.isArray(state?.violations)) return [];
  const violations = [];
  for (let index = 0; index < state.violations.length && index < MAX_VIOLATIONS; index += 1) {
    const violation = state.violations[index];
    const kind = oneLine(violation?.kind);
    const detail = sanitizedText(violation?.detail)?.text;
    if (kind === null || detail === undefined) continue;
    violations.push({
      at: oneLine(violation?.at, 128),
      detail,
      kind,
      nodeId: oneLine(violation?.nodeId),
    });
  }
  return violations;
}

function boundedBody(lines) {
  const sanitized = sanitizeJournalText(lines.join('\n'), MAX_BODY_CHARS);
  if (!sanitized.truncated) return sanitized.text;
  const marker = '\n\n[truncated]';
  return `${sanitized.text.slice(0, MAX_BODY_CHARS - marker.length)}${marker}`;
}

function journalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sanitizedEntryContent({ title, body, tags = [] } = {}) {
  const sanitizedTitle = oneLine(title, MAX_TITLE_CHARS);
  const sanitizedBody = sanitizedText(body, MAX_BODY_CHARS)?.text ?? null;
  if (sanitizedTitle === null || sanitizedBody === null) throw new TypeError('Journal title and body must be nonempty strings');
  if (!Array.isArray(tags)) throw new TypeError('Journal tags must be an array');
  const sanitizedTags = [];
  for (let index = 0; index < tags.length && index < MAX_TAGS; index += 1) {
    const tag = oneLine(tags[index], MAX_TAG_CHARS);
    if (tag === null) throw new TypeError('Journal tags must contain nonempty strings');
    if (!sanitizedTags.includes(tag)) sanitizedTags.push(tag);
  }
  return { title: sanitizedTitle, body: sanitizedBody, tags: sanitizedTags };
}

function stableContentId(kind, entry) {
  const { id: _id, ...content } = entry;
  return stableJournalId(kind, content);
}

function renderBody(summary) {
  const lines = [
    `# ${summary.title}`,
    '',
    '## Run',
    `- Intent: ${summary.metadata.intent}`,
    `- Status: ${summary.metadata.status}`,
    `- Created: ${summary.metadata.createdAt}`,
    `- Updated: ${summary.metadata.updatedAt}`,
    '',
    '## Initial request',
    summary.metadata.request.available ? summary.metadata.request.text : '[unavailable]',
  ];
  if (summary.metadata.request.truncated) lines.push('', '[truncated]');

  lines.push('', '## Nodes');
  if (!summary.metadata.nodes.length) lines.push('- None');
  for (const node of summary.metadata.nodes) {
    lines.push(`- ${node.id} | ${node.kind} | ${node.state} | attempt ${node.attempt}`);
  }

  lines.push('', '## Artifacts');
  if (!summary.metadata.artifacts.length) lines.push('- None');
  for (const artifact of summary.metadata.artifacts) {
    lines.push(`- ${artifact.ref} | ${artifact.kind} | version ${artifact.version} | ${artifact.status}`);
  }

  lines.push('', '## Changes');
  if (!summary.metadata.changes.length) lines.push('None.');
  for (const change of summary.metadata.changes) {
    lines.push(`### ${change.ref}`, `Node: ${change.nodeId ?? '[unavailable]'}`, 'Files:');
    lines.push(...(change.files.length ? change.files.map((file) => `- ${file}`) : ['- None']));
    lines.push('Summary:', change.summary ?? '[unavailable]', 'Unresolved:');
    lines.push(...(change.unresolved.length ? change.unresolved.map((item) => `- ${item}`) : ['- None']));
  }

  lines.push('', '## Verification');
  if (!summary.metadata.verifications.length) lines.push('None.');
  for (const verification of summary.metadata.verifications) {
    lines.push(`### ${verification.ref}`, `Node: ${verification.nodeId ?? '[unavailable]'}`, 'Commands:');
    lines.push(...(verification.commands.length
      ? verification.commands.map((command) => `- ${command.command}, exit ${command.exitCode ?? 'unavailable'}`)
      : ['- None']));
    lines.push('Summary:', verification.summary ?? '[unavailable]');
  }

  lines.push('', '## Failure', summary.metadata.failReason ?? 'None.', '', '## Violations');
  if (!summary.metadata.violations.length) lines.push('- None');
  for (const violation of summary.metadata.violations) {
    lines.push(`- ${violation.kind} | node ${violation.nodeId ?? '[unavailable]'} | ${violation.detail} | ${violation.at ?? '[unavailable]'}`);
  }
  return boundedBody(lines);
}

function createRunSummary(state, projectKey) {
  const runId = oneLine(state?.runId, 128);
  if (runId === null) throw new TypeError('Run summary requires a run id');
  const request = requestSummary(state);
  const intent = oneLine(state?.mode, 64) ?? 'unknown';
  const status = oneLine(state?.status, 64);
  if (!TERMINAL_STATUSES.has(status)) throw new TypeError('Run summary requires a terminal status');
  const createdAt = oneLine(state?.createdAt, 128) ?? '[unavailable]';
  const updatedAt = oneLine(state?.updatedAt, 128) ?? createdAt;
  const nodes = nodeSummaries(state);
  const { artifacts, changes, files, verifications } = artifactSummaries(state);
  const violations = violationSummaries(state);
  const failReason = sanitizedText(state?.failReason)?.text ?? null;
  const firstRequestLine = request.available ? request.text.split('\n', 1)[0] : null;
  const title = oneLine(firstRequestLine, 512) ?? 'Run summary';
  const metadata = {
    artifacts,
    changes,
    createdAt,
    failReason,
    files,
    intent,
    nodes,
    projectKey,
    request,
    runId,
    status,
    updatedAt,
    verifications,
    violations,
  };
  const summary = { metadata, title };
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    id: stableJournalId('run-summary', projectKey, runId),
    scope: 'project',
    kind: 'run-summary',
    title,
    createdAt: updatedAt,
    tags: [...new Set([intent, status])],
    sourceIds: [],
    metadata,
    body: renderBody(summary),
  };
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer from 1 to 1000');
  return limit;
}

export function createJournalService({ runStore, journalStore, journalSearch, enabled = true, worktree } = {}) {
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
  let lastError = enabled && projectKey === null ? 'Project journal unavailable' : null;

  function recordFailure(message, error) {
    failures += 1;
    lastError = message;
    if (error?.code === 'PROJECT_WORKTREE_UNAVAILABLE') projectAvailable = false;
  }

  async function projectRun(state) {
    try {
      if (!enabled) return Object.freeze({ created: false, reason: 'disabled' });
      if (projectKey === null) return Object.freeze({ created: false, reason: 'project-unavailable' });
      if (!TERMINAL_STATUSES.has(state?.status)) return Object.freeze({ created: false, reason: 'nonterminal' });
      const runId = oneLine(state?.runId, 128);
      if (runId === null) throw new TypeError('Run projection requires a run id');
      const id = stableJournalId('run-summary', projectKey, runId);
      let flight = flights.get(id);
      let owner = false;
      if (flight === undefined) {
        owner = true;
        flight = (async () => {
          try {
            if (await journalStore.exists('project', id)) {
              projectAvailable = true;
              return Object.freeze({ created: false, id, reason: 'exists' });
            }
            const result = await journalStore.write('project', createRunSummary(state, projectKey));
            const created = result?.created !== false;
            if (created) projected += 1;
            projectAvailable = true;
            return Object.freeze({ created, id, reason: created ? 'projected' : 'exists' });
          } catch (error) {
            recordFailure('Journal projection failed', error);
            return Object.freeze({ created: false, failed: true, id, reason: 'projection-failed' });
          }
        })();
        flights.set(id, flight);
      }
      try {
        return await flight;
      } finally {
        if (owner && flights.get(id) === flight) flights.delete(id);
      }
    } catch (error) {
      recordFailure('Journal projection failed', error);
      return Object.freeze({ created: false, failed: true, reason: 'projection-failed' });
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
      recordFailure('Journal backfill failed', error);
      report.failures += 1;
      return Object.freeze(report);
    }

    const pageLength = Math.min(runIds.length, limit);
    for (let index = 0; index < pageLength; index += 1) {
      report.inspected += 1;
      try {
        const runId = runIds[index];
        const id = stableJournalId('run-summary', projectKey, runId);
        if (await journalStore.exists('project', id)) {
          report.skipped += 1;
          continue;
        }
        const state = await runStore.loadRun(runId);
        if (state === null) throw new Error('Run could not be loaded');
        if (!TERMINAL_STATUSES.has(state.status)) {
          report.skipped += 1;
          continue;
        }
        const result = await projectRun(state);
        if (result.failed) report.failures += 1;
        else if (result.created) {
          report.projected += 1;
          backfilled += 1;
        } else report.skipped += 1;
      } catch (error) {
        recordFailure('Journal backfill failed', error);
        report.failures += 1;
      }
    }
    const nextOffset = offset + pageLength;
    backfillOffset = pageLength < limit || nextOffset > MAX_BACKFILL_OFFSET ? 0 : nextOffset;
    return Object.freeze(report);
  }

  async function backfill({ limit = 64 } = {}) {
    validateLimit(limit);
    if (backfillFlight !== null) return backfillFlight;
    const flight = runBackfill(limit);
    backfillFlight = flight;
    try {
      return await flight;
    } finally {
      if (backfillFlight === flight) backfillFlight = null;
    }
  }

  async function search(args) {
    await backfill();
    return journalSearch.search(args);
  }

  function read(scope, id) {
    return journalStore.read(scope, id);
  }

  async function writeInsight(state, input) {
    if (!enabled) throw journalError('JOURNAL_DISABLED');
    if (projectKey === null || !projectAvailable) throw journalError('JOURNAL_PROJECT_UNAVAILABLE');
    const status = state?.status;
    if (!TERMINAL_STATUSES.has(status)) throw journalError('JOURNAL_RUN_NOT_TERMINAL');
    const runId = oneLine(state?.runId, MAX_IDENTIFIER_CHARS);
    if (runId === null) throw new TypeError('Project insight requires a run id');
    const content = sanitizedEntryContent(input);
    const sourceId = stableJournalId('run-summary', projectKey, runId);
    const projection = await projectRun(state);
    if (projection.failed || projection.id !== sourceId) {
      throw journalError(projectAvailable ? 'JOURNAL_ERROR' : 'JOURNAL_PROJECT_UNAVAILABLE');
    }
    const createdAt = oneLine(state?.updatedAt ?? state?.createdAt, MAX_IDENTIFIER_CHARS);
    if (createdAt === null) throw new TypeError('Project insight requires a timestamp');
    const metadata = { projectKey, runId, status };
    const partial = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      scope: 'project',
      kind: 'insight',
      title: content.title,
      createdAt,
      tags: content.tags,
      sourceIds: [sourceId],
      metadata,
      body: content.body,
    };
    const entry = { ...partial, id: stableContentId('insight', partial) };
    try {
      const result = await journalStore.write('project', entry);
      projectAvailable = true;
      return result;
    } catch (error) {
      recordFailure('Journal insight write failed', error);
      throw error;
    }
  }

  async function promote(input = {}) {
    if (!enabled) throw journalError('JOURNAL_DISABLED');
    if (projectKey === null || !projectAvailable) throw journalError('JOURNAL_PROJECT_UNAVAILABLE');
    const source = await journalStore.read('project', input.insightId);
    if (source === null) throw journalError('JOURNAL_NOT_FOUND');
    if (source.kind !== 'insight') throw journalError('JOURNAL_WRONG_KIND');

    const content = sanitizedEntryContent(input);
    const knownProjectValues = new Set([source.id]);
    function addKnown(value) {
      if (typeof value === 'string' && value.length) knownProjectValues.add(value);
    }
    function addMetadata(entry) {
      addKnown(entry?.metadata?.projectKey);
      addKnown(entry?.metadata?.runId);
      if (Array.isArray(entry?.metadata?.files)) {
        for (const file of entry.metadata.files) addKnown(file);
      }
    }
    addMetadata(source);
    if (Array.isArray(source.sourceIds)) {
      for (const id of source.sourceIds) {
        addKnown(id);
        const linked = await journalStore.read('project', id);
        if (linked?.kind === 'run-summary') addMetadata(linked);
      }
    }
    const supplied = [content.title, content.body, ...content.tags];
    if ([...knownProjectValues].some((value) => supplied.some((text) => text.includes(value)))) {
      throw journalError('JOURNAL_METADATA_LEAK');
    }

    const createdAt = oneLine(source.createdAt, MAX_IDENTIFIER_CHARS);
    if (createdAt === null) throw new TypeError('Promoted insight requires a timestamp');
    const metadata = { originKind: source.kind };
    const partial = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      scope: 'global',
      kind: 'promoted-insight',
      title: content.title,
      createdAt,
      tags: content.tags,
      sourceIds: [],
      metadata,
      body: content.body,
    };
    const entry = { ...partial, id: stableContentId('promoted-insight', partial) };
    try {
      return await journalStore.write('global', entry);
    } catch (error) {
      recordFailure('Journal promotion failed', error);
      throw error;
    }
  }

  async function status() {
    let storeStatus = null;
    let searchStatus = null;
    let statusError = null;
    try {
      storeStatus = await journalStore.status();
      if (typeof storeStatus?.project?.available === 'boolean') projectAvailable = storeStatus.project.available;
    } catch {
      statusError = 'Journal store status unavailable';
      projectAvailable = false;
    }
    try {
      searchStatus = await journalSearch.status();
    } catch {
      statusError ??= 'Journal search status unavailable';
    }

    const pending = { count: 0, inspected: 0, truncated: false };
    if (enabled && projectKey !== null && projectAvailable) {
      let runIds;
      try {
        runIds = await runStore.listRunIds({ limit: MAX_PENDING_BACKFILL_RUNS });
        if (!Array.isArray(runIds)) throw new TypeError('Run store must return run ids');
        pending.truncated = runIds.length >= MAX_PENDING_BACKFILL_RUNS;
      } catch {
        runIds = undefined;
        statusError ??= 'Journal pending backfill status unavailable';
      }

      if (runIds !== undefined) {
        for (let index = 0; index < runIds.length && index < MAX_PENDING_BACKFILL_RUNS; index += 1) {
          pending.inspected += 1;
          try {
            const runId = runIds[index];
            const id = stableJournalId('run-summary', projectKey, runId);
            if (await journalStore.exists('project', id)) continue;
            const state = await runStore.loadRun(runId);
            if (TERMINAL_STATUSES.has(state?.status)) pending.count += 1;
          } catch (error) {
            if (error?.code === 'PROJECT_WORKTREE_UNAVAILABLE') {
              projectAvailable = false;
              pending.count = 0;
              pending.inspected = 0;
              pending.truncated = false;
              statusError ??= 'Project journal unavailable';
              break;
            }
            statusError ??= 'Journal pending backfill status unavailable';
          }
        }
      }
    }
    return Object.freeze({
      enabled,
      projectAvailable,
      projected,
      backfilled,
      failures,
      lastError: statusError ?? lastError,
      pendingBackfill: Object.freeze(pending),
      store: storeStatus,
      search: searchStatus,
    });
  }

  return Object.freeze({ projectRun, backfill, search, read, writeInsight, promote, status });
}

export function createJournaledRunStore(runStore, journalService) {
  async function saveRun(state) {
    const saved = await runStore.saveRun(state);
    try {
      await journalService.projectRun(saved);
    } catch {
      // Projection is advisory and cannot change authoritative runner persistence.
    }
    return saved;
  }

  return Object.freeze({
    createRun(...args) { return runStore.createRun(...args); },
    loadRun(...args) { return runStore.loadRun(...args); },
    getRun(...args) { return runStore.getRun(...args); },
    saveRun,
    releaseRun(...args) { return runStore.releaseRun(...args); },
    listRunIds(...args) { return runStore.listRunIds(...args); },
    hashFiles(...args) { return runStore.hashFiles(...args); },
    get persistent() { return runStore.persistent; },
  });
}
