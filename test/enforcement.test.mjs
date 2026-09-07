import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { createSubmitTools } from '../src/submit.mjs';
import { createEnforcement } from '../src/enforcement.mjs';

const SPECS = [
  { id: 'explore-1', kind: 'explore', agent: 'graph-explorer', dependsOn: [], inputs: [], outputs: [], acceptance: ['evidence'] },
  { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: ['explore-1'], inputs: [], outputs: [], acceptance: ['plan'] },
  { id: 'review-1', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['plan-1'], inputs: [], outputs: [], acceptance: ['review'] },
  { id: 'impl-1', kind: 'implement', agent: 'graph-implementer', dependsOn: ['review-1'], inputs: [], outputs: [], writeScope: ['src/a.ts'], acceptance: ['fix'] },
  { id: 'verify-1', kind: 'verify', agent: 'graph-verifier', dependsOn: ['impl-1'], inputs: [], outputs: [], acceptance: ['verify'] },
];

function harness(worktree) {
  const store = createRunStore({ worktree, stateDirectory: '.opencode-loop' });
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 2 });
  const bindings = new Map();
  const enforcement = createEnforcement({ settings: { worktree }, store, runner, bindings });
  const { tools } = createSubmitTools({ store, runner, bindings, worktree });
  return { store, runner, bindings, enforcement, tools };
}

async function startRun(h) {
  await h.enforcement.onChatMessage({ sessionID: 'root', agent: 'graph-orchestrator' });
}
async function dispatch(h, agent, { prompt = `work for ${agent}` } = {}) {
  const output = { args: { description: `dispatch ${agent}`, prompt, subagent_type: agent } };
  await h.enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID: `call-${agent}-${Math.random().toString(36).slice(2)}` }, output);
  return output;
}
async function bindChild(h, sessionId, agent) {
  await h.enforcement.onEvent({ event: { type: 'session.created', properties: { info: { id: sessionId, parentID: 'root' } } } });
  assert.equal(h.bindings.get(sessionId)?.agent, agent, `child ${sessionId} should bind to ${agent}`);
}
async function childIdle(h, sessionId) {
  await h.enforcement.onEvent({ event: { type: 'session.idle', properties: { sessionID: sessionId } } });
}
function ctx(h, sessionId, agent) {
  return { sessionID: sessionId, messageID: 'm1', agent, directory: '/w', worktree: '/w', abort: new AbortController().signal, metadata() {}, ask: async () => {} };
}

test('full gated flow: plan → FAIL terminates; blocked dispatch is rewritten as RUNNER_REJECTED', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  const plannerDispatch = await dispatch(h, 'graph-planner');
  assert.ok(!('code' in plannerDispatch) || !plannerDispatch.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const verdict = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['missing error path'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.effect, 'run-failed');

  const blocked = await dispatch(h, 'graph-implementer');
  assert.match(blocked.args.prompt, /RUNNER_REJECTED/);
  assert.match(blocked.args.prompt, /RUN_TERMINATED/);
  const state = h.store.getRun('root');
  assert.equal(state.status, 'FAILED');
  assert.ok(state.violations.some((entry) => entry.kind === 'gate-blocked-dispatch'));
});

test('implementer cannot be dispatched before review PASS; verifier evidence gates apply end to end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  const early = await dispatch(h, 'graph-implementer');
  assert.match(early.args.prompt, /RUNNER_REJECTED/);
  assert.match(early.args.prompt, /NO_READY_NODE/);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const pass = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(pass.ok, true);

  const impl = await dispatch(h, 'graph-implementer');
  assert.ok(!impl.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-impl', 'graph-implementer');
  assert.equal(h.bindings.get('child-impl').nodeId, 'impl-1');

  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'fixed auth errors' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));

  await dispatch(h, 'graph-verifier');
  await bindChild(h, 'child-verify', 'graph-verifier');
  const weak = JSON.parse(await h.tools.graph_submit_verification.execute({ nodeId: 'verify-1', verdict: 'PASS', commands: [] }, ctx(h, 'child-verify', 'graph-verifier')));
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'INSUFFICIENT_EVIDENCE');
  await childIdle(h, 'child-verify');

  const repaired = await dispatch(h, 'graph-verifier');
  assert.ok(!repaired.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-verify2', 'graph-verifier');
  const pass2 = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] },
    ctx(h, 'child-verify2', 'graph-verifier'),
  ));
  assert.equal(pass2.ok, true, JSON.stringify(pass2));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('out-of-scope edit and implementer bash are denied at the permission prompt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer');
  await bindChild(h, 'child-impl', 'graph-implementer');

  await h.enforcement.onToolBefore({ tool: 'edit', sessionID: 'child-impl', callID: 'bad-edit', args: { filePath: join(dir, 'docs', 'other.md') } }, { args: { filePath: join(dir, 'docs', 'other.md') } });
  const permission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'edit', sessionID: 'child-impl', callID: 'bad-edit', pattern: join(dir, 'docs', 'other.md') }, permission);
  assert.equal(permission.status, 'deny');
  const state = h.store.getRun('root');
  assert.ok(state.violations.some((entry) => entry.kind === 'out-of-scope-edit'));

  const bashPermission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'bash', sessionID: 'child-impl', callID: 'bash-1' }, bashPermission);
  assert.equal(bashPermission.status, 'deny');

  const inScope = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'edit', sessionID: 'child-impl', callID: 'ok-edit', pattern: join(dir, 'src', 'a.ts') }, inScope);
  assert.equal(inScope.status, 'ask');
});

test('crash window: side effects lead to RECOVERY_REQUIRED; resume preserves attempts and injects reconcile context', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef4-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer');
  await bindChild(h, 'child-impl', 'graph-implementer');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 1);

  // Simulate a restart: fresh bindings and stores over the same directory.
  h = harness(dir);
  await startRun(h);
  const state = h.store.getRun('root');
  assert.equal(state.status, 'RECOVERY_REQUIRED');
  assert.equal(state.nodes['impl-1'].state, 'RUNNING');

  const resume = JSON.parse(await h.tools.graph_run_resume.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.deepEqual(resume.report.recoveryRequired, ['impl-1']);
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 1);

  const before = await dispatch(h, 'graph-implementer');
  assert.match(before.args.prompt, /副作用/);
  assert.match(before.args.prompt, /src\/a.ts/);
  const after = h.store.getRun('root');
  assert.equal(after.nodes['impl-1'].state, 'RUNNING');
  assert.equal(after.nodes['impl-1'].attempt, 2);
});

test('session idle without submission marks INCOMPLETE and burns attempts; roles cannot forge other tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef5-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));

  const forged = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'not dispatched' }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'WRONG_ROLE');

  await dispatch(h, 'graph-implementer');
  await bindChild(h, 'child-impl', 'graph-implementer');
  const stranger = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'other session' }, { ...ctx(h, 'child-impl', 'graph-implementer'), sessionID: 'child-impl-other' }));
  assert.equal(stranger.ok, false);

  await childIdle(h, 'child-impl');
  const state = h.store.getRun('root');
  assert.equal(state.nodes['impl-1'].state, 'INCOMPLETE');
  assert.equal(state.nodes['impl-1'].attempt, 1);

  const inspect = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(inspect.status, 'RUNNING');
  assert.ok(inspect.nodes.some((node) => node.id === 'impl-1' && node.state === 'INCOMPLETE'));
});

test('invalid graphs are rejected with actionable errors; unbound sessions cannot submit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-ef6-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');

  const cyclic = JSON.parse(await h.tools.graph_submit_plan.execute(
    { intent: 'change', specs: SPECS.map((spec) => spec.id === 'impl-1' ? { ...spec, dependsOn: ['verify-1'] } : spec) },
    ctx(h, 'child-planner', 'graph-planner'),
  ));
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.detail, /cycle/);

  const noWriteScope = JSON.parse(await h.tools.graph_submit_plan.execute(
    { intent: 'change', specs: SPECS.map((spec) => spec.id === 'impl-1' ? { ...spec, writeScope: undefined } : spec) },
    ctx(h, 'child-planner', 'graph-planner'),
  ));
  assert.equal(noWriteScope.ok, false);

  const outsider = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'stranger', 'graph-planner')));
  assert.equal(outsider.ok, false);
  assert.equal(outsider.code, 'NOT_GRAPH_SESSION');
});
