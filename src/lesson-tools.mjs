// Lesson knowledge-base tools. Read access mirrors the journal tool surface
// (orchestrator, explorer, planner, plan critic); curated recording is root-
// orchestrator-only on terminal runs; global promotion additionally requires
// the native permission ask. Implementer, verifier and multimodal roles get
// none of these tools — they receive runner-injected lesson context instead.

import { tool } from '@opencode-ai/plugin/tool';
import { safeJournalStage } from './journal-errors.mjs';

const z = tool.schema;
const READ_ROLES = new Set(['graph-orchestrator', 'graph-explorer', 'graph-planner', 'graph-plan-critic']);
const ORCHESTRATOR = new Set(['graph-orchestrator']);
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED']);
const ID = /^[a-f0-9]{64}$/;
const SAFE_SERVICE_CODES = new Set([
  'LESSON_DISABLED',
  'LESSON_PROJECT_UNAVAILABLE',
  'LESSON_RUN_NOT_TERMINAL',
  'LESSON_NOT_FOUND',
  'LESSON_WRONG_KIND',
  'LESSON_METADATA_LEAK',
  'LESSON_INVALID_CATEGORY',
]);
const DETAILS = Object.freeze({
  LESSON_DISABLED: 'Lesson knowledge base is disabled',
  WRONG_ROLE: 'Lesson tool is not available to this role',
  NOT_GRAPH_SESSION: 'Lesson tools require a bound graph session',
  RUN_GONE: 'The bound graph run is unavailable',
  ROOT_REQUIRED: 'Lesson write tools require the root orchestrator',
  LESSON_RUN_NOT_TERMINAL: 'Curated lessons require a terminal graph run',
  LESSON_PROJECT_UNAVAILABLE: 'The project lesson store is unavailable',
  LESSON_NOT_FOUND: 'Lesson entry was not found',
  LESSON_WRONG_KIND: 'Only curated project lessons may be promoted; observation links must be observations',
  LESSON_METADATA_LEAK: 'Promotion content contains project-specific data',
  LESSON_INVALID_CATEGORY: 'Lesson category must be pitfall, surprise or repeated-mistake',
  LESSON_ERROR: 'Lesson operation failed',
});

function reply(payload) {
  return JSON.stringify(payload);
}

function rejected(code) {
  return reply({ ok: false, code, detail: DETAILS[code] ?? DETAILS.LESSON_ERROR });
}

function publicFailure(error) {
  return rejected(SAFE_SERVICE_CODES.has(error?.code) ? error.code : safeJournalStage(error?.code) ?? 'LESSON_ERROR');
}

const tags = () => z.array(z.string().min(1).max(128)).max(16).default([]);
const searchValues = (maxLength) => z.array(z.string().min(1).max(maxLength)).max(16).default([]);

export function createLessonTools({ lessonService, store, bindings, dispatches = null, enabled }) {
  async function authorized(context, roles, { root = false } = {}, operation) {
    if (!enabled) return rejected('LESSON_DISABLED');
    try {
      if (!roles.has(context?.agent)) return rejected('WRONG_ROLE');
      const binding = bindings.get(context?.sessionID);
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

  const graph_lesson_search = tool({
    description: 'Search bounded non-authoritative lesson knowledge bases (project and global): mechanical observations from finished runs plus curated lessons. Results include consolidated observation groups with occurrence counts.',
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
        const result = await lessonService.search(args);
        return reply({ ok: true, ...result });
      });
    },
  });

  const graph_lesson_read = tool({
    description: 'Read one project or global lesson entry (curated lesson, observation, or promoted lesson) by its lowercase SHA-256 ID.',
    args: {
      scope: z.enum(['project', 'global']),
      id: z.string().regex(ID),
    },
    async execute(args, context) {
      return authorized(context, READ_ROLES, {}, async () => {
        const entry = await lessonService.read(args.scope, args.id);
        return entry === null ? rejected('LESSON_NOT_FOUND') : reply({ ok: true, entry });
      });
    },
  });

  const graph_lesson_record = tool({
    description: 'Record a curated lesson on the current terminal run: an unexpected behavior or repeated mistake worth avoiding, with category, rule and trigger context. Mechanical observations are already projected automatically; use this to distill and refine them.',
    args: {
      title: z.string().min(1).max(512),
      body: z.string().min(1).max(32_000),
      category: z.enum(['pitfall', 'surprise', 'repeated-mistake']),
      tags: tags(),
      observationIds: z.array(z.string().regex(ID)).max(8).default([]),
    },
    async execute(args, context) {
      return authorized(context, ORCHESTRATOR, { root: true }, async ({ state }) => {
        if (!TERMINAL_STATUSES.has(state.status)) return rejected('LESSON_RUN_NOT_TERMINAL');
        const result = await lessonService.recordLesson(state, { ...args, tags: args.tags ?? [], observationIds: args.observationIds ?? [] });
        return reply({ ok: true, ...result });
      });
    },
  });

  const graph_lesson_promote = tool({
    description: 'Explicitly promote separately supplied, project-neutral lesson content to the global lesson knowledge base.',
    args: {
      lessonId: z.string().regex(ID),
      title: z.string().min(1).max(512),
      body: z.string().min(1).max(32_000),
      tags: tags(),
    },
    async execute(args, context) {
      return authorized(context, ORCHESTRATOR, { root: true }, async () => {
        const result = await lessonService.promoteLesson({ ...args, tags: args.tags ?? [] });
        return reply({ ok: true, ...result });
      });
    },
  });

  return Object.freeze({
    graph_lesson_search,
    graph_lesson_read,
    graph_lesson_record,
    graph_lesson_promote,
  });
}
