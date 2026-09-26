import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createRunStore } from '../../src/run-state.mjs';

const [worktree, stage] = process.argv.slice(2);
process.on('disconnect', () => process.exit(1));
const store = createRunStore({ worktree });
const state = await store.loadRun('root');
const rename = fs.rename;
fs.rename = async (...args) => {
  if (stage === 'after') await rename(...args);
  process.send({ stage });
  // Parent kills this process at a known before/after atomic replacement point.
  await new Promise(() => {});
};
syncBuiltinESMExports();
state.mode = 'interrupted-save';
await store.saveRun(state);
