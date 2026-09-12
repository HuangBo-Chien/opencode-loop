import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';

async function harness(client) {
  const store = createRunStore();
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3 });
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  state.nodes.impl = { spec: { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: [], writeScope: ['work/**'] }, state: 'PENDING', attempt: 0 };
  const bindings = new Map([['root', { runId: 'root', root: true, agent: 'graph-orchestrator' }]]);
  const dispatches = createDispatchBindings({ store, runner, bindings, client });
  const admit = (call, agent = 'graph-implementer', task_id) => dispatches.admit('root', call, { subagent_type: agent, task_id });
  const part = (call, session, agent = 'graph-implementer', status = 'running', extra = {}) => ({
    type: 'tool', tool: 'task', callID: call, sessionID: 'root',
    state: { status, input: { subagent_type: agent }, metadata: { parentSessionId: 'root', sessionId: session }, ...extra },
  });
  return { store, runner, state, bindings, dispatches, admit, part };
}

test('reserves before binding, counts once, and permits only same-attempt continuation', async () => {
  const h = await harness();
  assert.equal((await h.admit('first')).allowed, true);
  assert.equal(h.state.nodes.impl.attempt, 0);
  assert.equal((await h.admit('duplicate')).code, 'DISPATCH_PENDING');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  assert.equal(h.bindings.has('child'), false);
  await h.dispatches.onPart(h.part('first', 'child'));
  assert.equal(h.state.nodes.impl.attempt, 1);
  assert.equal(h.state.nodes.impl.sessionId, 'child');
  await h.dispatches.onPart(h.part('first', 'child'));
  assert.equal(h.state.nodes.impl.attempt, 1);
  assert.equal((await h.admit('continued', 'graph-implementer', 'child')).allowed, true);
  await h.dispatches.onPart(h.part('continued', 'child'));
  assert.equal(h.state.nodes.impl.attempt, 1);
  await h.dispatches.onIdle('child', 'idle-a');
  assert.equal(h.state.nodes.impl.state, 'RUNNING');
  await h.dispatches.onIdle('child', 'idle-b');
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');
  // An INCOMPLETE node is resumable by the session that last worked it: the
  // reservation succeeds, the attempt is charged only when binding begins.
  const resume = await h.admit('resume', 'graph-implementer', 'child');
  assert.equal(resume.allowed, true);
  assert.equal(resume.resumed, true);
  assert.equal(h.state.nodes.impl.attempt, 1);
});

test('task_id resume of an incomplete attempt rebinds, charges a new attempt and injects the ledger', async () => {
  const h = await harness();
  await h.admit('first');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  await h.dispatches.onPart(h.part('first', 'child'));
  h.runner.recordSideEffect(h.state, { nodeId: 'impl', tool: 'edit', target: 'work/a', now: 'now' });
  await h.dispatches.onIdle('child', 'idle-a');
  await h.dispatches.onIdle('child', 'idle-b');
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');

  const resume = await h.admit('resume', 'graph-implementer', 'child');
  assert.equal(resume.allowed, true, JSON.stringify(resume));
  assert.equal(resume.reconcile, true);
  await h.dispatches.onPart(h.part('resume', 'child'));
  assert.equal(h.state.nodes.impl.state, 'RUNNING');
  assert.equal(h.state.nodes.impl.attempt, 2);
  assert.equal(h.state.nodes.impl.sessionId, 'child');
  assert.equal(h.bindings.get('child').active, true);
  await h.dispatches.onIdle('child', 'idle-c');
  await h.dispatches.onIdle('child', 'idle-d');
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');
  assert.equal(h.state.nodes.impl.attempt, 2);
});

test('task_id resume is denied without attempts, for other nodes and for foreign sessions', async () => {
  const h = await harness();
  h.state.nodes.impl.spec.maxAttempts = 1;
  await h.admit('first');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  await h.dispatches.onPart(h.part('first', 'child'));
  await h.dispatches.onIdle('child', 'idle-a');
  await h.dispatches.onIdle('child', 'idle-b');
  assert.equal(h.state.nodes.impl.state, 'FAILED');
  assert.equal((await h.admit('exhausted', 'graph-implementer', 'child')).code, 'FRESH_SESSION_REQUIRED');
  assert.equal((await h.admit('wrong-role', 'graph-planner', 'child')).code, 'FRESH_SESSION_REQUIRED');

  const second = await harness();
  await second.admit('a');
  await second.dispatches.onSession({ id: 'worker', parentID: 'root' });
  await second.dispatches.onPart(second.part('a', 'worker'));
  await second.dispatches.onIdle('worker', 'idle-a');
  await second.dispatches.onIdle('worker', 'idle-b');
  assert.equal(second.state.nodes.impl.state, 'INCOMPLETE');
  // A different session never worked this node; only fresh sessions apply.
  await second.dispatches.onSession({ id: 'stranger', parentID: 'root' });
  assert.equal((await second.admit('stranger-call', 'graph-implementer', 'stranger')).code, 'FRESH_SESSION_REQUIRED');
  assert.equal(second.state.nodes.impl.attempt, 1);
});

test('metadata correlates concurrent free dispatches even with reversed creation and arrival order', async () => {
  const h = await harness();
  await h.admit('a', 'graph-explorer');
  await h.admit('b', 'graph-planner');
  await h.dispatches.onPart(h.part('b', 'second', 'graph-planner'));
  await h.dispatches.onSession({ id: 'unrelated', parentID: 'root' });
  await h.dispatches.onSession({ id: 'second', parentID: 'root' });
  await h.dispatches.onSession({ id: 'first', parentID: 'root' });
  await h.dispatches.onPart(h.part('a', 'first', 'graph-explorer'));
  assert.equal(h.bindings.has('unrelated'), false);
  assert.equal(h.bindings.get('second').agent, 'graph-planner');
  assert.equal(h.bindings.get('first').agent, 'graph-explorer');
});

test('failed reservation releases without charging an attempt; recovery revokes delayed events and old sessions', async () => {
  const h = await harness();
  await h.admit('failed');
  await h.dispatches.onPart(h.part('failed', undefined, 'graph-implementer', 'error'));
  assert.equal(h.state.nodes.impl.attempt, 0);
  await h.admit('real');
  await h.dispatches.onSession({ id: 'old', parentID: 'root' });
  await h.dispatches.onPart(h.part('real', 'old'));
  h.runner.recordSideEffect(h.state, { nodeId: 'impl', tool: 'edit', target: 'work/a', now: 'now' });
  h.dispatches.invalidate('root');
  const resume = h.runner.resumeRun(h.state, { now: 'now' });
  h.runner.reconcileNode(h.state, 'impl', { now: 'now' });
  assert.deepEqual(resume.report.recoveryRequired, ['impl']);
  await h.admit('new');
  await h.dispatches.onPart(h.part('real', 'late'));
  await h.dispatches.onIdle('old');
  assert.equal(h.state.nodes.impl.attempt, 1);
  await h.dispatches.onSession({ id: 'new', parentID: 'root' });
  await h.dispatches.onPart(h.part('new', 'new'));
  assert.equal(h.state.nodes.impl.attempt, 2);
  assert.equal(h.state.nodes.impl.sessionId, 'new');
  assert.equal(h.bindings.has('late'), false);
  assert.equal(h.bindings.has('old'), false);
});

test('conflicting role or parentage cannot bind a reservation', async () => {
  const h = await harness();
  await h.admit('call');
  await h.dispatches.onSession({ id: 'foreign', parentID: 'other-root' });
  await h.dispatches.onPart(h.part('call', 'foreign'));
  await h.dispatches.onSession({ id: 'wrong-role', parentID: 'root' });
  await h.dispatches.onPart(h.part('call', 'wrong-role', 'graph-planner'));
  assert.equal(h.state.nodes.impl.attempt, 0);
  assert.equal(h.bindings.has('foreign'), false);
  assert.equal(h.bindings.has('wrong-role'), false);
});

test('bounded host read resolves missing metadata event before child work', async () => {
  let messageCalls = 0;
  const client = { session: {
    async get() { return { data: { id: 'child', parentID: 'root' } }; },
    async messages(options) {
      messageCalls++;
      assert.equal(options.query.limit, 64);
      assert.ok(options.signal);
      return { data: [{ parts: [h.part('call', 'child')] }] };
    },
  } };
  const h = await harness(client);
  await h.admit('call');
  assert.equal(await h.dispatches.ensureSession('child'), true);
  assert.equal(h.state.nodes.impl.sessionId, 'child');
  assert.equal(messageCalls, 1);
});

test('unresolved sessions fail closed but verified native sessions are not graph-managed', async () => {
  const h = await harness({ session: { async get() { throw new Error('offline'); }, async messages() {} } });
  await h.admit('call');
  assert.equal(await h.dispatches.ensureSession('unknown'), false);
  assert.equal(h.dispatches.managed('unknown'), true);
  await h.dispatches.onSession({ id: 'native-child', parentID: 'native-root' });
  assert.equal(h.dispatches.managed('native-child'), false);
});

test('idle of an original prompt does not cancel an admitted continuation', async () => {
  const h = await harness();
  await h.admit('a');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  await h.dispatches.onPart(h.part('a', 'child'));
  await h.admit('b', 'graph-implementer', 'child');
  await h.dispatches.onIdle('child', 'idle-a');
  assert.equal(h.state.nodes.impl.state, 'RUNNING');
  await h.dispatches.onPart(h.part('b', 'child'));
  assert.equal(h.state.nodes.impl.attempt, 1);
  await h.dispatches.onIdle('child', 'idle-b');
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');
});

test('completed background metadata resolves bindings while foreground completion does not start work', async () => {
  const h = await harness({ session: {
    async get() { return { data: { id: 'child', parentID: 'root' } }; },
    async messages() { return { data: [{ parts: [h.part('a', 'child', 'graph-implementer', 'completed', {
      metadata: { parentSessionId: 'root', sessionId: 'child', background: true },
    })] }] }; },
  } });
  await h.admit('a');
  assert.equal(await h.dispatches.ensureSession('child'), true);
  assert.equal(h.state.nodes.impl.state, 'RUNNING');
  assert.equal(h.state.nodes.impl.attempt, 1);
});

test('idle is serialized behind in-progress binding persistence', async () => {
  const h = await harness();
  await h.admit('a');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  // A queued operation reproduces the asynchronous binding save window.
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const blocked = h.dispatches.exclusive('root', () => barrier);
  const binding = h.dispatches.onPart(h.part('a', 'child'));
  const idle = h.dispatches.onIdle('child');
  release();
  await Promise.all([blocked, binding, idle]);
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');
});

test('duplicate idle identity cannot finish a continuation and delayed idle evidence is retained', async () => {
  const h = await harness();
  await h.admit('a');
  await h.dispatches.onSession({ id: 'child', parentID: 'root' });
  await h.dispatches.onPart(h.part('a', 'child'));
  await h.admit('b', 'graph-implementer', 'child');
  await h.dispatches.onPart(h.part('b', 'child'));
  await h.dispatches.onIdle('child', 'event-a');
  await h.dispatches.onIdle('child', 'event-a');
  assert.equal(h.state.nodes.impl.state, 'RUNNING');
  await h.dispatches.onIdle('child', 'event-b');
  assert.equal(h.state.nodes.impl.state, 'INCOMPLETE');

  const late = await harness();
  await late.admit('late');
  await late.dispatches.onSession({ id: 'late-child', parentID: 'root' });
  await late.dispatches.onIdle('late-child', 'early-idle');
  await late.dispatches.onPart(late.part('late', 'late-child', 'graph-implementer', 'completed', {
    metadata: { parentSessionId: 'root', sessionId: 'late-child', background: true },
  }));
  assert.equal(late.state.nodes.impl.state, 'INCOMPLETE');
});

test('consumed call IDs cannot be reused after resume', async () => {
  const h = await harness();
  await h.admit('a');
  h.dispatches.invalidate('root');
  assert.equal((await h.admit('a')).code, 'DUPLICATE_DISPATCH');
});

test('binding persistence can retry without beginning or charging the node twice', async () => {
  const store = createRunStore();
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  state.nodes.impl = { spec: { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: [] }, state: 'PENDING', attempt: 0 };
  let saves = 0;
  const dispatches = createDispatchBindings({
    store: { ...store, async saveRun(s) {
      if (s.nodes.impl.state === 'RUNNING' && ++saves === 1) throw new Error('disk unavailable');
      return store.saveRun(s);
    } },
    runner: createRunner({ maxAttempts: 3, maxPlanRevisions: 3 }),
    bindings: new Map([['root', { root: true, runId: 'root' }]]),
  });
  await dispatches.admit('root', 'a', { subagent_type: 'graph-implementer' });
  await dispatches.onSession({ id: 'child', parentID: 'root' });
  const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: 'a', state: {
    status: 'running', input: { subagent_type: 'graph-implementer' }, metadata: { parentSessionId: 'root', sessionId: 'child' },
  } };
  await dispatches.onPart(part);
  assert.equal(state.nodes.impl.attempt, 1);
  assert.equal(dispatches.inspect('root')[0].bound, false);
  await dispatches.onPart(part);
  assert.equal(saves, 2);
  assert.equal(state.nodes.impl.attempt, 1);
  assert.equal(dispatches.inspect('root')[0].bound, true);
});

test('terminal events retain failed binding recovery until it can be durably reconciled', async () => {
  const store = createRunStore();
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  state.nodes.impl = { spec: { id: 'impl', kind: 'implement', agent: 'graph-implementer', dependsOn: [] }, state: 'PENDING', attempt: 0 };
  let offline = true;
  let saved = 'PENDING';
  const dispatches = createDispatchBindings({
    store: { ...store, async saveRun(s) {
      if (s.nodes.impl.state === 'RUNNING' && offline) throw new Error('disk unavailable');
      saved = s.nodes.impl.state;
    } },
    runner: createRunner({ maxAttempts: 3, maxPlanRevisions: 3 }),
    bindings: new Map([['root', { root: true, runId: 'root' }]]),
  });
  await dispatches.admit('root', 'a', { subagent_type: 'graph-implementer' });
  await dispatches.onSession({ id: 'child', parentID: 'root' });
  const part = { type: 'tool', tool: 'task', sessionID: 'root', callID: 'a', state: {
    status: 'running', input: { subagent_type: 'graph-implementer' }, metadata: { parentSessionId: 'root', sessionId: 'child' },
  } };
  await dispatches.onPart(part);
  await dispatches.onIdle('child', 'idle');
  await dispatches.onPart({ ...part, state: { ...part.state, status: 'completed' } });
  assert.equal(dispatches.inspect('root')[0]?.errorCode, 'BINDING_PERSISTENCE_FAILED');
  offline = false;
  await dispatches.onPart(part);
  assert.equal(state.nodes.impl.state, 'INCOMPLETE');
  assert.equal(saved, 'INCOMPLETE');
  assert.equal(state.nodes.impl.attempt, 1);
  assert.equal((await dispatches.admit('root', 'fresh', { subagent_type: 'graph-implementer' })).allowed, true);
});
