import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, opendir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { embeddingSpaceDigest, validateEmbeddingSpace } from './embeddings.mjs';
import { cleanJson, stableHash } from './json-safe.mjs';

export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_EMBEDDING_SCHEMA_VERSION = 2;
export const JOURNAL_SEARCH_MAX_CANDIDATES = 64;
export const JOURNAL_SEARCH_MAX_DIRENTS = JOURNAL_SEARCH_MAX_CANDIDATES * 4;
export const JOURNAL_SEARCH_MAX_BYTES = 2 * 1024 * 1024;

const ID_PATTERN = /^[a-f0-9]{64}$/;
const ENTRY_KEYS = Object.freeze(['body', 'createdAt', 'id', 'kind', 'metadata', 'schemaVersion', 'scope', 'sourceIds', 'tags', 'title']);
const EMBEDDING_KEYS = Object.freeze(['digest', 'dimensions', 'schemaVersion', 'space', 'spaceDigest', 'vector']);
const KINDS = Object.freeze({
  project: new Set(['run-summary', 'insight']),
  global: new Set(['promoted-insight']),
});
const MAX_BODY_CHARS = 1_000_000;
const MAX_ENTRY_BYTES = 4_200_000;
const MAX_EMBEDDING_BYTES = 262_144;
const MAX_EMBEDDING_DIMENSIONS = 4096;
const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;
const FILE_TYPE_CHECKS = Object.freeze(['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket']);

export class JournalBoundedReadError extends Error {
  constructor(message, { maxBytes, bytesRead }) {
    super(message);
    this.name = 'JournalBoundedReadError';
    this.code = 'JOURNAL_READ_LIMIT_EXCEEDED';
    this.maxBytes = maxBytes;
    this.bytesRead = bytesRead;
  }
}

async function readHandleBounded(handle, maxBytes, overflowMessage) {
  const buffer = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, Math.max(1, maxBytes)));
  const decoder = new StringDecoder('utf8');
  const parts = [];
  let bytesRead = 0;
  while (bytesRead < maxBytes) {
    const length = Math.min(buffer.byteLength, maxBytes - bytesRead);
    const result = await handle.read(buffer, 0, length, bytesRead);
    if (result.bytesRead === 0) {
      return { raw: `${parts.join('')}${decoder.end()}`, bytes: bytesRead };
    }
    bytesRead += result.bytesRead;
    parts.push(decoder.write(buffer.subarray(0, result.bytesRead)));
  }
  const overflow = await handle.read(buffer, 0, 1, bytesRead);
  if (overflow.bytesRead !== 0) {
    throw new JournalBoundedReadError(overflowMessage, { maxBytes, bytesRead: bytesRead + overflow.bytesRead });
  }
  return { raw: `${parts.join('')}${decoder.end()}`, bytes: bytesRead };
}

export function stableJournalId(...parts) {
  return stableHash(parts);
}

function validateScope(scope) {
  if (scope !== 'project' && scope !== 'global') throw new TypeError("Journal scope must be 'project' or 'global'");
  return scope;
}

function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Journal id must be a lowercase SHA-256 digest');
  return id;
}

function boundedString(value, name, limit) {
  if (typeof value !== 'string' || !value.trim().length || value.length > limit) throw new TypeError(`${name} must be a nonempty string of at most ${limit} characters`);
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.length > 128) throw new TypeError(`${name} must be a bounded string array`);
  for (const item of value) boundedString(item, `${name} item`, 256);
}

function validateEntry(input, expectedScope) {
  const scope = validateScope(expectedScope);
  const value = cleanJson(input, { maxBytes: MAX_ENTRY_BYTES, maxValues: 10_000, maxDepth: 32 });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Journal entry must be a plain JSON object');
  if (Object.keys(value).sort().join('\0') !== ENTRY_KEYS.join('\0')) throw new TypeError('Journal entry has an invalid shape');
  if (value.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw new TypeError('Journal entry schema version mismatch');
  validateId(value.id);
  if (value.scope !== scope) throw new TypeError(`Journal entry scope must be ${scope}`);
  if (!KINDS[scope].has(value.kind)) throw new TypeError(`Journal kind ${value.kind} is not permitted in ${scope} scope`);
  boundedString(value.title, 'Journal title', 512);
  boundedString(value.createdAt, 'Journal createdAt', 128);
  boundedString(value.body, 'Journal body', MAX_BODY_CHARS);
  stringArray(value.tags, 'Journal tags');
  stringArray(value.sourceIds, 'Journal sourceIds');
  if (value.metadata === null || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) throw new TypeError('Journal metadata must be a plain JSON object');
  const metadata = cleanJson(value.metadata, { maxBytes: 262_144, maxValues: 4000, maxDepth: 24 });
  return Object.freeze({ ...value, metadata });
}

function validateEmbedding(input) {
  const value = cleanJson(input, {
    maxBytes: MAX_EMBEDDING_BYTES,
    maxValues: MAX_EMBEDDING_DIMENSIONS + 32,
    maxDepth: 4,
    maxKeys: MAX_EMBEDDING_DIMENSIONS + 1,
  });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Journal embedding sidecar must be a plain JSON object');
  if (Object.keys(value).join('\0') !== EMBEDDING_KEYS.join('\0')) throw new TypeError('Journal embedding sidecar has an invalid shape');
  if (value.schemaVersion !== JOURNAL_EMBEDDING_SCHEMA_VERSION) throw new TypeError('Journal embedding sidecar schema version mismatch');
  validateId(value.digest);
  const space = validateEmbeddingSpace(value.space);
  validateId(value.spaceDigest);
  if (value.spaceDigest !== embeddingSpaceDigest(space)) throw new TypeError('Journal embedding space digest mismatch');
  if (!Number.isInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > MAX_EMBEDDING_DIMENSIONS) {
    throw new TypeError(`Journal embedding dimensions must be an integer from 1 to ${MAX_EMBEDDING_DIMENSIONS}`);
  }
  if (!Array.isArray(value.vector) || value.vector.length !== value.dimensions
    || value.vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new TypeError('Journal embedding vector must contain exactly dimensions finite numbers');
  }
  return value;
}

function serializeEntry(entry) {
  const { body, ...frontmatter } = entry;
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}

function unavailableWorktree(message = 'Project journal requires an existing worktree') {
  const error = new Error(message);
  error.code = 'PROJECT_WORKTREE_UNAVAILABLE';
  return error;
}

function unsafeProjectPath(message) {
  const error = new Error(message);
  error.code = 'PROJECT_JOURNAL_UNSAFE_PATH';
  return error;
}

function unsafeGlobalPath(message) {
  const error = new Error(message);
  error.code = 'GLOBAL_JOURNAL_UNSAFE_PATH';
  return error;
}

function isSameOrDescendant(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function comparablePath(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function canonicalPathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function canonicalPathContains(root, candidate) {
  return isSameOrDescendant(comparablePath(root), comparablePath(candidate));
}

function journalRootsOverlap(left, right) {
  const comparableLeft = comparablePath(left);
  const comparableRight = comparablePath(right);
  return isSameOrDescendant(comparableLeft, comparableRight) || isSameOrDescendant(comparableRight, comparableLeft);
}

function sameFileIdentity(expected, current) {
  if (expected.size !== current.size || FILE_TYPE_CHECKS.some((check) => expected[check]() !== current[check]())) return false;
  const identityValues = [expected.dev, expected.ino, current.dev, current.ino];
  const identityAvailable = identityValues.every((value) => (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint');
  const inodeIsMeaningful = (expected.ino !== 0 && expected.ino !== 0n) || (current.ino !== 0 && current.ino !== 0n);
  return !identityAvailable || !inodeIsMeaningful || (expected.dev === current.dev && expected.ino === current.ino);
}

export function createJournalStore({ worktree, stateDirectory = '.opencode-loop', globalDirectory } = {}) {
  if (worktree !== undefined && worktree !== null && (typeof worktree !== 'string' || !worktree.length)) throw new TypeError('worktree must be a nonempty string when provided');
  if (typeof stateDirectory !== 'string' || !stateDirectory.length || stateDirectory.includes('\\') || isAbsolute(stateDirectory)
    || stateDirectory.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError('stateDirectory must be a safe relative path');
  }
  if (globalDirectory !== undefined && (typeof globalDirectory !== 'string' || !globalDirectory.length)) throw new TypeError('globalDirectory must be a nonempty string when provided');

  const resolvedWorktree = typeof worktree === 'string' ? resolve(worktree) : null;
  const projectDirectory = resolvedWorktree === null ? null : join(resolvedWorktree, stateDirectory, 'journal', 'entries');
  const projectIndexDirectory = resolvedWorktree === null ? null : join(resolvedWorktree, stateDirectory, 'journal', 'index');
  const projectDirectoryParts = [...stateDirectory.split('/'), 'journal', 'entries'];
  const projectIndexDirectoryParts = [...stateDirectory.split('/'), 'journal', 'index'];
  const resolvedGlobalDirectory = resolve(globalDirectory ?? join(homedir(), '.config', 'opencode', 'opencode-loop', 'journal', 'entries'));
  const resolvedGlobalIndexDirectory = join(dirname(resolvedGlobalDirectory), 'index');
  if (projectDirectory !== null) {
    const configuredProjectRoots = [projectDirectory, projectIndexDirectory];
    const configuredGlobalRoots = [resolvedGlobalDirectory, resolvedGlobalIndexDirectory];
    if (configuredProjectRoots.some((projectRoot) => configuredGlobalRoots.some((globalRoot) => journalRootsOverlap(projectRoot, globalRoot)))) {
      throw new TypeError('Project and global journal entry roots must not overlap');
    }
  }
  if (journalRootsOverlap(resolvedGlobalDirectory, resolvedGlobalIndexDirectory)) {
    throw new TypeError('Global journal entry and index roots must not overlap');
  }

  function directory(scope) {
    validateScope(scope);
    if (scope === 'project' && projectDirectory === null) throw unavailableWorktree();
    return scope === 'project' ? projectDirectory : resolvedGlobalDirectory;
  }

  function indexDirectory(scope) {
    validateScope(scope);
    if (scope === 'project' && projectIndexDirectory === null) throw unavailableWorktree();
    return scope === 'project' ? projectIndexDirectory : resolvedGlobalIndexDirectory;
  }

  async function canonicalProjectRoot(base, parts) {
    if (resolvedWorktree === null) return null;
    try {
      return await realpath(base);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return join(await realpath(resolvedWorktree), ...parts);
    }
  }

  function canonicalProjectDirectory() {
    return canonicalProjectRoot(projectDirectory, projectDirectoryParts);
  }

  function assertCanonicalRootsSeparated(scope, canonicalProject, canonicalGlobal) {
    if (!journalRootsOverlap(canonicalProject, canonicalGlobal)) return;
    if (scope === 'global') throw unsafeGlobalPath('Global journal entry root must not overlap the project journal entry root');
    throw unsafeProjectPath('Project journal entry root must not overlap the global journal entry root');
  }

  function unsafePath(scope, message) {
    return scope === 'global' ? unsafeGlobalPath(message) : unsafeProjectPath(message);
  }

  async function ensureExistingGlobalSeparatedFromProject(canonicalProject) {
    for (const globalRoot of [resolvedGlobalDirectory, resolvedGlobalIndexDirectory]) {
      try {
        await lstat(globalRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      assertCanonicalRootsSeparated('project', canonicalProject, await realpath(globalRoot));
    }
  }

  async function inspectProjectDirectory(target, { create, scope = 'project', worktreeRoot = false, allowMissingWorktree = false }) {
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (worktreeRoot) {
        if (allowMissingWorktree) return false;
        throw unavailableWorktree('Project journal worktree does not exist');
      }
      if (!create) return false;
      try {
        await mkdir(target);
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(target);
    }
    if (info.isSymbolicLink()) throw unsafePath(scope, 'Project journal path must not contain a symbolic link or junction');
    if (!info.isDirectory()) {
      if (worktreeRoot && scope === 'project') throw unavailableWorktree('Project journal worktree is not a directory');
      throw unsafePath(scope, 'Project journal path components must be directories');
    }
    return true;
  }

  async function inspectProjectComponents({ create, scope, allowMissingWorktree = false, parts = projectDirectoryParts }) {
    if (resolvedWorktree === null) return { worktreeExists: false, complete: false };
    if (!await inspectProjectDirectory(resolvedWorktree, { create: false, scope, worktreeRoot: true, allowMissingWorktree })) {
      return { worktreeExists: false, complete: false };
    }
    let current = resolvedWorktree;
    let complete = true;
    for (const part of parts) {
      current = join(current, part);
      if (!await inspectProjectDirectory(current, { create, scope })) {
        complete = false;
        break;
      }
    }
    return { worktreeExists: true, complete };
  }

  async function ensureProjectStorageAvailable(base, parts, create) {
    if (base === null) throw unavailableWorktree();
    await inspectProjectComponents({ create, scope: 'project', parts });
    const canonicalProject = await canonicalProjectRoot(base, parts);
    await ensureExistingGlobalSeparatedFromProject(canonicalProject);
    return canonicalProject;
  }

  function ensureProjectAvailable(create) {
    return ensureProjectStorageAvailable(projectDirectory, projectDirectoryParts, create);
  }

  function ensureProjectIndexAvailable(create) {
    return ensureProjectStorageAvailable(projectIndexDirectory, projectIndexDirectoryParts, create);
  }

  async function ensureGlobalStorageAvailable(base, create) {
    let info;
    try {
      info = await lstat(base);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) return null;
      try {
        await mkdir(base, { recursive: true });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      info = await lstat(base);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw unsafeGlobalPath('Global journal storage root must be a real directory, not a symbolic link or junction');
    }
    const canonicalGlobal = await realpath(base);
    const projectRoots = [
      [projectDirectory, projectDirectoryParts],
      [projectIndexDirectory, projectIndexDirectoryParts],
    ];
    for (const [projectRoot, parts] of projectRoots) {
      if (projectRoot === null) continue;
      const inspected = await inspectProjectComponents({ create: false, scope: 'global', allowMissingWorktree: true, parts });
      if (inspected.worktreeExists) {
        const canonicalProject = await canonicalProjectRoot(projectRoot, parts);
        assertCanonicalRootsSeparated('global', canonicalProject, canonicalGlobal);
      }
    }
    return canonicalGlobal;
  }

  function ensureGlobalAvailable(create) {
    return ensureGlobalStorageAvailable(resolvedGlobalDirectory, create);
  }

  function ensureGlobalIndexAvailable(create) {
    return ensureGlobalStorageAvailable(resolvedGlobalIndexDirectory, create);
  }

  async function inspectRoot(scope, create) {
    const base = directory(scope);
    const canonicalRoot = scope === 'project'
      ? await ensureProjectAvailable(create)
      : await ensureGlobalAvailable(create);
    return { base, canonicalRoot };
  }

  async function inspectIndexRoot(scope, create) {
    const base = indexDirectory(scope);
    const canonicalRoot = scope === 'project'
      ? await ensureProjectIndexAvailable(create)
      : await ensureGlobalIndexAvailable(create);
    return { base, canonicalRoot };
  }

  async function prepare(scope, create = false) {
    return inspectRoot(scope, create || scope === 'global');
  }

  async function prepareIndex(scope, create = false) {
    return inspectIndexRoot(scope, create);
  }

  function assertCanonicalRootStable(scope, expected, current) {
    if ((expected === null && current === null)
      || (typeof expected === 'string' && typeof current === 'string' && canonicalPathsEqual(expected, current))) return;
    throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal entry root changed during the filesystem operation`);
  }

  async function revalidateStorageAccess(scope, expectedRoot, target, inspect) {
    const current = await inspect(scope, false);
    assertCanonicalRootStable(scope, expectedRoot, current.canonicalRoot);
    if (target === undefined) return;
    let canonicalTarget;
    try {
      canonicalTarget = await realpath(target);
    } catch (error) {
      throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal target could not be canonically verified`);
    }
    if (expectedRoot === null || !canonicalPathContains(expectedRoot, canonicalTarget)) {
      throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal target escaped its canonical entry root`);
    }
  }

  function revalidateAccess(scope, expectedRoot, target) {
    return revalidateStorageAccess(scope, expectedRoot, target, inspectRoot);
  }

  function revalidateIndexAccess(scope, expectedRoot, target) {
    return revalidateStorageAccess(scope, expectedRoot, target, inspectIndexRoot);
  }

  async function removeTemporary(scope, canonicalRoot, temporary) {
    try {
      await revalidateAccess(scope, canonicalRoot, temporary);
    } catch {
      return;
    }
    await rm(temporary, { force: true });
  }

  async function removeIndexTemporary(scope, canonicalRoot, temporary) {
    try {
      await revalidateIndexAccess(scope, canonicalRoot, temporary);
    } catch {
      return;
    }
    await rm(temporary, { force: true });
  }

  async function readValidatedFile(scope, target, canonicalRoot, expectedInfo, maxBytes, overflowMessage) {
    await revalidateAccess(scope, canonicalRoot, target);
    let handle;
    try {
      try {
        handle = await open(target, 'r');
      } catch (error) {
        if (error?.code === 'ENOENT') throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal target changed before it could be opened`);
        throw error;
      }
      const openedInfo = await handle.stat();
      if (!sameFileIdentity(expectedInfo, openedInfo)) {
        throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal target changed before it could be opened`);
      }
      try {
        return await readHandleBounded(handle, maxBytes, overflowMessage);
      } finally {
        await revalidateAccess(scope, canonicalRoot, target);
      }
    } finally {
      if (handle !== undefined) await handle.close();
    }
  }

  async function readValidatedIndexFile(scope, target, canonicalRoot, expectedInfo, maxBytes, overflowMessage) {
    await revalidateIndexAccess(scope, canonicalRoot, target);
    let handle;
    try {
      try {
        handle = await open(target, 'r');
      } catch (error) {
        if (error?.code === 'ENOENT') throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal index target changed before it could be opened`);
        throw error;
      }
      const openedInfo = await handle.stat();
      if (!sameFileIdentity(expectedInfo, openedInfo)) {
        throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal index target changed before it could be opened`);
      }
      try {
        return await readHandleBounded(handle, maxBytes, overflowMessage);
      } finally {
        await revalidateIndexAccess(scope, canonicalRoot, target);
      }
    } finally {
      if (handle !== undefined) await handle.close();
    }
  }

  function entryPath(base, id) {
    return join(base, `${validateId(id)}.md`);
  }

  function embeddingPath(base, id) {
    return join(base, `${validateId(id)}.json`);
  }

  function parseEntryFile(scope, id, raw) {
    if (!raw.startsWith('---\n')) throw new Error(`Journal entry ${id} has invalid frontmatter`);
    const delimiter = raw.indexOf('\n---\n', 4);
    if (delimiter < 0) throw new Error(`Journal entry ${id} has invalid frontmatter`);
    const frontmatter = JSON.parse(raw.slice(4, delimiter));
    if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter) || Object.hasOwn(frontmatter, 'body')) {
      throw new Error(`Journal entry ${id} has invalid frontmatter`);
    }
    const parsed = validateEntry({ ...frontmatter, body: raw.slice(delimiter + 5) }, scope);
    if (parsed.id !== id) throw new Error(`Journal entry ${id} does not match its path`);
    return parsed;
  }

  async function readEntryFile(scope, id, target, canonicalRoot, knownInfo, maxBytes = MAX_ENTRY_BYTES) {
    let info = knownInfo;
    if (info === undefined) {
      try {
        info = await lstat(target);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          await revalidateAccess(scope, canonicalRoot);
          return null;
        }
        throw error;
      }
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTRY_BYTES) throw new Error(`Journal entry ${id} is corrupt`);
    return readValidatedFile(scope, target, canonicalRoot, info, maxBytes, `Journal entry ${id} is corrupt`);
  }

  async function parseFile(scope, id, target, canonicalRoot, knownInfo) {
    const file = await readEntryFile(scope, id, target, canonicalRoot, knownInfo);
    if (file === null) return null;
    return { entry: parseEntryFile(scope, id, file.raw), bytes: file.bytes };
  }

  async function targetHasSameContent(scope, entry, target, content, canonicalRoot) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTRY_BYTES) throw new Error(`Journal entry ${entry.id} already exists with different content`);
    const existing = await readValidatedFile(
      scope,
      target,
      canonicalRoot,
      info,
      MAX_ENTRY_BYTES,
      `Journal entry ${entry.id} already exists with different content`,
    );
    if (existing.raw !== content) throw new Error(`Journal entry ${entry.id} already exists with different content`);
  }

  async function write(scope, input) {
    const entry = validateEntry(input, scope);
    const { base, canonicalRoot } = await prepare(scope, true);
    const target = entryPath(base, entry.id);
    const content = serializeEntry(entry);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await revalidateAccess(scope, canonicalRoot, temporary);
        const handleInfo = await handle.stat();
        let pathInfo;
        try {
          pathInfo = await lstat(temporary);
        } catch {
          throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal temporary file changed before content could be written`);
        }
        if (handleInfo.size !== 0 || !sameFileIdentity(handleInfo, pathInfo)) {
          throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal temporary file changed before content could be written`);
        }
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      await revalidateAccess(scope, canonicalRoot, temporary);
      try {
        await link(temporary, target);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await targetHasSameContent(scope, entry, target, content, canonicalRoot);
        return { created: false, entry };
      }
      await revalidateAccess(scope, canonicalRoot, target);
      return { created: true, entry };
    } finally {
      await removeTemporary(scope, canonicalRoot, temporary);
    }
  }

  async function readEmbedding(scope, id) {
    validateId(id);
    const { base, canonicalRoot } = await prepareIndex(scope);
    const target = embeddingPath(base, id);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (canonicalRoot === null) await prepareIndex(scope);
      else await revalidateIndexAccess(scope, canonicalRoot);
      return null;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EMBEDDING_BYTES) {
      await revalidateIndexAccess(scope, canonicalRoot);
      return null;
    }
    let file;
    try {
      file = await readValidatedIndexFile(
        scope,
        target,
        canonicalRoot,
        info,
        MAX_EMBEDDING_BYTES,
        `Journal embedding sidecar ${id} is corrupt`,
      );
    } catch (error) {
      if (error instanceof JournalBoundedReadError) return null;
      throw error;
    }
    try {
      return validateEmbedding(JSON.parse(file.raw));
    } catch {
      return null;
    }
  }

  async function writeEmbedding(scope, id, input) {
    validateId(id);
    const embedding = validateEmbedding(input);
    const { base, canonicalRoot } = await prepareIndex(scope, true);
    const target = embeddingPath(base, id);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await revalidateIndexAccess(scope, canonicalRoot, temporary);
        const handleInfo = await handle.stat();
        let pathInfo;
        try {
          pathInfo = await lstat(temporary);
        } catch {
          throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal index temporary file changed before content could be written`);
        }
        if (handleInfo.size !== 0 || !sameFileIdentity(handleInfo, pathInfo)) {
          throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal index temporary file changed before content could be written`);
        }
        await handle.writeFile(JSON.stringify(embedding), 'utf8');
      } finally {
        await handle.close();
      }
      await revalidateIndexAccess(scope, canonicalRoot, temporary);
      try {
        const targetInfo = await lstat(target);
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
          throw unsafePath(scope, `${scope === 'global' ? 'Global' : 'Project'} journal index target must be a real file`);
        }
        await revalidateIndexAccess(scope, canonicalRoot, target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await revalidateIndexAccess(scope, canonicalRoot);
      }
      await rename(temporary, target);
      await revalidateIndexAccess(scope, canonicalRoot, target);
      return embedding;
    } finally {
      await removeIndexTemporary(scope, canonicalRoot, temporary);
    }
  }

  async function read(scope, id) {
    validateId(id);
    const { base, canonicalRoot } = await prepare(scope);
    const parsed = await parseFile(scope, id, entryPath(base, id), canonicalRoot);
    return parsed?.entry ?? null;
  }

  async function exists(scope, id) {
    validateId(id);
    const { base, canonicalRoot } = await prepare(scope);
    const target = entryPath(base, id);
    try {
      await lstat(target);
      await revalidateAccess(scope, canonicalRoot, target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await revalidateAccess(scope, canonicalRoot);
        return false;
      }
      throw error;
    }
  }

  async function scan(scope) {
    const { base, canonicalRoot } = await prepare(scope);
    let names;
    try {
      await revalidateAccess(scope, canonicalRoot);
      names = await readdir(base);
      await revalidateAccess(scope, canonicalRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await revalidateAccess(scope, canonicalRoot);
        return { entries: [], corrupt: 0 };
      }
      throw error;
    }
    const entries = [];
    let corrupt = 0;
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const id = name.slice(0, -3);
      if (!ID_PATTERN.test(id)) {
        corrupt += 1;
        continue;
      }
      try {
        const parsed = await parseFile(scope, id, entryPath(base, id), canonicalRoot);
        if (parsed) entries.push(parsed.entry);
      } catch (error) {
        if (error?.code === 'PROJECT_JOURNAL_UNSAFE_PATH' || error?.code === 'GLOBAL_JOURNAL_UNSAFE_PATH') throw error;
        corrupt += 1;
      }
    }
    entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { entries, corrupt };
  }

  function boundedListOptions(options) {
    const value = options === undefined
      ? {}
      : cleanJson(options, { maxBytes: 256, maxValues: 8, maxDepth: 2 });
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'maxBytes' && key !== 'maxCandidates' && key !== 'maxDirents')) {
      throw new TypeError('Bounded journal list options must contain only maxCandidates, maxDirents, and maxBytes');
    }
    const maxCandidates = value.maxCandidates ?? JOURNAL_SEARCH_MAX_CANDIDATES;
    const maxDirents = value.maxDirents ?? JOURNAL_SEARCH_MAX_DIRENTS;
    const maxBytes = value.maxBytes ?? JOURNAL_SEARCH_MAX_BYTES;
    if (!Number.isInteger(maxCandidates) || maxCandidates < 0 || maxCandidates > JOURNAL_SEARCH_MAX_CANDIDATES) {
      throw new TypeError(`maxCandidates must be an integer from 0 to ${JOURNAL_SEARCH_MAX_CANDIDATES}`);
    }
    if (!Number.isInteger(maxDirents) || maxDirents < 0 || maxDirents > JOURNAL_SEARCH_MAX_DIRENTS) {
      throw new TypeError(`maxDirents must be an integer from 0 to ${JOURNAL_SEARCH_MAX_DIRENTS}`);
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > JOURNAL_SEARCH_MAX_BYTES) {
      throw new TypeError(`maxBytes must be an integer from 0 to ${JOURNAL_SEARCH_MAX_BYTES}`);
    }
    return { maxCandidates, maxDirents, maxBytes };
  }

  async function scanBounded(scope, options) {
    const { maxCandidates, maxDirents, maxBytes } = boundedListOptions(options);
    const { base, canonicalRoot } = await prepare(scope);
    if (maxCandidates === 0 || maxDirents === 0 || maxBytes === 0) {
      const candidates = Object.freeze({ inspected: 0, considered: 0, loaded: 0, bytes: 0, truncated: true });
      return Object.freeze({ entries: Object.freeze([]), corrupt: 0, candidates });
    }
    let handle;
    try {
      await revalidateAccess(scope, canonicalRoot);
      handle = await opendir(base);
      await revalidateAccess(scope, canonicalRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await revalidateAccess(scope, canonicalRoot);
        const candidates = Object.freeze({ inspected: 0, considered: 0, loaded: 0, bytes: 0, truncated: false });
        return Object.freeze({ entries: Object.freeze([]), corrupt: 0, candidates });
      }
      throw error;
    }

    const entries = [];
    let corrupt = 0;
    let inspected = 0;
    let considered = 0;
    let loaded = 0;
    let bytes = 0;
    let truncated = false;
    try {
      for await (const item of handle) {
        inspected += 1;
        const name = item.name;
        if (name.endsWith('.md')) {
          considered += 1;
          const id = name.slice(0, -3);
          if (!ID_PATTERN.test(id)) {
            corrupt += 1;
          } else {
            const target = entryPath(base, id);
            try {
              const info = await lstat(target);
              if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ENTRY_BYTES) {
                corrupt += 1;
              } else if (info.size > maxBytes - bytes) {
                truncated = true;
                break;
              } else {
                const file = await readEntryFile(scope, id, target, canonicalRoot, info, maxBytes - bytes);
                if (file === null) continue;
                bytes += file.bytes;
                loaded += 1;
                entries.push(parseEntryFile(scope, id, file.raw));
              }
            } catch (error) {
              if (error?.code === 'PROJECT_JOURNAL_UNSAFE_PATH' || error?.code === 'GLOBAL_JOURNAL_UNSAFE_PATH') throw error;
              if (error instanceof JournalBoundedReadError) {
                truncated = true;
                break;
              }
              if (error?.code !== 'ENOENT') corrupt += 1;
            }
          }
        }
        if (inspected >= maxDirents || considered >= maxCandidates || bytes >= maxBytes) {
          truncated = true;
          break;
        }
      }
    } finally {
      await handle.close().catch((error) => {
        if (error?.code !== 'ERR_DIR_CLOSED') throw error;
      });
    }
    await revalidateAccess(scope, canonicalRoot);
    entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    const candidates = Object.freeze({ inspected, considered, loaded, bytes, truncated });
    return Object.freeze({ entries: Object.freeze(entries), corrupt, candidates });
  }

  async function list(scope) {
    return (await scan(scope)).entries;
  }

  function listBounded(scope, options) {
    return scanBounded(scope, options);
  }

  async function status() {
    let project = { available: false, entries: 0, corrupt: 0 };
    if (projectDirectory !== null) {
      try {
        const result = await scan('project');
        project = { available: true, entries: result.entries.length, corrupt: result.corrupt };
      } catch (error) {
        if (error?.code !== 'PROJECT_WORKTREE_UNAVAILABLE') throw error;
      }
    }
    const globalResult = await scan('global');
    const global = { available: true, entries: globalResult.entries.length, corrupt: globalResult.corrupt };
    return Object.freeze({ project: Object.freeze(project), global: Object.freeze(global), corruptionCount: project.corrupt + global.corrupt });
  }

  return Object.freeze({ write, read, list, listBounded, exists, status, readEmbedding, writeEmbedding });
}
