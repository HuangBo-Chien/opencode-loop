import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../src/run-state.mjs';
import { createJournalStore } from '../src/journal-store.mjs';

test('bounded scans tolerate sync close and only suppress ERR_DIR_CLOSED', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'loop-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.opencode-loop', 'journal', 'entries'), { recursive: true });
  const runStore = createRunStore({ worktree: root });
  const journal = createJournalStore({ worktree: root, globalDirectory: join(root, 'global') });
  const original = fs.opendir;
  try {
    for (const close of [() => undefined, async () => undefined,
      () => { throw Object.assign(new Error('closed'), { code: 'ERR_DIR_CLOSED' }); },
      async () => { throw Object.assign(new Error('closed'), { code: 'ERR_DIR_CLOSED' }); }]) {
      fs.opendir = async () => ({ async *[Symbol.asyncIterator]() {}, close });
      syncBuiltinESMExports();
      assert.deepEqual(await runStore.listRunIds(), []);
      assert.deepEqual((await journal.listBounded('project')).entries, []);
    }
    fs.opendir = async () => ({
      async *[Symbol.asyncIterator]() { throw Object.assign(new Error('lazy scandir missing'), { code: 'ENOENT' }); },
      close() {},
    });
    syncBuiltinESMExports();
    assert.deepEqual(await runStore.listRunIds(), []);
    assert.deepEqual((await journal.listBounded('project')).entries, []);
    fs.opendir = async () => ({ async *[Symbol.asyncIterator]() {}, close() { throw Object.assign(new Error('I/O'), { code: 'EIO' }); } });
    syncBuiltinESMExports();
    await assert.rejects(runStore.listRunIds(), { code: 'EIO' });
    await assert.rejects(journal.listBounded('project'), { code: 'EIO' });
  } finally {
    fs.opendir = original;
    syncBuiltinESMExports();
  }
});
