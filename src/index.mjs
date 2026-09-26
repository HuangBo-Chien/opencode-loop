import { parseOptions, resolveWorktree } from './config.mjs';
import { registerAgents } from './agents.mjs';
import { createStatusTool } from './status.mjs';
import { createRunStore } from './run-state.mjs';
import { createPersistenceLogger } from './run-state-write.mjs';
import { createReliableRunStore } from './run-reliability.mjs';
import { createSettlementController } from './settlement.mjs';
import { createRunAccounting } from './run-accounting.mjs';
import { createRunner } from './runner.mjs';
import { createSubmitTools } from './submit.mjs';
import { createEnforcement } from './enforcement.mjs';
import { createEmbeddingProvider } from './embeddings.mjs';
import { createJournalSearch } from './journal-search.mjs';
import { createJournalStore } from './journal-store.mjs';
import { createJournalService, createJournaledRunStore } from './journal.mjs';
import { createJournalTools } from './journal-tools.mjs';
import { createLessonService, LESSON_KINDS } from './lessons.mjs';
import { createLessonTools } from './lesson-tools.mjs';
import { createTaskDefinitionHook } from './task-definition.mjs';

export default async function GraphPlugin(context, options = {}) {
  const settings = parseOptions(options);
  if (!settings.enabled) return {};
  const worktree = resolveWorktree(context);

  const persistenceLog = createPersistenceLogger(context.client);
  const accounting = createRunAccounting({ worktree, stateDirectory: settings.stateDirectory, enabled: settings.phaseAccounting });
  const baseStore = createReliableRunStore(createRunStore({ worktree, stateDirectory: settings.stateDirectory,
    onPersistenceEvent: event => { accounting.persistence(event); return persistenceLog(event); } }),
    { onCommit: accounting.commit, onFault: event => persistenceLog({ ...event, phase: 'failed', stage: 'publication' }) });
  const journalStore = createJournalStore({ worktree, stateDirectory: settings.stateDirectory });
  const lessonStore = createJournalStore({ worktree, stateDirectory: settings.stateDirectory, subdirectory: 'lessons', kinds: LESSON_KINDS });
  const embeddingProvider = createEmbeddingProvider();
  const journalSearch = createJournalSearch({
    store: journalStore,
    embeddingProvider,
    semanticSearch: settings.journal.semanticSearch,
  });
  const lessonSearch = createJournalSearch({
    store: lessonStore,
    embeddingProvider,
    semanticSearch: settings.journal.semanticSearch,
  });
  const journalService = createJournalService({
    runStore: baseStore,
    journalStore,
    journalSearch,
    enabled: settings.journal.enabled,
    worktree,
  });
  const lessonService = createLessonService({
    runStore: baseStore,
    lessonStore,
    lessonSearch,
    journalStore,
    enabled: settings.lessons.enabled,
    worktree,
  });
  const store = createJournaledRunStore(baseStore, journalService, lessonService);
  const runner = createRunner({ maxAttempts: settings.maxAttempts, maxPlanRevisions: settings.maxPlanRevisions, implementerParallel: settings.maxImplementerParallel, readerParallel: settings.maxParallel });
  const bindings = new Map();
  let toolPermissions = null;
  let hostConfig = null;
  const getToolPermissions = () => toolPermissions;
  const getSubagentDepth = () => hostConfig?.subagent_depth ?? 1;
  const taskDefinition = createTaskDefinitionHook();
  const enforcement = createEnforcement({ settings: { worktree, journal: settings.journal, lessons: settings.lessons }, store, runner, bindings, client: context.client, lessons: lessonService, getToolPermissions, getSubagentDepth });
  const settlement = createSettlementController({ store, exclusive: enforcement.dispatches.exclusive,
    reconcile: enforcement.reconcileSettlement, timeoutMs: settings.settlementTimeoutMs });
  const { tools } = createSubmitTools({ store, runner, bindings, worktree, dispatches: enforcement.dispatches, accounting });
  const journalTools = createJournalTools({
    journalService,
    store,
    bindings,
    dispatches: enforcement.dispatches,
    enabled: settings.journal.enabled,
  });
  const lessonTools = createLessonTools({
    lessonService,
    store,
    bindings,
    dispatches: enforcement.dispatches,
    enabled: settings.lessons.enabled,
  });

  return {
    async config(config) {
      toolPermissions = registerAgents(config, settings);
      // Native Config.subagent_depth is a top-level nonnegative integer.
      // TaskTool checks it before publishing any child lifetime metadata.
      if (config.subagent_depth === undefined) config.subagent_depth = 2;
      hostConfig = config;
    },
    tool: { graph_status: createStatusTool(settings, journalService, lessonService, getToolPermissions, taskDefinition.status), ...tools, ...journalTools, ...lessonTools },
    'tool.definition': taskDefinition.onToolDefinition,
    'chat.message': async (input, output) => {
      const existing = bindings.has(input?.sessionID);
      await enforcement.onChatMessage(input, output);
      const id = bindings.get(input?.sessionID)?.runId;
      if (!existing && id && store.getRun(id)?.status === 'SETTLING') await settlement.restore(id);
    },
    'tool.execute.before': enforcement.onToolBefore,
    'tool.execute.after': enforcement.onToolAfter,
    'permission.ask': enforcement.onPermissionAsk,
    event: async input => {
      if (input?.event?.type === 'server.instance.disposed') { settlement.close(); await accounting.close(); }
      if (input?.event?.type === 'message.updated') {
        const info = input.event.properties?.info;
        const binding = bindings.get(info?.sessionID);
        if (binding) accounting.message(info, binding);
      }
      await enforcement.onEvent(input);
      const p = input?.event?.properties;
      const sessionId = p?.part?.sessionID ?? p?.info?.sessionID ?? p?.sessionID;
      const runId = bindings.get(sessionId)?.runId ?? enforcement.dispatches.runForSession(sessionId);
      if (runId && store.getRun(runId)?.status === 'SETTLING') await settlement.tick(runId);
    },
  };
}
