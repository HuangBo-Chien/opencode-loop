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

function fakeTokenizer({ contentTokens = (text) => Array.from(text).length, specialTokens = 2 } = {}) {
  const calls = [];
  const tokenizer = () => {};
  tokenizer.calls = calls;
  tokenizer.encode = (text, { add_special_tokens: addSpecialTokens } = {}) => {
    calls.push({ text, addSpecialTokens });
    const count = contentTokens(text) + (addSpecialTokens ? specialTokens : 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid fake token count');
    return new Uint32Array(count);
  };
  return tokenizer;
}

function wordPieceContentTokens(value) {
  return (value.match(/\S+/gu) ?? []).reduce((total, word) => {
    const characters = Array.from(word);
    if (characters.length > 100) return total + 1;
    return total + characters.reduce((count, character) => count + (character === 'é' ? 2 : 1), 0);
  }, 0);
}

function hangulWordPieceContentTokens(value) {
  return (value.match(/\S+/gu) ?? []).reduce((total, word) => {
    const characters = Array.from(word);
    if (characters.length > 100) return total + 1;
    return total + characters.reduce((count, character) => count + (character === '각' ? 3 : 1), 0);
  }, 0);
}

function bertWordPieceContentTokens(value) {
  return (value.match(/[^\s\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]+|[\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/gu) ?? []).reduce((total, piece) => {
    if (/^[\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]$/u.test(piece)) return total + 1;
    const characters = Array.from(piece);
    if (/^[\x00-\x7F]+$/u.test(piece) && characters.length > 100) return total + 1;
    return total + characters.reduce((count, character) => count + (character === '각' ? 3 : 1), 0);
  }, 0);
}

function measuredDenseTokenizer({ maxCalls = Number.POSITIVE_INFINITY, rejectText, specialTokens = 2 } = {}) {
  const metrics = { calls: 0, characters: 0, maxCharacters: 0 };
  const tokenizer = () => {};
  tokenizer.encode = (text, { add_special_tokens: addSpecialTokens } = {}) => {
    metrics.calls += 1;
    metrics.characters += text.length;
    metrics.maxCharacters = Math.max(metrics.maxCharacters, text.length);
    if (metrics.calls > maxCalls) throw new Error('Dense tokenizer call budget exceeded');
    if (text === rejectText) throw new Error('Dense tokenizer received the complete input');
    const tokens = [];
    tokens.length = text.length + (addSpecialTokens ? specialTokens : 0);
    return tokens;
  };
  return { metrics, tokenizer };
}

function fakeExtractor(tokenizer, inference) {
  const extractor = async (...args) => inference(...args);
  extractor.tokenizer = tokenizer;
  return extractor;
}

async function sparseWhitespaceLegacyProbe(text, requiredOffset) {
  const {
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: (value) => value.includes('x') ? 1 : 0 });
  const encode = tokenizer.encode;
  const metrics = { fullInputCalls: 0, maxCharacters: 0 };
  tokenizer.encode = (value, options) => {
    metrics.maxCharacters = Math.max(metrics.maxCharacters, value.length);
    if (value === text) {
      metrics.fullInputCalls += 1;
      throw new Error('Sparse tokenizer received the complete legacy input');
    }
    return encode(value, options);
  };
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      assert.ok(batch.every((value) => value !== text));
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.equal(metrics.fullInputCalls, 0);
  assert.ok(metrics.maxCharacters <= MAX_CANONICAL_TEXT_CHARS);
  assert.ok(chunks.length >= 2 && chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(chunks.every((chunk) => chunk.length <= MAX_CANONICAL_TEXT_CHARS && chunk.length < text.length));
  assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  let requiredMarker;
  if (requiredOffset !== undefined) {
    requiredMarker = text[requiredOffset];
    assert.equal(text.indexOf(requiredMarker), requiredOffset);
    assert.equal(text.lastIndexOf(requiredMarker), requiredOffset);
    assert.ok(
      chunks.some((chunk) => chunk.includes(requiredMarker)),
      `expected a sparse chunk to intersect source offset ${requiredOffset}`,
    );
  }
  let sourceOffset = 0;
  const offsets = chunks.slice(0, -1).map((chunk) => {
    const markerOffset = requiredMarker === undefined ? -1 : chunk.indexOf(requiredMarker);
    const offset = markerOffset === -1 ? text.indexOf(chunk, sourceOffset) : requiredOffset - markerOffset;
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
    return offset;
  });
  const suffix = chunks.at(-1);
  const suffixOffset = text.length - suffix.length;
  assert.equal(suffix, text.slice(suffixOffset));
  assert.ok(suffixOffset >= sourceOffset);
  offsets.push(suffixOffset);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1) + suffix.length, text.length);
}

function testEmbeddingSpace(model, overrides = {}) {
  return Object.freeze({
    aggregate: 'mean-l2-normalize',
    aggregateVersion: 1,
    chunkStrategy: 'token-aware-spanning-windows',
    chunkVersion: 2,
    dtype: 'q8',
    maxCanonicalChars: 12_000,
    maxChunks: 48,
    maxIndexedTokens: 12_000,
    maxSequenceTokens: 256,
    model,
    normalize: true,
    overlapTokens: 0,
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
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_SPACE,
    EMBEDDING_SPACE_DIGEST,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
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
    chunkStrategy: 'token-aware-spanning-windows',
    chunkVersion: 2,
    dtype: MODEL_DTYPE,
    maxCanonicalChars: 12_000,
    maxChunks: 48,
    maxIndexedTokens: 12_000,
    maxSequenceTokens: 256,
    model: MODEL_NAME,
    normalize: true,
    overlapTokens: 0,
    pooling: 'mean',
    revision: MODEL_REVISION,
  });
  assert.equal(MAX_CANONICAL_TEXT_CHARS, 12_000);
  assert.equal(MAX_EMBEDDING_SEQUENCE_TOKENS, 256);
  assert.equal(MAX_INDEXED_TOKENS, 12_000);
  assert.equal(MAX_EMBEDDING_CHUNKS, 48);
  assert.equal(EMBEDDING_BATCH_SIZE, 8);
  assert.match(EMBEDDING_SPACE_DIGEST, /^[a-f0-9]{64}$/);

  const factoryCalls = [];
  const inferenceCalls = [];
  const tokenizer = fakeTokenizer({ contentTokens: () => 1 });
  assert.equal(typeof tokenizer, 'function');
  const provider = createEmbeddingProvider({
    pipelineFactory: async (...args) => {
      factoryCalls.push(args);
      return fakeExtractor(tokenizer, async (...inferenceArgs) => {
        inferenceCalls.push(inferenceArgs);
        return { tolist: () => inferenceArgs[0].map(() => [0.6, 0.8]) };
      });
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
    errorCode: null,
    initializationAttempts: 0,
    nextRetryAt: null,
  });

  const first = await provider.embed('first embedding');
  const second = await provider.embed('second embedding');

  for (const vector of [first, second]) {
    assert.ok(Math.abs(vector[0] - 0.6) < 1e-12);
    assert.ok(Math.abs(vector[1] - 0.8) < 1e-12);
  }
  assert.equal(Array.isArray(first), true);
  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0], ['feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE, revision: MODEL_REVISION }]);
  assert.deepEqual(inferenceCalls, [
    [['first embedding'], { pooling: 'mean', normalize: true }],
    [['second embedding'], { pooling: 'mean', normalize: true }],
  ]);
  assert.equal(provider.status().state, 'ready');
  assert.equal(provider.status().lastError, null);
});

test('embedding space requires a bounded canonical character identity', async () => {
  const {
    EMBEDDING_SPACE,
    EMBEDDING_SPACE_DIGEST,
    MAX_CANONICAL_TEXT_CHARS,
    embeddingSpaceDigest,
    validateEmbeddingSpace,
  } = await task3Modules();
  const missingCanonicalLimit = { ...EMBEDDING_SPACE };
  delete missingCanonicalLimit.maxCanonicalChars;
  assert.throws(() => validateEmbeddingSpace(missingCanonicalLimit), /invalid shape/i);
  assert.throws(() => validateEmbeddingSpace({ ...EMBEDDING_SPACE, unexpected: true }), /invalid shape/i);
  for (const maxCanonicalChars of [0, MAX_CANONICAL_TEXT_CHARS + 1, 1.5, '12000']) {
    assert.throws(
      () => validateEmbeddingSpace({ ...EMBEDDING_SPACE, maxCanonicalChars }),
      /invalid indexing limits/i,
    );
  }
  assert.notEqual(
    embeddingSpaceDigest({ ...EMBEDDING_SPACE, maxCanonicalChars: MAX_CANONICAL_TEXT_CHARS - 1 }),
    EMBEDDING_SPACE_DIGEST,
  );
});

test('embedding provider validates bounded text and finite model output without a real import', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const maximumText = 'x'.repeat(1_000_514);
  const boundedProvider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(
      fakeTokenizer({ contentTokens: () => 1 }),
      async (batch) => batch.map(() => [1, 0]),
    ),
  });
  assert.deepEqual(await boundedProvider.embed(maximumText), [1, 0]);
  await assert.rejects(() => boundedProvider.embed(`${maximumText}x`), TypeError);

  let factoryCalls = 0;
  const invalidOutput = createEmbeddingProvider({
    pipelineFactory: async () => {
      factoryCalls += 1;
      return fakeExtractor(fakeTokenizer(), async () => ({ tolist: () => [[1, Number.NaN]] }));
    },
  });

  for (const value of ['', '   ', null, 42, {}, `${maximumText}x`]) {
    await assert.rejects(() => invalidOutput.embed(value), TypeError);
  }
  assert.equal(factoryCalls, 0);
  await assert.rejects(() => invalidOutput.embed('valid text'), { code: 'EMBEDDING_INFERENCE_FAILED' });
  assert.equal(factoryCalls, 1);
  assert.equal(invalidOutput.status().state, 'degraded');
  assert.match(invalidOutput.status().lastError, /embedding inference failed/i);
});

test('token-aware embedding preserves exact under-budget source substrings without overlap', async () => {
  const { MAX_EMBEDDING_SEQUENCE_TOKENS, createEmbeddingProvider } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch, options) => {
      batches.push([...batch]);
      assert.deepEqual(options, { pooling: 'mean', normalize: true });
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `${'alpha '.repeat(60)}\n${'beta.'.repeat(60)} ${'🙂gamma '.repeat(50)}`;

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.ok(chunks.length > 1);
  let offset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk, text.slice(offset, offset + chunk.length));
    assert.ok(tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS);
    offset += chunk.length;
  }
  assert.equal(offset, text.length);
  assert.equal(chunks.join(''), text);
});

test('canonical dense CJK input repacks the complete source within chunk and batch caps', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = '汉'.repeat(MAX_CANONICAL_TEXT_CHARS);

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.equal(text.length, 12_000);
  assert.equal(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0), MAX_INDEXED_TOKENS);
  assert.equal(chunks.join(''), text);
  let sourceOffset = 0;
  for (const chunk of chunks) {
    assert.equal(chunk, text.slice(sourceOffset, sourceOffset + chunk.length));
    sourceOffset += chunk.length;
  }
  assert.equal(sourceOffset, text.length);
  assert.ok(chunks.every((chunk) => (
    tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
});

test('canonical token-expanding Unicode falls back to bounded spanning samples', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: (value) => Array.from(value).length * 3 });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = Array.from(
    { length: MAX_CANONICAL_TEXT_CHARS / 2 },
    (_, index) => String.fromCodePoint(0x10000 + index),
  ).join('');

  assert.equal(text.length, MAX_CANONICAL_TEXT_CHARS);
  assert.equal(tokenizer.encode(text, { add_special_tokens: false }).length, 18_000);
  const setupTokenizerCalls = tokenizer.calls.length;
  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.ok(
    tokenizer.calls.slice(setupTokenizerCalls).some((call) => call.text === text),
    'canonical text may be fully measured before fallback',
  );
  assert.ok(chunks.length >= 3 && chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
  assert.ok(chunks.every((chunk) => (
    chunk.length > 0
      && tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  assert.notEqual(chunks.join(''), text, 'over-budget canonical text must be sampled rather than fully indexed');

  let sourceOffset = 0;
  const spans = chunks.map((chunk) => {
    const start = text.indexOf(chunk, sourceOffset);
    assert.ok(start >= sourceOffset, 'samples must be source-ordered and non-overlapping');
    const end = start + chunk.length;
    sourceOffset = end;
    return { start, end };
  });
  assert.equal(spans[0].start, 0, 'samples must preserve the source prefix');
  assert.ok(spans.some(({ start, end }) => start <= text.length / 2 && text.length / 2 < end), 'samples must preserve the source midpoint');
  assert.equal(spans.at(-1).end, text.length, 'samples must preserve the source suffix');
});

test('canonical non-monotonic WordPiece text keeps a feasible full-source partition', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: hangulWordPieceContentTokens });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const segment = `${'각 '.repeat(70)}${'q'.repeat(101)} `;
  const text = segment.repeat(49);

  assert.equal(text.length, 11_858);
  assert.ok(text.length <= MAX_CANONICAL_TEXT_CHARS);
  assert.equal(tokenizer.encode(text, { add_special_tokens: false }).length, 10_339);
  const setupTokenizerCalls = tokenizer.calls.length;
  assert.deepEqual(await provider.embed(text), [1, 0]);
  const providerTokenizerCalls = tokenizer.calls.length - setupTokenizerCalls;
  const chunks = batches.flat();
  assert.ok(chunks.length >= 1 && chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
  assert.ok(chunks.every((chunk) => (
    chunk.length > 0
      && tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  assert.equal(chunks.join(''), text, 'feasible canonical text must remain complete and contiguous');
  assert.ok(providerTokenizerCalls <= 1000, `expected bounded tokenizer work, received ${providerTokenizerCalls} calls`);
});

test('canonical BERT punctuation boundaries recover a feasible full-source partition', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: bertWordPieceContentTokens });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `${'q'.repeat(101)},${'각'.repeat(98)},`.repeat(40);

  assert.equal(text.length, 8_040);
  assert.ok(text.length <= MAX_CANONICAL_TEXT_CHARS);
  assert.equal(tokenizer.encode('각', { add_special_tokens: false }).length, 3);
  assert.equal(tokenizer.encode('q'.repeat(101), { add_special_tokens: false }).length, 1);
  assert.equal(tokenizer.encode('a。각', { add_special_tokens: false }).length, 5);
  assert.equal(tokenizer.encode(text, { add_special_tokens: false }).length, 11_880);
  const setupTokenizerCalls = tokenizer.calls.length;

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const providerTokenizerCalls = tokenizer.calls.length - setupTokenizerCalls;
  const chunks = batches.flat();
  assert.ok(chunks.length >= 1 && chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
  assert.equal(chunks.join(''), text, 'feasible punctuation-delimited source must remain complete and contiguous');
  assert.ok(chunks.every((chunk) => (
    chunk.length > 0
      && tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  assert.ok(providerTokenizerCalls <= 1200, `expected bounded tokenizer work, received ${providerTokenizerCalls} calls`);
});

test('canonical BERT ASCII symbol boundaries recover a feasible full-source partition', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: bertWordPieceContentTokens });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `${'q'.repeat(101)}+${'각'.repeat(98)}+`.repeat(40);

  assert.equal(text.length, 8_040);
  assert.ok(text.length <= MAX_CANONICAL_TEXT_CHARS);
  assert.equal(tokenizer.encode('a+각', { add_special_tokens: false }).length, 5);
  assert.equal(tokenizer.encode(text, { add_special_tokens: false }).length, 11_880);
  const setupTokenizerCalls = tokenizer.calls.length;

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const providerTokenizerCalls = tokenizer.calls.length - setupTokenizerCalls;
  const chunks = batches.flat();
  assert.ok(chunks.length >= 1 && chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
  assert.equal(chunks.join(''), text, 'feasible BERT-symbol-delimited source must remain complete and contiguous');
  assert.ok(chunks.every((chunk) => (
    chunk.length > 0
      && tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  const indexedTokens = chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0);
  assert.equal(indexedTokens, 11_880);
  assert.ok(indexedTokens <= MAX_INDEXED_TOKENS);
  assert.ok(providerTokenizerCalls <= 1200, `expected bounded tokenizer work, received ${providerTokenizerCalls} calls`);
});

test('canonical character boundary completely embeds non-additive WordPiece text', async () => {
  const { MAX_CANONICAL_TEXT_CHARS, createEmbeddingProvider } = await task3Modules();
  const tokenizer = fakeTokenizer({ contentTokens: wordPieceContentTokens });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `${'q'.repeat(11_000)}${'é'.repeat(1_000)}`;

  assert.equal(text.length, 12_000);
  assert.equal(tokenizer.encode('q'.repeat(101), { add_special_tokens: false }).length, 1);
  assert.equal(tokenizer.encode('q'.repeat(100), { add_special_tokens: false }).length, 100);
  assert.deepEqual(await provider.embed(text), [1, 0]);
  assert.equal(MAX_CANONICAL_TEXT_CHARS, text.length);
  assert.deepEqual(batches.flat(), [text]);
});

test('oversized character boundary sparsely embeds WordPiece text without a full encode', async () => {
  const {
    MAX_CANONICAL_TEXT_CHARS,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const text = `${'q'.repeat(11_000)}${' '.repeat(1_001)}`;
  const tokenizer = fakeTokenizer({ contentTokens: wordPieceContentTokens });
  const encode = tokenizer.encode;
  let fullInputCalls = 0;
  let maxCharacters = 0;
  tokenizer.encode = (value, options) => {
    maxCharacters = Math.max(maxCharacters, value.length);
    if (value === text) {
      fullInputCalls += 1;
      throw new Error('WordPiece tokenizer received the complete oversized input');
    }
    return encode(value, options);
  };
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });

  assert.equal(text.length, MAX_CANONICAL_TEXT_CHARS + 1);
  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.equal(fullInputCalls, 0);
  assert.ok(maxCharacters < text.length);
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  assert.ok(text.startsWith(chunks[0]));
  assert.ok(text.endsWith(chunks.at(-1)));
  let sourceOffset = 0;
  for (const chunk of chunks) {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
  }
});

test('sparse whitespace legacy input keeps separate bounded edge windows', async () => {
  await sparseWhitespaceLegacyProbe(`x${' '.repeat(12_000)}`);
});

test('sparse near-maximum non-token-dense legacy input keeps bounded edge windows', async () => {
  const length = 1_000_514;
  const midpoint = Math.floor(length / 2);
  const text = `x${' '.repeat(midpoint - 1)}M${' '.repeat(length - midpoint - 1)}`;
  await sparseWhitespaceLegacyProbe(text, midpoint);
});

test('token-aware embedding samples first, middle, and last spans within token and batch caps', async () => {
  const {
    EMBEDDING_BATCH_SIZE,
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return {
        data: new Float32Array(batch.flatMap(() => [1, 0])),
        dims: [batch.length, 2],
      };
    }),
  });
  const text = Array.from({ length: 80 }, (_, index) => (
    `SECTION-${String(index).padStart(3, '0')}|${String.fromCharCode(65 + index % 26).repeat(230)}\n`
  )).join('');

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.ok(chunks.length > 2);
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(batches.every((batch) => batch.length <= EMBEDDING_BATCH_SIZE));
  assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
  assert.ok(chunks.reduce((total, chunk) => total + tokenizer.encode(chunk, { add_special_tokens: false }).length, 0) <= MAX_INDEXED_TOKENS);
  assert.ok(text.startsWith(chunks[0]));
  assert.ok(text.endsWith(chunks.at(-1)));

  let sourceOffset = 0;
  const offsets = chunks.map((chunk) => {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
    return offset;
  });
  assert.ok(offsets.some((offset) => offset >= text.length * 0.4 && offset <= text.length * 0.6));
});

test('over-budget dense embedding bounds tokenizer work before materializing all chunks', async () => {
  const {
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const { metrics, tokenizer } = measuredDenseTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `A${'x'.repeat(1_000_512)}Z`;

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  assert.ok(
    metrics.calls < 1000 && metrics.characters < text.length * 6,
    `expected bounded tokenizer work, received ${metrics.calls} calls and ${metrics.characters} characters`,
  );
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(chunks.every((chunk) => chunk.length + 2 <= MAX_EMBEDDING_SEQUENCE_TOKENS));
  assert.ok(chunks.reduce((total, chunk) => total + chunk.length, 0) <= MAX_INDEXED_TOKENS);
  assert.ok(chunks[0].startsWith('A'));
  assert.ok(chunks.at(-1).endsWith('Z'));
  let sourceOffset = 0;
  for (const chunk of chunks) {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
  }
});

test('oversized sparse sampling never encodes the full maximum-size dense input', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const text = `A${'x'.repeat(1_000_512)}Z`;
  const { metrics, tokenizer } = measuredDenseTokenizer({ rejectText: text });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });

  assert.deepEqual(await provider.embed(text), [1, 0]);
  assert.ok(metrics.maxCharacters < 10_000);
  assert.ok(metrics.calls < 1000);
  assert.ok(text.startsWith(batches.flat()[0]));
  assert.ok(text.endsWith(batches.flat().at(-1)));
});

test('over-budget sampling greedily expands underfilled heading and tail spans', async () => {
  const {
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `HEAD🙂\n${'x'.repeat(13_000)}\nTAIL🙂`;

  assert.deepEqual(await provider.embed(text), [1, 0]);
  const chunks = batches.flat();
  const contentTokenCapacity = MAX_EMBEDDING_SEQUENCE_TOKENS - 2;
  const contentTokenCounts = chunks.map((chunk) => tokenizer.encode(chunk, { add_special_tokens: false }).length);
  assert.equal(contentTokenCounts[0], contentTokenCapacity);
  assert.ok(
    contentTokenCounts.slice(1, -1).every((count) => count === contentTokenCapacity),
    `expected full middle spans, received ${contentTokenCounts.join(', ')}`,
  );
  assert.equal(contentTokenCounts.at(-1), contentTokenCapacity);
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(chunks.reduce((total, chunk) => total + tokenizer.encode(chunk, { add_special_tokens: false }).length, 0) <= MAX_INDEXED_TOKENS);
  let sourceOffset = 0;
  const offsets = chunks.map((chunk) => {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    assert.equal(chunk, text.slice(offset, offset + chunk.length));
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff));
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
    sourceOffset = offset + chunk.length;
    return offset;
  });
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1) + chunks.at(-1).length, text.length);
  assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
});

test('over-budget zoned trim refits a non-monotonic WordPiece span', async () => {
  const {
    MAX_EMBEDDING_CHUNKS,
    MAX_EMBEDDING_SEQUENCE_TOKENS,
    MAX_INDEXED_TOKENS,
    createEmbeddingProvider,
  } = await task3Modules();
  const contentTokens = (value) => (value.match(/\S+/gu) ?? []).reduce((total, word) => (
    total + (/^q+$/u.test(word) && word.length > 100 ? 1 : Array.from(word).length)
  ), 0);
  const tokenizer = fakeTokenizer({ contentTokens });
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = `${'abc '.repeat(3073)}${'q'.repeat(101)} ${'xyz '.repeat(931)}`;

  assert.equal(tokenizer.encode('q'.repeat(101), { add_special_tokens: false }).length, 1);
  assert.equal(tokenizer.encode('q'.repeat(100), { add_special_tokens: false }).length, 100);
  assert.deepEqual(await provider.embed(text), [1, 0]);
  assert.ok(tokenizer.calls.some((call) => (
    call.addSpecialTokens
      && call.text.match(/q+/u)?.[0].length === 100
      && contentTokens(call.text) + 2 > MAX_EMBEDDING_SEQUENCE_TOKENS
  )));
  const chunks = batches.flat();
  assert.ok(chunks.length <= MAX_EMBEDDING_CHUNKS);
  assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
  assert.ok(chunks.reduce((total, chunk) => (
    total + tokenizer.encode(chunk, { add_special_tokens: false }).length
  ), 0) <= MAX_INDEXED_TOKENS);
  assert.ok(text.startsWith(chunks[0]));
  assert.ok(text.endsWith(chunks.at(-1)));
  let sourceOffset = 0;
  for (const chunk of chunks) {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
  }
});

test('oversized sparse sampling avoids full input and respects candidate token capacity', async () => {
  const { MAX_INDEXED_TOKENS, createEmbeddingProvider } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [1, 0]);
    }),
  });
  const text = Array.from({ length: 60 }, (_, index) => (
    `CHUNK-${String(index).padStart(3, '0')}|${'x'.repeat(243)}\n`
  )).join('');

  assert.ok(48 * 254 > MAX_INDEXED_TOKENS);
  assert.deepEqual(await provider.embed(text), [1, 0]);
  const fullContentCounts = tokenizer.calls.filter((call) => call.text === text && call.addSpecialTokens === false).length;
  const chunks = batches.flat();
  assert.equal(fullContentCounts, 0);
  assert.ok(chunks.length <= Math.floor(MAX_INDEXED_TOKENS / 254));
  assert.ok(chunks.reduce((total, chunk) => total + Array.from(chunk).length, 0) <= MAX_INDEXED_TOKENS);
  assert.ok(text.startsWith(chunks[0]));
  assert.ok(text.endsWith(chunks.at(-1)));
  let sourceOffset = 0;
  const offsets = chunks.map((chunk) => {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
    return offset;
  });
  assert.ok(offsets.some((offset) => offset >= text.length * 0.4 && offset <= text.length * 0.6));
});

test('over-budget embedding aggregates distinct vectors in source order across batches', async () => {
  const { EMBEDDING_BATCH_SIZE, createEmbeddingProvider } = await task3Modules();
  const { tokenizer } = measuredDenseTokenizer({ maxCalls: 600 });
  const text = `A${'x'.repeat(99_998)}Z`;
  const batches = [];
  let outputIndex = 0;
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map(() => {
        outputIndex += 1;
        return [outputIndex, 1];
      });
    }),
  });

  const vector = await provider.embed(text);
  const chunks = batches.flat();
  assert.ok(chunks.length > EMBEDDING_BATCH_SIZE);
  assert.equal(outputIndex, chunks.length);
  assert.ok(batches.length > 1);
  assert.ok(batches.slice(0, -1).every((batch) => batch.length === EMBEDDING_BATCH_SIZE));
  assert.ok(batches.at(-1).length >= 1 && batches.at(-1).length <= EMBEDDING_BATCH_SIZE);
  assert.ok(text.startsWith(chunks[0]));
  assert.ok(text.endsWith(chunks.at(-1)));
  let sourceOffset = 0;
  for (const chunk of chunks) {
    const offset = text.indexOf(chunk, sourceOffset);
    assert.ok(offset >= sourceOffset);
    sourceOffset = offset + chunk.length;
  }
  const mean = [(chunks.length + 1) / 2, 1];
  const norm = Math.hypot(...mean);
  assert.ok(Math.abs(vector[0] - mean[0] / norm) < 1e-12);
  assert.ok(Math.abs(vector[1] - mean[1] / norm) < 1e-12);
});

test('long query-like text aggregates equal chunk vectors and applies final L2 normalization', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const tokenizer = fakeTokenizer();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
      batches.push([...batch]);
      return batch.map((_, index) => index % 2 === 0 ? [1, 0] : [0, 1]);
    }),
  });

  const vector = await provider.embed(`Explain ${'q'.repeat(392)}`);
  assert.equal(batches.flat().length, 2);
  assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-12);
});

test('embedding provider scale-normalizes one huge finite vector without overflow', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(fakeTokenizer(), async (batch) => (
      batch.map(() => [Number.MAX_VALUE, Number.MAX_VALUE])
    )),
  });

  const vector = await provider.embed('one huge vector');
  assert.ok(vector.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-12);
  assert.ok(Math.abs(vector[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(vector[1] - Math.SQRT1_2) < 1e-12);
  assert.equal(provider.status().state, 'ready');
});

test('embedding provider rejects a non-finite final aggregate as a safe inference failure', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const batches = [];
  const provider = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(fakeTokenizer(), async (batch) => {
      batches.push([...batch]);
      return batch.map(() => [Number.MAX_VALUE, Number.MAX_VALUE]);
    }),
  });
  const text = `${'a'.repeat(200)}\n${'b'.repeat(200)}\n${'c'.repeat(200)}`;

  await assert.rejects(() => provider.embed(text), { code: 'EMBEDDING_INFERENCE_FAILED' });
  assert.equal(batches.flat().length, 3);
  assert.equal(provider.status().state, 'degraded');
  assert.equal(provider.status().errorCode, 'EMBEDDING_INFERENCE_FAILED');
  assert.doesNotMatch(JSON.stringify(provider.status()), /MAX_VALUE|Infinity|NaN/i);
});

test('token-aware splitting terminates for CJK, emoji, whitespace, code, and giant no-space text', { timeout: 10_000 }, async () => {
  const { MAX_EMBEDDING_SEQUENCE_TOKENS, createEmbeddingProvider } = await task3Modules();
  const cases = [
    '汉字'.repeat(300),
    '🙂'.repeat(300),
    `head${' '.repeat(700)}tail`,
    'function example() { return 1; }\n'.repeat(30),
    'z'.repeat(20_000),
  ];

  for (const text of cases) {
    const tokenizer = fakeTokenizer();
    const batches = [];
    const provider = createEmbeddingProvider({
      pipelineFactory: async () => fakeExtractor(tokenizer, async (batch) => {
        batches.push([...batch]);
        return batch.map(() => [1, 0]);
      }),
    });
    assert.deepEqual(await provider.embed(text), [1, 0]);
    const chunks = batches.flat();
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((chunk) => tokenizer.encode(chunk, { add_special_tokens: true }).length <= MAX_EMBEDDING_SEQUENCE_TOKENS));
    assert.ok(chunks.every((chunk) => {
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      return !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff);
    }));
    assert.ok(text.startsWith(chunks[0]));
    assert.ok(text.endsWith(chunks.at(-1)));
    if (Array.from(text).length <= 12_000) assert.equal(chunks.join(''), text);
  }
});

test('malformed batched output and tokenizer failures are safe inference failures', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  const malformed = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor(fakeTokenizer(), async () => ({
      data: new Float32Array([1, 0]),
      dims: [2, 1],
    })),
  });
  await assert.rejects(() => malformed.embed('one input'), { code: 'EMBEDDING_INFERENCE_FAILED' });
  assert.equal(malformed.status().state, 'degraded');

  let tokenizerCalls = 0;
  const tokenizerFailure = createEmbeddingProvider({
    pipelineFactory: async () => fakeExtractor({
      encode() {
        tokenizerCalls += 1;
        throw new Error('C:\\private\\tokenizer failure');
      },
    }, async () => assert.fail('inference must not run')),
  });
  await assert.rejects(() => tokenizerFailure.embed('tokenize me'), { code: 'EMBEDDING_INFERENCE_FAILED' });
  assert.equal(tokenizerCalls, 1, 'unrelated tokenizer errors must not retry through sparse sampling');
  assert.equal(tokenizerFailure.status().errorCode, 'EMBEDDING_INFERENCE_FAILED');
  assert.doesNotMatch(JSON.stringify(tokenizerFailure.status()), /private|tokenizer failure/i);
});

test('missing public tokenizer is an initialization failure with normal cooldown semantics', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  let now = 0;
  let calls = 0;
  const provider = createEmbeddingProvider({
    now: () => now,
    pipelineFactory: async () => {
      calls += 1;
      return async () => [[1, 0]];
    },
  });

  await assert.rejects(() => provider.embed('query'), { code: 'EMBEDDING_INITIALIZATION_FAILED' });
  assert.equal(calls, 1);
  assert.equal(provider.status().nextRetryAt, 30_000);
  await assert.rejects(() => provider.embed('query'), { code: 'EMBEDDING_INITIALIZATION_FAILED' });
  assert.equal(calls, 1);
  now = 30_000;
  await assert.rejects(() => provider.embed('query'), { code: 'EMBEDDING_INITIALIZATION_FAILED' });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(provider.status()), /tokenizer|private/i);
});

test('initialization retry is query-driven, single-flight, cooled down and capped at three attempts', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  let now = 0;
  let calls = 0;
  const provider = createEmbeddingProvider({ now: () => now, pipelineFactory: async () => {
    calls++;
    throw new Error('private download details');
  } });
  await Promise.all([1, 2].map(() => assert.rejects(provider.embed('query'), { code: 'EMBEDDING_INITIALIZATION_FAILED' })));
  assert.equal(calls, 1);
  await assert.rejects(provider.embed('query'));
  assert.equal(calls, 1);
  now = 30_000;
  await assert.rejects(provider.embed('query'));
  assert.equal(calls, 2);
  now = 89_999;
  await assert.rejects(provider.embed('query'));
  assert.equal(calls, 2);
  now = 90_000;
  await assert.rejects(provider.embed('query'));
  assert.equal(calls, 3);
  now = 1_000_000;
  await assert.rejects(provider.embed('query'));
  assert.equal(calls, 3);
  assert.equal(provider.status().initializationAttempts, 3);
  assert.equal(provider.status().nextRetryAt, null);
  assert.doesNotMatch(JSON.stringify(provider.status()), /private download/);
});

test('provider recovers after cooldown and reuses the successful extractor', async () => {
  const { createEmbeddingProvider } = await task3Modules();
  let now = 0;
  let calls = 0;
  const provider = createEmbeddingProvider({ now: () => now, pipelineFactory: async () => {
    if (++calls === 1) throw new Error('offline');
    return fakeExtractor(fakeTokenizer(), async (batch) => batch.map(() => [1, 0]));
  } });
  await assert.rejects(provider.embed('query'));
  now = 30_000;
  assert.deepEqual(await provider.embed('query'), [1, 0]);
  assert.deepEqual(await provider.embed('query'), [1, 0]);
  assert.equal(calls, 2);
  assert.equal(provider.status().state, 'ready');
  assert.equal(provider.status().errorCode, null);
});

test('entry scan failure reports its stage without initializing embeddings or pretending an empty result', async () => {
  const { createJournalSearch } = await task3Modules();
  const search = createJournalSearch({
    store: { async listBounded() { throw new Error('/private/scan'); } },
    embeddingProvider: { embed() { assert.fail('must not initialize'); } },
  });
  await assert.rejects(search.search({ scope: 'project' }), { code: 'JOURNAL_SCAN_FAILED' });
  assert.equal(search.status().errorCode, 'JOURNAL_SCAN_FAILED');
  assert.doesNotMatch(JSON.stringify(search.status()), /private/);
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

test('sidecar cache reuse embeds each query and lazily migrates stale space, digest, and dimensions', async (t) => {
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
  const sidecarPath = join(worktree, '.opencode-loop', 'journal', 'index', `${entry.id}.json`);
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
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 1);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1);

  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 2, 'every search must embed its query once');
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1, 'matching sidecar must be reused');

  const characterSpace = {
    aggregate: 'mean-l2-normalize',
    aggregateVersion: 1,
    chunkStrategy: 'evenly-spaced-windows',
    chunkVersion: 1,
    dtype: 'q8',
    maxChunkChars: 3000,
    maxChunks: 4,
    maxIndexedChars: 12_000,
    model: provider.model,
    normalize: true,
    pooling: 'mean',
    revision: 'test-revision-1',
  };
  const staleSidecar = JSON.stringify({
    ...initial,
    space: characterSpace,
    spaceDigest: sha256(JSON.stringify(characterSpace)),
    vector: [0, 1],
  });
  await writeFile(sidecarPath, staleSidecar, { mode: 0o600 });
  assert.equal(await store.readEmbedding('project', entry.id), null, 'old character-space sidecar must not be reusable');

  const metadataResult = await search.search({ scope: 'project' });
  assert.equal(metadataResult.mode, 'metadata');
  assert.equal(await readFile(sidecarPath, 'utf8'), staleSidecar, 'metadata-only search must not migrate sidecars');
  const disabledResult = await createJournalSearch({ store, embeddingProvider: provider, semanticSearch: false }).search({
    query: 'cache-query',
    scope: 'project',
  });
  assert.equal(disabledResult.mode, 'text-fallback');
  assert.equal(await readFile(sidecarPath, 'utf8'), staleSidecar, 'disabled semantic search must not migrate sidecars');
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 2);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 1);

  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 3);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 2, 'old character-space sidecar must rebuild lazily');
  const migrated = await store.readEmbedding('project', entry.id);
  assert.deepEqual(migrated, initial);
  assert.deepEqual(migrated.space, provider.embeddingSpace);
  assert.equal(migrated.spaceDigest, embeddingSpaceDigest(provider.embeddingSpace));

  const current = migrated;
  await store.writeEmbedding('project', entry.id, { ...current, digest: '0'.repeat(64) });
  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 4);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 3, 'digest mismatch must rebuild');

  await store.writeEmbedding('project', entry.id, {
    ...(await store.readEmbedding('project', entry.id)),
    dimensions: 3,
    vector: [0.8, 0.6, 0],
  });
  await search.search({ query: 'cache-query', scope: 'project' });
  assert.equal(provider.calls.filter((text) => text === 'cache-query').length, 5);
  assert.equal(provider.calls.filter((text) => text === indexedText(entry)).length, 4, 'dimension mismatch must rebuild');
  assert.deepEqual(await store.readEmbedding('project', entry.id), initial);
});

test('search embeds each trimmed query and complete candidate entry exactly once', async (t) => {
  const { createJournalSearch, createJournalStore } = await task3Modules();
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
  const query = 'conceptual request';
  const provider = deterministicProvider((text) => {
    if (text === query || text === indexedText(longEntry)) return [1, 0];
    return [0, 1];
  });

  const result = await createJournalSearch({ store, embeddingProvider: provider }).search({
    query: `  ${query}  `,
    scope: 'project',
  });

  assert.equal(provider.calls.filter((text) => text === query).length, 1);
  assert.equal(provider.calls.filter((text) => text === indexedText(longEntry)).length, 1);
  assert.equal(provider.calls.filter((text) => text === indexedText(comparison)).length, 1);
  assert.equal(provider.calls.length, 3, 'provider must receive one query and one call per cache-miss entry');
  assert.ok(provider.calls.every((text) => text.length > 0), 'provider must never receive empty text');
  assert.equal(provider.calls.some((text) => text.length === 3000), false, 'search must not create character windows');
  assert.equal(result.hits[0].id, longEntry.id);
  const sidecar = await store.readEmbedding('project', longEntry.id);
  assert.equal(sidecar.digest, sha256(indexedText(longEntry)));
  assert.deepEqual(sidecar.vector, [1, 0]);
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
