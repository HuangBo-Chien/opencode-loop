import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, relative, sep } from 'node:path';
import { extractShellWriteTargets, firstOutOfScopeShellWrite } from '../src/shell-scope.mjs';

const WORKTREE = '/wt/project';
// Mirrors enforcement's toWorkspaceRelative for absolute host paths.
function toWorkspaceRelative(target) {
  if (typeof target !== 'string' || !target.length) return null;
  if (!isAbsolute(target)) return target.replace(/\\/g, '/');
  const relativePath = relative(WORKTREE, target);
  if (!relativePath.length || relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return relativePath.split(sep).join('/');
}
const screen = (command, patterns) => firstOutOfScopeShellWrite(command, patterns, toWorkspaceRelative);

test('redirections, appending and fd variants produce workspace-relative targets', () => {
  assert.deepEqual(extractShellWriteTargets('uv --version', toWorkspaceRelative), [null].slice(0, 0));
  assert.deepEqual(extractShellWriteTargets('echo hi > logs/setup/a.log', toWorkspaceRelative), ['logs/setup/a.log']);
  assert.deepEqual(extractShellWriteTargets('echo hi >>logs/b.log', toWorkspaceRelative), ['logs/b.log']);
  assert.deepEqual(extractShellWriteTargets('python -c "x" 2> logs/err.txt', toWorkspaceRelative), ['logs/err.txt']);
  assert.equal(screen('echo hi > logs/setup/a.log', ['logs/**']), null);
  assert.equal(screen('echo hi > elsewhere/a.log', ['logs/**']), 'elsewhere/a.log');
});

test('2>&1, /dev/null and outside-workspace targets are ignored', () => {
  assert.deepEqual(extractShellWriteTargets('cmd 2>&1', toWorkspaceRelative), []);
  assert.deepEqual(extractShellWriteTargets('cmd > /dev/null 2>&1', toWorkspaceRelative), [null]);
  assert.deepEqual(extractShellWriteTargets('cmd > /tmp/scratch.txt', toWorkspaceRelative), [null]);
  assert.equal(screen('cmd > /tmp/scratch.txt', []), null);
});

test('heredoc bodies are not scanned but heredoc targets are', () => {
  const command = 'cat > scripts/run.sh <<\'EOF\'\nrm -rf elsewhere/thing\ncp x y\nEOF';
  assert.deepEqual(extractShellWriteTargets(command, toWorkspaceRelative), ['scripts/run.sh']);
  assert.equal(screen(command, ['scripts/**']), null);
  assert.equal(screen(command, ['logs/**']), 'scripts/run.sh');
  const unterminated = 'cat > out.txt <<EOF\nstill body';
  assert.deepEqual(extractShellWriteTargets(unterminated, toWorkspaceRelative), ['out.txt']);
});

test('write tool commands extract their destination operands', () => {
  assert.deepEqual(extractShellWriteTargets('cp src/a.txt cache/a.txt', toWorkspaceRelative), ['cache/a.txt']);
  assert.deepEqual(extractShellWriteTargets('mv /wt/project/cache/x /wt/project/logs/x', toWorkspaceRelative), ['logs/x']);
  assert.deepEqual(extractShellWriteTargets('rm -rf cache/uv junk', toWorkspaceRelative), ['cache/uv', 'junk']);
  assert.deepEqual(extractShellWriteTargets('tee -a logs/setup/list.txt', toWorkspaceRelative), ['logs/setup/list.txt']);
  assert.deepEqual(extractShellWriteTargets('dd if=img of=cache/img bs=1M', toWorkspaceRelative), ['cache/img']);
  assert.deepEqual(extractShellWriteTargets('sed -i s/a/b/ src/a.ts src/b.ts', toWorkspaceRelative), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(extractShellWriteTargets('truncate -s 0 logs/x.log', toWorkspaceRelative), ['logs/x.log']);
  assert.deepEqual(extractShellWriteTargets('cp -t cache src/a src/b', toWorkspaceRelative), ['cache']);
  assert.equal(screen('cp src/a.txt cache/a.txt', ['cache/**']), null);
  assert.equal(screen('cp src/a.txt scripts/a.txt', ['cache/**']), 'scripts/a.txt');
});

test('cd is tracked when resolving relative targets', () => {
  assert.deepEqual(extractShellWriteTargets('cd /wt/project/efficientnet && rm logs/x.log', toWorkspaceRelative), ['efficientnet/logs/x.log']);
  assert.equal(screen('cd /wt/project/efficientnet && rm logs/x.log', ['efficientnet/logs/**']), null);
  assert.equal(screen('cd /wt/project/efficientnet && rm ../shared/x', ['efficientnet/**']), 'shared/x');
  // Escaping the workspace disables relative screening for that chain.
  assert.equal(screen('cd /tmp && rm relative.txt', []), null);
});

test('dir/** scope patterns also admit the base directory itself', () => {
  assert.equal(screen('rm -rf .venv', ['.venv/**']), null);
  assert.equal(screen('rm -rf .venv', ['cache/**']), '.venv');
});

test('quoted spans, variables and globs fail open', () => {
  assert.deepEqual(extractShellWriteTargets('echo "cp a b" > logs/ok.txt', toWorkspaceRelative), ['logs/ok.txt']);
  assert.equal(screen('echo "a > b"', []), null);
  assert.equal(screen('rm $TARGET', []), null);
  assert.equal(screen('cp a "b c"', []), null);
  assert.equal(screen('rm cache/*.tmp', ['cache/**']), null);
});

test('empty and malformed commands never report escapes', () => {
  assert.equal(screen('', []), null);
  assert.equal(screen(undefined, []), null);
  assert.equal(screen('&&& ||| ;;;', []), null);
});
