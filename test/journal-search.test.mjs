import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function task3Modules() {
  const [embeddings, search, store] = await Promise.all([
    import('../src/embeddings.mjs'),
    import('../src/journal-search.mjs'),
    import('../src/journal-store.mjs'),
  ]);
  return { ...embeddings, ...search, ...store };
}

async function roots(t) {
  const root = await mkdtemp(join(tmpdir(), 'loop-journal-search-'));
  const worktree = join(root, 'project');
  const globalDirectory = join(root, 'global-journal', 'entries');
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, worktree, globalDirectory };
}

async function withPatchedFs(method, replacement, operation) {
  const original = fsPromises[method];
  fsPromises[method] = replacement(original);
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    fsPromises[method] = original;
    syncBuiltinESMExports();
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function journalEntry(overrides = {}) {
  const scope = overrides.scope ?? 'project';
  const kind = overrides.kind ?? (scope === 'global' ? 'promoted-insight' : 'insight');
  const title = overrides.title ?? 'Searchable journal entry';
  const body = overrides.body ?? 'A compact searchable body.';
  const createdAt = overrides.createdAt ?? '2026-09-10T12:00:00.000Z';
  return {
    schemaVersion: 1,
    id: overrides.id ?? sha256(JSON.stringify([scope, kind, title, body, createdAt])),
    scope,
    kind,
    title,
    createdAt,
    tags: overrides.tags ?? ['memory'],
    sourceIds: overrides.sourceIds ?? ['run:search-test'],
    metadata: overrides.metadata ?? { status: 'SUCCEEDED', files: ['src/default.mjs'] },
    body,
  };
}

function indexedText(entry) {
  return `${entry.title}\n\n${entry.body}`;
}

function testEmbeddingSpace(model, overrides = {}) {
  return Object.freeze({
    aggregate: 'mean-l2-normalize',
    aggregateVersion: 1,
    chunkStrategy: 'evenly-spaced-windows',
    chunkVersion: 1,
    dtype: 'q8',
    maxChunkChars: 3000,
    maxChunks: 4,
    maxIndexedChars: 12_000,
    model,
    normalize: true,
    pooling: 'mean',
    revision: 'test-revision-1',
    ...overrides,
  });
}

function deterministicProvider(vectors, { model = 'test/deterministic-v1', embeddingSpace = testEmbeddingSpace(model) } = {}) {
  const calls = [];
  return Object.freeze({
    model,
    embeddingSpace,
    calls,
    async embed(text) {
      calls.push(text);
      const vector = typeof vectors === 'function' ? await vectors(text) : vectors.get(text);
      if (vector instanceof Error) throw vector;
      if (vector === undefined) throw new Error(`Unexpected embedding input: ${text.slice(0, 40)}`);
      return [...vector];
    },
    status() {
      return Object.freeze({ model, embeddingSpace, state: 'ready', lastError: null });
    },
  });
}

async function writeEntries(store, entries) {
  for (const entry of entries) await store.write(entry.scope, entry);
}

test('embedding provider is lazy, caches one q8 pipeline, and returns a plain finite vector', async () => {
  const {
    EMBEDDING_SPACE,
    EMBEDDING_SPACE_DIGEST,
    MODEL_DTYPE,
    MODEL_NAME,
    MODEL_REVISION,
    createEmbeddingProvider,
  } = await task3Modules();
  assert.equal(MODEL_NAME, 'Xenova/all-MiniLM-L6-v2');
  assert.equal(MODEL_DTYPE, 'q8');
  assert.equal(MODEL_REVISION, '751bff37182d3f1213fa05d7196b954e230abad9');
  assert.deepEqual(EMBEDDING_SPACE, {
    aggregate: 'mean-l2-normalize',
    aggregateVersion: 1,
    chunkStrategy: 'evenly-spaced-windows',
    chunkVersion: 1,
    dtype: MODEL_DTYPE,
    maxChunkChars: 3000,
    maxChunks: 4,
    maxIndexedChars: 12_000,
    model: MODEL_NAME,
    normalize: true,
    pooling: 'mean',
    revision: MODEL_REVISION,
  });
  assert.match(EMBEDDING_SPACE_DIGEST, /^[a-f0-9]{64}$/);

  const factoryCalls = [];
  const inferenceCalls = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async (...args) => {
      factoryCalls.push(args);
      return async (...inferenceArgs) => {
        inferenceCalls.push(inferenceArgs);
        return { tolist: () => [[0.6, 0.8]] };
      };
    },
  });

  assert.equal(factoryCalls.length, 0);
  assert.deepEqual(provider.status(), {
    model: MODEL_NAME,
    revision: MODEL_REVISION,
    dtype: MODEL_DTYPE,
    embeddingSpace: EMBEDDING_SPACE,
    embeddingSpaceDigest: EMBEDDING_SPACE_DIGEST,
    state: 'idle',
    lastError: null,
  });

  const first = await provider.embed('first embedding');
  const second = await provider.embed('second embedding');

  assert.deepEqual(first, [0.6, 0.8]);
  assert.deepEqual(second, [0.6, 0.8]);
  assert.equal(Array.isArray(first), true);
  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0], ['feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE, revision: MODEL_REVISION }]);
  assert.deepEqual(inferenceCalls, [
    ['first embedding', { pooling: 'mean', normalize: true }],
    ['second embedding', { pooling: 'mean', normalize: true }],
  ]);
  assert.equal(provider.status().state, 'ready');
  assert.equal(provider.status().lastError, null);
});

test('embedding provider validates bounded text and finite model output without a real import', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  let factoryCalls = 0;
  const invalidOutput = createEmbeddingProvider({
    pipelineFactory: async () => {
      factoryCalls += 1;
      return async () => ({ tolist: () => [[1, Number.NaN]] });
    },
  });

  for (const value of ['', '   ', null, 42, {}, 'x'.repeat(12_001)]) {
    await assert.rejects(() => invalidOutput.embed(value), TypeError);
  }
  assert.equal(factoryCalls, 0);
  await assert.rejects(() => invalidOutput.embed('valid text'), /finite numeric vector/i);
  assert.equal(factoryCalls, 1);
  assert.equal(invalidOutput.status().state, 'degraded');
  assert.match(invalidOutput.status().lastError, /embedding inference failed/i);
});

test('cosineSimilarity validates vectors and handles orthogonal and zero-norm inputs', async () => {
  const { cosineSimilarity } = await task3Modules();
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), [1, 0]), 1);
  const longVector = Array(4097).fill(1);
  assert.equal(cosineSimilarity(longVector, longVector), 1);

  for (const [left, right] of [
    [[], []],
    [[1], [1, 2]],
    [[Number.NaN], [1]],
    [[Number.POSITIVE_INFINITY], [1]],
    [['1'], [1]],
    [{ length: 1, 0: 1 }, [1]],
  ]) {
    assert.throws(() => cosineSimilarity(left, right), TypeError);
  }
});

test('hybrid search combines semantic order, bounded exact boost, and project preference', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const exactGlobal = journalEntry({
    scope: 'global',
    title: 'Literal match',
    body: 'This global note contains the NEEDLE phrase verbatim.',
    createdAt: '2026-09-10T09:00:00.000Z',
  });
  const projectSemantic = journalEntry({
    title: 'Project architecture',
    body: 'A conceptually close project result without the literal term.',
    createdAt: '2026-09-10T08:00:00.000Z',
  });
  const globalSemantic = journalEntry({
    scope: 'global',
    title: 'Global architecture',
    body: 'A conceptually close global result without the literal term.',
    createdAt: '2026-09-10T10:00:00.000Z',
  });
  const unrelated = journalEntry({
    title: 'Unrelated project note',
    body: 'Orthogonal content only.',
    createdAt: '2026-09-10T11:00:00.000Z',
  });
  const entries = [exactGlobal, projectSemantic, globalSemantic, unrelated];
  await writeEntries(store, entries);
  const entryNamesBefore = await readdir(join(worktree, '.opencode-loop', 'journal', 'entries'));
  const provider = deterministicProvider(new Map([
    ['needle', [1, 0]],
    [indexedText(exactGlobal), [0.98, 0.2]],
    [indexedText(projectSemantic), [1, 0]],
    [indexedText(globalSemantic), [1, 0]],
    [indexedText(unrelated), [0, 1]],
  ]));
  const search = createJournalSearch({ store, embeddingProvider: provider });

  const result = await search.search({ query: 'needle', limit: 10 });

  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.hits.map((hit) => hit.id), [
    exactGlobal.id,
    projectSemantic.id,
    globalSemantic.id,
    unrelated.id,
  ]);
  assert.ok(result.hits[0].score > result.hits[1].score, 'one exact-text boost must outrank a small semantic gap');
  assert.ok(result.hits[1].score > result.hits[2].score, 'project preference must break equal semantic scores');
  assert.ok(result.hits[2].score > result.hits[3].score, 'semantic similarity must affect order');
  assert.deepEqual(Object.keys(result.hits[0]), ['id', 'scope', 'kind', 'title', 'createdAt', 'tags', 'status', 'score', 'snippet']);
  assert.match(result.hits[0].snippet, /NEEDLE/);
  assert.ok(result.hits.every((hit) => hit.snippet.length <= 240));
  assert.ok(result.hits.every((hit) => !/schemaVersion|sourceIds|"metadata"/.test(hit.snippet)));
  assert.deepEqual(await readdir(join(worktree, '.opencode-loop', 'journal', 'entries')), entryNamesBefore);
  await assert.rejects(lstat(join(worktree, '.opencode-loop', 'runs')), { code: 'ENOENT' });
});

test('hybrid search applies deterministic createdAt/id ties before limit', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const tiedA = journalEntry({ id: 'a'.repeat(64), title: 'Tie alpha', createdAt: '2026-09-10T10:00:00.000Z' });
  const tiedB = journalEntry({ id: 'b'.repeat(64), title: 'Tie bravo', createdAt: '2026-09-10T10:00:00.000Z' });
  const newest = journalEntry({ id: 'c'.repeat(64), title: 'Tie newest', createdAt: '2026-09-10T11:00:00.000Z' });
  const entries = [tiedB, newest, tiedA];
  await writeEntries(store, entries);
  const provider = deterministicProvider(new Map([
    ['unmatched-query', [1, 0]],
    ...entries.map((entry) => [indexedText(entry), [1, 0]]),
  ]));

  const result = await createJournalSearch({ store, embeddingProvider: provider }).search({
    query: 'unmatched-query',
    scope: 'project',
    limit: 2,
  });

  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.hits.map((hit) => hit.id), [newest.id, tiedA.id]);
});

test('metadata filters run before embedding and list only selected scopes', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const realStore = createJournalStore({ worktree, globalDirectory });
  const matching = journalEntry({
    title: 'Matching metadata',
    tags: ['Runner', 'Memory', 'TDD'],
    metadata: { status: 'FAILED', files: ['src/a.mjs', 'src/b.mjs'] },
  });
  const missingTag = journalEntry({
    title: 'Missing one required tag',
    tags: ['runner'],
    metadata: { status: 'FAILED', files: ['src/a.mjs'] },
  });
  const wrongStatus = journalEntry({
    title: 'Wrong status',
    tags: ['runner', 'memory'],
    metadata: { status: 'SUCCEEDED', files: ['src/a.mjs'] },
  });
  const global = journalEntry({
    scope: 'global',
    title: 'Unlisted global entry',
    tags: ['runner', 'memory'],
    metadata: { status: 'FAILED', files: ['src/a.mjs'] },
  });
  await writeEntries(realStore, [matching, missingTag, wrongStatus, global]);
  const listed = [];
  const store = {
    listBounded(scope, options) {
      listed.push(scope);
      return realStore.listBounded(scope, options);
    },
    readEmbedding: realStore.readEmbedding,
    writeEmbedding: realStore.writeEmbedding,
  };
  let embedCalls = 0;
  const embeddingProvider = {
    model: 'test/must-not-run',
    async embed() {
      embedCalls += 1;
      throw new Error('metadata search must not embed');
    },
  };
  const search = createJournalSearch({ store, embeddingProvider });

  const result = await search.search({
    scope: 'project',
    kinds: ['insight'],
    statuses: ['FAILED'],
    tags: ['memory', 'RUNNER'],
    files: ['src/a.mjs', 'src/not-present.mjs'],
  });

  assert.equal(result.mode, 'metadata');
  assert.deepEqual(result.hits.map((hit) => hit.id), [matching.id]);
  assert.deepEqual(listed, ['project']);
  assert.equal(embedCalls, 0);
});

test('a query with no metadata candidates does not initialize or inspect the provider', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  await store.write('project', journalEntry({ tags: ['present'] }));
  let providerAccesses = 0;
  const provider = {
    get model() {
      providerAccesses += 1;
      throw new Error('filtered queries must not inspect model state');
    },
    async embed() {
      providerAccesses += 1;
      throw new Error('filtered queries must not embed');
    },
  };

  const result = await createJournalSearch({ store, embeddingProvider: provider }).search({
    query: 'anything',
    scope: 'project',
    tags: ['absent'],
  });

  assert.equal(result.mode, 'hybrid');
  assert.deepEqual(result.hits, []);
  assert.equal(providerAccesses, 0);
});

test('no-query search returns newest metadata matches from both scopes without touching the provider', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const older = journalEntry({ title: 'Older project result', createdAt: '2026-09-10T08:00:00.000Z' });
  const newer = journalEntry({ scope: 'global', title: 'Newer global result', createdAt: '2026-09-10T09:00:00.000Z' });
  await writeEntries(store, [older, newer]);
  let providerAccesses = 0;
  const provider = {
    get model() {
      providerAccesses += 1;
      throw new Error('model must stay lazy');
    },
    async embed() {
      providerAccesses += 1;
      throw new Error('embed must stay lazy');
    },
  };

  const result = await createJournalSearch({ store, embeddingProvider: provider }).search({});

  assert.equal(result.mode, 'metadata');
  assert.deepEqual(result.hits.map((hit) => hit.id), [newer.id, older.id]);
  assert.ok(result.hits.every((hit) => hit.score === 0));
  assert.equal(providerAccesses, 0);
});

test('search tolerates concurrent creation of the exact missing project journal root', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const entriesDirectory = join(worktree, '.opencode-loop', 'journal', 'entries');
  const search = createJournalSearch({
    store: createJournalStore({ worktree, globalDirectory }),
    semanticSearch: false,
  });
  let created = false;

  const result = await withPatchedFs(
    'opendir',
    (originalOpendir) => async (directory, ...args) => {
      if (!created && String(directory) === entriesDirectory) {
        created = true;
        await mkdir(entriesDirectory, { recursive: true });
      }
      return originalOpendir(directory, ...args);
    },
    () => search.search({ query: 'needle', scope: 'project' }),
  );

  assert.equal(created, true);
  assert.equal(result.mode, 'text-fallback');
  assert.deepEqual(result.hits, []);
  assert.deepEqual(result.candidates, {
    inspected: 0,
    considered: 0,
    loaded: 0,
    bytes: 0,
    truncated: false,
  });
});

test('search has one 64-candidate budget across scopes independent of result limit', async (t) => {
  const {
    JOURNAL_SEARCH_MAX_BYTES,
    JOURNAL_SEARCH_MAX_CANDIDATES,
    JOURNAL_SEARCH_MAX_DIRENTS,
    createJournalSearch,
    createJournalStore,
  } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const projectEntries = Array.from({ length: 40 }, (_, index) => journalEntry({
    title: `Project bounded candidate ${index}`,
    body: `Project body ${index}`,
    createdAt: `2026-09-10T10:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const globalEntries = Array.from({ length: 40 }, (_, index) => journalEntry({
    scope: 'global',
    title: `Global bounded candidate ${index}`,
    body: `Global body ${index}`,
    createdAt: `2026-09-10T11:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  await writeEntries(store, [...projectEntries, ...globalEntries]);
  let providerAccesses = 0;
  const search = createJournalSearch({
    store,
    semanticSearch: false,
    embeddingProvider: {
      get embeddingSpace() {
        providerAccesses += 1;
        throw new Error('metadata search must not inspect embedding space');
      },
      async embed() {
        providerAccesses += 1;
        throw new Error('metadata search must not embed');
      },
    },
  });

  const result = await search.search({ scope: 'both', limit: 1 });

  assert.equal(JOURNAL_SEARCH_MAX_CANDIDATES, 64);
  assert.equal(JOURNAL_SEARCH_MAX_DIRENTS, 256);
  assert.equal(JOURNAL_SEARCH_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.candidates, {
    inspected: JOURNAL_SEARCH_MAX_CANDIDATES,
    considered: JOURNAL_SEARCH_MAX_CANDIDATES,
    loaded: JOURNAL_SEARCH_MAX_CANDIDATES,
    bytes: result.candidates.bytes,
    truncated: true,
  });
  assert.ok(result.candidates.bytes > 0);
  assert.ok(result.candidates.bytes <= JOURNAL_SEARCH_MAX_BYTES);
  assert.equal(providerAccesses, 0);
  assert.equal((await store.list('project')).length, 40);
  assert.equal((await store.list('global')).length, 40);
  assert.deepEqual(search.status().candidateLimits, {
    count: JOURNAL_SEARCH_MAX_CANDIDATES,
    dirents: JOURNAL_SEARCH_MAX_DIRENTS,
    bytes: JOURNAL_SEARCH_MAX_BYTES,
  });
  assert.deepEqual(search.status().lastCandidates, result.candidates);
});

test('default both-scope search reserves half of each scan budget for global matches', async (t) => {
  const {
    JOURNAL_SEARCH_MAX_BYTES,
    JOURNAL_SEARCH_MAX_CANDIDATES,
    JOURNAL_SEARCH_MAX_DIRENTS,
    createJournalSearch,
    createJournalStore,
  } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const projectEntries = Array.from({ length: JOURNAL_SEARCH_MAX_CANDIDATES }, (_, index) => journalEntry({
    title: `Project metadata nonmatch ${index}`,
    body: `Project-only candidate ${index}`,
  }));
  const globalMatch = journalEntry({
    scope: 'global',
    title: 'Promoted global match',
    body: 'Contains the promoted-only-needle requested by this search.',
  });
  await writeEntries(store, [...projectEntries, globalMatch]);

  const search = createJournalSearch({ store, semanticSearch: false });
  const result = await search.search({
    query: 'promoted-only-needle',
    kinds: ['promoted-insight'],
  });

  assert.deepEqual(result.hits.map((hit) => hit.id), [globalMatch.id]);
  assert.equal(result.candidates.considered, (JOURNAL_SEARCH_MAX_CANDIDATES / 2) + 1);
  assert.ok(result.candidates.considered <= JOURNAL_SEARCH_MAX_CANDIDATES);
  assert.ok(result.candidates.inspected <= JOURNAL_SEARCH_MAX_DIRENTS);
  assert.ok(result.candidates.bytes <= JOURNAL_SEARCH_MAX_BYTES);
  assert.deepEqual(search.status().candidateLimits, {
    count: JOURNAL_SEARCH_MAX_CANDIDATES,
    dirents: JOURNAL_SEARCH_MAX_DIRENTS,
    bytes: JOURNAL_SEARCH_MAX_BYTES,
  });
});

test('lexical fallback shares a 2 MiB aggregate journal-byte budget across scopes', async (t) => {
  const { JOURNAL_SEARCH_MAX_BYTES, createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const largeBody = (label) => `needle ${label}\n${'x'.repeat(600_000)}`;
  const entries = [
    journalEntry({ title: 'Large project alpha', body: largeBody('project-alpha') }),
    journalEntry({ title: 'Large project bravo', body: largeBody('project-bravo') }),
    journalEntry({ scope: 'global', title: 'Large global alpha', body: largeBody('global-alpha') }),
    journalEntry({ scope: 'global', title: 'Large global bravo', body: largeBody('global-bravo') }),
  ];
  await writeEntries(store, entries);

  const result = await createJournalSearch({ store, semanticSearch: false }).search({
    query: 'needle',
    scope: 'both',
    limit: 50,
  });

  assert.equal(result.mode, 'text-fallback');
  assert.equal(result.hits.length, 3);
  assert.deepEqual(result.candidates, {
    inspected: 4,
    considered: 4,
    loaded: 3,
    bytes: result.candidates.bytes,
    truncated: true,
  });
  assert.ok(result.candidates.bytes <= JOURNAL_SEARCH_MAX_BYTES);
});

test('sidecar cache is reused and revision, digest, or dimension mismatch rebuilds it', async (t) => {
  const {
    JOURNAL_EMBEDDING_SCHEMA_VERSION,
    createJournalSearch,
    createJournalStore,
    embeddingSpaceDigest,
  } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const entry = journalEntry({ title: 'Digest-bound cache', body: 'Stable indexed content.' });
  await store.write('project', entry);
  const provider = deterministicProvider(new Map([
    ['cache-query', [1, 0]],
    [indexedText(entry), [0.8, 0.6]],
  ]));
  const search = createJournalSearch({ store, embeddingProvider: provider });

  await search.search({ query: 'cache-query', scope: 'project' });
  const initial = await store.readEmbedding('project', entry.id);
  assert.deepEqual(Object.keys(initial), ['digest', 'dimensions', 'schemaVersion', 'space', 'spaceDigest', 'vector']);
  assert.equal(JOURNAL_EMBEDDING_SCHEMA_VERSION, 2);
  assert.equal(initial.schemaVersion, JOURNAL_EMBEDDING_SCHEMA_VERSION);
  assert.deepEqual(initial.space, provider.embeddingSpace);
  assert.equal(initial.spaceDigest, embeddingSpaceDigest(provider.embeddingSpace));
  assert.match(initial.digest, /^[a-f0-9]{64}$/);
  assert.equal(initial.dimensions, 2);
  assert.deepEqual(initial.vector, [0.8, 0.6]);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1);

  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1, 'matching sidecar must be reused');

  const staleRevisionSpace = { ...initial.space, revision: 'test-stale-revision' };
  await store.writeEmbedding('project', entry.id, {
    ...initial,
    space: staleRevisionSpace,
    spaceDigest: embeddingSpaceDigest(staleRevisionSpace),
  });
  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 2, 'revision mismatch must rebuild');

  const current = await store.readEmbedding('project', entry.id);
  await store.writeEmbedding('project', entry.id, { ...current, digest: '0'.repeat(64) });
  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 3, 'digest mismatch must rebuild');

  await store.writeEmbedding('project', entry.id, {
    ...(await store.readEmbedding('project', entry.id)),
    dimensions: 3,
    vector: [0.8, 0.6, 0],
  });
  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 4, 'dimension mismatch must rebuild');
  assert.deepEqual(await store.readEmbedding('project', entry.id), initial);
});

test('long entries embed bounded spanning chunks and later sections contribute to ranking', async (t) => {
  const {
    MAX_EMBEDDING_CHUNKS,
    MAX_INDEXED_CHARS,
    createJournalSearch,
    createJournalStore,
  } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const longEntry = journalEntry({
    title: 'Long spanning entry',
    body: [
      'A'.repeat(10_000),
      'B'.repeat(10_000),
      'C'.repeat(10_000),
      `${'D'.repeat(9990)} LATE_SECTION_SIGNAL`,
    ].join('\n'),
    createdAt: '2026-09-10T08:00:00.000Z',
  });
  const comparison = journalEntry({
    title: 'Comparison entry',
    body: 'Only unrelated comparison material.',
    createdAt: '2026-09-10T09:00:00.000Z',
  });
  await writeEntries(store, [longEntry, comparison]);
  const provider = deterministicProvider((text) => {
    if (text === 'conceptual request' || text.includes('LATE_SECTION_SIGNAL')) return [1, 0];
    return [0, 1];
  });

  const result = await createJournalSearch({ store, embeddingProvider: provider }).search({
    query: 'conceptual request',
    scope: 'project',
  });

  const longChunks = provider.calls.filter((text) => text.length === 3000);
  assert.equal(MAX_INDEXED_CHARS, 12_000);
  assert.equal(MAX_EMBEDDING_CHUNKS, 4);
  assert.equal(longChunks.length, MAX_EMBEDDING_CHUNKS);
  assert.equal(longChunks.reduce((total, chunk) => total + chunk.length, 0), MAX_INDEXED_CHARS);
  assert.ok(longChunks[0].includes(longEntry.title));
  assert.ok(longChunks.at(-1).includes('LATE_SECTION_SIGNAL'));
  assert.equal(result.hits[0].id, longEntry.id);
  const sidecar = await store.readEmbedding('project', longEntry.id);
  assert.ok(sidecar.vector[0] > 0.3, `later-section contribution missing from ${sidecar.vector}`);
  assert.ok(Math.abs(Math.hypot(...sidecar.vector) - 1) < 1e-12, 'aggregate vector must be normalized');
});

test('embedding concurrency is capped at two across simultaneous searches', async (t) => {
  const { EMBEDDING_CONCURRENCY, createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const entries = Array.from({ length: 5 }, (_, index) => journalEntry({
    title: `Concurrency entry ${index}`,
    body: `Bounded inference body ${index}`,
  }));
  await writeEntries(store, entries);
  let active = 0;
  let maxActive = 0;
  let entryCalls = 0;
  const provider = deterministicProvider(async (text) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (text.startsWith('Concurrency entry')) entryCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return [1, 0];
  });
  const search = createJournalSearch({ store, embeddingProvider: provider });

  await search.search({ query: 'warmup query', scope: 'project', limit: 1 });
  assert.equal(entryCalls, entries.length, 'result limit must not become an indexing work limit');
  active = 0;
  maxActive = 0;

  await Promise.all(Array.from({ length: 6 }, (_, index) => search.search({
    query: `simultaneous query ${index}`,
    scope: 'project',
    limit: 1,
  })));

  assert.equal(EMBEDDING_CONCURRENCY, 2);
  assert.equal(search.status().embeddingConcurrency, EMBEDDING_CONCURRENCY);
  assert.equal(maxActive, 2);
});

test('concurrent searches single-flight one sidecar inference and write', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const realStore = createJournalStore({ worktree, globalDirectory });
  const entry = journalEntry({ title: 'Single flight entry', body: 'Build this sidecar once.' });
  await realStore.write('project', entry);
  let writes = 0;
  const store = {
    listBounded: realStore.listBounded,
    readEmbedding: realStore.readEmbedding,
    async writeEmbedding(...args) {
      writes += 1;
      return realStore.writeEmbedding(...args);
    },
  };
  let entryCalls = 0;
  const provider = deterministicProvider(async (text) => {
    if (text === indexedText(entry)) {
      entryCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [1, 0];
  });
  const search = createJournalSearch({ store, embeddingProvider: provider });

  const results = await Promise.all(Array.from({ length: 8 }, () => search.search({
    query: 'single-flight query',
    scope: 'project',
  })));

  assert.equal(entryCalls, 1);
  assert.equal(writes, 1);
  assert.ok(results.every((result) => result.mode === 'hybrid' && result.hits[0].id === entry.id));
});

test('missing and corrupt sidecars rebuild under the journal index sibling', async (t) => {
  const { JOURNAL_EMBEDDING_SCHEMA_VERSION, createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const entry = journalEntry({ title: 'Rebuild sidecar', body: 'The body remains authoritative.' });
  await store.write('project', entry);
  const provider = deterministicProvider(new Map([
    ['rebuild-query', [1, 0]],
    [indexedText(entry), [1, 0]],
  ]));
  const search = createJournalSearch({ store, embeddingProvider: provider });
  const sidecarPath = join(worktree, '.opencode-loop', 'journal', 'index', `${entry.id}.json`);

  assert.equal(await store.readEmbedding('project', entry.id), null);
  await search.search({ query: 'rebuild-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1);
  assert.equal(JSON.parse(await readFile(sidecarPath, 'utf8')).schemaVersion, JOURNAL_EMBEDDING_SCHEMA_VERSION);

  await unlink(sidecarPath);
  await search.search({ query: 'rebuild-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 2);

  await writeFile(sidecarPath, JSON.stringify({
    schemaVersion: 1,
    model: provider.model,
    digest: '0'.repeat(64),
    dimensions: 2,
    vector: [1, 0],
  }), { mode: 0o600 });
  assert.equal(await store.readEmbedding('project', entry.id), null);
  await search.search({ query: 'rebuild-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 3);

  await writeFile(sidecarPath, '{not valid JSON', { mode: 0o600 });
  assert.equal(await store.readEmbedding('project', entry.id), null);
  await search.search({ query: 'rebuild-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 4);
  assert.deepEqual((await store.readEmbedding('project', entry.id)).vector, [1, 0]);

  await assert.rejects(() => store.readEmbedding('project', `../${entry.id}`), TypeError);
  const validSidecar = await store.readEmbedding('project', entry.id);
  await assert.rejects(() => store.writeEmbedding('project', entry.id, {
    ...validSidecar,
    path: '../../outside',
  }), TypeError);
  const maximumSidecar = await store.writeEmbedding('project', entry.id, {
    ...validSidecar,
    dimensions: 4096,
    vector: Array(4096).fill(0),
  });
  assert.equal(maximumSidecar.vector.length, 4096);
  assert.equal((await store.readEmbedding('project', entry.id)).vector.length, 4096);
  await assert.rejects(() => store.writeEmbedding('project', entry.id, {
    ...validSidecar,
    dimensions: 4097,
    vector: Array(4097).fill(1),
  }), TypeError);
});

test('provider failure returns lexical substring matches and records only a safe error', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { root, worktree, globalDirectory } = await roots(t);
  const store = createJournalStore({ worktree, globalDirectory });
  const matching = journalEntry({ title: 'Fallback match', body: 'A literal Needle remains searchable.' });
  const unrelated = journalEntry({ title: 'Other content', body: 'No matching text here.' });
  await writeEntries(store, [matching, unrelated]);
  const model = 'test/failing-provider';
  const provider = {
    model,
    embeddingSpace: testEmbeddingSpace(model),
    async embed() {
      throw new Error(`super-secret provider detail at ${join(root, 'private-model')}`);
    },
  };
  const search = createJournalSearch({ store, embeddingProvider: provider });

  const result = await search.search({ query: 'needle', scope: 'project' });

  assert.equal(result.mode, 'text-fallback');
  assert.deepEqual(result.hits.map((hit) => hit.id), [matching.id]);
  const status = search.status();
  assert.equal(status.semanticSearch, true);
  assert.equal(status.model, provider.model);
  assert.match(status.lastError, /semantic search unavailable/i);
  assert.equal(JSON.stringify(status).includes('super-secret'), false);
  assert.equal(JSON.stringify(status).includes(root), false);
  assert.equal(Object.isFrozen(status), true);
});

test('entry embedding and sidecar failures also degrade the whole query to text fallback', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
  const { worktree, globalDirectory } = await roots(t);
  const realStore = createJournalStore({ worktree, globalDirectory });
  const matching = journalEntry({ title: 'Index fallback', body: 'literal fallback-term content' });
  const semanticOnly = journalEntry({ title: 'Semantic only', body: 'conceptually related content' });
  await writeEntries(realStore, [matching, semanticOnly]);

  await t.test('entry embedding failure', async () => {
    const provider = deterministicProvider(async (text) => {
      if (text === 'fallback-term') return [1, 0];
      throw new Error('entry inference failed with private details');
    });
    const search = createJournalSearch({ store: realStore, embeddingProvider: provider });
    const result = await search.search({ query: 'fallback-term', scope: 'project' });
    assert.equal(result.mode, 'text-fallback');
    assert.deepEqual(result.hits.map((hit) => hit.id), [matching.id]);
    assert.match(search.status().lastError, /semantic search unavailable/i);
  });

  await t.test('sidecar write failure', async () => {
    const provider = deterministicProvider(new Map([
      ['fallback-term', [1, 0]],
      [indexedText(matching), [1, 0]],
      [indexedText(semanticOnly), [1, 0]],
    ]));
    const store = {
      listBounded: realStore.listBounded,
      async readEmbedding() { return null; },
      async writeEmbedding() { throw new Error('C:\\private\\index failure'); },
    };
    const search = createJournalSearch({ store, embeddingProvider: provider });
    const result = await search.search({ query: 'fallback-term', scope: 'project' });
    assert.equal(result.mode, 'text-fallback');
    assert.deepEqual(result.hits.map((hit) => hit.id), [matching.id]);
    assert.equal(JSON.stringify(search.status()).includes('private'), false);
  });
});

test('search validates bounded arguments before listing or embedding', async () => {
  const { createJournalSearch } = await task3Modules();
  let operations = 0;
  const search = createJournalSearch({
    store: {
      async listBounded() { operations += 1; return { entries: [], candidates: { inspected: 0, considered: 0, loaded: 0, bytes: 0, truncated: false } }; },
      async readEmbedding() { operations += 1; return null; },
      async writeEmbedding() { operations += 1; },
    },
    embeddingProvider: {
      model: 'test/unused',
      async embed() { operations += 1; return [1]; },
    },
  });
  const invalid = [
    { query: '' },
    { query: '   ' },
    { query: 'x'.repeat(8001) },
    { query: 42 },
    { scope: 'local' },
    { kinds: 'insight' },
    { statuses: Array(129).fill('FAILED') },
    { tags: [''] },
    { files: [42] },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
  ];

  for (const args of invalid) await assert.rejects(() => search.search(args), TypeError);
  assert.equal(operations, 0);
});

test('package pins the local embedding runtime exactly', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@huggingface/transformers'], '3.8.1');
});
