// No monkey-patched built-ins or real model downloads: run with Node and Bun.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../src/run-state.mjs';
import { createJournalStore } from '../src/journal-store.mjs';
import { createJournalSearch } from '../src/journal-search.mjs';
import { createEmbeddingProvider } from '../src/embeddings.mjs';

test('real runtime scans empty/populated stores and falls back when initialization fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'loop-runtime-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = createRunStore({ worktree: root });
  const store = createJournalStore({ worktree: root, globalDirectory: join(root, 'global') });
  let initializations = 0;
  const provider = createEmbeddingProvider({ pipelineFactory: async () => { initializations++; throw new Error('offline smoke fixture'); } });
  const search = createJournalSearch({ store, embeddingProvider: provider });
  assert.deepEqual(await runs.listRunIds(), []);
  assert.equal((await search.search({ query: 'smoke', scope: 'both' })).hits.length, 0);
  assert.equal(initializations, 0);
  for (const [index, scope] of ['project', 'global'].entries()) {
    await store.write(scope, {
      schemaVersion: 1, id: String(index + 1).repeat(64), scope,
      kind: scope === 'project' ? 'insight' : 'promoted-insight',
      title: 'Smoke query', body: 'Runtime smoke evidence', createdAt: '2026-09-12T00:00:00.000Z',
      sourceIds: [], tags: [], metadata: {},
    });
  }
  for (const id of ['run-a', 'run-b']) await runs.createRun({ runId: id, rootSessionId: id, now: 'now' });
  assert.equal((await runs.listRunIds({ limit: 1 })).length, 1);
  assert.equal((await runs.listRunIds()).length, 2);
  const metadata = await search.search();
  assert.equal(metadata.mode, 'metadata');
  assert.equal(metadata.hits.length, 2);
  assert.equal(initializations, 0);
  const fallback = await search.search({ query: 'smoke', scope: 'both' });
  assert.equal(fallback.mode, 'text-fallback');
  assert.equal(fallback.hits.length, 2);
  assert.equal(initializations, 1);
  assert.equal(search.status().errorCode, 'EMBEDDING_INITIALIZATION_FAILED');
});
