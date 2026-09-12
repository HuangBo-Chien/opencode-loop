// Best-effort static screening of shell commands for file-write targets.
// This is a heuristic boundary, not a sandbox: it extracts the common write
// shapes (redirections, tee/cp/mv/rm/dd/sed -i/truncate/install operands)
// after dropping heredoc bodies and quoted spans, resolves each candidate
// against the command's tracked working directory, and reports the first
// workspace-relative target that falls outside the allowed scope patterns.
// Anything the screen cannot confidently resolve fails open to the native
// permission flow; verdicts never relax because of a parse miss.

import { matchScopePath, normalizeScopePath } from './task-spec.mjs';

const MAX_SCAN_CHARS = 100_000;
const WRITE_COMMANDS = new Set(['cp', 'mv', 'install', 'rm', 'tee', 'dd', 'sed', 'truncate']);
const SKIP_TARGETS = /^\/dev\/(null|zero|full|stdout|stderr|tty)/;
// '$', '*' and backtick indicate expansion or unexpanded globs anywhere in
// a token; '~' only means tilde expansion at the start of one. Mid-token
// tildes are literal characters (notably Windows 8.3 short names like
// C:\Users\RUNNER~1\...), so treating them as unresolvable would fail open
// on real runner paths.
const UNRESOLVABLE = /[$*`]/;
const TILDE_EXPANSION = /^~/;
function unresolvableToken(raw) {
  return UNRESOLVABLE.test(raw) || TILDE_EXPANSION.test(raw);
}
const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripHeredocs(command) {
  let text = command;
  for (;;) {
    const opener = text.match(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!opener || opener.index === undefined) return text;
    const head = text.slice(0, opener.index);
    const body = text.slice(opener.index + opener[0].length);
    const lines = body.split('\n');
    const terminator = lines.findIndex((line) => line.trim() === opener[2]);
    text = terminator === -1 ? head : `${head}\n${lines.slice(terminator + 1).join('\n')}`;
  }
}

function stripQuotedSpans(text) {
  return text.replace(/'(?:[^']|'\\'' )*'/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
}

// Canonical join of a tracked cwd and a relative operand; '..' beyond the
// workspace root escapes and is treated as unresolvable (outside the tree).
function joinRelative(cwd, relativePath) {
  const stack = cwd.length ? cwd.split('/') : [];
  for (const segment of relativePath.split('/')) {
    if (!segment.length || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

// Resolves one candidate path against the tracked working directory.
// Absolute paths map through the caller's workspace-relative resolver; paths
// outside the workspace or containing unresolvable tokens return null.
function resolveCandidate(raw, cwd, toWorkspaceRelative) {
  if (typeof raw !== 'string' || !raw.length || SKIP_TARGETS.test(raw) || unresolvableToken(raw)) return null;
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('/')) {
    return toWorkspaceRelative(raw);
  }
  if (/[\x00-\x1f\x7f\\]/.test(raw)) return null;
  return joinRelative(cwd, raw);
}

function scopeMatches(patterns, candidate) {
  return patterns.some((pattern) => matchScopePath(pattern, candidate)
    || (pattern.endsWith('/**') && candidate === pattern.slice(0, -3)));
}

/**
 * Extract candidate write targets from a shell command string. Each target is
 * returned as a workspace-relative path (or null when it resolves outside the
 * workspace) so the caller can compare it against scope patterns.
 */
export function extractShellWriteTargets(command, toWorkspaceRelative) {
  if (typeof command !== 'string' || !command.length) return [];
  const scanned = stripQuotedSpans(stripHeredocs(command.slice(0, MAX_SCAN_CHARS)));
  const targets = [];

  for (const candidate of scanned.matchAll(/(?:[0-9]|&)?>>?\s*([^\s;|&<>()]+)/g)) {
    const raw = candidate[1];
    // Lone digits are fd numbers (`1>&2` duplicates stderr), not file targets;
    // `&`-prefixed captures are fd duplicators and already skipped.
    if (!raw.startsWith('&') && !/^\d+$/.test(raw)) targets.push(raw);
  }

  let cwd = '';
  let outside = false;
  for (const segment of scanned.split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    while (tokens.length && ASSIGNMENT.test(tokens[0])) tokens.shift();
    if (!tokens.length) continue;
    const command = tokens[0].split('/').pop();
    const operands = [];
    const flags = [];
    let flagTTarget = null;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '-t' && index + 1 < tokens.length) { flagTTarget = tokens[index + 1]; index += 1; continue; }
      if (command === 'truncate' && token === '-s' && index + 1 < tokens.length) { index += 1; continue; }
      if (token.startsWith('-') && token.length > 1) { flags.push(token); continue; }
      operands.push(token);
    }
    if (command === 'cd') {
      const destination = operands[0];
      if (destination === undefined) cwd = '';
      else if (destination.startsWith('/') || /^[a-zA-Z]:/.test(destination)) {
        const relative = toWorkspaceRelative(destination);
        if (relative === null) outside = true;
        else { cwd = relative; outside = false; }
      } else if (!unresolvableToken(destination)) {
        const joined = cwd.length ? `${cwd}/${destination}` : destination;
        const normalized = normalizeScopePath(joined);
        if (normalized) cwd = normalized;
      } else outside = true;
      continue;
    }
    if (!WRITE_COMMANDS.has(command) || outside) continue;
    if (command === 'cp' || command === 'mv') {
      if (flagTTarget !== null) targets.push(flagTTarget);
      else if (operands.length >= 2) targets.push(operands[operands.length - 1]);
    } else if (command === 'install') {
      if (flagTTarget !== null) targets.push(flagTTarget);
      else if (operands.length >= 1) targets.push(operands[operands.length - 1]);
    } else if (command === 'rm' || command === 'tee' || command === 'truncate') {
      targets.push(...operands.filter((operand) => operand !== '-'));
    } else if (command === 'dd') {
      targets.push(...operands.filter((operand) => operand.startsWith('of=')).map((operand) => operand.slice(3)));
    } else if (command === 'sed') {
      if (flags.some((flag) => /^-[a-zA-Z]*i/.test(flag)) && operands.length >= 2) {
        targets.push(...operands.slice(1));
      }
    }
  }
  return targets.map((raw) => resolveCandidate(raw, cwd, toWorkspaceRelative));
}

// Returns the first workspace-relative write target that is outside every
// pattern, or null when nothing conclusively escapes.
export function firstOutOfScopeShellWrite(command, patterns, toWorkspaceRelative) {
  for (const target of extractShellWriteTargets(command, toWorkspaceRelative)) {
    if (target !== null && !scopeMatches(patterns, target)) return target;
  }
  return null;
}
