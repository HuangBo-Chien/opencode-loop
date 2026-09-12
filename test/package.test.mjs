import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = path.join(root, 'package.json');
const lockfile = path.join(root, 'package-lock.json');

function relativeFiles(directory) {
  const files = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...relativeFiles(file));
    else files.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return files;
}

test('package pins the SDK and publishes only self-contained runtime files', () => {
  assert.ok(existsSync(manifest), 'package manifest must exist');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const lock = JSON.parse(readFileSync(lockfile, 'utf8'));
  assert.equal(pkg.name, 'opencode-loop');
  assert.equal(pkg.version, '0.3.0-alpha.8');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.exports, './src/index.mjs');
  assert.deepEqual(pkg.dependencies, {
    '@huggingface/transformers': '3.8.1',
    '@opencode-ai/plugin': '1.18.25',
  });
  assert.deepEqual(pkg.files, ['src', 'README.md']);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  function inspect(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { inspect(file); continue; }
      if (!file.endsWith('.mjs')) continue;
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /b0420|\.\.\/\.\.\/scripts/);
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
    const parsed = JSON.parse(packed.stdout);
    const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    assert.equal(info.filename, 'opencode-loop-0.3.0-alpha.8.tgz');
    assert.equal(info.version, '0.3.0-alpha.8');
    assert.deepEqual(
      info.files.map(file => file.path).sort(),
      ['package.json', 'README.md', ...relativeFiles(path.join(root, 'src'))].sort(),
    );
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
    assert.equal(existsSync(path.join(temporary, 'node_modules', '@huggingface', 'transformers')), false);
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', "globalThis.fetch=()=>{throw Error('network access attempted')}; const {default:plugin}=await import('./package/src/index.mjs'); const hooks=await plugin({}); const config={}; await hooks.config(config); if(Object.keys(config.agent).length!==7)throw Error('agents'); const status=JSON.parse(await hooks.tool.graph_status.execute({})); if(status.runtimeAvailable!==true||status.workflowMode!=='gated'||status.limitsEnforced!==true||status.managedRuntimeStatus!=='available'||status.enforcementAttested!==false)throw Error('status'); const journal=status.journal; if(!journal||journal.enabled!==true||journal.model!=='Xenova/all-MiniLM-L6-v2'||journal.revision!=='751bff37182d3f1213fa05d7196b954e230abad9'||journal.dtype!=='q8'||journal.searchMode!=='hybrid'||journal.projectAvailable!==false||journal.pendingBackfill?.count!==0)throw Error('journal status');"], { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', HOME: temporary, USERPROFILE: temporary, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
