import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';
import { createEnforcement } from '../src/enforcement.mjs';
import { createSubmitTools } from '../src/submit.mjs';

const roles = ['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-implementer', 'graph-verifier'];
async function fixture(role = 'graph-explorer', options = {}) {
  const store = { ...createRunStore() };
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 3, readerParallel: 1 });
  const state = await store.createRun({ runId: 'root', rootSessionId: 'root', now: 'now' });
  const bindings = new Map([['root', { root: true, runId: 'root', agent: 'graph-orchestrator' }]]);
  const parents = new Map();
  const messages = new Map();
  const client = { session: {
    get: async ({ path }) => ({ data: { id: path.id, parentID: parents.get(path.id) } }),
    messages: async ({ path }) => ({ data: messages.get(path.id) ?? [] }),
    status: async () => ({ data: {} }),
  } };
  let dispatches = createDispatchBindings({ store, runner, bindings, client, ...options });
  const part = (caller, call, session, agent, status = 'running') => ({ type: 'tool', tool: 'task', sessionID: caller, callID: call,
    state: { status, input: { subagent_type: agent }, metadata: { parentSessionId: caller, sessionId: session } } });
  const bind = async (caller, call, session, agent, reverse = false) => {
    parents.set(session, caller);
    const metadata = part(caller, call, session, agent);
    messages.set(caller, [...(messages.get(caller) ?? []), { parts: [metadata] }]);
    if (reverse) await dispatches.onPart(metadata);
    await dispatches.onSession({ id: session, parentID: caller });
    if (!reverse) await dispatches.onPart(metadata);
  };
  const kind = { 'graph-explorer': 'explore', 'graph-planner': 'plan', 'graph-plan-critic': 'review', 'graph-implementer': 'implement', 'graph-verifier': 'verify' }[role];
  state.nodes.owner = { spec: { id: 'owner', kind, agent: role, dependsOn: [], writeScope: ['work/**'] }, state: 'PENDING', attempt: 0 };
  assert.equal((await dispatches.admit('root', 'owner-call', { subagent_type: role }, 'owner')).allowed, true);
  await bind('root', 'owner-call', 'caller', role);
  const consult = (call = 'consult', extra = {}, caller = 'caller') => dispatches.admit(caller, call, { subagent_type: 'graph-multimodal', prompt: 'Read image', ...extra });
  return { store, runner, state, bindings, client, parents, messages, part, bind, consult,
    get dispatches() { return dispatches; }, restart: async () => { bindings.clear(); dispatches = createDispatchBindings({ store, runner, bindings, client, ...options }); await dispatches.recoverPaused(state); } };
}

test('native depth prerequisite denies before reserving and retains arbitrary host errors', async () => {
  let depth = 1;
  const h = await fixture('graph-explorer', { getSubagentDepth: () => depth });
  const before = structuredClone(h.state);
  assert.equal((await h.consult()).code, 'SUBAGENT_DEPTH_LIMIT');
  assert.deepEqual(h.state, before);
  depth = 0;
  assert.equal((await h.dispatches.admit('root', 'root-denied', { subagent_type: 'graph-multimodal' })).code, 'SUBAGENT_DEPTH_LIMIT');
  assert.deepEqual(h.state, before);
  depth = 2;
  assert.equal((await h.consult()).allowed, true);
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'error'));
  assert.equal(h.dispatches.inspect('root').filter(r => r.nested).length, 1);
});

for (const role of roles) test(`nested ${role} consult bypasses ready analyze and ordinary capacity`, async () => {
  const h = await fixture(role);
  h.state.nodes.image = { spec: { id: 'image', kind: 'analyze', agent: 'graph-multimodal', dependsOn: [] }, state: 'PENDING', attempt: 0 };
  const result = await h.consult();
  assert.equal(result.allowed, true, JSON.stringify(result));
  assert.equal(result.nodeId, null);
  assert.equal(result.nested, true);
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal', true);
  assert.equal(h.dispatches.current(h.bindings.get('image-child')), true);
  assert.equal(h.state.nodes.image.attempt, 0);
  assert.equal((await h.consult('second')).code, 'NESTED_CONSULT_CAPACITY');
  const record = h.state.dispatchReservations.find(r => r.nested);
  assert.equal(record.callerSessionId, 'caller');
  assert.equal(record.callerDispatchId, h.bindings.get('caller').dispatchId);
  assert.equal(record.rootSessionId, 'root');
});

test('nested targets, continuations and inactive authority reject before reservation', async () => {
  const h = await fixture();
  for (const extra of [{ nodeId: 'x' }, { prompt: '[nodeId:x]\nimage' }, { subagent_type: 'graph-explorer' }, { task_id: 'foreign' }, { task_id: 'caller' }]) {
    assert.equal((await h.consult('bad', extra)).allowed, false);
  }
  assert.equal(h.state.dispatchReservations.length, 1);
  assert.equal((await h.consult()).allowed, true);
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  assert.equal((await h.consult('recursive', {}, 'image-child')).allowed, false);
  assert.equal((await h.dispatches.admit('root', 'steal', { subagent_type: 'graph-multimodal', task_id: 'image-child' })).allowed, false);
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed'));
  assert.equal((await h.consult('continue', { task_id: 'image-child' })).allowed, true);
  h.state.nodes.owner.state = 'SUCCEEDED';
  assert.equal(h.dispatches.current(h.bindings.get('image-child')), false);
  assert.equal((await h.consult('stale')).allowed, false);
});

test('nested persistence failure does not publish a reservation', async () => {
  const h = await fixture();
  h.store.saveRun = async () => { throw new Error('EIO'); };
  assert.equal((await h.consult()).code, 'DISPATCH_PERSISTENCE_FAILED');
  assert.equal(h.dispatches.inspect('root').length, 1);
});

test('nested revocation and paused restart retain and settle actual caller metadata', async () => {
  const h = await fixture('graph-implementer');
  assert.equal((await h.consult()).allowed, true);
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.revokeExecution(h.state, { nodeIds: ['owner'] });
  assert.equal(h.bindings.get('image-child').settlementOnly, true);
  h.state.status = 'AWAITING_USER_DECISION';
  await h.restart();
  assert.equal(h.dispatches.inspect('root').filter(r => r.nested).length, 1);
  assert.equal(h.dispatches.runForSession('image-child'), 'root');
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed'));
  assert.equal(h.dispatches.inspect('root').filter(r => r.nested).length, 0);
});

test('nested enforcement is serialized without recursive locks and findings never write closeouts', { timeout: 3000 }, async () => {
  const h = await fixture();
  const enforcement = createEnforcement({ settings: {}, ...h, dispatches: h.dispatches });
  const output = { args: { subagent_type: 'graph-multimodal', prompt: 'Read image' } };
  await enforcement.onToolBefore({ tool: 'task', sessionID: 'caller', callID: 'consult' }, output);
  assert.match(output.args.prompt, /NESTED_CONSULT/);
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  const tools = createSubmitTools({ ...h, worktree: '.' }).tools;
  for (const status of ['RUNNING', 'AWAITING_USER_DECISION']) {
    h.state.status = status;
    const result = JSON.parse(await tools.graph_submit_findings.execute({ summary: 'image' }, { sessionID: 'image-child', agent: 'graph-multimodal' }));
    assert.equal(result.code, 'NESTED_CONSULT_ONLY');
    assert.equal(h.state.artifacts.findings, undefined);
    assert.deepEqual(h.state.closeouts ?? [], []);
  }
});

test('runner consultOnly is explicit and preserves run/role gates', async () => {
  const h = await fixture();
  assert.equal(h.runner.admitDispatch(h.state, { agent: 'graph-multimodal', consultOnly: true }).nodeId, null);
  assert.equal(h.runner.admitDispatch(h.state, { agent: 'graph-explorer', consultOnly: true }).allowed, false);
  for (const status of ['AWAITING_USER_DECISION', 'RECOVERY_REQUIRED', 'SUCCEEDED']) {
    h.state.status = status;
    assert.equal(h.runner.admitDispatch(h.state, { agent: 'graph-multimodal', consultOnly: true }).allowed, false);
  }
});

test('same callID is scoped to actual caller and capacity is run-wide', async () => {
  const h = await fixture('graph-implementer');
  assert.equal((await h.dispatches.admit('root', 'other', { subagent_type: 'graph-explorer' })).allowed, true);
  await h.bind('root', 'other', 'other-caller', 'graph-explorer');
  assert.equal((await h.consult('owner-call')).allowed, true);
  assert.equal((await h.consult('owner-call', {}, 'other-caller')).code, 'NESTED_CONSULT_CAPACITY');
  await h.bind('caller', 'owner-call', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('caller', 'owner-call', 'image-child', 'graph-multimodal', 'completed'));
  assert.equal((await h.consult('foreign', { task_id: 'image-child' }, 'other-caller')).code, 'TASK_CALLER_MISMATCH');
  assert.equal((await h.consult('owner-call', {}, 'other-caller')).allowed, true);
  assert.equal(h.state.nodes.owner.state, 'RUNNING');
});

test('caller rebinding cannot continue a consultation from the old generation', async () => {
  const h = await fixture('graph-implementer');
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed'));
  await h.dispatches.onPart(h.part('root', 'owner-call', 'caller', 'graph-implementer', 'completed'));
  assert.equal((await h.dispatches.admit('root', 'owner-new', { subagent_type: 'graph-implementer', task_id: 'caller' }, 'owner')).allowed, true);
  await h.bind('root', 'owner-new', 'caller', 'graph-implementer');
  assert.equal((await h.consult('old', { task_id: 'image-child' })).code, 'TASK_CALLER_MISMATCH');
});

test('parent lifetime completion revokes descendant without releasing nested capacity', async () => {
  const h = await fixture('graph-implementer');
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('root', 'owner-call', 'caller', 'graph-implementer', 'completed'));
  assert.equal(h.bindings.get('image-child').settlementOnly, true);
  assert.equal(h.dispatches.inspect('root').length, 1);
  h.dispatches.invalidate('root');
  assert.equal(h.dispatches.inspect('root').length, 1);
  await h.restart();
  assert.equal(h.dispatches.inspect('root').length, 1);
  assert.equal(h.state.dispatchRecoveryIssues?.length ?? 0, 0);
});

for (const mutation of ['missing-caller', 'foreign-generation', 'foreign-run', 'node-bound', 'parent-conflict']) test(`recovery rejects nested lineage ${mutation}`, async () => {
  const h = await fixture();
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  const r = h.state.dispatchReservations.find(r => r.nested);
  if (mutation === 'missing-caller') delete r.callerSessionId;
  if (mutation === 'foreign-generation') r.callerDispatchId = r.dispatchId;
  if (mutation === 'foreign-run') h.state.dispatchReservations[0].runId = 'foreign';
  if (mutation === 'node-bound') r.nodeId = 'owner';
  if (mutation === 'parent-conflict') h.state.dispatchReservations.push({ ...h.state.dispatchReservations[0], agent: 'graph-verifier' });
  h.state.status = 'AWAITING_USER_DECISION';
  await h.restart();
  assert.equal(h.bindings.has('image-child'), false);
  assert.ok(h.state.dispatchRecoveryIssues.length);
  assert.equal(h.dispatches.inspect('root').some(r => r.nested), false);
});

test('nested recovery persistence failure publishes no partial authority or drops evidence', async () => {
  const h = await fixture();
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  h.state.status = 'AWAITING_USER_DECISION';
  const before = structuredClone(h.state.dispatchReservations);
  h.store.saveRun = async () => { throw new Error('EIO'); };
  await assert.rejects(h.restart(), /EIO/);
  assert.equal(h.bindings.size, 0);
  assert.deepEqual(h.state.dispatchReservations, before);
});

test('recovery scans nested caller even after parent settlement and authenticates metadata parent', async () => {
  const h = await fixture();
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('root', 'owner-call', 'caller', 'graph-explorer', 'completed'));
  h.messages.set('caller', [{ parts: [h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed')] }]);
  await h.restart();
  assert.equal(h.dispatches.inspect('root').length, 0);
});

test('nested prompt anchor and terminal witness settle background work after restart', async () => {
  const h = await fixture();
  const result = await h.consult();
  h.parents.set('image-child', 'caller');
  await h.dispatches.onSession({ id: 'image-child', parentID: 'caller' });
  const part = h.part('caller', 'consult', 'image-child', 'graph-multimodal');
  part.state.metadata.background = true;
  await h.dispatches.onPart(part);
  const user = { info: { id: 'user-image', sessionID: 'image-child', role: 'user', agent: 'graph-multimodal' },
    parts: [{ type: 'text', sessionID: 'image-child', messageID: 'user-image', text: `[RUNNER_TASK_CALL:${result.turnToken}]` }] };
  await h.dispatches.onUserPrompt(user.info, user.parts);
  assert.equal(h.state.dispatchReservations.find(r => r.nested).userAnchorSource, 'chat.message');
  h.state.status = 'AWAITING_USER_DECISION';
  await h.restart();
  assert.equal(h.dispatches.inspect('root').filter(r => r.nested).length, 1);
  h.messages.set('image-child', [user, { info: { id: 'answer', sessionID: 'image-child', role: 'assistant', agent: 'graph-multimodal', parentID: 'user-image', finish: 'stop', time: { completed: 2 } }, parts: [] }]);
  await h.dispatches.onIdle('image-child', 'idle-image');
  assert.equal(h.dispatches.inspect('root').filter(r => r.nested).length, 0);
});

test('descendant lookup failure stays managed and blocks native task', async () => {
  const h = await fixture();
  await h.dispatches.onSession({ id: 'unknown-grandchild', parentID: 'missing-parent' });
  h.client.session.get = async () => { throw new Error('offline'); };
  const enforcement = createEnforcement({ settings: {}, ...h });
  await assert.rejects(enforcement.onToolBefore({ tool: 'task', sessionID: 'unknown-grandchild', callID: 'bad' }, { args: { subagent_type: 'graph-multimodal' } }), /BINDING_UNAVAILABLE/);
});

test('fully verified native ancestry remains unmanaged while malformed ancestry fails closed', async () => {
  const h = await fixture();
  h.parents.set('native-child', 'native-root');
  await h.dispatches.ensureSession('native-child');
  assert.equal(h.dispatches.managed('native-child'), false);
  h.parents.set('malformed-child', 42);
  await h.dispatches.ensureSession('malformed-child');
  assert.equal(h.dispatches.managed('malformed-child'), true);
});

test('pre-binding nested idle receipt cannot claim an unrelated root reservation', async () => {
  const h = await fixture('graph-implementer');
  await h.dispatches.admit('root', 'root-reader', { subagent_type: 'graph-explorer' });
  await h.consult();
  await h.dispatches.onSession({ id: 'image-child', parentID: 'caller' });
  await h.dispatches.onIdle('image-child', 'early-idle');
  assert.deepEqual(h.state.pendingIdleEvidence[0].owners.map(o => o.callID), ['consult']);
  h.state.status = 'AWAITING_USER_DECISION';
  await h.restart();
  assert.deepEqual(h.state.pendingIdleEvidence[0].owners.map(o => o.callID), ['consult']);
});

test('task hook rejects a descendant whose owning run is unavailable', async () => {
  const h = await fixture();
  const store = { ...h.store, getRun: () => null };
  const enforcement = createEnforcement({ settings: {}, ...h, store });
  await assert.rejects(enforcement.onToolBefore({ tool: 'task', sessionID: 'caller', callID: 'bad' }, { args: { subagent_type: 'graph-multimodal' } }), /BINDING_UNAVAILABLE/);
});

test('root cannot reuse a nested binding after its bounded settled history expires', async () => {
  const h = await fixture('graph-implementer');
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed'));
  h.state.settledDispatches = [];
  const before = structuredClone(h.state.dispatchReservations);
  assert.equal((await h.dispatches.admit('root', 'steal', { subagent_type: 'graph-multimodal', task_id: 'image-child' })).code, 'TASK_CALLER_MISMATCH');
  assert.deepEqual(h.state.dispatchReservations, before);
});

for (const cold of [false, true]) test(`root fallback rejects old nested task_id in successor run (cold=${cold})`, async () => {
  const h = await fixture('graph-implementer');
  await h.consult();
  await h.bind('caller', 'consult', 'image-child', 'graph-multimodal');
  await h.dispatches.onPart(h.part('caller', 'consult', 'image-child', 'graph-multimodal', 'completed'));
  h.dispatches.invalidate('root');
  const next = await h.store.createRun({ runId: 'root:2', rootSessionId: 'root', now: 'now' });
  h.bindings.set('root', { runId: next.runId, root: true, agent: 'graph-orchestrator' });
  const dispatches = cold ? createDispatchBindings(h) : h.dispatches;
  const before = structuredClone(next);
  const result = await dispatches.admit('root', 'stolen', { subagent_type: 'graph-multimodal', task_id: 'image-child' });
  assert.equal(result.code, 'TASK_CALLER_MISMATCH');
  assert.deepEqual(next, before);
  assert.deepEqual(dispatches.inspect(next.runId), []);
});

for (const proof of ['current-run', 'wrong-parent', 'wrong-role', 'old-run', 'lookup-error', 'missing-metadata']) {
  test(`cold free root continuation requires native current-run ownership (${proof})`, async () => {
    const h = await fixture('graph-implementer');
    await h.dispatches.admit('root', 'reader', { subagent_type: 'graph-multimodal' });
    await h.bind('root', 'reader', 'root-image', 'graph-multimodal');
    await h.dispatches.onPart(h.part('root', 'reader', 'root-image', 'graph-multimodal', 'completed'));
    h.dispatches.invalidate('root');
    h.state.settledDispatches = []; // bounded history evicted; native call + admission ledger survive
    if (proof === 'wrong-parent') h.parents.set('root-image', 'foreign');
    if (proof === 'wrong-role') h.messages.get('root').at(-1).parts[0].state.input.subagent_type = 'graph-explorer';
    if (proof === 'old-run') h.state.dispatchCallIds = [];
    if (proof === 'lookup-error') h.client.session.get = async () => { throw new Error('offline'); };
    if (proof === 'missing-metadata') h.messages.set('root', []);
    const dispatches = createDispatchBindings(h);
    const before = structuredClone(h.state);
    const result = await dispatches.admit('root', 'continue-reader', { subagent_type: 'graph-multimodal', task_id: 'root-image' });
    assert.equal(result.allowed, proof === 'current-run', JSON.stringify(result));
    if (!result.allowed) {
      assert.equal(result.code, 'TASK_CALLER_MISMATCH');
      assert.deepEqual(h.state, before);
      assert.deepEqual(dispatches.inspect('root'), []);
    }
  });
}
