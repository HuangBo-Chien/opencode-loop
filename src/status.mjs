import { readFileSync } from 'node:fs';
import { tool } from '@opencode-ai/plugin/tool';
import { MODEL_DTYPE, MODEL_NAME, MODEL_REVISION } from './embeddings.mjs';
import { JOURNAL_STAGE_ERRORS, safeJournalStage } from './journal-errors.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const GLOBAL_JOURNAL_LABEL = '~/.config/opencode/opencode-loop/journal';
const SAFE_JOURNAL_ERRORS = new Set([
  ...Object.values(JOURNAL_STAGE_ERRORS),
  'Project journal unavailable',
  'Journal projection failed',
  'Journal backfill failed',
  'Journal insight write failed',
  'Journal promotion failed',
  'Journal store status unavailable',
  'Journal search status unavailable',
  'Journal pending backfill status unavailable',
  'Semantic search unavailable; using text fallback',
]);

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeError(value) {
  if (value === null || value === undefined) return null;
  return SAFE_JOURNAL_ERRORS.has(value) ? value : 'Journal operation failed';
}

function journalStatus(options, runtime, unavailable) {
  const enabled = options.journal.enabled;
  const semanticSearch = options.journal.semanticSearch;
  const searchDegraded = unavailable || runtime?.search === null || runtime?.search === undefined
    || runtime.search.lastError !== null && runtime.search.lastError !== undefined;
  const project = Object.freeze({
    entries: count(runtime?.store?.project?.entries),
    corrupt: count(runtime?.store?.project?.corrupt),
  });
  const global = Object.freeze({
    entries: count(runtime?.store?.global?.entries),
    corrupt: count(runtime?.store?.global?.corrupt),
  });
  const pendingBackfill = Object.freeze({
    count: count(runtime?.pendingBackfill?.count),
    inspected: count(runtime?.pendingBackfill?.inspected),
    truncated: runtime?.pendingBackfill?.truncated === true,
  });
  const reportedError = runtime?.lastError ?? runtime?.search?.lastError;
  return Object.freeze({
    enabled,
    includeUserRequest: options.journal.includeUserRequest,
    rawRequestsRetained: enabled && options.journal.includeUserRequest,
    semanticSearch,
    model: MODEL_NAME,
    revision: MODEL_REVISION,
    dtype: MODEL_DTYPE,
    searchMode: !enabled ? 'disabled' : (!semanticSearch || searchDegraded ? 'text-fallback' : 'hybrid'),
    projectAvailable: unavailable ? false : runtime?.projectAvailable === true,
    project,
    global,
    corruptionCount: count(runtime?.store?.corruptionCount) || project.corrupt + global.corrupt,
    pendingBackfill,
    projected: count(runtime?.projected),
    backfilled: count(runtime?.backfilled),
    failures: count(runtime?.failures),
    lastError: unavailable ? 'Journal status unavailable' : safeError(reportedError),
    errorCode: safeJournalStage(runtime?.search?.errorCode) ?? safeJournalStage(runtime?.errorCode),
    embedding: Object.freeze({
      state: ['idle', 'loading', 'ready', 'degraded'].includes(runtime?.search?.provider?.state) ? runtime.search.provider.state : 'unknown',
      initializationAttempts: Math.min(3, count(runtime?.search?.provider?.initializationAttempts)),
      nextRetryAt: Number.isSafeInteger(runtime?.search?.provider?.nextRetryAt) && runtime.search.provider.nextRetryAt >= 0 ? runtime.search.provider.nextRetryAt : null,
    }),
    storage: Object.freeze({
      project: `${options.stateDirectory}/journal`,
      global: GLOBAL_JOURNAL_LABEL,
    }),
  });
}

function lessonsStatus(options, runtime, unavailable) {
  const enabled = options.lessons.enabled;
  return Object.freeze({
    enabled,
    injectMax: options.lessons.injectMax,
    projectAvailable: unavailable ? false : runtime?.projectAvailable === true,
    projected: count(runtime?.projected),
    backfilled: count(runtime?.backfilled),
    failures: count(runtime?.failures),
    lastError: unavailable ? 'Lesson status unavailable' : runtime?.lastError ?? null,
    store: Object.freeze({
      project: Object.freeze({ entries: count(runtime?.store?.project?.entries), corrupt: count(runtime?.store?.project?.corrupt) }),
      global: Object.freeze({ entries: count(runtime?.store?.global?.entries), corrupt: count(runtime?.store?.global?.corrupt) }),
    }),
    storage: Object.freeze({
      project: `${options.stateDirectory}/lessons`,
      global: '~/.config/opencode/opencode-loop/lessons',
    }),
  });
}

export function createStatusTool(options, journalService, lessonService = null) {
  return tool({
    description: 'Report plugin capabilities and enforcement scope. Does not start, inspect, or mutate graph runs (use graph_inspect / graph_run_resume).',
    args: {},
    async execute() {
      let runtime = null;
      let unavailable = false;
      try {
        runtime = await journalService.status();
        if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) throw new TypeError('Invalid journal status');
      } catch {
        unavailable = true;
      }
      let lessonRuntime = null;
      let lessonUnavailable = lessonService === null;
      if (lessonService !== null) {
        try {
          lessonRuntime = await lessonService.status();
          if (lessonRuntime === null || typeof lessonRuntime !== 'object' || Array.isArray(lessonRuntime)) throw new TypeError('Invalid lesson status');
        } catch {
          lessonUnavailable = true;
        }
      }
      return JSON.stringify({
        package: 'opencode-loop', version,
        workflowMode: 'gated',
        enforcement: 'tool-execute-hooks',
        enforcementScope: 'GRAPH_MANAGED_SESSIONS',
        enforcementDetail: 'Dispatch admission reserves work by callID; host task metadata and parentage bind sessions before attempts begin. Scope, bash, verdict and evidence gates use tool.execute.before/after hooks and native permissions. Unresolved child bindings fail closed. Rejected task dispatches receive a fresh RUNNER_REJECTED child turn.',
        enforcementAttested: false,
        runtimeAvailable: true,
        managedRuntimeStatus: 'available',
        limitsEnforced: true,
        reason: 'Mechanical gates are active for graph-managed sessions and covered by unit and hook-simulation tests; real-model workflow acceptance on a locked host build is separate evidence.',
        limits: {
          maxAttempts: options.maxAttempts, maxParallel: options.maxParallel,
          maxImplementerParallel: options.maxImplementerParallel, maxPlanRevisions: options.maxPlanRevisions,
        },
        stateDirectory: options.stateDirectory,
        journal: journalStatus(options, runtime, unavailable),
        lessons: lessonsStatus(options, lessonRuntime, lessonUnavailable),
      });
    },
  });
}
