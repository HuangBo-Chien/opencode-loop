import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createEnforcement } from '../src/enforcement.mjs';

// Ready-node fixtures isolate dispatch from plan authoring. No filesystem writes.
async function harness(agent = 'graph-implementer', count = 2) {
  const store = createRunStore();
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3, implementerParallel: 2 });
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  for (const id of ['a', 'b'].slice(0, count)) {
    state.nodes[id] = {
      spec: { id, agent, kind: agent === 'graph-verifier' ? 'verify' : 'implement', dependsOn: [],
        ...(agent === 'graph-implementer' ? { writeScope: [`pkg-${id}/**`] } : {}) },
      state: 'PENDING', attempt: 0,
    };
  }
  const bindings = new Map([['root', { runId: 'root', root: true, agent: 'graph-orchestrator' }]]);
  const enforcement = createEnforcement({ settings: {}, store, runner, bindings });
  const dispatch = async (callID, prompt, extra = {}) => {
    const output = { args: { description: callID, subagent_type: agent, prompt, ...extra } };
    await enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID }, output);
    return output.args;
  };
  const session = (id) => enforcement.dispatches.onSession({ id, parentID: 'root' });
  const metadata = (callID, sessionId, args) => enforcement.dispatches.onPart({
    type: 'tool', tool: 'task', callID, sessionID: 'root',
    state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId } },
  });
  return { store, runner, state, bindings, enforcement, dispatch, session, metadata };
}

for (const agent of ['graph-implementer', 'graph-verifier']) {
  for (const count of [1, 2]) {
    test(`strict target: ${agent} requires a node even with ${count} ready node(s)`, async () => {
      const h = await harness(agent, count);
      const args = await h.dispatch('missing', 'Work on task B');
      assert.match(args.prompt, /RUNNER_REJECTED/);
      assert.match(args.prompt, /NODE_ID_REQUIRED/);
      assert.deepEqual(h.enforcement.dispatches.inspect('root'), []);
      assert.ok(Object.values(h.state.nodes).every((node) => node.state === 'PENDING' && node.attempt === 0));
    });
  }

  test(`strict target: direct ${agent} admission cannot bypass target validation`, async () => {
    const h = await harness(agent);
    for (const [target, code] of [[null, 'NODE_ID_REQUIRED'], ['', 'INVALID_NODE_ID'], [42, 'INVALID_NODE_ID'], ['a/b', 'INVALID_NODE_ID']]) {
      const result = await h.enforcement.dispatches.admit('root', `bad-${String(target)}`, { subagent_type: agent }, target);
      assert.equal(result.code, code);
      assert.equal(result.allowed, false);
      assert.deepEqual(h.enforcement.dispatches.inspect('root'), []);
      assert.equal(Object.hasOwn(h.state, 'dispatchCallIds'), false);
    }
    assert.deepEqual(h.state.dispatchCallIds ?? [], []);
  });
}

test('strict target: direct admission validates every target source before reserving', async () => {
  for (const args of [
    { nodeId: 'a' },
    { prompt: '[nodeId:a]\nImplement A' },
  ]) {
    const h = await harness();
    const before = structuredClone(h.state);
    const result = await h.enforcement.dispatches.admit(
      'root',
      'conflict',
      { subagent_type: 'graph-implementer', ...args },
      'b',
    );
    assert.equal(result.code, 'CONFLICTING_NODE_ID');
    assert.equal(result.allowed, false);
    assert.deepEqual(h.state, before);
    assert.deepEqual(h.enforcement.dispatches.inspect('root'), []);
  }

  const h = await harness();
  const result = await h.enforcement.dispatches.admit(
    'root',
    'argument-only',
    { subagent_type: 'graph-implementer', nodeId: 'a' },
  );
  assert.equal(result.allowed, true, JSON.stringify(result));
  assert.equal(result.nodeId, 'a');
});

const invalidTargets = [
  ['inline marker', '[nodeId:b] Implement B', {}, 'INVALID_NODE_ID'],
  ['empty marker', '[nodeId:]\nImplement B', {}, 'INVALID_NODE_ID'],
  ['illegal marker', '[nodeId:b/c]\nImplement B', {}, 'INVALID_NODE_ID'],
  ['unclosed marker', '[nodeId:b\nImplement B', {}, 'INVALID_NODE_ID'],
  ['multiple markers', '[nodeId:a] [nodeId:b]\nImplement B', {}, 'INVALID_NODE_ID'],
  ['empty argument', 'Implement B', { nodeId: '' }, 'INVALID_NODE_ID'],
  ['null argument', '[nodeId:b]\nImplement B', { nodeId: null }, 'INVALID_NODE_ID'],
  ['non-string argument', '[nodeId:b]\nImplement B', { nodeId: 42 }, 'INVALID_NODE_ID'],
  ['illegal argument', '[nodeId:b]\nImplement B', { nodeId: 'a/b' }, 'INVALID_NODE_ID'],
  ['conflicting sources', '[nodeId:b]\nImplement B', { nodeId: 'a' }, 'CONFLICTING_NODE_ID'],
  ['valid argument cannot mask malformed marker', '[nodeId:b] Implement B', { nodeId: 'b' }, 'INVALID_NODE_ID'],
  ['second-line marker is not a target', 'Implement B\n[nodeId:b]', {}, 'NODE_ID_REQUIRED'],
];
for (const [name, prompt, extra, code] of invalidTargets) {
  test(`strict target: ${name} is rejected before reservation`, async () => {
    const h = await harness();
    const args = await h.dispatch('bad', prompt, extra);
    assert.match(args.prompt, /RUNNER_REJECTED/);
    assert.ok(args.prompt.includes(code), args.prompt);
    assert.deepEqual(h.enforcement.dispatches.inspect('root'), []);
    assert.deepEqual(h.state.dispatchCallIds ?? [], []);
    assert.equal(h.state.nodes.a.attempt, 0);
    assert.equal(h.state.nodes.b.attempt, 0);
  });
}

for (const [name, prompt, extra] of [
  ['marker', '[nodeId:b]\nImplement B', {}],
  ['CRLF and surrounding whitespace', ' \t[nodeId: b]\t\r\nImplement B', {}],
  ['argument', 'Implement B', { nodeId: 'b' }],
  ['matching sources', '[nodeId:b]\nImplement B', { nodeId: 'b' }],
  ['body quotation is not another target', '[nodeId:b]\nExample only: [nodeId:a]', {}],
]) {
  test(`strict target: valid ${name} selects the requested node`, async () => {
    const h = await harness();
    const args = await h.dispatch('b', prompt, extra);
    assert.match(args.prompt, /Assigned nodeId: b/);
    assert.match(args.prompt, /writeScope: pkg-b\/\*\*/);
    assert.ok(args.prompt.endsWith(prompt));
    await h.session('child-b');
    await h.metadata('b', 'child-b', args);
    assert.equal(h.bindings.get('child-b').nodeId, 'b');
  });
}

for (const agent of ['graph-implementer', 'graph-verifier']) {
  for (const phase of ['RUNNING', 'INCOMPLETE', 'PENDING', 'STALE', 'restart']) {
    test(`strict continuation: ${agent} ${phase} rejects a different node without revoking its own binding`, async () => {
      const h = await harness(agent);
      const initial = await h.dispatch('initial', '[nodeId:a]\nImplement A');
      await h.session('child-a');
      await h.metadata('initial', 'child-a', initial);
      if (phase !== 'RUNNING') {
        await h.enforcement.dispatches.onIdle('child-a', 'idle-initial');
        assert.equal(h.state.nodes.a.state, 'INCOMPLETE');
        if (phase === 'PENDING' || phase === 'STALE') h.state.nodes.a.state = phase;
        if (phase === 'restart') h.enforcement.dispatches.invalidate('root');
      }
      const beforeNode = structuredClone(h.state.nodes.a);
      const beforeBinding = h.bindings.get('child-a');
      const beforeDispatches = h.enforcement.dispatches.inspect('root');
      const beforeCalls = [...h.state.dispatchCallIds];
      const conflict = await h.dispatch('conflict', '[nodeId:b]\nImplement B', { task_id: 'child-a' });
      assert.match(conflict.prompt, /RUNNER_REJECTED/);
      assert.match(conflict.prompt, /TASK_NODE_MISMATCH/);
      assert.equal(Object.hasOwn(conflict, 'task_id'), false);
      assert.deepEqual(h.state.nodes.a, beforeNode);
      assert.equal(h.bindings.get('child-a'), beforeBinding);
      assert.deepEqual(h.enforcement.dispatches.inspect('root'), beforeDispatches);
      assert.deepEqual(h.state.dispatchCallIds, beforeCalls);

      const missing = await h.dispatch('missing', 'Continue A', { task_id: 'child-a' });
      assert.match(missing.prompt, /NODE_ID_REQUIRED/);
      assert.equal(Object.hasOwn(missing, 'task_id'), false);
      assert.deepEqual(h.enforcement.dispatches.inspect('root'), beforeDispatches);

      const valid = await h.dispatch('continue-a', '[nodeId:a]\nContinue A', { task_id: 'child-a' });
      assert.match(valid.prompt, /Assigned nodeId: a/);
      assert.equal(h.state.nodes.a.attempt, 1); // reservation never charges
      await h.metadata('continue-a', 'child-a', valid);
      assert.equal(h.bindings.get('child-a').nodeId, 'a');
      assert.equal(h.state.nodes.a.attempt, phase === 'RUNNING' ? 1 : 2);
    });
  }
}

test('strict continuation: active attempt continues at full writer capacity without charging twice', async () => {
  const h = await harness();
  for (const id of ['a', 'b']) {
    const args = await h.dispatch(id, `[nodeId:${id}]\nImplement ${id}`);
    await h.session(`child-${id}`);
    await h.metadata(id, `child-${id}`, args);
  }
  const continued = await h.dispatch('again', '[nodeId:a]\nContinue A', { task_id: 'child-a' });
  assert.match(continued.prompt, /Assigned nodeId: a/);
  assert.equal(h.state.nodes.a.attempt, 1);
});

for (const reverseSessions of [false, true]) {
  for (const reverseMetadata of [false, true]) {
    for (const metadataFirst of [false, true]) {
      test(`strict parallel: session reverse=${reverseSessions}, metadata reverse=${reverseMetadata}, metadata first=${metadataFirst}`, async () => {
        const h = await harness();
        const [b, a] = await Promise.all([
          h.dispatch('call-b', '[nodeId:b]\nImplement B in pkg-b/main.js'),
          h.dispatch('call-a', '[nodeId:a]\nImplement A in pkg-a/main.js'),
        ]);
        assert.match(b.prompt, /Assigned nodeId: b/);
        assert.match(a.prompt, /Assigned nodeId: a/);
        const args = { a, b };
        const sessions = async () => {
          for (const id of reverseSessions ? ['a', 'b'] : ['b', 'a']) await h.session(`child-${id}`);
        };
        const metadata = async () => {
          for (const id of reverseMetadata ? ['a', 'b'] : ['b', 'a']) await h.metadata(`call-${id}`, `child-${id}`, args[id]);
        };
        await (metadataFirst ? metadata() : sessions());
        await (metadataFirst ? sessions() : metadata());
        for (const id of ['a', 'b']) {
          assert.equal(h.bindings.get(`child-${id}`).nodeId, id);
          assert.equal(h.state.nodes[id].attempt, 1);
          const other = id === 'a' ? 'b' : 'a';
          await assert.doesNotReject(h.enforcement.onToolBefore(
            { tool: 'write', sessionID: `child-${id}`, callID: `own-${id}` },
            { args: { filePath: `pkg-${id}/main.js` } },
          ));
          await assert.rejects(h.enforcement.onToolBefore(
            { tool: 'write', sessionID: `child-${id}`, callID: `other-${id}` },
            { args: { filePath: `pkg-${other}/main.js` } },
          ), /RUNNER_DENIED\(out-of-scope-write\)/);
        }
      });
    }
  }
}
