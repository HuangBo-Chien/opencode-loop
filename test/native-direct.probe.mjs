// Opt-in fixed-host test with a local deterministic provider, no model credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map(part => part.text ?? '').join('\n');

for (const denyCheck of [false, true]) test(`native Direct one-worker acceptance (bash denied=${denyCheck})`, {
  skip: !process.env.OPENCODE_NATIVE_BINARY, timeout: 120000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'loop-native-direct-'));
  const project = join(root, 'project');
  for (const name of ['project', 'config', 'cache', 'data', 'state', 'home']) await mkdir(join(root, name));
  await writeFile(join(project, 'probe.txt'), 'before');
  // Explicit fixture permission policy, applied after the real plugin config hook.
  const permissionPlugin = join(root, 'probe-permissions.mjs');
  await writeFile(permissionPlugin, `export default async () => ({config(config) {
    config.agent['graph-implementer'].permission.write = 'allow';
    config.agent['graph-implementer'].permission.edit = 'allow';
    config.agent['graph-implementer'].permission.bash = '${denyCheck ? 'deny' : 'allow'}';
  }});`);
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let rootStep = 0, workerStep = 0, serial = 0;
  const failures = [], responses = [], roles = [];
  const call = (name, args) => ({ tool: { id: `direct-${++serial}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } } });
  const command = denyCheck
    ? `"${process.execPath}" -e "require('node:fs').writeFileSync('denied-executed.txt','unexpected')"`
    : `"${process.execPath}" -e "if(require('node:fs').readFileSync('probe.txt','utf8')!=='after')process.exit(1)"`;
  function respond(body) {
    const messages = body.messages ?? [];
    const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(textOf).join('\n');
    responses.push(...messages.filter(m => m.role === 'tool').map(textOf));
    if (system.includes('你是 graph-orchestrator')) {
      roles.push('root');
      switch (rootStep++) {
        case 0: return call('graph_direct_start', {
          requirement: 'Change probe.txt to after and run the declared check.',
          rationale: 'One bounded file change with an exact foreground acceptance check.',
          acceptance: ['probe.txt contains exactly after'], writeScope: ['probe.txt'], deliverables: ['probe.txt'],
          checks: [{ id: 'content', command, cwd: '.', timeoutMs: 10000 }],
        });
        case 1: return call('task', { description: 'Direct native probe', subagent_type: 'graph-implementer',
          nodeId: 'direct', prompt: 'Run the check first, then make the scoped change and recheck. Use Direct tools.' });
        case 2: return call('graph_inspect', {});
        default: return { text: 'LOOP_DIRECT_PROBE_COMPLETE' };
      }
    }
    if (system.includes('你是 graph-implementer')) {
      roles.push('worker');
      if (denyCheck) return workerStep++ === 0 ? call('graph_direct_check', { checkId: 'content' })
        : { text: 'Check permission denied; no acceptance is claimed.' };
      switch (workerStep++) {
        case 0: return call('graph_direct_check', { checkId: 'content' });
        case 1: return call('write', { filePath: join(project, 'probe.txt'), content: 'after' });
        case 2: return call('graph_direct_check', { checkId: 'content' });
        case 3: return call('graph_submit_change', { nodeId: 'direct', filesTouched: ['probe.txt'],
          summary: 'Changed exact content and checked it.', checksRun: [], unresolved: [], risks: [] });
        default: return { text: 'Direct worker finished.' };
      }
    }
    assert.ok(!/你是 graph-(planner|plan-critic|verifier|explorer)/.test(system), 'Direct must not dispatch additional work roles');
    return { text: 'Direct probe' };
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.match(req.url, /chat\/completions/);
      const body = JSON.parse(raw);
      const reply = respond(body);
      const base = { id: `completion-${serial}`, object: 'chat.completion.chunk', created: 1, model: 'mock' };
      const delta = reply.tool ? { role: 'assistant', tool_calls: [{ index: 0, ...reply.tool }] }
        : { role: 'assistant', content: reply.text };
      const finish_reason = reply.tool ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0,
          message: reply.tool ? { role: 'assistant', content: null, tool_calls: [reply.tool] }
            : { role: 'assistant', content: reply.text }, finish_reason }] }));
      }
    } catch (error) { failures.push(error.message); res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = {
    model: 'loop-mock/mock', small_model: 'loop-mock/mock', enabled_providers: ['loop-mock'],
    share: 'disabled', autoupdate: false,
    plugin: [[new URL('../src/index.mjs', import.meta.url).href,
      { journal: { enabled: false }, lessons: { enabled: false } }], pathToFileURL(permissionPlugin).href],
    provider: { 'loop-mock': { npm: '@ai-sdk/openai-compatible', name: 'Local Direct fixture',
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only' },
      models: { mock: { name: 'Mock', limit: { context: 64000, output: 4096 }, tool_call: true } } } },
  };
  const env = { ...process.env, USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_DIR: join(root, 'config'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_PURE;
  child = spawn(process.env.OPENCODE_NATIVE_BINARY, ['run', '--format', 'json', '--agent', 'graph-orchestrator',
    '--model', 'loop-mock/mock', '--title', 'Native Direct probe', 'LOOP_DIRECT_ROOT'],
  { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.deepEqual(failures, [], stderr);
  assert.equal(exit, 0, stderr + stdout);
  assert.match(stdout, /LOOP_DIRECT_PROBE_COMPLETE/, stderr);
  const runDir = join(project, '.opencode-loop', 'runs');
  const files = (await readdir(runDir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(await readFile(join(runDir, files[0]), 'utf8'));
  assert.deepEqual(Object.keys(run.nodes), ['direct'], JSON.stringify({ run, responses }));
  assert.equal(run.nodes.direct.attempt, 1, 'failed check repairs inside the same worker attempt');
  assert.equal(Object.hasOwn(run.artifacts, 'plan'), false);
  assert.equal(Object.hasOwn(run.artifacts, 'review'), false);
  if (denyCheck) {
    assert.notEqual(run.status, 'SUCCEEDED');
    assert.equal(await readFile(join(project, 'probe.txt'), 'utf8'), 'before');
    await assert.rejects(readFile(join(project, 'denied-executed.txt')), { code: 'ENOENT' });
    assert.ok(responses.some(value => /denied|reject|permission/i.test(value)), JSON.stringify(responses));
  } else {
    assert.equal(run.status, 'SUCCEEDED', JSON.stringify({ run, responses }));
    assert.equal(await readFile(join(project, 'probe.txt'), 'utf8'), 'after');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'data', 'opencode', 'opencode.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('select count(*) as n from session where parent_id = ?').get(run.rootSessionId).n, 1);
    const checks = db.prepare("select data from part where json_extract(data, '$.tool') = 'graph_direct_check'")
      .all().map(row => JSON.parse(row.data));
    assert.equal(checks.length, denyCheck ? 1 : 2);
  } finally { db.close(); }
  t.diagnostic(`OpenCode Direct: one worker, ${denyCheck ? 'permission denied; no completion' : 'failed check → same-session edit → actual passing check → settled success'}.`);
});
