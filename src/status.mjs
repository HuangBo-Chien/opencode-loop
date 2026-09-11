import { readFileSync } from 'node:fs';
import { tool } from '@opencode-ai/plugin/tool';
import { MODEL_DTYPE, MODEL_NAME, MODEL_REVISION } from './embeddings.mjs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const GLOBAL_JOURNAL_LABEL = '~/.config/opencode/opencode-loop/journal';
const SAFE_JOURNAL_ERRORS = new Set([
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
    storage: Object.freeze({
      project: `${options.stateDirectory}/journal`,
      global: GLOBAL_JOURNAL_LABEL,
    }),
  });
}

export function createStatusTool(options, journalService) {
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
      return JSON.stringify({
        package: 'opencode-loop', version,
        workflowMode: 'gated',
        enforcement: 'tool-execute-hooks',
        enforcementScope: 'GRAPH_MANAGED_SESSIONS',
        enforcementDetail: 'Dispatch admission, write-scope confinement, bash deferral, attempt counters, verdict gates (PASS/REVISE/FAIL/BLOCKED) and version-bound evidence are enforced mechanically via tool.execute.before/after, permission.ask and session events. Reads remain unrestricted; a rejected task dispatch is rewritten into an explicit RUNNER_REJECTED child turn instead of aborting the tool call.',
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
      });
    },
  });
}
