import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'direct-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const command = (code) => `"${process.execPath}" -e "${code}"`;

test('workspace captures dirty and ignored source, additions and deletions with stable revisions', async (t) => {
  const { captureWorkspace, workspaceChanges } = await import('../src/direct-workspace.mjs');
  const root = await fixture(t);
  await writeFile(path.join(root, '.gitignore'), 'ignored.js');
  await writeFile(path.join(root, 'ignored.js'), 'dirty baseline');
  await mkdir(path.join(root, '.opencode-loop'));
  await writeFile(path.join(root, '.opencode-loop', 'state'), 'excluded');
  const before = await captureWorkspace(root);
  assert.equal(before.revision, (await captureWorkspace(root)).revision);
  assert.ok(before.files['ignored.js']);
  assert.equal(before.files['.opencode-loop/state'], undefined);
  await writeFile(path.join(root, 'ignored.js'), 'modified ignored source');
  assert.deepEqual(workspaceChanges(before, await captureWorkspace(root)), ['ignored.js']);
  await rm(path.join(root, 'ignored.js'));
  await writeFile(path.join(root, 'new.js'), 'new');
  const after = await captureWorkspace(root);
  assert.notEqual(before.revision, after.revision);
  assert.deepEqual(workspaceChanges(before, after), ['ignored.js', 'new.js']);
});

test('workspace rejects a directory junction instead of traversing outside root', async (t) => {
  const { captureWorkspace } = await import('../src/direct-workspace.mjs');
  const root = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureWorkspace(root), /symlink|symbolic/i);
});

test('workspace validates exclusions and bounds inventory', async (t) => {
  const { captureWorkspace } = await import('../src/direct-workspace.mjs');
  const root = await fixture(t);
  await assert.rejects(captureWorkspace(root, { stateDirectory: '..' }), /state directory/i);
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(root, String(i)), '')));
  await assert.rejects(captureWorkspace(root), /limit/i);
});

test('commands run real shell checks, record exit codes and bound output', async (t) => {
  const { runDirectCommand } = await import('../src/direct-check.mjs');
  const cwd = await fixture(t);
  const passed = await runDirectCommand({ command: command('console.log(123)'), cwd, timeoutMs: 5000 });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.uncertain, false);
  assert.match(passed.output, /123/);
  const failed = await runDirectCommand({ command: command('process.exit(7)'), cwd, timeoutMs: 5000 });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  const noisy = await runDirectCommand({ command: command('console.log(String.fromCharCode(120).repeat(20000))'), cwd, timeoutMs: 5000 });
  assert.equal(noisy.status, 'passed');
  assert.ok(Buffer.byteLength(noisy.output) <= 8192);
});

test('commands terminate on timeout and cancellation with finite teardown', async (t) => {
  const { runDirectCommand } = await import('../src/direct-check.mjs');
  const cwd = await fixture(t);
  const started = Date.now();
  const result = await runDirectCommand({ command: command('setInterval(()=>{},1000)'), cwd, timeoutMs: 100 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.uncertain, true);
  assert.ok(Date.now() - started < 7000);
  const controller = new AbortController();
  const pending = runDirectCommand({ command: command('setInterval(()=>{},1000)'), cwd, timeoutMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).status, 'aborted');
  assert.equal((await runDirectCommand({ command: 'echo unused', cwd, timeoutMs: Infinity })).status, 'error');
});

test('timeout kills descendants inheriting command pipes', async (t) => {
  const { runDirectCommand } = await import('../src/direct-check.mjs');
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'descendant.cjs'), 'require("node:fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>{},1000);');
  await writeFile(path.join(cwd, 'parent.cjs'), 'require("node:child_process").spawn(process.execPath,["descendant.cjs"],{stdio:"inherit"});setInterval(()=>{},1000);');
  const result = await runDirectCommand({ command: `"${process.execPath}" parent.cjs`, cwd, timeoutMs: 1200 });
  assert.equal(result.status, 'timeout');
  const pid = Number(await readFile(path.join(cwd, 'child.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('pre-aborted commands do not execute and invalid cwd is an error', async (t) => {
  const { runDirectCommand } = await import('../src/direct-check.mjs');
  const cwd = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const result = await runDirectCommand({ command: 'echo unused', cwd, signal: controller.signal });
  assert.equal(result.status, 'aborted');
  assert.equal(result.uncertain, false);
  assert.equal((await runDirectCommand({ command: 'echo unused', cwd: path.join(cwd, 'absent') })).status, 'error');
});
