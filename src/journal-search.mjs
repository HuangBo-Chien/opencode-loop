import { createHash } from 'node:crypto';
import { journalStageError, safeJournalStage } from './journal-errors.mjs';
import {
  cosineSimilarity,
  createEmbeddingProvider,
  embeddingSpaceDigest,
  meanNormalizedVector,
  validateEmbeddingSpace,
} from './embeddings.mjs';
import {
  JOURNAL_EMBEDDING_SCHEMA_VERSION,
  JOURNAL_SEARCH_MAX_BYTES,
  JOURNAL_SEARCH_MAX_CANDIDATES,
  JOURNAL_SEARCH_MAX_DIRENTS,
} from './journal-store.mjs';

export { JOURNAL_SEARCH_MAX_BYTES, JOURNAL_SEARCH_MAX_CANDIDATES, JOURNAL_SEARCH_MAX_DIRENTS } from './journal-store.mjs';

export const EMBEDDING_CONCURRENCY = 2;

const MAX_QUERY_CHARS = 8000;
const MAX_FILTER_VALUES = 128;
const MAX_FILTER_VALUE_CHARS = 1024;
const SNIPPET_CHARS = 240;
const EXACT_TEXT_BOOST = 0.15;
const PROJECT_SCOPE_BOOST = 0.01;
const PROVIDER_LIMITERS = new WeakMap();
const STORE_SIDECAR_FLIGHTS = new WeakMap();

function createLimiter(maxConcurrency) {
  let active = 0;
  const pending = [];
  function advance() {
    if (active >= maxConcurrency || pending.length === 0) return;
    active += 1;
    const { operation, resolve, reject } = pending.shift();
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        advance();
      });
  }
  return (operation) => new Promise((resolve, reject) => {
    pending.push({ operation, resolve, reject });
    advance();
  });
}

function providerLimiter(provider) {
  if (provider === null || (typeof provider !== 'object' && typeof provider !== 'function')) {
    throw new TypeError('Embedding provider must be an object');
  }
  let limiter = PROVIDER_LIMITERS.get(provider);
  if (limiter === undefined) {
    limiter = createLimiter(EMBEDDING_CONCURRENCY);
    PROVIDER_LIMITERS.set(provider, limiter);
  }
  return limiter;
}

function sidecarFlights(store) {
  let flights = STORE_SIDECAR_FLIGHTS.get(store);
  if (flights === undefined) {
    flights = new Map();
    STORE_SIDECAR_FLIGHTS.set(store, flights);
  }
  return flights;
}

async function mapWithConcurrency(values, maxConcurrency, operation) {
  const results = Array(values.length);
  let nextIndex = 0;
  let failure = null;
  async function worker() {
    while (failure === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, values.length) }, () => worker()));
  if (failure !== null) throw failure;
  return results;
}

function boundedStringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILTER_VALUES) throw new TypeError(`${name} must be a bounded string array`);
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim().length || item.length > MAX_FILTER_VALUE_CHARS) {
      throw new TypeError(`${name} must be a bounded string array`);
    }
  }
  return [...value];
}

function searchArguments(args) {
  if (args === undefined) args = {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Journal search arguments must be an object');
  let query;
  if (args.query !== undefined) {
    if (typeof args.query !== 'string' || !args.query.trim().length || args.query.length > MAX_QUERY_CHARS) {
      throw new TypeError(`query must be a nonempty string of at most ${MAX_QUERY_CHARS} characters`);
    }
    query = args.query.trim();
  }
  const scope = args.scope ?? 'both';
  if (scope !== 'project' && scope !== 'global' && scope !== 'both') {
    throw new TypeError("scope must be 'project', 'global', or 'both'");
  }
  const limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be an integer from 1 to 50');
  return {
    query,
    scope,
    kinds: boundedStringArray(args.kinds, 'kinds'),
    statuses: boundedStringArray(args.statuses, 'statuses'),
    tags: boundedStringArray(args.tags, 'tags'),
    files: boundedStringArray(args.files, 'files'),
    limit,
  };
}

function matchesMetadata(entry, filters) {
  if (filters.kinds.length && !filters.kinds.includes(entry.kind)) return false;
  if (filters.statuses.length && !filters.statuses.includes(entry.metadata?.status)) return false;
  if (filters.tags.length) {
    const tags = new Set(entry.tags.map((tag) => tag.toLowerCase()));
    if (!filters.tags.every((tag) => tags.has(tag.toLowerCase()))) return false;
  }
  if (filters.files.length) {
    const files = Array.isArray(entry.metadata?.files) ? entry.metadata.files : [];
    if (!filters.files.some((file) => files.includes(file))) return false;
  }
  return true;
}

function indexText(entry) {
  return `${entry.title}\n\n${entry.body}`;
}

function indexChunks(text, space) {
  const { maxChunkChars, maxChunks, maxIndexedChars } = space;
  if (text.length <= maxIndexedChars) {
    const chunks = [];
    for (let start = 0; start < text.length; start += maxChunkChars) chunks.push(text.slice(start, start + maxChunkChars));
    return chunks;
  }
  const finalStart = text.length - maxChunkChars;
  return Array.from({ length: maxChunks }, (_, index) => {
    const start = index === maxChunks - 1 ? finalStart : Math.floor((finalStart * index) / (maxChunks - 1));
    return text.slice(start, start + maxChunkChars);
  });
}

function textDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function containsQuery(text, query) {
  return text.toLowerCase().includes(query.toLowerCase());
}

function snippet(entry, query) {
  const body = entry.body.replace(/\s+/g, ' ').trim();
  if (!body.length) return '';
  let start = 0;
  if (query !== undefined) {
    const match = body.toLowerCase().indexOf(query.toLowerCase());
    if (match >= 0) start = Math.max(0, match - 60);
  }
  const prefix = start > 0 ? '...' : '';
  const suffixLength = body.length > start + SNIPPET_CHARS - prefix.length ? 3 : 0;
  const contentLength = SNIPPET_CHARS - prefix.length - suffixLength;
  const content = body.slice(start, start + contentLength);
  const suffix = start + content.length < body.length ? '...' : '';
  return `${prefix}${content}${suffix}`;
}

function scoreOrder(left, right) {
  return right.score - left.score
    || right.entry.createdAt.localeCompare(left.entry.createdAt)
    || left.entry.id.localeCompare(right.entry.id);
}

function newestOrder(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

function compactHit(entry, score, query) {
  return Object.freeze({
    id: entry.id,
    scope: entry.scope,
    kind: entry.kind,
    title: entry.title,
    createdAt: entry.createdAt,
    tags: Object.freeze([...entry.tags]),
    status: typeof entry.metadata?.status === 'string' ? entry.metadata.status : null,
    score: Number(score.toFixed(6)),
    snippet: snippet(entry, query),
  });
}

function freezeCandidates(value) {
  return Object.freeze({
    inspected: value.inspected,
    considered: value.considered,
    loaded: value.loaded,
    bytes: value.bytes,
    truncated: value.truncated,
  });
}

function result(mode, ranked, limit, query, candidates) {
  const hits = ranked.slice(0, limit).map(({ entry, score }) => compactHit(entry, score, query));
  return Object.freeze({ mode, hits: Object.freeze(hits), candidates: freezeCandidates(candidates) });
}

function validatedVector(value) {
  cosineSimilarity(value, value);
  return Array.from(value);
}

function reusableVector(sidecar, spaceDigest, digest, dimensions) {
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)
    || sidecar.schemaVersion !== JOURNAL_EMBEDDING_SCHEMA_VERSION || sidecar.spaceDigest !== spaceDigest || sidecar.digest !== digest
    || sidecar.dimensions !== dimensions || !Array.isArray(sidecar.vector)) return null;
  try {
    const vector = validatedVector(sidecar.vector);
    return vector.length === dimensions ? vector : null;
  } catch {
    return null;
  }
}

function providerEmbeddingSpace(provider) {
  let space = provider.embeddingSpace;
  if (space === undefined && typeof provider.status === 'function') space = provider.status()?.embeddingSpace;
  return validateEmbeddingSpace(space);
}

export function createJournalSearch({ store, embeddingProvider, semanticSearch = true } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.listBounded !== 'function') {
    throw new TypeError('store must provide bounded journal list operations');
  }
  if (typeof semanticSearch !== 'boolean') throw new TypeError('semanticSearch must be a boolean');
  const provider = embeddingProvider ?? createEmbeddingProvider();
  const flights = sidecarFlights(store);
  let lastError = null;
  let errorCode = null;
  let lastCandidates = null;

  async function selectedEntries(filters) {
    const scopes = filters.scope === 'both' ? ['project', 'global'] : [filters.scope];
    const entries = [];
    const candidates = { inspected: 0, considered: 0, loaded: 0, bytes: 0, truncated: false };
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index];
      const reserveGlobalCapacity = filters.scope === 'both' && index === 0;
      const remainingCandidates = JOURNAL_SEARCH_MAX_CANDIDATES - candidates.considered;
      const remainingDirents = JOURNAL_SEARCH_MAX_DIRENTS - candidates.inspected;
      const remainingBytes = JOURNAL_SEARCH_MAX_BYTES - candidates.bytes;
      const maxCandidates = reserveGlobalCapacity
        ? Math.min(remainingCandidates, Math.floor(JOURNAL_SEARCH_MAX_CANDIDATES / 2))
        : remainingCandidates;
      const maxDirents = reserveGlobalCapacity
        ? Math.min(remainingDirents, Math.floor(JOURNAL_SEARCH_MAX_DIRENTS / 2))
        : remainingDirents;
      const maxBytes = reserveGlobalCapacity
        ? Math.min(remainingBytes, Math.floor(JOURNAL_SEARCH_MAX_BYTES / 2))
        : remainingBytes;
      if (maxCandidates === 0 || maxDirents === 0 || maxBytes === 0) {
        candidates.truncated = true;
        break;
      }
      try {
        const listed = await store.listBounded(scope, {
          maxCandidates,
          maxDirents,
          maxBytes,
        });
        if (listed === null || typeof listed !== 'object' || Array.isArray(listed) || !Array.isArray(listed.entries)
          || listed.candidates === null || typeof listed.candidates !== 'object' || Array.isArray(listed.candidates)) {
          throw new TypeError('Journal store bounded list must return entries and candidate metadata');
        }
        const metadata = listed.candidates;
        if (!Number.isInteger(metadata.inspected) || metadata.inspected < 0
          || !Number.isInteger(metadata.considered) || metadata.considered < 0 || metadata.considered > metadata.inspected
          || !Number.isInteger(metadata.loaded) || metadata.loaded < 0 || metadata.loaded > metadata.considered
          || !Number.isInteger(metadata.bytes) || metadata.bytes < 0
          || metadata.inspected > maxDirents || metadata.considered > maxCandidates || metadata.bytes > maxBytes
          || typeof metadata.truncated !== 'boolean') {
          throw new TypeError('Journal store returned invalid candidate metadata');
        }
        candidates.inspected += metadata.inspected;
        candidates.considered += metadata.considered;
        candidates.loaded += metadata.loaded;
        candidates.bytes += metadata.bytes;
        candidates.truncated ||= metadata.truncated;
        if (candidates.inspected > JOURNAL_SEARCH_MAX_DIRENTS
          || candidates.considered > JOURNAL_SEARCH_MAX_CANDIDATES || candidates.bytes > JOURNAL_SEARCH_MAX_BYTES) {
          throw new TypeError('Journal store exceeded bounded search limits');
        }
        entries.push(...listed.entries.filter((entry) => matchesMetadata(entry, filters)));
      } catch (error) {
        if (error?.code !== 'PROJECT_WORKTREE_UNAVAILABLE') throw error;
      }
    }
    return { entries, candidates: freezeCandidates(candidates) };
  }

  function textFallback(entries, query, limit, candidates) {
    const ranked = entries
      .filter((entry) => containsQuery(indexText(entry), query))
      .map((entry) => ({ entry, score: 1 + (entry.scope === 'project' ? PROJECT_SCOPE_BOOST : 0) }))
      .sort(scoreOrder);
    return result('text-fallback', ranked, limit, query, candidates);
  }

  async function semanticResult(entries, query, limit, candidates) {
    const space = providerEmbeddingSpace(provider);
    const spaceDigest = embeddingSpaceDigest(space);
    if (typeof provider.embed !== 'function' || typeof store.readEmbedding !== 'function' || typeof store.writeEmbedding !== 'function') {
      throw new TypeError('Semantic search dependencies are unavailable');
    }
    const embed = (text) => providerLimiter(provider)(() => provider.embed(text));
    const queryVector = validatedVector(await embed(query));

    async function vectorForEntry(entry, text, digest) {
      const key = JSON.stringify([entry.scope, entry.id, digest, spaceDigest]);
      let flight = flights.get(key);
      if (flight === undefined) {
        flight = (async () => {
          let sidecar;
          try { sidecar = await store.readEmbedding(entry.scope, entry.id); }
          catch { throw journalStageError('JOURNAL_INDEX_READ_FAILED'); }
          const reusable = reusableVector(sidecar, spaceDigest, digest, queryVector.length);
          if (reusable !== null) return reusable;
          const chunkVectors = [];
          for (const chunk of indexChunks(text, space)) chunkVectors.push(validatedVector(await embed(chunk)));
          const vector = meanNormalizedVector(chunkVectors);
          if (vector.length !== queryVector.length) throw new TypeError('Query and journal embedding dimensions must match');
          try { await store.writeEmbedding(entry.scope, entry.id, {
            schemaVersion: JOURNAL_EMBEDDING_SCHEMA_VERSION,
            digest,
            space,
            spaceDigest,
            dimensions: vector.length,
            vector,
          }); } catch { throw journalStageError('JOURNAL_INDEX_WRITE_FAILED'); }
          return vector;
        })();
        flights.set(key, flight);
      }
      try {
        return await flight;
      } finally {
        if (flights.get(key) === flight) flights.delete(key);
      }
    }

    const ranked = await mapWithConcurrency(entries, EMBEDDING_CONCURRENCY, async (entry) => {
      const text = indexText(entry);
      const digest = textDigest(text);
      const vector = await vectorForEntry(entry, text, digest);
      return {
        entry,
        score: cosineSimilarity(queryVector, vector)
          + (containsQuery(text, query) ? EXACT_TEXT_BOOST : 0)
          + (entry.scope === 'project' ? PROJECT_SCOPE_BOOST : 0),
      };
    });
    ranked.sort(scoreOrder);
    return result('hybrid', ranked, limit, query, candidates);
  }

  async function search(args) {
    const filters = searchArguments(args);
    let selected;
    try { selected = await selectedEntries(filters); }
    catch {
      errorCode = 'JOURNAL_SCAN_FAILED';
      lastError = 'Journal entry scan failed';
      throw journalStageError(errorCode);
    }
    if (errorCode === 'JOURNAL_SCAN_FAILED') { errorCode = null; lastError = null; }
    const { entries, candidates } = selected;
    lastCandidates = candidates;
    if (filters.query === undefined) {
      const ranked = [...entries].sort(newestOrder).map((entry) => ({ entry, score: 0 }));
      return result('metadata', ranked, filters.limit, undefined, candidates);
    }
    if (!entries.length) return result(semanticSearch ? 'hybrid' : 'text-fallback', [], filters.limit, filters.query, candidates);
    if (!semanticSearch) return textFallback(entries, filters.query, filters.limit, candidates);
    try {
      const semantic = await semanticResult(entries, filters.query, filters.limit, candidates);
      lastError = null;
      errorCode = null;
      return semantic;
    } catch (error) {
      lastError = 'Semantic search unavailable; using text fallback';
      errorCode = safeJournalStage(error?.code) ?? 'JOURNAL_SEMANTIC_FAILED';
      return textFallback(entries, filters.query, filters.limit, candidates);
    }
  }

  function status() {
    let embeddingSpace = null;
    let currentSpaceDigest = null;
    let model = null;
    let providerStatus = null;
    try {
      embeddingSpace = providerEmbeddingSpace(provider);
      currentSpaceDigest = embeddingSpaceDigest(embeddingSpace);
      model = embeddingSpace.model;
      if (typeof provider.status === 'function') providerStatus = provider.status();
    } catch {
      // Status must remain safe even when a third-party provider is malformed.
    }
    return Object.freeze({
      semanticSearch,
      model,
      embeddingSpace,
      embeddingSpaceDigest: currentSpaceDigest,
      embeddingConcurrency: EMBEDDING_CONCURRENCY,
      candidateLimits: Object.freeze({ count: JOURNAL_SEARCH_MAX_CANDIDATES, dirents: JOURNAL_SEARCH_MAX_DIRENTS, bytes: JOURNAL_SEARCH_MAX_BYTES }),
      lastCandidates,
      lastError,
      errorCode,
      provider: Object.freeze({
        state: ['idle', 'loading', 'ready', 'degraded'].includes(providerStatus?.state) ? providerStatus.state : 'unknown',
        errorCode: safeJournalStage(providerStatus?.errorCode),
        initializationAttempts: Number.isInteger(providerStatus?.initializationAttempts) ? Math.min(3, Math.max(0, providerStatus.initializationAttempts)) : 0,
        nextRetryAt: Number.isSafeInteger(providerStatus?.nextRetryAt) && providerStatus.nextRetryAt >= 0 ? providerStatus.nextRetryAt : null,
      }),
    });
  }

  return Object.freeze({ search, status });
}
