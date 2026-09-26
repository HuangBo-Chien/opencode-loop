import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

// Direct evidence covers all files, including ignored source. Infrastructure
// (.git, node_modules, and the configured state directory) is outside its scope.
// Larger workspaces must use Graph; never silently truncate the inventory.
const MAX_FILES = 2000;
const MAX_ENTRIES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 400000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export async function captureWorkspace(worktree, { stateDirectory = '.opencode-loop' } = {}) {
  if (typeof stateDirectory !== 'string' || !stateDirectory || path.isAbsolute(stateDirectory)
    || stateDirectory.replaceAll('\\', '/').split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid state directory for workspace evidence');
  }
  const excludedState = stateDirectory.replaceAll('\\', '/');
  const root = await realpath(worktree);
  if (!(await lstat(root)).isDirectory()) throw new Error('Workspace must be a directory');
  async function inventory() {
    const files = Object.create(null);
    let entries = 0;
    let bytes = 0;
    let count = 0;
    let manifestBytes = 0;
    async function visit(directory, prefix = '') {
      const before = await lstat(directory);
      if (before.isSymbolicLink()) throw new Error('Workspace symbolic links are unsupported');
      const relative = path.relative(root, await realpath(directory));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Workspace path escapes root');
      const iterator = await opendir(directory);
      for await (const entry of iterator) {
        if (++entries > MAX_ENTRIES) throw new Error('Workspace entry limit exceeded; use Graph');
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name === '.git' || entry.name === 'node_modules' || name === excludedState) continue;
        const full = path.join(directory, entry.name);
        const metadata = await lstat(full);
        if (metadata.isSymbolicLink()) throw new Error(`Workspace symbolic link is unsupported: ${name}`);
        if (metadata.isDirectory()) {
          if (name.split('/').length > 64) throw new Error('Workspace depth limit exceeded; use Graph');
          await visit(full, name);
        } else if (metadata.isFile()) {
          manifestBytes += Buffer.byteLength(name) + 72;
          if (++count > MAX_FILES || (bytes += metadata.size) > MAX_BYTES || manifestBytes > MAX_MANIFEST_BYTES) throw new Error('Workspace inventory limit exceeded; use Graph');
          const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            if (!same(metadata, await handle.stat())) throw new Error('Workspace changed during capture');
            const hash = createHash('sha256');
            const buffer = Buffer.alloc(65536);
            let read = 0;
            while (true) {
              const result = await handle.read(buffer, 0, buffer.length, null);
              if (!result.bytesRead) break;
              read += result.bytesRead;
              if (read > metadata.size) throw new Error('Workspace changed during capture');
              hash.update(buffer.subarray(0, result.bytesRead));
            }
            if (read !== metadata.size || !same(metadata, await handle.stat()) || !same(metadata, await lstat(full))) throw new Error('Workspace changed during capture');
            files[name] = hash.digest('hex');
          } finally { await handle.close(); }
        } else throw new Error(`Unsupported workspace file: ${name}`);
      }
      if (!same(before, await lstat(directory))) throw new Error('Workspace changed during capture');
    }
    await visit(root);
    const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
    return { files: sorted, revision: digest(JSON.stringify(sorted)) };
  }
  const first = await inventory();
  const second = await inventory();
  if (first.revision !== second.revision) throw new Error('Workspace changed during capture');
  return second;
}

export function workspaceChanges(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((name) => before.files[name] !== after.files[name]).sort();
}
