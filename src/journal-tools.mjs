import { tool } from '@opencode-ai/plugin/tool';
import { JOURNAL_STAGE_ERRORS, safeJournalStage } from './journal-errors.mjs';
import { MAX_AUTHORED_BODY_INPUT_CHARS } from './journal-text.mjs';

const z = tool.schema;
const READ_ROLES = new Set(['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic']);
const ORCHESTRATOR = new Set(['graph-orchestrator']);
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED']);
const ID = /^[a-f0-9]{64}$/;
const SAFE_SERVICE_CODES = new Set([
  'JOURNAL_DISABLED',
  'JOURNAL_PROJECT_UNAVAILABLE',
  'JOURNAL_RUN_NOT_TERMINAL',
  'JOURNAL_NOT_FOUND',
  'JOURNAL_WRONG_KIND',
  'JOURNAL_METADATA_LEAK',
]);
const DETAILS = Object.freeze({
  ...JOURNAL_STAGE_ERRORS,
  JOURNAL_DISABLED: 'Journal is disabled',
  WRONG_ROLE: 'Journal tool is not available to this role',
  NOT_GRAPH_SESSION: 'Journal tools require a bound graph session',
  RUN_GONE: 'The bound graph run is unavailable',
  ROOT_REQUIRED: 'Journal write tools require the root orchestrator',
  JOURNAL_RUN_NOT_TERMINAL: 'Project insights require a terminal graph run',
  JOURNAL_PROJECT_UNAVAILABLE: 'The project journal is unavailable',
  JOURNAL_NOT_FOUND: 'Journal entry was not found',
  JOURNAL_WRONG_KIND: 'Only project insights may be promoted',
  JOURNAL_METADATA_LEAK: 'Promotion content contains project-specific data',
  JOURNAL_ERROR: 'Journal operation failed',
});

function reply(payload) {
  return JSON.stringify(payload);
}

function rejected(code) {
  return reply({ ok: false, code, detail: DETAILS[code] ?? DETAILS.JOURNAL_ERROR });
}

function publicFailure(error) {
  return rejected(SAFE_SERVICE_CODES.has(error?.code) ? error.code : safeJournalStage(error?.code) ?? 'JOURNAL_ERROR');
}

const tags = () => z.array(z.string().min(1).max(128)).max(16).default([]);
const searchValues = (maxLength) => z.array(z.string().min(1).max(maxLength)).max(16).default([]);

export function createJournalTools({ journalService, store, bindings, dispatches = null, enabled }) {
  async function authorized(context, roles, { root = false } = {}, operation) {
    if (!enabled) return rejected('JOURNAL_DISABLED');
    try {
      if (!roles.has(context?.agent)) return rejected('WRONG_ROLE');
      const binding = bindings.get(context?.sessionID);
      // Read access stays available to managed children whose own binding is
      // gone (finished dispatch, terminated run): resolve the owning run
      // through the host-verified parent chain.
      const runId = binding?.runId ?? (dispatches ? dispatches.runForSession(context.sessionID) : null);
      if (!runId) return rejected('NOT_GRAPH_SESSION');
      if (binding && binding.agent !== context.agent) return rejected('WRONG_ROLE');
      const state = store.getRun(runId);
      if (!state || state.runId !== runId) return rejected('RUN_GONE');
      if (root && (!binding?.root || state.rootSessionId !== context.sessionID)) return rejected('ROOT_REQUIRED');
      return await operation({ binding, state });
    } catch (error) {
      return publicFailure(error);
    }
  }

  const graph_journal_search = tool({
    description: 'Search bounded non-authoritative project and global journal history.',
    args: {
      query: z.string().min(1).max(8000).optional(),
      scope: z.enum(['project', 'global', 'both']).default('both'),
      kinds: searchValues(128),
      statuses: searchValues(128),
      tags: searchValues(128),
      files: searchValues(512),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async execute(args, context) {
      return authorized(context, READ_ROLES, {}, async () => {
        const result = await journalService.search(args);
        return reply({ ok: true, ...result });
      });
    },
  });

  const graph_journal_read = tool({
    description: 'Read one project or global journal entry by its lowercase SHA-256 ID.',
    args: {
      scope: z.enum(['project', 'global']),
      id: z.string().regex(ID),
    },
    async execute(args, context) {
      return authorized(context, READ_ROLES, {}, async () => {
        const entry = await journalService.read(args.scope, args.id);
        return entry === null ? rejected('JOURNAL_NOT_FOUND') : reply({ ok: true, entry });
      });
    },
  });

  const graph_journal_write_insight = tool({
    description: 'Write a sanitized project insight linked to the current terminal run summary.',
    args: {
      title: z.string().min(1).max(512),
      body: z.string().min(1).max(MAX_AUTHORED_BODY_INPUT_CHARS),
      tags: tags(),
    },
    async execute(args, context) {
      return authorized(context, ORCHESTRATOR, { root: true }, async ({ state }) => {
        if (!TERMINAL_STATUSES.has(state.status)) return rejected('JOURNAL_RUN_NOT_TERMINAL');
        const result = await journalService.writeInsight(state, { ...args, tags: args.tags ?? [] });
        return reply({ ok: true, ...result });
      });
    },
  });

  const graph_journal_promote = tool({
    description: 'Explicitly promote separately supplied, project-neutral insight content to the global journal.',
    args: {
      insightId: z.string().regex(ID),
      title: z.string().min(1).max(512),
      body: z.string().min(1).max(MAX_AUTHORED_BODY_INPUT_CHARS),
      tags: tags(),
    },
    async execute(args, context) {
      return authorized(context, ORCHESTRATOR, { root: true }, async () => {
        const result = await journalService.promote({ ...args, tags: args.tags ?? [] });
        return reply({ ok: true, ...result });
      });
    },
  });

  return Object.freeze({
    graph_journal_search,
    graph_journal_read,
    graph_journal_write_insight,
    graph_journal_promote,
  });
}
