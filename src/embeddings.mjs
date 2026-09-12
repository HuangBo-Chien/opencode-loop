import { cleanJson, stableHash } from './json-safe.mjs';
import { journalStageError } from './journal-errors.mjs';

export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const MODEL_DTYPE = 'q8';
export const MAX_INDEXED_CHARS = 12_000;
export const MAX_EMBEDDING_CHUNKS = 4;
export const MAX_EMBEDDING_CHUNK_CHARS = MAX_INDEXED_CHARS / MAX_EMBEDDING_CHUNKS;

const EMBEDDING_SPACE_KEYS = Object.freeze([
  'aggregate',
  'aggregateVersion',
  'chunkStrategy',
  'chunkVersion',
  'dtype',
  'maxChunkChars',
  'maxChunks',
  'maxIndexedChars',
  'model',
  'normalize',
  'pooling',
  'revision',
]);
const MAX_VECTOR_DIMENSIONS = 4096;

function boundedIdentityString(value, name, limit = 512) {
  if (typeof value !== 'string' || !value.trim().length || value.length > limit) {
    throw new TypeError(`${name} must be a nonempty string of at most ${limit} characters`);
  }
}

export function validateEmbeddingSpace(input) {
  const value = cleanJson(input, { maxBytes: 4096, maxValues: 32, maxDepth: 3 });
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).join('\0') !== EMBEDDING_SPACE_KEYS.join('\0')) {
    throw new TypeError('Embedding space has an invalid shape');
  }
  boundedIdentityString(value.model, 'Embedding model');
  boundedIdentityString(value.revision, 'Embedding model revision');
  if (value.dtype !== 'q8' || value.pooling !== 'mean' || value.normalize !== true
    || value.aggregate !== 'mean-l2-normalize' || value.aggregateVersion !== 1
    || value.chunkStrategy !== 'evenly-spaced-windows' || value.chunkVersion !== 1) {
    throw new TypeError('Embedding space uses an unsupported inference or aggregation strategy');
  }
  if (!Number.isInteger(value.maxIndexedChars) || value.maxIndexedChars < 1 || value.maxIndexedChars > MAX_INDEXED_CHARS
    || !Number.isInteger(value.maxChunks) || value.maxChunks < 1 || value.maxChunks > MAX_EMBEDDING_CHUNKS
    || !Number.isInteger(value.maxChunkChars) || value.maxChunkChars < 1 || value.maxChunkChars > MAX_INDEXED_CHARS
    || value.maxChunkChars * value.maxChunks !== value.maxIndexedChars) {
    throw new TypeError('Embedding space has invalid indexing limits');
  }
  return value;
}

export function embeddingSpaceDigest(space) {
  return stableHash(validateEmbeddingSpace(space));
}

export const EMBEDDING_SPACE = validateEmbeddingSpace({
  model: MODEL_NAME,
  revision: MODEL_REVISION,
  dtype: MODEL_DTYPE,
  pooling: 'mean',
  normalize: true,
  aggregate: 'mean-l2-normalize',
  aggregateVersion: 1,
  chunkStrategy: 'evenly-spaced-windows',
  chunkVersion: 1,
  maxIndexedChars: MAX_INDEXED_CHARS,
  maxChunks: MAX_EMBEDDING_CHUNKS,
  maxChunkChars: MAX_EMBEDDING_CHUNK_CHARS,
});
export const EMBEDDING_SPACE_DIGEST = embeddingSpaceDigest(EMBEDDING_SPACE);

function isVector(value) {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}

function finiteVector(value, name, maxDimensions) {
  if (!isVector(value) || !Number.isInteger(value.length) || value.length < 1
    || (maxDimensions !== undefined && value.length > maxDimensions)) {
    const bound = maxDimensions === undefined ? '' : ` of at most ${maxDimensions} dimensions`;
    throw new TypeError(`${name} must be a nonempty finite numeric vector${bound}`);
  }
  const vector = Array.from(value);
  if (vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    const bound = maxDimensions === undefined ? '' : ` of at most ${maxDimensions} dimensions`;
    throw new TypeError(`${name} must be a nonempty finite numeric vector${bound}`);
  }
  return vector;
}

export function cosineSimilarity(a, b) {
  const left = finiteVector(a, 'Cosine vector');
  const right = finiteVector(b, 'Cosine vector');
  if (left.length !== right.length) throw new TypeError('Cosine vectors must have equal dimensions');

  let leftScale = 0;
  let rightScale = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftScale = Math.max(leftScale, Math.abs(left[index]));
    rightScale = Math.max(rightScale, Math.abs(right[index]));
  }
  if (leftScale === 0 || rightScale === 0) return 0;

  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] / leftScale;
    const rightValue = right[index] / rightScale;
    dot += leftValue * rightValue;
    leftSquared += leftValue * leftValue;
    rightSquared += rightValue * rightValue;
  }
  if (dot === 0) return 0;
  return dot / Math.sqrt(leftSquared * rightSquared);
}

export function meanNormalizedVector(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_EMBEDDING_CHUNKS) {
    throw new TypeError(`Embedding aggregate must contain from 1 to ${MAX_EMBEDDING_CHUNKS} vectors`);
  }
  const vectors = values.map((value) => finiteVector(value, 'Embedding aggregate vector', MAX_VECTOR_DIMENSIONS));
  const dimensions = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new TypeError('Embedding aggregate vectors must have equal dimensions');
  }
  const mean = Array(dimensions).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) mean[index] += vector[index] / vectors.length;
  }
  let scale = 0;
  for (const value of mean) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return mean;
  let scaledSquared = 0;
  for (const value of mean) scaledSquared += (value / scale) ** 2;
  const norm = scale * Math.sqrt(scaledSquared);
  return mean.map((value) => value / norm);
}

async function defaultPipelineFactory(...args) {
  const imported = await import('@huggingface/transformers');
  if (typeof imported.pipeline !== 'function') throw new TypeError('Embedding runtime does not export pipeline');
  return imported.pipeline(...args);
}

async function outputVector(output) {
  let value = output;
  if (value !== null && typeof value === 'object' && typeof value.tolist === 'function') value = await value.tolist();
  else if (value !== null && typeof value === 'object' && isVector(value.data)) value = value.data;
  if (Array.isArray(value) && value.length === 1 && isVector(value[0])) [value] = value;
  return finiteVector(value, 'Embedding output', MAX_VECTOR_DIMENSIONS);
}

export function createEmbeddingProvider({ pipelineFactory, now = Date.now } = {}) {
  if (pipelineFactory !== undefined && typeof pipelineFactory !== 'function') throw new TypeError('pipelineFactory must be a function when provided');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const factory = pipelineFactory ?? defaultPipelineFactory;
  let pipelinePromise;
  let state = 'idle';
  let lastError = null;
  let errorCode = null;
  let initializationAttempts = 0;
  let nextRetryAt = null;

  async function getPipeline() {
    if (pipelinePromise === undefined) {
      if (initializationAttempts >= 3 || nextRetryAt !== null && now() < nextRetryAt) {
        throw journalStageError('EMBEDDING_INITIALIZATION_FAILED');
      }
      initializationAttempts += 1;
      state = 'loading';
      pipelinePromise = Promise.resolve()
        .then(() => factory('feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE, revision: MODEL_REVISION }))
        .then((extractor) => {
          if (typeof extractor !== 'function') throw new TypeError('Embedding pipeline factory must return a function');
          state = 'ready';
          lastError = null;
          errorCode = null;
          nextRetryAt = null;
          return extractor;
        })
        .catch(() => {
          state = 'degraded';
          lastError = 'Embedding initialization failed';
          errorCode = 'EMBEDDING_INITIALIZATION_FAILED';
          nextRetryAt = initializationAttempts < 3 ? now() + 30_000 * initializationAttempts : null;
          pipelinePromise = undefined;
          throw journalStageError(errorCode);
        });
    }
    return pipelinePromise;
  }

  async function embed(text) {
    if (typeof text !== 'string' || !text.trim().length || text.length > MAX_INDEXED_CHARS) {
      throw new TypeError(`Embedding text must be a nonempty string of at most ${MAX_INDEXED_CHARS} characters`);
    }
    const extractor = await getPipeline();
    try {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const vector = await outputVector(output);
      state = 'ready';
      lastError = null;
      errorCode = null;
      return vector;
    } catch {
      state = 'degraded';
      lastError = 'Embedding inference failed';
      errorCode = 'EMBEDDING_INFERENCE_FAILED';
      throw journalStageError(errorCode);
    }
  }

  function status() {
    return Object.freeze({
      model: MODEL_NAME,
      revision: MODEL_REVISION,
      dtype: MODEL_DTYPE,
      embeddingSpace: EMBEDDING_SPACE,
      embeddingSpaceDigest: EMBEDDING_SPACE_DIGEST,
      state,
      lastError,
      errorCode,
      initializationAttempts,
      nextRetryAt,
    });
  }

  return Object.freeze({
    model: MODEL_NAME,
    revision: MODEL_REVISION,
    dtype: MODEL_DTYPE,
    embeddingSpace: EMBEDDING_SPACE,
    embeddingSpaceDigest: EMBEDDING_SPACE_DIGEST,
    embed,
    status,
  });
}
