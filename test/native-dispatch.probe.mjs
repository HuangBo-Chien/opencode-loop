// Opt-in real OpenCode host probe. Uses a deterministic local OpenAI-compatible
// fixture, no external model or credentials, and an isolated disposable project.
// OPENCODE_NATIVE_BINARY must name the native executable, not a shell shim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const specs = [
  { id: 'plan', kind: 'plan', agent: 'graph-planner', dependsOn: [] },
  { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: ['plan'], writeScope: ['probe.txt'], acceptance: ['No file changes. Submit filesTouched=[] when asked to finish.'] },
  { id: 'verify', kind: 'verify', agent: 'graph-verifier', dependsOn: ['impl'], acceptance: ['Transport probe only: report UNVERIFIED without running workspace commands.'] },
];
const textOf = message => typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map(p => p.text ?? '').join('\n');

for (const backgroundSchema of [false, true]) test(`native structured dispatch (background schema=${backgroundSchema})`, {
  skip: !process.env.OPENCODE_NATIVE_BINARY, timeout: 120000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'loop-native-dispatch-'));
  const project = join(root, 'project');
  for (const directory of ['project', 'config', 'cache', 'data', 'state', 'home']) await mkdir(join(root, directory));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let rootStep = 0, plannerStep = 0, implementerStep = 0, verifierStep = 0, serial = 0;
  const failures = [], schemas = [], toolErrors = [], requests = [];
  const call = (name, args) => ({ tool: { id: `probe-${++serial}`, type: 'function', function: { name, arguments: JSON.stringify(args) } } });
  function respond(body) {
    const messages = body.messages ?? [];
    const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(textOf).join('\n');
    const task = body.tools?.find(item => item.function?.name === 'task')?.function;
    if (task) schemas.push(task.parameters);
    for (const message of messages.filter(m => m.role === 'tool')) {
      if (textOf(message).includes('RUNNER_REJECTED')) toolErrors.push(textOf(message));
    }
    const dispatch = (agent, prompt, extra = {}) => call('task', { description: 'Native dispatch probe', subagent_type: agent, prompt, ...(backgroundSchema ? { background: false } : {}), ...extra });
    if (system.includes('你是 graph-orchestrator')) {
      requests.push(`root:${rootStep}`);
      switch (rootStep++) {
        case 0: return dispatch('graph-implementer', 'LOOP_INVALID_TARGET', { nodeId: 'absent' });
        case 1: return dispatch('graph-planner', 'LOOP_PLANNER');
        case 2: return dispatch('graph-implementer', '[nodeId:other] LOOP_CONFLICT', { nodeId: 'impl' });
        case 3: return dispatch('graph-implementer', 'LOOP_IMPL_YIELD', { nodeId: 'impl' });
        case 4: {
          const result = messages.filter(m => m.role === 'tool').map(textOf).findLast(s => s.includes('LOOP_IMPL_YIELDED'));
          const task_id = result?.match(/<task id="([^"]+)"/)?.[1];
          assert.ok(task_id, 'native task result must carry the real child session identity');
          return dispatch('graph-implementer', 'LOOP_IMPL_FINISH', { task_id });
        }
        case 5: return dispatch('graph-verifier', 'LOOP_VERIFY', { nodeId: 'verify' });
        case 6: return call('graph_inspect', {});
        default: return { text: 'LOOP_NATIVE_PROBE_COMPLETE: transport exercised; no product behavior was verified.' };
      }
    }
    if (system.includes('你是 graph-planner')) {
      requests.push(`planner:${plannerStep}`);
      return plannerStep++ === 0 ? call('graph_submit_plan', { intent: 'light', specs }) : { text: 'LOOP_PLANNED' };
    }
    if (system.includes('你是 graph-implementer')) {
      const prompt = textOf(messages.filter(m => m.role === 'user').at(-1));
      requests.push('implementer');
      if (prompt.includes('LOOP_IMPL_YIELD')) return { text: 'LOOP_IMPL_YIELDED' };
      return implementerStep++ === 0 ? call('graph_submit_change', { nodeId: 'impl', filesTouched: [], summary: 'No-op native transport fixture', checksRun: [], unresolved: [], risks: [] }) : { text: 'LOOP_IMPLEMENTED' };
    }
    if (system.includes('你是 graph-verifier')) {
      requests.push('verifier');
      return verifierStep++ === 0 ? call('graph_submit_verification', { nodeId: 'verify', verdict: 'UNVERIFIED', commands: [], summary: 'Native transport fixture only; no workspace behavior verification was performed.' }) : { text: 'LOOP_VERIFIED_TRANSPORT_ONLY' };
    }
    return { text: 'Native transport probe' }; // title/summary helpers
  }
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.match(req.url, /chat\/completions/);
      const reply = respond(body);
      const base = { id: `completion-${serial}`, object: 'chat.completion.chunk', created: 1, model: 'mock' };
      const delta = reply.tool ? { role: 'assistant', tool_calls: [{ index: 0, ...reply.tool }] } : { role: 'assistant', content: reply.text };
      const finish_reason = reply.tool ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(reply.tool ? { tool_calls: [reply.tool] } : {}) }, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      }
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = {
    $schema: 'https://opencode.ai/config.json', model: 'loop-mock/mock', small_model: 'loop-mock/mock',
    enabled_providers: ['loop-mock'], share: 'disabled', autoupdate: false,
    plugin: [[new URL('../src/index.mjs', import.meta.url).href, { journal: { enabled: false }, lessons: { enabled: false } }]],
    provider: { 'loop-mock': { npm: '@ai-sdk/openai-compatible', name: 'Local probe fixture',
      options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only' },
      models: { mock: { name: 'Mock', limit: { context: 64000, output: 4096 }, tool_call: true } } } },
  };
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_DIR: join(root, 'config'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: backgroundSchema ? 'true' : 'false',
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_PURE;
  child = spawn(process.env.OPENCODE_NATIVE_BINARY, ['run', '--format', 'json', '--agent', 'graph-orchestrator', '--model', 'loop-mock/mock', '--title', 'Native dispatch probe', 'LOOP_NATIVE_ROOT'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.deepEqual(failures, [], stderr);
  assert.equal(exit, 0, stderr + stdout);
  assert.match(stdout, /LOOP_NATIVE_PROBE_COMPLETE/, stderr + '\n' + JSON.stringify(requests));
  assert.ok(schemas.length > 0, 'actual provider request must expose task schema');
  for (const schema of schemas) {
    assert.equal(schema.properties.nodeId.type, 'string');
    assert.equal(schema.required.includes('nodeId'), false);
    assert.equal(Object.hasOwn(schema.properties, 'background'), backgroundSchema);
  }
  assert.ok(toolErrors.some(s => s.includes('NODE_NOT_FOUND')));
  assert.ok(toolErrors.some(s => s.includes('CONFLICTING_NODE_ID')));
  const runDir = join(project, '.opencode-loop', 'runs');
  const files = (await readdir(runDir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const run = JSON.parse(await readFile(join(runDir, files[0]), 'utf8'));
  const receipts = [...(run.dispatchReservations ?? []), ...(run.settledDispatches ?? [])];
  assert.equal(new Set(receipts.map(r => r.sessionId)).size, 3, 'only planner, implementer and verifier children; no rejection-only children');
  assert.equal(receipts.length, 4, 'planner, initial implementation, continuation, verifier');
  assert.equal(run.nodes.impl.attempt, 2);
  assert.equal(run.nodes.verify.attempt, 1);
  assert.ok(receipts.some(r => r.nodeId === 'impl' && r.targetSource === 'task-id'));
  assert.ok(receipts.some(r => r.nodeId === 'verify' && r.targetSource === 'argument'));
  assert.equal(run.violations.filter(v => v.kind === 'gate-blocked-dispatch').length, 2);
  assert.equal(run.status, 'AWAITING_USER_DECISION', 'UNVERIFIED is deliberately honest about this transport-only fixture');
  // Count real host children, not only runner receipts: an unwanted rejection
  // child would have no receipt and must still fail this probe.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(root, 'data', 'opencode', 'opencode.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('select count(*) as n from session where parent_id = ?').get(run.rootSessionId).n, 3);
    const tasks = db.prepare("select data from part where session_id = ? and json_extract(data, '$.tool') = 'task'")
      .all(run.rootSessionId).map(row => JSON.parse(row.data));
    assert.equal(tasks.length, 6);
    const errors = tasks.filter(part => part.state.status === 'error');
    assert.equal(errors.length, 2);
    const missing = errors.find(part => part.state.error.includes('NODE_NOT_FOUND'));
    assert.equal(missing.state.input.nodeId, 'absent');
    assert.equal(missing.state.input.prompt, 'LOOP_INVALID_TARGET');
    assert.ok(errors.some(part => part.state.error.includes('CONFLICTING_NODE_ID')));
  } finally { db.close(); }
  t.diagnostic(`Native host probe: ${receipts.length} admitted calls, 3 child identities, 2 direct rejections; background schema=${backgroundSchema}.`);
});
