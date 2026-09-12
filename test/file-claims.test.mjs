import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createSubmitTools } from '../src/submit.mjs';

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'loop-claims-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'work'));
  await mkdir(join(root, 'work', 'dir'));
  await writeFile(join(root, 'work', 'a.bin'), Buffer.from([255, 0, 254, 128]));
  const store = createRunStore({ worktree: root });
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const state = await store.createRun({ runId: 'claims', rootSessionId: 'root', now: 'now' });
  for (const id of ['impl', 'other']) state.nodes[id] = {
    spec: { id, kind: 'implement', agent: 'graph-implementer', writeScope: ['work/**'] },
    state: 'RUNNING', attempt: 1, sessionId: id,
  };
  await store.saveRun(state);
  const bindings = new Map([['impl', { runId: 'claims', nodeId: 'impl', agent: 'graph-implementer' }]]);
  const { tools } = createSubmitTools({ store, runner, bindings, worktree: root });
  const submit = (args) => tools.graph_submit_change.execute({ nodeId: 'impl', summary: 'changed', filesTouched: [], ...args }, { sessionID: 'impl', agent: 'graph-implementer' }).then(JSON.parse);
  return { root, store, state, runner, submit };
}

test('invalid literal claims can be corrected within the same attempt', async (t) => {
  const h = await harness(t);
  for (const file of ['work/', 'work/dir', 'work/**', 'work/missing']) {
    const result = await h.submit({ filesTouched: [file] });
    assert.equal(result.code, 'INVALID_FILE_CLAIM', JSON.stringify(result));
    assert.equal(result.retryable, true);
    assert.equal(h.state.nodes.impl.state, 'RUNNING');
    assert.equal(h.state.nodes.impl.attempt, 1);
    assert.equal(h.state.artifacts['change:impl'], undefined);
  }
  assert.equal((await h.submit({ filesTouched: ['work/a.bin'] })).ok, true);
  const expected = createHash('sha256').update(Buffer.from([255, 0, 254, 128])).digest('hex');
  assert.equal(h.state.artifacts['change:impl'].snapshot['work/a.bin'], expected);
});

test('deleted claims must be absent and a subset of touched files', async (t) => {
  const h = await harness(t);
  assert.equal((await h.submit({ filesDeleted: ['work/gone'] })).code, 'INVALID_FILE_CLAIM');
  assert.equal((await h.submit({ filesTouched: ['work/a.bin'], filesDeleted: ['work/a.bin'] })).code, 'INVALID_FILE_CLAIM');
  await rm(join(h.root, 'work/a.bin'));
  assert.equal((await h.submit({ filesTouched: ['work/a.bin'], filesDeleted: ['work/a.bin'] })).ok, true);
  assert.equal(h.state.artifacts['change:impl'].snapshot['work/a.bin'], 'MISSING');
  assert.deepEqual(h.state.artifacts['change:impl'].payload.filesDeleted, ['work/a.bin']);
});

test('caller cannot submit a different running node', async (t) => {
  const h = await harness(t);
  const result = await h.submit({ nodeId: 'other', filesTouched: ['work/a.bin'] });
  assert.equal(result.code, 'NOT_DISPATCHED_NODE');
  assert.equal(h.state.nodes.other.state, 'RUNNING');
});

test('strict scope and ledger rejections survive reload', async (t) => {
  for (const file of ['../escape', '/escape', 'outside.txt']) {
    const h = await harness(t);
    assert.equal((await h.submit({ filesTouched: [file] })).code, 'OUT_OF_SCOPE');
    const saved = await h.store.loadRun('claims');
    assert.equal(saved.nodes.impl.state, 'FAILED');
    assert.ok(saved.violations.length);
  }
  const h = await harness(t);
  h.runner.recordSideEffect(h.state, { nodeId: 'impl', tool: 'edit', target: 'work/a.bin', now: 'now' });
  assert.equal((await h.submit({ filesTouched: [] })).code, 'LEDGER_MISMATCH');
  assert.equal((await h.store.loadRun('claims')).nodes.impl.state, 'FAILED');
});

test('file snapshots do not follow a directory link outside the workspace', async (t) => {
  const h = await harness(t);
  await symlink(tmpdir(), join(h.root, 'work', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const snapshot = await h.store.hashFiles(['work/link/no-file']);
  assert.equal(snapshot['work/link/no-file'], 'UNVERIFIABLE');
});
