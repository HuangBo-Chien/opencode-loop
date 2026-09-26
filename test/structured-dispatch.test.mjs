import test from 'node:test';
import assert from 'node:assert/strict';
import * as Schema from 'effect/Schema';
import { parseNodeIdHint, resolveNodeIdHint } from '../src/dispatch-target.mjs';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createEnforcement } from '../src/enforcement.mjs';

async function harness(agent = 'graph-implementer') {
  const store = { ...createRunStore() };
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3, implementerParallel: 2 });
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  for (const id of ['a', 'b']) state.nodes[id] = { state: 'PENDING', attempt: 0,
    spec: { id, agent, kind: agent === 'graph-implementer' ? 'implement' : 'verify', dependsOn: [], inputs: [],
      acceptance: [`contract ${id}`], ...(agent === 'graph-implementer' ? { writeScope: [`${id}.txt`] } : {}) } };
  const bindings = new Map([['root', { runId: 'root', root: true, agent: 'graph-orchestrator' }]]);
  const enforcement = createEnforcement({ settings: {}, store, runner, bindings });
  const before = (callID, args) => enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID }, { args });
  const bind = async (callID, args, sessionId = 'child') => {
    await enforcement.dispatches.onSession({ id: sessionId, parentID: 'root' });
    await enforcement.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID,
      state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId } } });
  };
  const args = extra => ({ description: 'work', subagent_type: agent, prompt: 'Work on the assigned node', ...extra });
  return { store, state, runner, bindings, enforcement, before, bind, args };
}

test('structured nodeId does not depend on prompt layout; recognizable contradictory leading IDs reject', () => {
  for (const prompt of ['Do work', '[nodeId:a] Do work', '[nodeId:broken\nDo work', 'Example: [nodeId:b]\nDo work']) {
    const parsed = parseNodeIdHint({ nodeId: 'a', prompt }, { strict: true });
    assert.equal(parsed.allowed, true, prompt);
    assert.equal(parsed.nodeId, 'a');
    assert.equal(parsed.source, 'argument');
  }
  for (const prompt of ['[nodeId:b] Do work', '[nodeId:a] [nodeId:b]\nWork']) {
    assert.equal(parseNodeIdHint({ nodeId: 'a', prompt }, { strict: true }).code, 'CONFLICTING_NODE_ID');
  }
});

test('legacy-only input accepts a unique leading inline marker but never mines body examples', () => {
  for (const prompt of ['[nodeId:a] Do work', ' [nodeId: a]\tDo work\r\nDetails']) {
    assert.deepEqual(parseNodeIdHint({ prompt }, { strict: true }), { allowed: true, nodeId: 'a', source: 'marker' });
  }
  assert.equal(parseNodeIdHint({ prompt: 'Do work\n[nodeId:a]' }, { strict: true }).nodeId, null);
  for (const prompt of ['[nodeId:a] [nodeId:b]', '[nodeId:a] [nodeId:a]', '[nodeId:a/b]', '[nodeId:]', '[nodeId:a']) {
    assert.equal(parseNodeIdHint({ prompt }, { strict: true }).code, 'INVALID_NODE_ID', prompt);
  }
});

test('same-line prose quotations do not become additional leading targets', () => {
  const prompt = '[nodeId:a] Add a test whose input is [nodeId:b].';
  assert.deepEqual(parseNodeIdHint({ prompt }, { strict: true }), { allowed: true, nodeId: 'a', source: 'marker' });
  assert.deepEqual(parseNodeIdHint({ nodeId: 'a', prompt }, { strict: true }), { allowed: true, nodeId: 'a', source: 'argument' });
  assert.equal(parseNodeIdHint({ prompt: '[nodeId:a] [nodeId:b] Do work' }, { strict: true }).code, 'INVALID_NODE_ID');
  assert.equal(parseNodeIdHint({ nodeId: 'a', prompt: '[nodeId:a][nodeId:b] Do work' }, { strict: true }).code, 'CONFLICTING_NODE_ID');
});

test('structural targets reject trailing line terminators instead of accepting a regex end-of-line match', () => {
  for (const nodeId of ['a\n', 'a\r', 'a\u2028', 'a\u2029']) {
    assert.equal(parseNodeIdHint({ nodeId }, { strict: true }).code, 'INVALID_NODE_ID');
    assert.equal(resolveNodeIdHint({}, nodeId, { strict: true }).code, 'INVALID_NODE_ID');
  }
});

for (const agent of ['graph-implementer', 'graph-verifier']) test(`${agent} uses nodeId through hook and native decoder without any marker`, async () => {
  const h = await harness(agent);
  const args = h.args({ nodeId: 'b', background: true });
  await h.before('good', args);
  assert.equal(Object.hasOwn(args, 'nodeId'), false, 'plugin-only argument is consumed before the native decoder');
  const nativeParameters = Schema.Struct({ description: Schema.String, prompt: Schema.String, subagent_type: Schema.String,
    background: Schema.optional(Schema.Boolean), task_id: Schema.optional(Schema.String) });
  const native = Schema.decodeUnknownSync(nativeParameters)(args);
  assert.equal(native.background, true);
  assert.match(native.prompt, /Assigned nodeId: b/);
  assert.match(native.prompt, /contract b/);
  await h.bind('good', args);
  assert.equal(h.bindings.get('child').nodeId, 'b');
  assert.equal(h.state.nodes.b.attempt, 1);
  assert.equal(h.state.dispatchReservations[0].targetSource, 'argument');
  const formatted = args.prompt;
  await h.before('good', args);
  assert.equal(args.prompt, formatted);
});

test('rejection directly prevents native execution and preserves the original input', async () => {
  const h = await harness();
  const args = h.args(), original = structuredClone(args);
  let nativeCalls = 0;
  await assert.rejects(async () => {
    await h.before('missing', args);
    nativeCalls++;
  }, error => {
    assert.equal(error.code, 'NODE_ID_REQUIRED');
    assert.deepEqual(error.diagnostic.candidates, ['a', 'b']);
    assert.equal(error.diagnostic.nextAction, 'correct-target');
    assert.match(error.message, /RUNNER_REJECTED\(NODE_ID_REQUIRED\)/);
    return true;
  });
  assert.equal(nativeCalls, 0);
  assert.deepEqual(args, original);
  assert.equal(h.state.dispatchReservations?.length ?? 0, 0);
  assert.equal(h.state.dispatchCallIds?.length ?? 0, 0);
  assert.equal(h.state.nodes.a.attempt + h.state.nodes.b.attempt, 0);
  assert.equal(h.state.violations.at(-1).callID, 'missing');
});

test('active and incomplete task_id continuations infer only their authenticated original node', async () => {
  for (const phase of ['active', 'incomplete', 'restart']) {
    const h = await harness();
    const args = h.args({ nodeId: 'a' });
    await h.before('initial', args);
    await h.bind('initial', args);
    if (phase !== 'active') {
      await h.enforcement.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: 'initial',
        state: { status: 'completed', input: args, metadata: { parentSessionId: 'root', sessionId: 'child' } } });
      if (phase === 'restart') h.enforcement.dispatches.invalidate('root');
    }
    const continuation = h.args({ task_id: 'child' });
    await h.before('continue', continuation);
    assert.match(continuation.prompt, /Assigned nodeId: a/);
    assert.equal(h.state.dispatchReservations.find(r => r.callID === 'continue').targetSource, 'task-id');
    await h.bind('continue', continuation);
    assert.equal(h.state.nodes.a.attempt, phase === 'active' ? 1 : 2);
    assert.equal(h.state.nodes.b.attempt, 0);
  }
});

test('unknown and foreign task_id never auto-resolve even when another node is uniquely ready', async () => {
  const h = await harness();
  delete h.state.nodes.b;
  h.bindings.set('foreign', { runId: 'other', nodeId: 'a', agent: 'graph-implementer', root: false });
  for (const task_id of ['unknown', 'foreign']) {
    await assert.rejects(h.before(task_id, h.args({ task_id })), /RUNNER_REJECTED/);
    assert.equal(h.state.dispatchReservations?.length ?? 0, 0);
    assert.equal(h.state.nodes.a.attempt, 0);
  }
});

test('rejection logging failure still prevents native execution without rewriting args', async () => {
  const h = await harness();
  h.store.saveRun = async () => { throw new Error('disk full'); };
  const args = h.args(), before = structuredClone(args);
  let calls = 0;
  await assert.rejects(async () => { await h.before('error', args); calls++; }, /disk full|RUNNER_REJECTED/);
  assert.equal(calls, 0);
  assert.deepEqual(args, before);
  assert.equal(h.state.dispatchReservations?.length ?? 0, 0);
});

test('a paused active continuation reports the run blocker, not a misleading target correction', async () => {
  const h = await harness();
  const args = h.args({ nodeId: 'a' });
  await h.before('initial', args);
  await h.bind('initial', args);
  h.state.status = 'AWAITING_USER_DECISION';
  await assert.rejects(h.before('paused', h.args({ task_id: 'child' })), error => {
    assert.equal(error.code, 'AWAITING_DECISION');
    assert.equal(error.diagnostic.nextAction, 'user-decision');
    return true;
  });
  assert.equal(h.state.nodes.a.attempt, 1);
  assert.equal(h.state.dispatchReservations.length, 1);
});
