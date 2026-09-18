import { cleanJson, stableHash } from './json-safe.mjs';
import { journalStageError } from './journal-errors.mjs';

export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const MODEL_DTYPE = 'q8';
export const MAX_EMBEDDING_SEQUENCE_TOKENS = 256;
export const MAX_INDEXED_TOKENS = 12_000;
export const MAX_CANONICAL_TEXT_CHARS = 12_000;
export const MAX_EMBEDDING_CHUNKS = 48;
export const EMBEDDING_BATCH_SIZE = 8;

const EMBEDDING_SPACE_KEYS = Object.freeze([
  'aggregate',
  'aggregateVersion',
  'chunkStrategy',
  'chunkVersion',
  'dtype',
  'maxCanonicalChars',
  'maxChunks',
  'maxIndexedTokens',
  'maxSequenceTokens',
  'model',
  'normalize',
  'overlapTokens',
  'pooling',
  'revision',
]);
const MAX_EMBEDDING_INPUT_CHARS = 1_000_514;
const MAX_VECTOR_DIMENSIONS = 4096;
const INDEXED_TOKEN_BUDGET_EXCEEDED = Symbol('indexed-token-budget-exceeded');

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
    || value.chunkStrategy !== 'token-aware-spanning-windows' || value.chunkVersion !== 2
    || value.overlapTokens !== 0) {
    throw new TypeError('Embedding space uses an unsupported inference or aggregation strategy');
  }
  if (!Number.isInteger(value.maxCanonicalChars) || value.maxCanonicalChars < 1
    || value.maxCanonicalChars > MAX_CANONICAL_TEXT_CHARS
    || !Number.isInteger(value.maxIndexedTokens) || value.maxIndexedTokens < 1 || value.maxIndexedTokens > MAX_INDEXED_TOKENS
    || !Number.isInteger(value.maxChunks) || value.maxChunks < 1 || value.maxChunks > MAX_EMBEDDING_CHUNKS
    || !Number.isInteger(value.maxSequenceTokens) || value.maxSequenceTokens < 1
    || value.maxSequenceTokens > MAX_EMBEDDING_SEQUENCE_TOKENS) {
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
  chunkStrategy: 'token-aware-spanning-windows',
  chunkVersion: 2,
  maxCanonicalChars: MAX_CANONICAL_TEXT_CHARS,
  maxIndexedTokens: MAX_INDEXED_TOKENS,
  maxChunks: MAX_EMBEDDING_CHUNKS,
  maxSequenceTokens: MAX_EMBEDDING_SEQUENCE_TOKENS,
  overlapTokens: 0,
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

function tokenCount(tokenizer, text, addSpecialTokens) {
  const encoded = tokenizer.encode(text, { add_special_tokens: addSpecialTokens });
  if (!isVector(encoded) || !Number.isSafeInteger(encoded.length) || encoded.length < 0) {
    throw new TypeError('Embedding tokenizer returned an invalid encoding');
  }
  return encoded.length;
}

function isCodePointBoundary(text, index, start, end) {
  if (index <= start || index >= end) return false;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function isPreferredBoundary(character) {
  return /[\s\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/u.test(character);
}

function nearestPreferredBoundary(text, start, end, kind) {
  const midpoint = (start + end) / 2;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    const width = codePoint > 0xffff ? 2 : 1;
    const boundary = index + width;
    let matches = false;
    if (kind === 'newline') {
      matches = character === '\n' || character === '\r' && text.charCodeAt(boundary) !== 0x0a;
    } else {
      matches = isPreferredBoundary(character);
    }
    if (matches && boundary < end) {
      const distance = Math.abs(boundary - midpoint);
      if (distance < bestDistance) {
        best = boundary;
        bestDistance = distance;
      }
    }
    index = boundary;
  }
  return best;
}

function fallbackBoundary(text, start, end) {
  const midpoint = start + Math.floor((end - start) / 2);
  for (let distance = 0; distance < end - start; distance += 1) {
    const lower = midpoint - distance;
    if (isCodePointBoundary(text, lower, start, end)) return lower;
    const upper = midpoint + distance;
    if (upper !== lower && isCodePointBoundary(text, upper, start, end)) return upper;
  }
  return null;
}

function splitBoundary(text, start, end) {
  return nearestPreferredBoundary(text, start, end, 'newline')
    ?? nearestPreferredBoundary(text, start, end, 'preferred')
    ?? fallbackBoundary(text, start, end);
}

function tokenAwareChunks(tokenizer, text) {
  const pending = [{ start: 0, end: text.length }];
  const spans = [];
  while (pending.length) {
    const span = pending.pop();
    const value = text.slice(span.start, span.end);
    if (tokenCount(tokenizer, value, true) <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
      spans.push(span);
      continue;
    }
    const boundary = splitBoundary(text, span.start, span.end);
    if (boundary === null) throw new TypeError('Embedding text cannot be split within the model token limit');
    pending.push({ start: boundary, end: span.end }, { start: span.start, end: boundary });
  }

  const merged = [];
  let current = spans[0];
  for (let index = 1; index < spans.length; index += 1) {
    const next = spans[index];
    const combined = text.slice(current.start, next.end);
    if (tokenCount(tokenizer, combined, true) <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
      current = { start: current.start, end: next.end };
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  const chunks = merged.map((span) => {
    const value = text.slice(span.start, span.end);
    return {
      ...span,
      text: value,
      contentTokens: tokenCount(tokenizer, value, false),
    };
  });
  const totalTokens = chunks.reduce((total, chunk) => total + chunk.contentTokens, 0);
  if (chunks.length <= MAX_EMBEDDING_CHUNKS && totalTokens <= MAX_INDEXED_TOKENS) return chunks;

  const repacked = [];
  let sourceOffset = 0;
  let sourceChunkIndex = 0;
  let repackedTokens = 0;
  while (sourceOffset < text.length && repacked.length < MAX_EMBEDDING_CHUNKS) {
    while (chunks[sourceChunkIndex]?.end <= sourceOffset) sourceChunkIndex += 1;
    const sourceChunk = chunks[sourceChunkIndex];
    if (sourceChunk === undefined || sourceChunk.start > sourceOffset) {
      throw new TypeError('Canonical embedding spans do not cover the source');
    }
    const prefix = targetedTokenAwareChunk(
      tokenizer,
      text,
      { start: sourceOffset, end: sourceChunk.end },
      0,
      'start',
    );
    const chunk = expandedChunk(tokenizer, text, prefix, text.length, 1, true);
    if (chunk.start !== sourceOffset || chunk.end <= sourceOffset
      || chunk.text !== text.slice(sourceOffset, chunk.end)
      || chunk.sequenceTokens > MAX_EMBEDDING_SEQUENCE_TOKENS) {
      throw new TypeError('Canonical embedding repacking made invalid source progress');
    }
    repackedTokens += chunk.contentTokens;
    repacked.push(chunk);
    sourceOffset = chunk.end;
  }
  if (sourceOffset !== text.length || repacked.length > MAX_EMBEDDING_CHUNKS
    || repackedTokens > MAX_INDEXED_TOKENS) return INDEXED_TOKEN_BUDGET_EXCEEDED;
  return repacked;
}

function coarseSourceSpans(text, maximumRegions) {
  const spans = [{ start: 0, end: text.length, splittable: true }];
  while (spans.length < maximumRegions) {
    let candidateIndex = -1;
    let candidateLength = 0;
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      if (span.splittable && span.end - span.start > candidateLength) {
        candidateIndex = index;
        candidateLength = span.end - span.start;
      }
    }
    if (candidateIndex === -1) break;
    const candidate = spans[candidateIndex];
    const boundary = splitBoundary(text, candidate.start, candidate.end);
    if (boundary === null) {
      candidate.splittable = false;
      continue;
    }
    spans.splice(
      candidateIndex,
      1,
      { start: candidate.start, end: boundary, splittable: true },
      { start: boundary, end: candidate.end, splittable: true },
    );
  }
  return spans.map(({ start, end }) => ({ start, end }));
}

function targetedTokenAwareChunk(tokenizer, text, region, targetTokens, edge) {
  let start = region.start;
  let end = region.end;
  let target = targetTokens;
  while (true) {
    const value = text.slice(start, end);
    const sequenceTokens = tokenCount(tokenizer, value, true);
    if (sequenceTokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
      const contentTokens = tokenCount(tokenizer, value, false);
      let sourceTarget = fallbackBoundary(text, start, end) ?? start;
      if (edge === 'start') {
        sourceTarget = start;
      } else if (edge === 'end') {
        sourceTarget = end;
      } else if (contentTokens > 0) {
        sourceTarget = start + Math.round(
          ((end - start) * Math.max(0, Math.min(contentTokens, target))) / contentTokens,
        );
        if (sourceTarget > start && sourceTarget < end
          && !isCodePointBoundary(text, sourceTarget, start, end)) {
          sourceTarget -= 1;
        }
      }
      return {
        start,
        end,
        text: value,
        sequenceTokens,
        contentTokens,
        target: sourceTarget,
      };
    }
    const boundary = splitBoundary(text, start, end);
    if (boundary === null) throw new TypeError('Embedding sample cannot be split within the model token limit');
    if (edge === 'start') {
      end = boundary;
    } else if (edge === 'end') {
      start = boundary;
    } else {
      const leftTokens = tokenCount(tokenizer, text.slice(start, boundary), false);
      if (target < leftTokens) {
        end = boundary;
      } else {
        start = boundary;
        target = Math.max(0, target - leftTokens);
      }
    }
  }
}

function fittedTokenAwareChunk(tokenizer, text, start, end, { edge, target, requiredMidpoint } = {}) {
  const retainsTarget = Number.isInteger(target) && target > start && target < end;
  const chunk = targetedTokenAwareChunk(
    tokenizer,
    text,
    { start, end },
    retainsTarget ? tokenCount(tokenizer, text.slice(start, target), false) : 0,
    retainsTarget ? undefined : edge,
  );
  if (retainsTarget && chunk.start <= target && target <= chunk.end) chunk.target = target;
  if (requiredMidpoint) chunk.requiredMidpoint = true;
  return chunk;
}

function moveCodePoints(text, index, count, limit, direction) {
  let boundary = index;
  for (let moved = 0; moved < count && boundary !== limit; moved += 1) {
    if (direction > 0) {
      const codePoint = text.codePointAt(boundary);
      boundary = Math.min(limit, boundary + (codePoint > 0xffff ? 2 : 1));
    } else {
      boundary -= 1;
      const codeUnit = text.charCodeAt(boundary);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && boundary > limit) boundary -= 1;
      boundary = Math.max(limit, boundary);
    }
  }
  return boundary;
}

function nextPreferredBoundary(text, index, limit, direction) {
  let boundary = index;
  while (boundary !== limit) {
    const next = moveCodePoints(text, boundary, 1, limit, direction);
    const character = direction > 0 ? text.slice(boundary, next) : text.slice(next, boundary);
    if (isPreferredBoundary(character)) return direction > 0 ? next : boundary;
    boundary = next;
  }
  return limit;
}

function expandedChunk(tokenizer, text, chunk, limit, direction, recoverPreferred = false) {
  const fixedBoundary = direction > 0 ? chunk.start : chunk.end;
  let fitBoundary = direction > 0 ? chunk.end : chunk.start;
  if (fitBoundary === limit) return chunk;
  let fitTokens = chunk.sequenceTokens;
  let step = Math.max(1, MAX_EMBEDDING_SEQUENCE_TOKENS - fitTokens);
  let unfitBoundary = null;

  const countAt = (boundary) => tokenCount(
    tokenizer,
    direction > 0
      ? text.slice(fixedBoundary, boundary)
      : text.slice(boundary, fixedBoundary),
    true,
  );
  if (recoverPreferred) {
    while (fitBoundary !== limit) {
      const probe = moveCodePoints(text, fitBoundary, step, limit, direction);
      const probeTokens = countAt(probe);
      if (probeTokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
        fitBoundary = probe;
        fitTokens = probeTokens;
        step = Math.max(2, step * 2);
        continue;
      }
      const preferred = nextPreferredBoundary(text, probe, limit, direction);
      if (preferred !== probe) {
        const preferredTokens = countAt(preferred);
        if (preferredTokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
          fitBoundary = preferred;
          fitTokens = preferredTokens;
          step = Math.max(2, step * 2);
          continue;
        }
      }
      unfitBoundary = probe;
      break;
    }
  } else {
    const probe = moveCodePoints(text, fitBoundary, step, limit, direction);
    const probeTokens = countAt(probe);
    if (probeTokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
      fitBoundary = probe;
      fitTokens = probeTokens;
      if (fitBoundary !== limit) {
        const adjacent = moveCodePoints(text, fitBoundary, 1, limit, direction);
        const adjacentTokens = countAt(adjacent);
        if (adjacentTokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
          fitBoundary = adjacent;
          fitTokens = adjacentTokens;
          step = Math.max(2, step * 2);
          while (fitBoundary !== limit) {
            const farther = moveCodePoints(text, fitBoundary, step, limit, direction);
            const fartherTokens = countAt(farther);
            if (fartherTokens > MAX_EMBEDDING_SEQUENCE_TOKENS) {
              unfitBoundary = farther;
              break;
            }
            fitBoundary = farther;
            fitTokens = fartherTokens;
            step *= 2;
          }
        } else {
          unfitBoundary = adjacent;
        }
      }
    } else {
      unfitBoundary = probe;
    }
  }

  while (unfitBoundary !== null) {
    const lower = Math.min(fitBoundary, unfitBoundary);
    const upper = Math.max(fitBoundary, unfitBoundary);
    const boundary = splitBoundary(text, lower, upper);
    if (boundary === null) break;
    const tokens = countAt(boundary);
    if (tokens <= MAX_EMBEDDING_SEQUENCE_TOKENS) {
      fitBoundary = boundary;
      fitTokens = tokens;
    } else {
      unfitBoundary = boundary;
    }
  }

  const start = direction > 0 ? chunk.start : fitBoundary;
  const end = direction > 0 ? fitBoundary : chunk.end;
  const value = text.slice(start, end);
  return {
    start,
    end,
    text: value,
    sequenceTokens: fitTokens,
    contentTokens: tokenCount(tokenizer, value, false),
    target: chunk.target,
    requiredMidpoint: chunk.requiredMidpoint,
  };
}

function expandSelectedChunks(tokenizer, text, selected) {
  const lastIndex = selected.length - 1;
  const anchors = selected.map((chunk, index) => {
    if (index === 0) return 0;
    if (index === lastIndex) return text.length;
    return Math.max(chunk.start, Math.min(chunk.end, chunk.target));
  });
  const boundaries = [0];
  for (let index = 1; index < anchors.length; index += 1) {
    const left = anchors[index - 1];
    const right = anchors[index];
    // Interpolate equal source-quantile cells without giving endpoint samples half-width zones.
    let boundary = left + Math.ceil(((right - left) * (anchors.length - index)) / anchors.length);
    if (boundary <= left || boundary >= right) {
      boundary = fallbackBoundary(text, left, right) ?? selected[index].start;
    } else if (!isCodePointBoundary(text, boundary, left, right)) {
      boundary -= 1;
    }
    boundaries.push(boundary);
  }
  boundaries.push(text.length);

  return selected.map((candidate, index) => {
    const edge = index === 0 ? 'start' : index === lastIndex ? 'end' : undefined;
    const zoneStart = boundaries[index];
    const zoneEnd = boundaries[index + 1];
    let windowStart = zoneStart;
    let windowEnd = zoneEnd;
    if (windowEnd - windowStart > MAX_CANONICAL_TEXT_CHARS) {
      if (edge === 'start') {
        windowEnd = windowStart + MAX_CANONICAL_TEXT_CHARS;
        if (!isCodePointBoundary(text, windowEnd, windowStart, zoneEnd)) windowEnd -= 1;
      } else if (edge === 'end') {
        windowStart = windowEnd - MAX_CANONICAL_TEXT_CHARS;
        if (!isCodePointBoundary(text, windowStart, zoneStart, windowEnd)) windowStart += 1;
      } else {
        windowStart = Math.min(
          Math.max(zoneStart, anchors[index] - Math.floor(MAX_CANONICAL_TEXT_CHARS / 2)),
          zoneEnd - MAX_CANONICAL_TEXT_CHARS,
        );
        if (windowStart > zoneStart && !isCodePointBoundary(text, windowStart, zoneStart, zoneEnd)) windowStart += 1;
        windowEnd = Math.min(zoneEnd, windowStart + MAX_CANONICAL_TEXT_CHARS);
        if (windowEnd < zoneEnd && !isCodePointBoundary(text, windowEnd, windowStart, zoneEnd)) windowEnd -= 1;
      }
    }

    const start = Math.max(candidate.start, windowStart);
    const end = Math.min(candidate.end, windowEnd);
    let chunk = start === candidate.start && end === candidate.end
      ? candidate
      : fittedTokenAwareChunk(tokenizer, text, start, end, {
        edge,
        target: anchors[index],
        requiredMidpoint: candidate.requiredMidpoint,
      });
    if (edge === 'start') {
      chunk = expandedChunk(tokenizer, text, chunk, windowEnd, 1);
    } else if (edge === 'end') {
      chunk = expandedChunk(tokenizer, text, chunk, windowStart, -1);
    } else {
      chunk = expandedChunk(tokenizer, text, chunk, windowEnd, 1);
      if (chunk.sequenceTokens < MAX_EMBEDDING_SEQUENCE_TOKENS) {
        chunk = expandedChunk(tokenizer, text, chunk, windowStart, -1);
      }
    }
    return chunk;
  });
}

function sampleTokenAwareChunks(tokenizer, text) {
  const emptyContentTokens = tokenCount(tokenizer, '', false);
  const specialTokenOverhead = tokenCount(tokenizer, '', true) - emptyContentTokens;
  const maximumChunkContentTokens = MAX_EMBEDDING_SEQUENCE_TOKENS - specialTokenOverhead;
  if (specialTokenOverhead < 0 || maximumChunkContentTokens < 1) {
    throw new TypeError('Embedding tokenizer has invalid special-token overhead');
  }
  const sampleCount = Math.min(
    // Leave room for a source-midpoint candidate when token quantiles do not cover it.
    MAX_EMBEDDING_CHUNKS - 1,
    Math.floor(MAX_INDEXED_TOKENS / maximumChunkContentTokens),
  );
  if (sampleCount < 2) throw new TypeError('Embedding token limits cannot retain spanning samples');

  const regions = coarseSourceSpans(text, MAX_EMBEDDING_CHUNKS * 4).map((span) => {
    const value = text.slice(span.start, span.end);
    return { ...span, contentTokens: tokenCount(tokenizer, value, false) };
  });
  const regionalTokens = regions.reduce((total, region) => total + region.contentTokens, 0);
  if (regionalTokens < 1) throw new TypeError('Embedding tokenizer returned no regional content tokens');

  const candidates = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    let region;
    let localTarget;
    let edge;
    if (sample === 0) {
      region = regions[0];
      localTarget = 0;
      edge = 'start';
    } else if (sample === sampleCount - 1) {
      region = regions.at(-1);
      localTarget = region.contentTokens;
      edge = 'end';
    } else {
      const target = (regionalTokens * sample) / (sampleCount - 1);
      let cumulative = 0;
      let regionIndex = 0;
      while (regionIndex < regions.length - 1 && cumulative + regions[regionIndex].contentTokens <= target) {
        cumulative += regions[regionIndex].contentTokens;
        regionIndex += 1;
      }
      region = regions[regionIndex];
      localTarget = Math.max(0, target - cumulative);
    }
    candidates.push(targetedTokenAwareChunk(tokenizer, text, region, localTarget, edge));
  }

  const sourceMidpoint = fallbackBoundary(text, 0, text.length);
  if (sourceMidpoint === null) throw new TypeError('Embedding source midpoint cannot be represented safely');
  const containsMidpoint = (chunk) => chunk.start <= sourceMidpoint && sourceMidpoint < chunk.end;
  const coveringCandidate = candidates.find(containsMidpoint);
  if (coveringCandidate === undefined) {
    const midpointRegion = regions.find((region) => (
      region.start <= sourceMidpoint && sourceMidpoint < region.end
    ));
    if (midpointRegion === undefined) throw new TypeError('Embedding source midpoint is outside sampled regions');
    candidates.push(fittedTokenAwareChunk(
      tokenizer,
      text,
      midpointRegion.start,
      midpointRegion.end,
      {
        edge: sourceMidpoint === midpointRegion.start ? 'start' : undefined,
        target: sourceMidpoint,
        requiredMidpoint: true,
      },
    ));
  } else {
    coveringCandidate.target = sourceMidpoint;
    coveringCandidate.requiredMidpoint = true;
  }

  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const selected = [];
  for (const candidate of candidates) {
    const previous = selected.at(-1);
    if (previous === undefined || candidate.start >= previous.end) {
      selected.push(candidate);
      continue;
    }
    if (candidate.end <= previous.end) {
      if (candidate.requiredMidpoint) {
        previous.target = sourceMidpoint;
        previous.requiredMidpoint = true;
      }
      continue;
    }
    let requiredMidpoint = candidate.requiredMidpoint;
    if (requiredMidpoint && containsMidpoint(previous)) {
      previous.target = sourceMidpoint;
      previous.requiredMidpoint = true;
      requiredMidpoint = false;
    }
    selected.push(fittedTokenAwareChunk(tokenizer, text, previous.end, candidate.end, {
      edge: requiredMidpoint && sourceMidpoint === previous.end ? 'start' : 'end',
      target: requiredMidpoint ? sourceMidpoint : candidate.target,
      requiredMidpoint,
    }));
  }

  const expanded = expandSelectedChunks(tokenizer, text, selected);
  let selectedTokens = expanded.reduce((total, chunk) => total + chunk.contentTokens, 0);
  while ((selectedTokens > MAX_INDEXED_TOKENS || expanded.length > MAX_EMBEDDING_CHUNKS)
    && expanded.length > 3) {
    let removalIndex = -1;
    for (let index = 1; index < expanded.length - 1; index += 1) {
      if (expanded[index].requiredMidpoint) continue;
      if (removalIndex === -1 || expanded[index].contentTokens > expanded[removalIndex].contentTokens) {
        removalIndex = index;
      }
    }
    if (removalIndex === -1) break;
    selectedTokens -= expanded[removalIndex].contentTokens;
    expanded.splice(removalIndex, 1);
  }
  if (expanded.length < 3 || expanded[0].start !== 0 || expanded.at(-1).end !== text.length
    || expanded.length > MAX_EMBEDDING_CHUNKS || selectedTokens > MAX_INDEXED_TOKENS
    || !expanded.slice(1, -1).some((chunk) => chunk.requiredMidpoint && containsMidpoint(chunk))
    || expanded.some((chunk, index) => (
      chunk.start >= chunk.end || chunk.end - chunk.start > MAX_CANONICAL_TEXT_CHARS
      || chunk.sequenceTokens > MAX_EMBEDDING_SEQUENCE_TOKENS
      || index > 0 && chunk.start < expanded[index - 1].end
    ))) {
    throw new TypeError('Embedding samples exceed spanning or token limits');
  }
  return expanded;
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
  const scaledNorm = Math.sqrt(scaledSquared);
  return mean.map((value) => (value / scale) / scaledNorm);
}

async function defaultPipelineFactory(...args) {
  const imported = await import('@huggingface/transformers');
  if (typeof imported.pipeline !== 'function') throw new TypeError('Embedding runtime does not export pipeline');
  return imported.pipeline(...args);
}

async function outputVectors(output, batchSize) {
  let value = output;
  if (value !== null && typeof value === 'object' && typeof value.tolist === 'function') value = await value.tolist();
  else if (value !== null && typeof value === 'object' && isVector(value.data)) {
    const { data, dims } = value;
    if (!Array.isArray(dims) || dims.length !== 2 || dims[0] !== batchSize
      || !Number.isInteger(dims[1]) || dims[1] < 1 || dims[1] > MAX_VECTOR_DIMENSIONS
      || data.length !== dims[0] * dims[1]) {
      throw new TypeError('Embedding output tensor has invalid dimensions');
    }
    const flattened = Array.from(data);
    value = Array.from({ length: dims[0] }, (_, index) => (
      flattened.slice(index * dims[1], (index + 1) * dims[1])
    ));
  }
  if (!Array.isArray(value) || value.length !== batchSize) {
    throw new TypeError('Embedding output batch has invalid cardinality');
  }
  const vectors = value.map((vector) => finiteVector(vector, 'Embedding output', MAX_VECTOR_DIMENSIONS));
  const dimensions = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new TypeError('Embedding output vectors must have equal dimensions');
  }
  return vectors;
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
          const tokenizer = extractor.tokenizer;
          if (tokenizer === null || typeof tokenizer !== 'object' && typeof tokenizer !== 'function'
            || typeof tokenizer.encode !== 'function') {
            throw new TypeError('Embedding pipeline must expose tokenizer.encode');
          }
          state = 'ready';
          lastError = null;
          errorCode = null;
          nextRetryAt = null;
          return { extractor, tokenizer };
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
    if (typeof text !== 'string' || text.length > MAX_EMBEDDING_INPUT_CHARS || !text.trim().length) {
      throw new TypeError(`Embedding text must be a nonempty string of at most ${MAX_EMBEDDING_INPUT_CHARS} characters`);
    }
    const pipeline = await getPipeline();
    try {
      let chunks = text.length > MAX_CANONICAL_TEXT_CHARS
        ? sampleTokenAwareChunks(pipeline.tokenizer, text)
        : tokenAwareChunks(pipeline.tokenizer, text);
      if (chunks === INDEXED_TOKEN_BUDGET_EXCEEDED) {
        chunks = sampleTokenAwareChunks(pipeline.tokenizer, text);
      }
      const vectors = [];
      for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE).map((chunk) => chunk.text);
        const output = await pipeline.extractor(batch, { pooling: 'mean', normalize: true });
        vectors.push(...await outputVectors(output, batch.length));
      }
      const vector = finiteVector(
        meanNormalizedVector(vectors),
        'Embedding aggregate output',
        MAX_VECTOR_DIMENSIONS,
      );
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
