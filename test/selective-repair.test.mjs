import test from 'node:test';
import assert from 'node:assert/strict';
import { newRun } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { validateTaskGraph } from '../src/task-spec.mjs';
import { createRunStore } from '../src/run-state.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createDispatchBindings } from '../src/dispatch-bindings.mjs';
import { createEnforcement } from '../src/enforcement.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exactRef, publishArtifact, repairClosure, retainedLineage, verificationFiles } from '../src/artifact-dependencies.mjs';

const now = '2026-09-21T00:00:00.000Z';
const roles = { plan: 'planner', review: 'plan-critic', implement: 'implementer', verify: 'verifier' };
const spec = (id, kind, dependsOn = [], extra = {}) => ({ id, kind, agent: `graph-${roles[kind]}`, dependsOn,
  inputs: [], outputs: [], acceptance: ['done'], ...(kind === 'implement' ? { writeScope: [`${id}.txt`] } : {}), ...extra });

function fixture(extra = [], options = {}) {
  const runner = createRunner({ maxAttempts: 4, maxPlanRevisions: 2, ...options });
  const state = newRun({ runId: 'repair', rootSessionId: 'root', now });
  const specs = [spec('p', 'plan'), spec('r', 'review', ['p']), spec('a', 'implement', ['r']),
    spec('b', 'implement', ['r']), spec('v', 'verify', ['a', 'b']), ...extra];
  const graph = validateTaskGraph(specs);
  assert.equal(graph.ok, true, JSON.stringify(graph.errors));
  assert.equal(runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now }).ok, true);
  const begin = (id) => runner.beginNode(state, id, { now, sessionId: `session-${id}`, dispatchId: `dispatch-${id}-${state.nodes[id].attempt}` });
  const change = (id) => { begin(id); assert.equal(runner.submitChange(state, { nodeId: id, filesTouched: [], summary: id, now }).ok, true); };
  const pass = (id) => { begin(id); assert.equal(runner.submitVerification(state, { nodeId: id, verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], now }).ok, true); };
  begin('r');
  runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now });
  change('a'); change('b');
  return { runner, state, begin, change, pass };
}

for (const selective of [false, true]) test(`FAIL ${selective ? 'a only preserves b exactly' : 'defaults to both direct implementations'}`, () => {
  const { runner, state, begin } = fixture();
  const b = structuredClone({ node: state.nodes.b, artifact: state.artifacts['change:b'] });
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', ...(selective ? { repairTargets: ['a'] } : {}), now });
  assert.equal(result.ok, true);
  assert.deepEqual(state.artifacts['verification:v'].payload.repairTargets, selective ? ['a'] : ['a', 'b']);
  assert.equal(state.nodes.a.state, 'PENDING');
  if (selective) assert.deepEqual({ node: state.nodes.b, artifact: state.artifacts['change:b'] }, b);
  else assert.equal(state.nodes.b.state, 'PENDING');
});

for (const repairTargets of [[], ['a', 'a'], ['missing'], ['r'], ['c'], ['a*'], ['change:a@1'], null, 'a']) {
  test(`invalid repairTargets ${JSON.stringify(repairTargets)} is atomic`, () => {
    const { runner, state, begin } = fixture([spec('c', 'implement', ['r'])]);
    begin('v');
    const before = structuredClone(state);
    const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets, now });
    assert.equal(result.code, 'INVALID_REPAIR_TARGETS');
    assert.deepEqual(state, before);
  });
}
for (const verdict of ['PASS', 'BASELINE', 'UNVERIFIED', 'bogus']) test(`repairTargets forbidden on ${verdict}`, () => {
  const { runner, state, begin } = fixture(); begin('v');
  const before = structuredClone(state);
  assert.equal(runner.submitVerification(state, { nodeId: 'v', verdict, repairTargets: ['a'], now }).code, 'INVALID_REPAIR_TARGETS');
  assert.deepEqual(state, before);
});

for (const artifactOnly of [false, true]) test(`closure crosses verifiers and ${artifactOnly ? 'artifact-only' : 'execution'} implementation consumers without reopening b`, () => {
  const { runner, state, begin, change, pass } = fixture([
    spec('v1', 'verify', ['a']), spec('v2', 'verify', ['v1', 'b']),
    spec('c', 'implement', artifactOnly ? ['r'] : ['r', 'a'], artifactOnly ? { inputs: ['change:a'] } : {}),
    spec('vc', 'verify', ['c']), spec('pending', 'verify', ['vc', 'b']),
  ]);
  pass('v1'); pass('v2'); change('c'); pass('vc'); begin('v');
  const b = structuredClone(state.nodes.b);
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.ok, true);
  for (const id of ['v1', 'v2', 'c', 'vc']) {
    assert.equal(state.nodes[id].state, 'STALE', id);
    assert.notEqual(state.artifacts[`${id === 'c' ? 'change' : 'verification'}:${id}`].status, 'valid');
  }
  assert.equal(state.nodes.pending.state, 'PENDING');
  assert.deepEqual(state.nodes.b, b);
  assert.equal(runner.admitDispatch(state, { agent: 'graph-implementer', nodeId: 'a', now }).repairEvidence.verifier, 'v');
  assert.equal(runner.admitDispatch(state, { agent: 'graph-implementer', nodeId: 'b', now }).repairEvidence, undefined);
});

test('repair finishes using only affected new attempts, without a no-op b submission', () => {
  const { runner, state, begin, change, pass } = fixture();
  begin('v');
  runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  change('a'); pass('v');
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.nodes.b.attempt, 1);
  assert.equal(state.artifacts['change:b'].version, 1);
  assert.equal(state.artifacts['change:a'].version, 2);
  assert.equal(state.nodes.v.attempt, 1);
});

test('obsolete explicit pin requires actionable replan and remains authored', () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'], { inputs: ['change:a@1'] })]);
  change('c'); begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
  assert.ok(result.offendingRefs.includes('change:a@1'));
  assert.deepEqual(state.nodes.c.spec.inputs, ['change:a@1']);
  assert.equal(state.status, 'RUNNING');
  assert.equal(runner.admitDispatch(state, { agent: 'graph-planner', now }).allowed, true);
  assert.equal(runner.admitDispatch(state, { agent: 'graph-implementer', nodeId: 'a', now }).code, 'PLAN_REVISION_REQUIRED');
});

test('global repair exhaustion preserves effective targets and invalidation evidence', () => {
  const { runner, state, begin } = fixture([], { maxAttempts: 1 }); begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.effect, 'await-decision');
  assert.equal(state.status, 'AWAITING_USER_DECISION');
  assert.equal(state.revisionCounters['implement-verify'], 1);
  assert.equal(state.nodes.v.attempt, 1, 'exhausted verdict retains the actual final attempt');
  assert.deepEqual(state.artifacts['verification:v'].payload.repairTargets, ['a']);
  assert.notEqual(state.artifacts['change:a'].status, 'valid');
  assert.equal(state.artifacts['change:b'].status, 'valid');
  const before = structuredClone(state);
  runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.deepEqual(state, before);
});

async function publicFixture(t, { failSave = () => false, cInput = 'change:a' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'selective-repair-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const backing = createRunStore({ worktree: dir });
  const state = await backing.createRun({ runId: 'repair', rootSessionId: 'root', now });
  const f = fixture([spec('c', 'implement', ['r'], { inputs: [cInput] }), spec('d', 'implement', ['r'])]);
  Object.assign(state, f.state);
  // Model a delivered node whose host is still alive by dispatching a first,
  // then delivering through the real public tool.
  state.nodes.a.state = 'PENDING'; state.nodes.a.attempt = 0;
  delete state.artifacts['change:a'];
  const store = { ...backing, saveRun: async (candidate) => {
    if (failSave()) { candidate.updatedAt = 'unsaved'; throw new Error('injected EIO'); }
    return backing.saveRun(candidate);
  } };
  const bindings = new Map([['root', { root: true, runId: 'repair', agent: 'graph-orchestrator' }]]);
  const dispatches = createDispatchBindings({ store, runner: f.runner, bindings });
  const enforcement = createEnforcement({ settings: { worktree: dir }, store, runner: f.runner, bindings, dispatches });
  const tools = createSubmitTools({ store, runner: f.runner, bindings, worktree: dir, dispatches }).tools;
  let sequence = 0;
  async function bind(id, taskId) {
    const callID = `call-${++sequence}`;
    const args = { subagent_type: state.nodes[id].spec.agent, prompt: `[nodeId:${id}]\nWork`, ...(taskId ? { task_id: taskId } : {}) };
    const admitted = await dispatches.admit('root', callID, args);
    if (!admitted.allowed) return admitted;
    const sessionId = taskId ?? `child-${id}-${sequence}`;
    await dispatches.onSession({ id: sessionId, parentID: 'root' });
    await dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID,
      state: { status: 'running', input: args, metadata: { parentSessionId: 'root', sessionId } } });
    assert.equal(bindings.get(sessionId)?.nodeId, id);
    return { allowed: true, sessionId, callID, args };
  }
  const context = (call) => ({ sessionID: call.sessionId, agent: call.args.subagent_type });
  const a = await bind('a');
  assert.equal(JSON.parse(await tools.graph_submit_change.execute({ nodeId: 'a', filesTouched: [], summary: 'a' }, context(a))).ok, true);
  const c = await bind('c'); const d = await bind('d'); const v = await bind('v');
  const submit = (args = {}) => tools.graph_submit_verification.execute({ nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], ...args }, context(v)).then(JSON.parse);
  return { state, store, runner: f.runner, bindings, dispatches, enforcement, tools, bind, a, c, d, v, submit,
    disk: () => readFile(join(dir, '.opencode-loop/runs/repair.json'), 'utf8') };
}

test('public selective revocation fences affected RUNNING and host-alive SUCCEEDED attempts, unrelated live sibling continues', async (t) => {
  const h = await publicFixture(t);
  const d = h.bindings.get(h.d.sessionId);
  h.state.pendingEffects = [{ nodeId: 'a', sessionId: h.a.sessionId, dispatchId: h.state.nodes.a.dispatchId, callID: 'old-edit', tool: 'edit', target: 'a.txt' }];
  assert.equal((await h.submit()).ok, true);
  assert.equal(h.runner.inspect(h.state).nodes.find((node) => node.id === 'a').ready, false);
  assert.equal(h.state.nodes.c.state, 'STALE');
  for (const call of [h.a, h.c, h.v]) {
    assert.equal(h.dispatches.current(h.bindings.get(call.sessionId)), false);
    assert.equal(h.bindings.get(call.sessionId).settlementOnly, true);
    assert.equal(h.dispatches.owns(h.bindings.get(call.sessionId)), true, 'lifetime identity is retained');
  }
  assert.equal(h.dispatches.current(d), true);
  for (const taskId of [undefined, h.a.sessionId]) assert.equal((await h.bind('a', taskId)).code, 'REPAIR_SETTLEMENT_PENDING');
  const old = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'a', filesTouched: [], summary: 'late' }, { sessionID: h.a.sessionId, agent: 'graph-implementer' }));
  assert.equal(old.ok, false);
  // Host terminal evidence alone cannot release an outstanding tool effect.
  await h.dispatches.onPart({ type: 'tool', tool: 'task', sessionID: 'root', callID: h.a.callID, state: { status: 'completed' } });
  assert.equal((await h.bind('a')).code, 'REPAIR_SETTLEMENT_PENDING');
  h.state.pendingEffects = [];
  assert.equal((await h.bind('a', h.a.sessionId)).allowed, true);
  assert.equal(h.dispatches.current(d), true);
});

for (const failure of ['EIO', 'capacity']) test(`public FAIL ${failure} rolls back state, disk, bindings and private reservations`, async (t) => {
  let offline = false;
  const h = await publicFixture(t, { failSave: () => offline });
  if (failure === 'capacity') { h.state.padding = 'x'.repeat(525000); await h.store.saveRun(h.state); }
  const before = structuredClone(h.state);
  const bindings = structuredClone(h.bindings);
  const disk = await h.disk();
  offline = failure === 'EIO';
  let result;
  try { result = await h.submit(); } catch (error) { result = { ok: false, detail: error.message }; }
  assert.equal(result.ok, false);
  assert.deepEqual(h.state, before);
  assert.deepEqual(h.bindings, bindings);
  assert.equal(await h.disk(), disk);
  offline = false;
  if (failure === 'capacity') delete h.state.padding;
  await h.dispatches.onIdle(h.d.sessionId, 'flush-private-ledger');
  assert.ok(h.state.dispatchReservations.every((r) => !r.settlementOnly));
  assert.equal((await h.submit()).ok, true);
});

test('public invalid semantic targets and schema targets never persist or mutate', async (t) => {
  const h = await publicFixture(t);
  const before = structuredClone(h.state); const disk = await h.disk();
  for (const targets of [[], ['a', 'a'], ['c'], ['v'], ['unknown'], ['a*'], null]) {
    assert.equal((await h.submit({ repairTargets: targets })).code, 'INVALID_REPAIR_TARGETS');
    assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  }
  for (const targets of [[], ['a', 'a'], ['a*']]) assert.equal(h.tools.graph_submit_verification.args.repairTargets.safeParse(targets).success, false);
});

for (const viaHistory of [true, false]) test(`ordinary historical publication stays legal; repair follows exact ${viaHistory ? 'transitive' : 'independent'} consumed lineage`, () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'], { inputs: [] }), spec('vc', 'verify', ['c'])]);
  publishArtifact(state, 'verification:history', { kind: 'verification', nodeId: 'historical', version: 1,
    basedOn: viaHistory ? ['change:a@1'] : [], payload: { summary: 'not retained in lineage' }, status: 'valid' });
  state.nodes.c.spec.inputs = ['verification:history'];
  change('c');
  assert.ok(state.nodes.c.consumedRefs.includes('verification:history@1'));
  publishArtifact(state, 'verification:history', { kind: 'verification', nodeId: 'historical', version: 2,
    basedOn: [], payload: {}, status: 'valid' });
  assert.equal(state.nodes.c.state, 'SUCCEEDED');
  assert.equal(state.artifacts['change:c'].status, 'valid');
  assert.deepEqual(state.artifactLineage['verification:history@1'].basedOn, viaHistory ? ['change:a@1'] : []);
  assert.equal(state.artifactLineage['verification:history@1'].payload, undefined);
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, false);
  assert.equal(state.nodes.c.state, viaHistory ? 'STALE' : 'SUCCEEDED');
  assert.equal(state.artifacts['verification:history'].status, 'valid', 'exact historical version only');
});

test('failing current a@2 does not invalidate an independent already-consumed a@1', () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'], { inputs: ['change:a'] })]);
  change('c');
  state.nodes.a.state = 'PENDING';
  change('a'); // ordinary publication, with no semantic invalidation
  assert.equal(state.nodes.c.state, 'SUCCEEDED');
  const c = structuredClone(state.nodes.c);
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, false);
  assert.deepEqual(state.nodes.c, c);
  assert.equal(state.artifacts['change:c'].status, 'valid');
  assert.equal(state.artifactLineage['change:a@1'].status, 'valid');
});

test('artifact basedOn closure invalidates approval and requires a new plan, never reuses stale approval', () => {
  const { runner, state, begin } = fixture();
  // Historical plan provenance can connect approval to repaired evidence.
  state.artifacts.plan.basedOn = ['change:a@1'];
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
  assert.ok(result.offendingRefs.includes('plan@1'));
  assert.ok(result.offendingRefs.includes('review@1'));
  assert.equal(state.artifacts.review.status, 'stale');
  assert.equal(state.status, 'RUNNING');
  assert.equal(runner.admitDispatch(state, { agent: 'graph-plan-critic', nodeId: 'r', now }).code, 'PLAN_REVISION_REQUIRED');
  assert.equal(runner.admitDispatch(state, { agent: 'graph-planner', now }).allowed, true);
});

test('legacy missing historical lineage is an explicit replan blocker rather than assumed independence', () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'])]);
  change('c');
  delete state.nodes.c.consumedRefs;
  state.artifacts['change:c'].basedOn = ['verification:missing@1'];
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
  assert.ok(result.offendingRefs.includes('verification:missing@1'));
});

test('provenance publication capacity is atomic and referenced history is never silently discarded', () => {
  const { state } = fixture();
  state.padding = 'x'.repeat(525000);
  const before = structuredClone(state);
  assert.throws(() => publishArtifact(state, 'change:a', { ...state.artifacts['change:a'], version: 2 }), /byte|capacity|size/i);
  assert.deepEqual(state, before);
});

test('provenance traversal is bounded, iterative and visits each edge source once', () => {
  const { state } = fixture();
  let ref = 'change:a@1';
  for (let i = 0; i < 300; i++) {
    const next = `verification:h${i}@1`;
    (state.artifactLineage ??= {})[next] = { basedOn: [ref], status: 'valid' };
    ref = next;
  }
  state.nodes.b.consumedRefs = [ref];
  const retained = retainedLineage(state);
  assert.equal(Object.keys(retained).length, 300);
  let reads = 0;
  for (const entry of Object.values(state.artifactLineage)) {
    const basedOn = entry.basedOn;
    Object.defineProperty(entry, 'basedOn', { get() { reads++; return basedOn; } });
  }
  const closure = repairClosure(state, ['a'], 'v');
  assert.ok(closure.nodeIds.includes('b'));
  assert.ok(reads <= 300, `repeated provenance scans: ${reads}`);
  state.nodes.b.consumedRefs = [];
  assert.deepEqual(retainedLineage(state), {}, 'unreferenced historical edges are pruned');
});

test('public rejection streak changes persist transactionally, including the repeated-rejection pause', async (t) => {
  let offline = false;
  const h = await publicFixture(t, { failSave: () => offline });
  const before = structuredClone(h.state); const disk = await h.disk();
  offline = true;
  await assert.rejects(h.submit({ verdict: 'PASS', repairTargets: undefined }), /EIO/);
  assert.deepEqual(h.state, before); assert.equal(await h.disk(), disk);
  offline = false;
  assert.equal((await h.submit({ verdict: 'PASS', repairTargets: undefined })).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(h.state.nodes.v.rejectionStreak.count, 1);
  assert.equal(JSON.parse(await h.disk()).nodes.v.rejectionStreak.count, 1);
  assert.equal((await h.submit({ verdict: 'PASS', repairTargets: undefined })).code, 'REJECTION_LOOP');
  assert.equal(JSON.parse(await h.disk()).status, 'AWAITING_USER_DECISION');
});

test('old affected tool callbacks keep original exact effect provenance and cannot regain execution authority', async (t) => {
  const h = await publicFixture(t);
  const identity = { sessionID: h.c.sessionId, callID: 'old-c-edit', tool: 'edit' };
  const args = { filePath: 'c.txt', oldString: 'old', newString: 'new' };
  await h.enforcement.onToolBefore(identity, { args });
  const old = structuredClone(h.state.pendingEffects[0]);
  await h.submit();
  await assert.rejects(h.enforcement.onToolBefore({ ...identity, callID: 'new-c-edit' }, { args }), /BINDING_UNAVAILABLE/);
  await h.enforcement.onToolAfter({ ...identity, args }, {});
  const effect = h.state.sideEffects.find((e) => e.callID === identity.callID);
  for (const key of ['nodeId', 'sessionId', 'dispatchId', 'callID', 'tool', 'target']) assert.equal(effect[key], old[key], key);
  assert.equal(h.state.nodes.c.state, 'STALE');
  assert.equal(h.dispatches.current(h.bindings.get(h.c.sessionId)), false);
  await h.enforcement.onToolAfter({ ...identity, args }, {});
  assert.equal(h.state.sideEffects.filter((e) => e.callID === identity.callID).length, 1);
});

test('PASS binds admission versions even when a consumed unpinned dependency slot is ordinarily republished mid-attempt', () => {
  const { runner, state, begin } = fixture(); begin('v');
  publishArtifact(state, 'change:a', { ...state.artifacts['change:a'], version: 2 });
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], now });
  assert.equal(result.ok, true);
  assert.ok(state.artifacts['verification:v'].basedOn.includes('change:a@1'));
  assert.ok(!state.artifacts['verification:v'].basedOn.includes('change:a@2'));
});

test('pure begin cannot bypass the invalidated-approval replan requirement', () => {
  const { runner, state, begin } = fixture(); state.artifacts.plan.basedOn = ['change:a@1']; begin('v');
  runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  const before = structuredClone(state);
  assert.throws(() => begin('a'), /revis.*plan|plan.*revis/i);
  assert.deepEqual(state, before);
});

test('ordinary verification replacement retains valid already-consumed history', () => {
  const { runner, state, begin, pass, change } = fixture([spec('v1', 'verify', ['a']),
    spec('c', 'implement', ['r'], { inputs: ['verification:v1'] }), spec('vc', 'verify', ['c'])]);
  pass('v1'); change('c');
  state.nodes.v1.state = 'PENDING'; pass('v1');
  assert.equal(state.artifactLineage['verification:v1@1'].status, 'valid');
  begin('vc');
  assert.equal(runner.submitVerification(state, { nodeId: 'vc', verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], now }).ok, true);
});

test('affected consumers retain repair guidance after the failing verifier publishes a newer PASS', () => {
  const { runner, state, begin, change, pass } = fixture([spec('c', 'implement', ['r'], { inputs: ['change:a'] })]);
  change('c'); begin('v');
  runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], summary: 'repair the edge case', now });
  change('a'); pass('v');
  assert.equal(state.status, 'RUNNING');
  const admitted = runner.admitDispatch(state, { agent: 'graph-implementer', nodeId: 'c', now });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.repairEvidence?.summary, 'repair the edge case');
});

test('plan basedOn captures the actually consumed unpinned version', () => {
  const { runner, state } = fixture();
  state.artifacts.findings = { kind: 'findings', nodeId: 'historical', version: 7, basedOn: [], payload: {}, status: 'valid' };
  const nodes = new Map(Object.values(state.nodes).map((node) => [node.spec.id, node.spec]));
  assert.equal(runner.submitPlan(state, { intent: 'change', nodes, basedOn: ['findings'], now }).ok, true);
  assert.deepEqual(state.artifacts.plan.basedOn, ['findings@7']);
});

test('public verification snapshots include transitive artifact-only implementation evidence', async (t) => {
  const h = await publicFixture(t);
  // c is a running artifact-only consumer of a. Complete it, then verify c
  // through v without a as a direct execution dependency.
  h.state.artifacts['change:a'].payload.filesTouched = ['a.txt'];
  h.runner.submitChange(h.state, { nodeId: 'c', filesTouched: [], summary: 'c', now });
  h.state.nodes.v.spec.dependsOn = ['c', 'b'];
  h.state.nodes.v.consumedRefs = ['change:c@1', 'change:b@1', 'review@1'];
  const result = await h.submit({ verdict: 'PASS', repairTargets: undefined, commands: [{ command: 'test', exitCode: 0 }] });
  assert.equal(result.ok, true);
  assert.equal(h.state.artifacts['verification:v'].snapshot['a.txt'], 'MISSING');
});

test('public findings replacement retains consumed provenance without retaining old payloads', async (t) => {
  const h = await publicFixture(t);
  h.bindings.set('reader', { runId: 'repair', agent: 'graph-explorer', active: true });
  const tools = createSubmitTools({ store: h.store, runner: h.runner, bindings: h.bindings }).tools;
  const context = { sessionID: 'reader', agent: 'graph-explorer' };
  await tools.graph_submit_findings.execute({ summary: 'first' }, context);
  h.state.nodes.d.consumedRefs.push('findings@1');
  await tools.graph_submit_findings.execute({ summary: 'second' }, context);
  assert.deepEqual(h.state.artifactLineage['findings@1'], { basedOn: [], status: 'valid' });
});

test('resume cannot erase selective-repair lifetime fences', async (t) => {
  const h = await publicFixture(t); await h.submit();
  const before = structuredClone(h.state);
  const result = JSON.parse(await h.tools.graph_run_resume.execute({}, { sessionID: 'root', agent: 'graph-orchestrator' }));
  assert.equal(result.code, 'REPAIR_SETTLEMENT_PENDING');
  assert.deepEqual(h.state, before);
  assert.equal((await h.bind('a')).code, 'REPAIR_SETTLEMENT_PENDING');
});

test('legacy unpinned consumers with no admission provenance cannot be assumed independent', () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'])]);
  // Install a legacy current artifact and a completed consumer without exact
  // admission refs, whose old unpinned input was subsequently overwritten.
  state.artifacts['verification:old'] = { kind: 'verification', version: 2, nodeId: 'old', basedOn: [], status: 'valid', payload: {} };
  state.nodes.c.spec.inputs = ['verification:old'];
  change('c'); delete state.nodes.c.consumedRefs;
  state.artifacts['change:c'].basedOn = ['review@1'];
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
});

for (const pin of [false, true]) test(`affected historical input without a future producer requires replan (pin=${pin})`, () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'])]);
  publishArtifact(state, 'verification:old', { kind: 'verification', nodeId: 'old', version: 1,
    basedOn: ['change:a@1'], status: 'valid', payload: {} });
  state.nodes.c.spec.inputs = [pin ? 'verification:old@1' : 'verification:old'];
  change('c'); begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
  assert.ok(result.offendingRefs.includes(pin ? 'verification:old@1' : 'verification:old'));
});

test('repairTargets is forbidden on a baseline FAIL without changing rejection streak', () => {
  const { runner, state, begin } = fixture(); begin('v'); state.nodes.v.spec.baseline = true;
  const before = structuredClone(state);
  assert.equal(runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now }).code, 'INVALID_REPAIR_TARGETS');
  assert.deepEqual(state, before);
});

test('provenance reference capacity rejects atomically instead of dropping a referenced chain', () => {
  const { runner, state, begin } = fixture(); begin('v');
  let ref = 'change:a@1';
  for (let i = 0; i < 1025; i++) {
    const next = `verification:history-${i}@1`;
    state.artifactLineage[next] = { basedOn: [ref], status: 'valid' };
    ref = next;
  }
  state.nodes.b.consumedRefs = [ref];
  const before = structuredClone(state);
  assert.throws(() => retainedLineage(state), /capacity/i);
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.code, 'PROVENANCE_CAPACITY');
  assert.match(result.detail, /revise.*plan|capacity/i);
  assert.deepEqual(state, before);
});

test('beginNode uses the admission resolver and cannot record a different version for an unavailable explicit pin', () => {
  const { state, begin } = fixture([spec('c', 'implement', ['r'])]);
  state.nodes.c.spec.inputs = ['change:a@99'];
  const before = structuredClone(state);
  assert.throws(() => begin('c'), /change:a@99.*current version/);
  assert.deepEqual(state, before);
});

for (const completed of [false, true]) test(`alias pin: pure ${completed ? 'completed' : 'RUNNING'} artifact-only consumer is invalidated`, () => {
  const { runner, state, begin, change } = fixture([spec('c', 'implement', ['r'], { inputs: ['change:a@01'] })]);
  if (completed) change('c'); else begin('c');
  begin('v');
  const b = structuredClone(state.nodes.b);
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.ok, true);
  assert.equal(state.nodes.c.state, 'STALE', 'a replan diagnostic must not substitute for actual invalidation');
  if (completed) assert.equal(state.artifacts['change:c'].status, 'stale');
  assert.ok(state.nodes.c.consumedRefs.includes('change:a@1'));
  assert.deepEqual(state.nodes.c.spec.inputs, ['change:a@01']);
  assert.ok(result.offendingRefs.includes('change:a@01'), 'diagnostics preserve the authored pin');
  assert.deepEqual(state.nodes.b, b);
});

for (const completed of [false, true]) test(`alias pin: public ${completed ? 'completed' : 'RUNNING'} consumer loses authority and retains its lifetime`, async (t) => {
  const h = await publicFixture(t, { cInput: 'change:a@01' });
  const binding = h.bindings.get(h.c.sessionId);
  assert.equal(h.dispatches.current(binding), true);
  if (completed) assert.equal(JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'c', filesTouched: [], summary: 'consumed alias' },
    { sessionID: h.c.sessionId, agent: 'graph-implementer' })).ok, true);
  const d = structuredClone(h.state.nodes.d);
  const result = await h.submit();
  assert.equal(result.ok, true);
  assert.equal(h.state.nodes.c.state, 'STALE');
  assert.equal(h.dispatches.current(binding), false);
  assert.equal(binding.settlementOnly, true);
  assert.equal(h.dispatches.owns(binding), true);
  if (completed) assert.equal(h.state.artifacts['change:c'].status, 'stale');
  assert.deepEqual(h.state.nodes.c.spec.inputs, ['change:a@01']);
  assert.ok(h.state.nodes.c.consumedRefs.includes('change:a@1'));
  assert.deepEqual(h.state.nodes.d, d);
  assert.equal(h.dispatches.current(h.bindings.get(h.d.sessionId)), true);
  assert.equal(JSON.parse(await h.disk()).nodes.c.state, 'STALE');
});

for (const path of ['current', 'historical-canonical-key', 'historical-alias-key']) {
  test(`alias pin: persisted legacy aliases across restart follow ${path} provenance`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'repair-alias-restart-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = createRunStore({ worktree: dir });
    const f = fixture([spec('c', 'implement', ['r']), spec('vc', 'verify', ['c'])]);
    const { runner, state, begin, change, pass } = f;
    state.artifacts['verification:bridge'] = { kind: 'verification', nodeId: 'old', version: 1,
      basedOn: ['change:a@01'], status: 'valid', payload: {} };
    state.nodes.c.spec.inputs = ['verification:bridge@01'];
    change('c'); pass('vc'); begin('v');
    // Recreate a saved pre-fix run: aliases can occur in every provenance field.
    state.nodes.c.consumedRefs = ['verification:bridge@0001', 'review@01'];
    state.nodes.c.producedRef = 'change:c@01';
    state.artifacts['change:c'].basedOn = ['verification:bridge@01', 'review@01'];
    state.artifacts['verification:audit'] = { kind: 'verification', nodeId: 'old-audit', version: 1,
      basedOn: ['change:a@0001'], status: 'valid', payload: {} };
    if (path !== 'current') {
      state.artifactLineage[path === 'historical-alias-key' ? 'verification:bridge@01' : 'verification:bridge@1'] = {
        basedOn: ['change:a@001'], status: 'valid',
      };
      state.artifacts['verification:bridge'] = { ...state.artifacts['verification:bridge'], version: 2, basedOn: [] };
    }
    await store.createRun({ runId: state.runId, rootSessionId: 'root', now });
    await store.saveRun(state);
    const restored = await createRunStore({ worktree: dir }).loadRun(state.runId);
    const b = structuredClone(restored.nodes.b);
    const result = runner.submitVerification(restored, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
    assert.equal(result.ok, true);
    for (const id of ['c', 'vc']) assert.equal(restored.nodes[id].state, 'STALE', id);
    for (const name of ['change:c', 'verification:vc', 'verification:audit']) assert.equal(restored.artifacts[name].status, 'stale', name);
    if (path !== 'current') {
      assert.equal(restored.artifacts['verification:bridge'].status, 'valid', 'independent v2 is not the affected v1');
      assert.equal(restored.artifactLineage['verification:bridge@1'].status, 'stale');
    }
    assert.deepEqual(restored.nodes.c.spec.inputs, ['verification:bridge@01']);
    assert.deepEqual(restored.nodes.b, b);
  });
}

test('alias pin: retained historical keys and sources normalize without losing referenced lineage', () => {
  const { state } = fixture();
  state.artifactLineage['verification:old@01'] = { basedOn: ['change:a@001'], status: 'valid' };
  state.nodes.b.consumedRefs = ['verification:old@0001'];
  assert.deepEqual(retainedLineage(state), { 'verification:old@1': { basedOn: ['change:a@1'], status: 'valid' } });
  state.artifacts['change:a'].payload.filesTouched = ['a.txt'];
  assert.ok(verificationFiles(state, state.nodes.b).includes('a.txt'));
});

test('alias pin: equivalent spellings normalize but distinct obsolete/future versions never repin', () => {
  const { state, begin, change } = fixture([spec('c', 'implement', ['r'], { inputs: ['change:a@01'] })]);
  change('c');
  state.nodes.a.state = 'PENDING'; change('a');
  assert.equal(exactRef(state, 'change:a@01'), 'change:a@1');
  assert.equal(exactRef(state, 'change:a@03'), 'change:a@3');
  assert.equal(exactRef(state, 'change:a'), 'change:a@2');
  state.nodes.c.state = 'PENDING';
  const before = structuredClone(state);
  assert.throws(() => begin('c'), /change:a@01.*current version/);
  assert.deepEqual(state, before);
});

test('alias pin: PASS accepts consumed historical aliases but never revives invalidated alias evidence', () => {
  for (const status of ['valid', 'stale']) {
    const { runner, state, begin } = fixture();
    state.artifacts['verification:old'] = { kind: 'verification', nodeId: 'old', version: 1, basedOn: [], status: 'valid', payload: {} };
    state.nodes.v.spec.inputs = ['verification:old@01']; begin('v');
    state.nodes.v.consumedRefs = ['verification:old@0001', 'change:a@01', 'change:b@1', 'review@01'];
    state.artifacts['verification:old'] = { ...state.artifacts['verification:old'], version: 2 };
    state.artifactLineage['verification:old@001'] = { basedOn: [], status };
    const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], now });
    assert.equal(result.ok, status === 'valid', JSON.stringify(result));
    if (status === 'valid') assert.ok(state.artifacts['verification:v'].basedOn.includes('verification:old@1'));
    else assert.equal(result.code, 'STALE_CHANGE');
    assert.deepEqual(state.nodes.v.spec.inputs, ['verification:old@01']);
  }
});

test('alias pin: duplicate historical spellings cannot hide edges or restore validity', () => {
  const { state } = fixture();
  state.artifactLineage['verification:old@1'] = { basedOn: ['change:a@01'], status: 'stale' };
  state.artifactLineage['verification:old@01'] = { basedOn: [], status: 'valid' };
  state.nodes.b.consumedRefs = ['verification:old@001'];
  assert.deepEqual(retainedLineage(state)['verification:old@1'], { basedOn: ['change:a@1'], status: 'stale' });
  assert.ok(repairClosure(state, ['a'], 'v').nodeIds.includes('b'));
});

function legacyPinnedConsumer(pin, { history = 'missing' } = {}) {
  const f = fixture([spec('c', 'implement', ['r']), spec('vc', 'verify', ['c'])]);
  const { state, begin, change } = f;
  state.artifacts['verification:old'] = { kind: 'verification', nodeId: 'old', version: 1,
    basedOn: history === 'independent' ? [] : ['change:a@1'], status: 'valid', payload: {} };
  state.nodes.c.spec.inputs = [pin];
  change('c');
  // The legacy publisher recorded only approval, not its explicit consumption.
  delete state.nodes.c.consumedRefs;
  delete state.nodes.c.producedRef;
  state.artifacts['change:c'].basedOn = ['review@1'];
  state.artifacts['verification:old'] = { ...state.artifacts['verification:old'], version: 2, basedOn: [] };
  if (history !== 'missing') state.artifactLineage['verification:old@1'] = {
    basedOn: history === 'independent' ? [] : ['change:a@1'], status: history === 'invalid' ? 'stale' : 'valid',
  };
  begin('v');
  return f;
}

for (const pin of ['verification:old@1', 'verification:old@01']) {
  test(`legacy explicit provenance: missing ${pin} blocks repair progress and final success`, () => {
    const { runner, state, begin } = legacyPinnedConsumer(pin);
    const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
    assert.equal(result.ok, true);
    assert.equal(result.needsPlanRevision, true);
    assert.ok(result.offendingRefs.includes(pin));
    assert.equal(runner.inspect(state).needsPlanRevision, true);
    assert.equal(state.status, 'RUNNING');
    assert.deepEqual(state.nodes.c.spec.inputs, [pin]);
    assert.equal(runner.admitDispatch(state, { agent: 'graph-planner', now }).allowed, true);
    for (const id of ['a', 'v', 'vc']) {
      assert.equal(runner.admitDispatch(state, { agent: state.nodes[id].spec.agent, nodeId: id, now }).code, 'PLAN_REVISION_REQUIRED');
      assert.throws(() => begin(id), /revised plan/);
    }
    assert.equal(state.nodes.c.attempt, 1);
    assert.equal(state.artifacts['change:c'].version, 1);
    assert.notEqual(state.status, 'SUCCEEDED');
  });

  test(`legacy explicit provenance: known independent history for ${pin} remains usable`, () => {
    const { runner, state, begin, change, pass } = legacyPinnedConsumer(pin, { history: 'independent' });
    const c = structuredClone({ node: state.nodes.c, artifact: state.artifacts['change:c'] });
    const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
    assert.equal(result.needsPlanRevision, false);
    change('a'); pass('v'); pass('vc');
    assert.equal(state.status, 'SUCCEEDED');
    assert.deepEqual({ node: state.nodes.c, artifact: state.artifacts['change:c'] }, c);
  });
}

test('legacy explicit provenance: known affected history still invalidates the completed consumer', () => {
  const { runner, state } = legacyPinnedConsumer('verification:old@01', { history: 'affected' });
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.ok, true);
  assert.equal(state.nodes.c.state, 'STALE');
  assert.equal(state.artifacts['change:c'].status, 'stale');
});

test('legacy explicit provenance: invalid retained history is not proof of independence', () => {
  const { runner, state } = legacyPinnedConsumer('verification:old@01', { history: 'invalid' });
  state.artifactLineage['verification:old@1'].basedOn = [];
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, true);
  assert.ok(result.offendingRefs.includes('verification:old@01'));
});

test('legacy explicit provenance: never-started future pins are not treated as missing consumed history', () => {
  const { runner, state, begin, change, pass } = fixture([spec('c', 'implement', ['r']), spec('vc', 'verify', ['c'])]);
  state.nodes.c.spec.inputs = ['change:a@02'];
  begin('v');
  const result = runner.submitVerification(state, { nodeId: 'v', verdict: 'FAIL', repairTargets: ['a'], now });
  assert.equal(result.needsPlanRevision, false);
  assert.equal(state.nodes.c.state, 'PENDING');
  assert.equal(state.nodes.c.attempt, 0);
  change('a'); change('c'); pass('v'); pass('vc');
  assert.equal(state.status, 'SUCCEEDED');
  assert.deepEqual(state.nodes.c.spec.inputs, ['change:a@02']);
});

test('legacy explicit provenance: an outstanding persisted replan blocker prevents last-verifier completion', () => {
  const { runner, state, begin, pass } = fixture([spec('c', 'implement', ['r']), spec('vc', 'verify', ['b'])]);
  // Model a persisted blocker with other work already delivered: final evidence
  // may settle, but node success alone must never override the run-level blocker.
  state.nodes.c.state = 'SUCCEEDED';
  pass('v'); begin('vc');
  state.repairPlanRevision = { needsPlanRevision: true, offendingRefs: ['verification:old@01'], detail: 'submit a revised plan' };
  const result = runner.submitVerification(state, { nodeId: 'vc', verdict: 'PASS', commands: [{ command: 'test', exitCode: 0 }], now });
  assert.equal(result.ok, true);
  assert.equal(state.status, 'RUNNING');
  assert.equal(runner.inspect(state).needsPlanRevision, true);
  assert.equal(runner.admitDispatch(state, { agent: 'graph-planner', now }).allowed, true);
});
