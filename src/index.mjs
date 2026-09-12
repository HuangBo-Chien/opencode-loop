import { parseOptions, resolveWorktree } from './config.mjs';
import { registerAgents } from './agents.mjs';
import { createStatusTool } from './status.mjs';
import { createRunStore } from './run-state.mjs';
import { createRunner } from './runner.mjs';
import { createSubmitTools } from './submit.mjs';
import { createEnforcement } from './enforcement.mjs';
import { createEmbeddingProvider } from './embeddings.mjs';
import { createJournalSearch } from './journal-search.mjs';
import { createJournalStore } from './journal-store.mjs';
import { createJournalService, createJournaledRunStore } from './journal.mjs';
import { createJournalTools } from './journal-tools.mjs';

export default async function GraphPlugin(context, options = {}) {
  const settings = parseOptions(options);
  if (!settings.enabled) return {};
  const worktree = resolveWorktree(context);

  const baseStore = createRunStore({ worktree, stateDirectory: settings.stateDirectory });
  const journalStore = createJournalStore({ worktree, stateDirectory: settings.stateDirectory });
  const embeddingProvider = createEmbeddingProvider();
  const journalSearch = createJournalSearch({
    store: journalStore,
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
  const store = createJournaledRunStore(baseStore, journalService);
  const runner = createRunner({ maxAttempts: settings.maxAttempts, maxPlanRevisions: settings.maxPlanRevisions, implementerParallel: settings.maxImplementerParallel });
  const bindings = new Map();
  const enforcement = createEnforcement({ settings: { worktree, journal: settings.journal }, store, runner, bindings, client: context.client });
  const { tools } = createSubmitTools({ store, runner, bindings, worktree, dispatches: enforcement.dispatches });
  const journalTools = createJournalTools({
    journalService,
    store,
    bindings,
    dispatches: enforcement.dispatches,
    enabled: settings.journal.enabled,
  });

  return {
    async config(config) { registerAgents(config, settings); },
    tool: { graph_status: createStatusTool(settings, journalService), ...tools, ...journalTools },
    'chat.message': enforcement.onChatMessage,
    'tool.execute.before': enforcement.onToolBefore,
    'tool.execute.after': enforcement.onToolAfter,
    'permission.ask': enforcement.onPermissionAsk,
    event: enforcement.onEvent,
  };
}
