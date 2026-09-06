import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = path.join(root, 'package.json');

test('package pins the SDK and publishes only self-contained runtime files', () => {
  assert.ok(existsSync(manifest), 'package manifest must exist');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  assert.equal(pkg.name, 'opencode-loop');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports, './src/index.mjs');
  assert.equal(pkg.dependencies['@opencode-ai/plugin'], '1.18.25');
  assert.deepEqual(pkg.files, ['src', 'README.md']);
  function inspect(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { inspect(file); continue; }
      if (!file.endsWith('.mjs')) continue;
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /b0420|\.config[\\/]opencode|\.\.\/\.\.\/scripts/);
      for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
        const specifier = match[2];
        if (specifier.startsWith('.')) {
          const relative = path.relative(root, path.resolve(path.dirname(file), specifier));
          assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), `escaping import: ${specifier}`);
        } else assert.ok(specifier.startsWith('node:') || Object.keys(pkg.dependencies).some(name => specifier === name || specifier.startsWith(`${name}/`)), `undeclared dependency ${specifier}`);
      }
    }
  }
  inspect(path.join(root, 'src'));
});

test('packed entry imports and runs outside workspace with declared tool dependency closure', () => {
  assert.ok(existsSync(manifest), 'package manifest must exist before packing');
  const temporary = mkdtempSync(path.join(tmpdir(), 'opencode-loop-pack-'));
  try {
    const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npm = process.platform === 'win32' ? process.execPath : 'npm';
    const prefix = process.platform === 'win32' ? [npmCli] : [];
    const packed = spawnSync(npm, [...prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const info = JSON.parse(packed.stdout)[0];
    assert.ok(info.files.every(file => file.path === 'package.json' || file.path === 'README.md' || file.path.startsWith('src/')));
    const unpacked = spawnSync('tar', ['-xf', path.join(temporary, info.filename), '-C', temporary], { encoding: 'utf8' });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    // Copy the real installed SDK and its tool subpath's sole runtime dependency;
    // no links or workspace sources exist in the isolated import directory.
    const sdkTool = fileURLToPath(import.meta.resolve('@opencode-ai/plugin/tool'));
    const sdkRoot = path.dirname(path.dirname(sdkTool));
    const zodEntry = fileURLToPath(import.meta.resolve('zod'));
    let zodRoot = path.dirname(zodEntry);
    while (!existsSync(path.join(zodRoot, 'package.json'))) zodRoot = path.dirname(zodRoot);
    mkdirSync(path.join(temporary, 'node_modules', '@opencode-ai'), { recursive: true });
    cpSync(sdkRoot, path.join(temporary, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true, dereference: true });
    cpSync(zodRoot, path.join(temporary, 'node_modules', 'zod'), { recursive: true, dereference: true });
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', "const {default:plugin}=await import('./package/src/index.mjs'); const hooks=await plugin({}); const config={}; await hooks.config(config); if(Object.keys(config.agent).length!==7)throw Error('agents'); const status=JSON.parse(await hooks.tool.graph_status.execute({})); if(status.runtimeAvailable!==true||status.workflowMode!=='advisory'||status.limitsEnforced!==false||status.enforcementAttested!==false)throw Error('status');"], { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
