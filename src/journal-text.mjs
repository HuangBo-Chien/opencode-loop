const RAW_TEXT_LOOKAHEAD = 4096;
const MAX_REQUEST_PARTS = 256;
const MAX_ASSIGNMENT_KEY_CHARS = 128;
const MAX_TYPESCRIPT_TYPE_CHARS = 512;
const MAX_TYPESCRIPT_TYPE_DEPTH = 8;
const REDACTED = '[REDACTED]';
const BEARER_TOKEN = /\b(Bearer[ \t]+)(?!\[REDACTED\])([^\s,;]+)/gi;
const JWT_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}(?![A-Za-z0-9_-])/g;
const TRUNCATED_JWT_TAIL = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{3,}(?:\.[A-Za-z0-9_-]*)?$/g;
const PREFIXED_TOKEN = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[a-z]-[A-Za-z0-9-]{6,})(?![A-Za-z0-9_-])/gi;
const TRUNCATED_PREFIXED_TOKEN_TAIL = /(?<![A-Za-z0-9_])(?:sk-[A-Za-z0-9_-]*|ghp_[A-Za-z0-9_]*|github_pat_[A-Za-z0-9_]*|xox[a-z]-[A-Za-z0-9-]*)$/gi;
const PROCESS_ENV_REFERENCE = /^process[ \t]*\.[ \t]*env[ \t]*\.[ \t]*[A-Za-z_$][A-Za-z0-9_$]*$/;
const CALL_EXPRESSION = /^(?:(?:await|new)[ \t]+)*[A-Za-z_$][A-Za-z0-9_$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)*[ \t]*\(/;
const ARROW_EXPRESSION = /^(?:async[ \t]+)?(?:[A-Za-z_$][A-Za-z0-9_$]*|\([^)]*\))[ \t]*=>/;
const MEMBER_ACCESS_EXPRESSION = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[ \t]*\.[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const DECLARATION_PREFIX = /\b(?:const|let|var)[ \t]+$/;
const TYPESCRIPT_PRIMITIVES = new Set([
  'any', 'bigint', 'boolean', 'never', 'null', 'number', 'object', 'string', 'symbol', 'undefined', 'unknown', 'void',
]);
const SECRET_METADATA_SUFFIXES = new Set([
  'count', 'enabled', 'hint', 'label', 'length', 'name', 'policy', 'required', 'ttl', 'type',
]);

function keyWords(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSecretKey(key) {
  const words = keyWords(key);
  const terminal = words.at(-1);
  if (SECRET_METADATA_SUFFIXES.has(terminal)) return false;
  const separated = /[^A-Za-z0-9]/.test(key);
  const secretTerm = separated
    ? words.some((word) => word === 'secret' || word === 'password' || word === 'token')
    : terminal === 'secret' || terminal === 'password' || terminal === 'token';
  const secretKey = words.at(-2) === 'secret' && terminal === 'key';
  const secretAccessKey = words.at(-3) === 'secret' && words.at(-2) === 'access' && terminal === 'key';
  return secretTerm || secretKey || secretAccessKey || terminal === 'apikey' || (words.at(-2) === 'api' && terminal === 'key');
}

function isKeyCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_.-]/.test(character);
}

function isTypeIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_$]/.test(character);
}

function isTypeIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function skipTypeWhitespace(line, start, end) {
  let cursor = start;
  while (cursor < end && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1;
  return cursor;
}

function parseTypeExpression(line, start, end, depth = 0) {
  if (depth > MAX_TYPESCRIPT_TYPE_DEPTH) return null;
  let term = parseTypeTerm(line, start, end, depth);
  if (!term) return null;
  let cursor = term.end;
  let typeEvidence = term.typeEvidence;
  while (true) {
    cursor = skipTypeWhitespace(line, cursor, end);
    if (line[cursor] !== '|') break;
    term = parseTypeTerm(line, cursor + 1, end, depth);
    if (!term) return null;
    cursor = term.end;
    typeEvidence = true;
  }
  return { end: cursor, typeEvidence };
}

function parseTypeTerm(line, start, end, depth) {
  let cursor = skipTypeWhitespace(line, start, end);
  if (!isTypeIdentifierStart(line[cursor])) return null;
  const firstStart = cursor;
  cursor += 1;
  while (cursor < end && isTypeIdentifierPart(line[cursor])) cursor += 1;
  const first = line.slice(firstStart, cursor);
  let typeEvidence = TYPESCRIPT_PRIMITIVES.has(first);

  while (line[cursor] === '.') {
    cursor += 1;
    if (!isTypeIdentifierStart(line[cursor])) return null;
    cursor += 1;
    while (cursor < end && isTypeIdentifierPart(line[cursor])) cursor += 1;
    typeEvidence = true;
  }

  cursor = skipTypeWhitespace(line, cursor, end);
  if (line[cursor] === '<') {
    typeEvidence = true;
    cursor = skipTypeWhitespace(line, cursor + 1, end);
    while (true) {
      const argument = parseTypeExpression(line, cursor, end, depth + 1);
      if (!argument) return null;
      cursor = skipTypeWhitespace(line, argument.end, end);
      if (line[cursor] === '>') {
        cursor += 1;
        break;
      }
      if (line[cursor] !== ',') return null;
      cursor = skipTypeWhitespace(line, cursor + 1, end);
    }
  }

  while (true) {
    const bracket = skipTypeWhitespace(line, cursor, end);
    if (line[bracket] !== '[' || line[bracket + 1] !== ']') break;
    cursor = bracket + 2;
    typeEvidence = true;
  }
  return { end: cursor, typeEvidence };
}

function isTypeScriptTypeAnnotation(line, start) {
  const end = Math.min(line.length, start + MAX_TYPESCRIPT_TYPE_CHARS + 1);
  const parsed = parseTypeExpression(line, start, end);
  if (!parsed?.typeEvidence) return false;
  const cursor = skipTypeWhitespace(line, parsed.end, end);
  if (cursor - start > MAX_TYPESCRIPT_TYPE_CHARS) return false;
  return cursor === line.length || /[,;}\]]/.test(line[cursor]);
}

function assignmentValue(start, end, scanEnd, value, quoted = false) {
  const normalized = value.trim();
  return {
    start,
    end,
    scanEnd,
    alreadyRedacted: normalized === REDACTED && (!quoted || value.length > 0),
  };
}

function isUnquotedCodeExpression(line, keyStart, value) {
  const normalized = value.trim();
  if (PROCESS_ENV_REFERENCE.test(normalized)) return true;
  if (CALL_EXPRESSION.test(normalized) || ARROW_EXPRESSION.test(normalized)) return true;
  return DECLARATION_PREFIX.test(line.slice(0, keyStart)) && MEMBER_ACCESS_EXPRESSION.test(normalized);
}

function assignmentAt(line, start) {
  if (start > 0 && isKeyCharacter(line[start - 1])) return null;
  let cursor = start;
  let key;
  const quote = line[cursor] === '"' || line[cursor] === "'" ? line[cursor] : '';
  if (quote) {
    const keyStart = ++cursor;
    let escaped = false;
    while (cursor < line.length && cursor - keyStart <= MAX_ASSIGNMENT_KEY_CHARS) {
      if (!escaped && line[cursor] === quote) break;
      escaped = !escaped && line[cursor] === '\\';
      if (line[cursor] !== '\\') escaped = false;
      cursor += 1;
    }
    if (line[cursor] !== quote || cursor === keyStart || cursor - keyStart > MAX_ASSIGNMENT_KEY_CHARS) return null;
    key = line.slice(keyStart, cursor);
    cursor += 1;
  } else {
    const keyStart = cursor;
    while (isKeyCharacter(line[cursor]) && cursor - keyStart < MAX_ASSIGNMENT_KEY_CHARS) cursor += 1;
    if (cursor === keyStart || isKeyCharacter(line[cursor])) return null;
    key = line.slice(keyStart, cursor);
    const firstWords = keyWords(key);
    if (firstWords.length === 1 && firstWords[0] === 'api') {
      const spacingStart = cursor;
      while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
      const nextStart = cursor;
      while (isKeyCharacter(line[cursor]) && cursor - nextStart < MAX_ASSIGNMENT_KEY_CHARS) cursor += 1;
      if (cursor > nextStart && keyWords(line.slice(nextStart, cursor)).join(' ') === 'key') {
        key = `${key} ${line.slice(nextStart, cursor)}`;
      } else {
        cursor = spacingStart;
      }
    }
  }
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  if (line[cursor] !== ':' && line[cursor] !== '=') return null;
  const operator = line[cursor];
  if (operator === '=' && (line[cursor + 1] === '=' || line[cursor + 1] === '>')) return null;
  cursor += 1;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
  if (!isSecretKey(key) || cursor >= line.length) return null;
  if (operator === ':' && isTypeScriptTypeAnnotation(line, cursor)) return null;

  const rawValueStart = cursor;
  const valueQuote = line[cursor] === '"' || line[cursor] === "'" ? line[cursor] : '';
  if (valueQuote) {
    const valueStart = cursor + 1;
    cursor = valueStart;
    while (cursor < line.length) {
      if (line[cursor] === '\\' && cursor + 1 < line.length) {
        cursor += 2;
        continue;
      }
      if (line[cursor] === valueQuote) {
        if (cursor === valueStart) return null;
        let tail = cursor + 1;
        while (line[tail] === ' ' || line[tail] === '\t') tail += 1;
        if (tail === line.length || /[,;}\]]/.test(line[tail])) {
          return assignmentValue(valueStart, cursor, tail, line.slice(valueStart, cursor), true);
        }
        while (tail < line.length && !/[,;}\]]/.test(line[tail])) tail += 1;
        return assignmentValue(rawValueStart, tail, tail, line.slice(rawValueStart, tail));
      }
      cursor += 1;
    }
    return cursor === valueStart ? null : assignmentValue(valueStart, cursor, cursor, line.slice(valueStart, cursor));
  }

  const valueStart = cursor;
  if (/[,;}\]]/.test(line[cursor])) cursor += 1;
  if (line.startsWith(REDACTED, cursor)) cursor += REDACTED.length;
  while (cursor < line.length && !/[,;}\]]/.test(line[cursor])) cursor += 1;
  const value = line.slice(valueStart, cursor);
  if (cursor === valueStart || isUnquotedCodeExpression(line, start, value)) return null;
  return assignmentValue(valueStart, cursor, cursor, value);
}

function redactSecretAssignments(line) {
  let cursor = 0;
  let scan = 0;
  let output = '';
  let redactions = 0;
  while (scan < line.length) {
    const assignment = assignmentAt(line, scan);
    if (!assignment) {
      scan += 1;
      continue;
    }
    if (assignment.alreadyRedacted) {
      scan = assignment.scanEnd;
      continue;
    }
    output += `${line.slice(cursor, assignment.start)}${REDACTED}`;
    cursor = assignment.end;
    scan = assignment.scanEnd;
    redactions += 1;
  }
  return { text: `${output}${line.slice(cursor)}`, redactions };
}

function sanitizeBoundedJournalText(input, limit, rawTruncated) {
  const jwtTailCrossesRawBoundary = rawTruncated && /[.A-Za-z0-9_-]$/.test(input);
  const prefixedTokenTailCrossesRawBoundary = rawTruncated && /[A-Za-z0-9_-]$/.test(input);
  let text = input.replace(/\r\n/g, '\n').trim();
  let redactions = 0;
  const assigned = text.split('\n').map(redactSecretAssignments);
  text = assigned.map((line) => line.text).join('\n');
  redactions += assigned.reduce((total, line) => total + line.redactions, 0);
  text = text.replace(BEARER_TOKEN, (_match, prefix) => {
    redactions += 1;
    return `${prefix}[REDACTED]`;
  });
  text = text.replace(JWT_TOKEN, () => {
    redactions += 1;
    return REDACTED;
  });
  if (jwtTailCrossesRawBoundary) {
    text = text.replace(TRUNCATED_JWT_TAIL, () => {
      redactions += 1;
      return REDACTED;
    });
  }
  text = text.replace(PREFIXED_TOKEN, () => {
    redactions += 1;
    return REDACTED;
  });
  if (prefixedTokenTailCrossesRawBoundary) {
    text = text.replace(TRUNCATED_PREFIXED_TOKEN_TAIL, () => {
      redactions += 1;
      return REDACTED;
    });
  }

  const truncated = rawTruncated || text.length > limit;
  return { text: truncated ? text.slice(0, limit) : text, truncated, redactions };
}

export function sanitizeJournalText(input, limit) {
  if (typeof input !== 'string') throw new TypeError('Journal text must be a string');
  if (!Number.isInteger(limit) || limit < 1 || limit > 32000) throw new TypeError('Journal text limit must be an integer from 1 to 32000');

  const rawCap = limit + RAW_TEXT_LOOKAHEAD;
  const rawTruncated = input.length > rawCap;
  return sanitizeBoundedJournalText(input.slice(0, rawCap), limit, rawTruncated);
}

export function captureRequest(parts, journalOptions) {
  if (journalOptions?.enabled !== true || journalOptions.includeUserRequest !== true || !Array.isArray(parts)) return null;
  const limit = journalOptions.maxUserRequestChars;
  if (!Number.isInteger(limit) || limit < 1 || limit > 32000) throw new TypeError('Journal text limit must be an integer from 1 to 32000');
  const rawCap = limit + RAW_TEXT_LOOKAHEAD;
  const text = [];
  let rawLength = 0;
  let inspectedLength = 0;
  let rawTailTruncated = false;
  const inspectedParts = Math.min(parts.length, MAX_REQUEST_PARTS);
  let omittedContent = parts.length > inspectedParts;
  for (let index = 0; index < inspectedParts; index += 1) {
    if (inspectedLength >= rawCap || rawLength >= rawCap) {
      omittedContent = true;
      rawTailTruncated = true;
      break;
    }
    const part = parts[index];
    if (part === null || typeof part !== 'object' || Array.isArray(part) || part.type !== 'text') continue;
    const partText = part.text;
    if (typeof partText !== 'string' || !partText.length) continue;
    const separator = text.length ? '\n\n' : '';
    const available = Math.min(rawCap - inspectedLength, rawCap - rawLength - separator.length);
    if (available <= 0) {
      omittedContent = true;
      rawTailTruncated = true;
      break;
    }
    const bounded = partText.slice(0, available);
    inspectedLength += bounded.length;
    const omittedFromPart = partText.length > bounded.length;
    if (!bounded.trim().length) {
      if (omittedFromPart) {
        omittedContent = true;
        rawTailTruncated = true;
        break;
      }
      continue;
    }
    if (separator) {
      text.push(separator);
      rawLength += separator.length;
    }
    text.push(bounded);
    rawLength += bounded.length;
    if (omittedFromPart) {
      omittedContent = true;
      rawTailTruncated = true;
      break;
    }
  }
  if (!text.length) return null;
  const captured = sanitizeBoundedJournalText(text.join(''), limit, rawTailTruncated);
  if (!captured.text.length) return null;
  return omittedContent && !captured.truncated ? { ...captured, truncated: true } : captured;
}
