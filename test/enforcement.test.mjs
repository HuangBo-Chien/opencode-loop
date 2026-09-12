import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore, newRun } from '../src/run-state.mjs';
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
  const journal = { enabled: true, includeUserRequest: true, semanticSearch: true, maxUserRequestChars: 8000 };
  const enforcement = createEnforcement({ settings: { worktree, journal }, store, runner, bindings });
  const { tools } = createSubmitTools({ store, runner, bindings, worktree, dispatches: enforcement.dispatches });
  return { store, runner, bindings, enforcement, tools, calls: [] };
}

async function startRun(h) {
  await h.enforcement.onChatMessage({ sessionID: 'root', agent: 'graph-orchestrator' });
}
async function dispatch(h, agent, { prompt = `work for ${agent}` } = {}) {
  const output = { args: { description: `dispatch ${agent}`, prompt, subagent_type: agent } };
  const callID = `call-${agent}-${Math.random().toString(36).slice(2)}`;
  await h.enforcement.onToolBefore({ tool: 'task', sessionID: 'root', callID }, output);
  if (!output.args.prompt.includes('RUNNER_REJECTED')) h.calls.push({ agent, callID });
  return output;
}
async function bindChild(h, sessionId, agent) {
  await h.enforcement.onEvent({ event: { type: 'session.created', properties: { info: { id: sessionId, parentID: 'root' } } } });
  const index = h.calls.findIndex((call) => call.agent === agent);
  const [call] = h.calls.splice(index, 1);
  await h.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'task', sessionID: 'root', callID: call.callID,
    state: { status: 'running', input: { subagent_type: agent }, metadata: { parentSessionId: 'root', sessionId } },
  } } } });
  assert.equal(h.bindings.get(sessionId)?.agent, agent, `child ${sessionId} should bind to ${agent}`);
}
async function childIdle(h, sessionId) {
  await h.enforcement.onEvent({ event: { type: 'session.idle', properties: { sessionID: sessionId } } });
}
function ctx(h, sessionId, agent) {
  return { sessionID: sessionId, messageID: 'm1', agent, directory: '/w', worktree: '/w', abort: new AbortController().signal, metadata() {}, ask: async () => {} };
}

test('only the first graph-orchestrator root request is captured', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let h = harness(dir);

  await h.enforcement.onChatMessage(
    { sessionID: 'subagent-before-root', agent: 'graph-planner' },
    { parts: [{ type: 'text', text: 'Subagent content must not create a run.' }] },
  );
  assert.equal(h.store.getRun('subagent-before-root'), null);

  await h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [
      { type: 'text', text: '  Build the feature\r\nwith token=secret-value  ' },
      { type: 'file', filename: 'ignored.txt', data: 'attachment-secret' },
    ] },
  );
  const first = structuredClone(h.store.getRun('root').request);
  assert.equal(first.text, 'Build the feature\nwith token=[REDACTED]');
  assert.equal(first.truncated, false);
  assert.equal(first.redactions, 1);
  assert.equal(typeof first.capturedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(first.capturedAt)));
  assert.equal(h.store.getRun('root').requestCaptureCompleted, true);

  await h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'Later root request must not replace the first.' }] },
  );
  await h.enforcement.onChatMessage(
    { sessionID: 'child', agent: 'graph-implementer' },
    { parts: [{ type: 'text', text: 'Subagent request must not replace the first.' }] },
  );
  assert.deepEqual(h.store.getRun('root').request, first);

  await h.store.releaseRun('root');
  h = harness(dir);
  await h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'A request after restart must not replace the first.' }] },
  );
  assert.deepEqual(h.store.getRun('root').request, first);
});

test('request capture hook completes without inspecting a part after the raw cap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-request-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  const rawCap = 8000 + 4096;
  const unread = {};
  Object.defineProperties(unread, {
    type: {
      get() { throw new Error('type beyond the bounded raw cap must not be read'); },
    },
    text: {
      get() { throw new Error('text beyond the bounded raw cap must not be read'); },
    },
  });

  await assert.doesNotReject(() => h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [
      { type: 'text', text: `token=${'x'.repeat(rawCap - 'token='.length)}` },
      unread,
    ] },
  ));

  const state = h.store.getRun('root');
  assert.equal(state.request.text, 'token=[REDACTED]');
  assert.equal(state.request.truncated, true);
  assert.equal(state.request.redactions, 1);
  assert.equal(state.requestCaptureCompleted, true);
  const persisted = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'root.json'), 'utf8'));
  assert.equal(persisted.requestCaptureCompleted, true);
});

test('request capture bounds attachment-only parts and durably completes with null', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-request-parts-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  let tailReads = 0;
  const unreadTail = {};
  Object.defineProperty(unreadTail, 'type', {
    get() {
      tailReads += 1;
      throw new Error('attachment beyond the inspection ceiling must not be read');
    },
  });

  await assert.doesNotReject(() => h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [...Array.from({ length: 256 }, () => ({ type: 'file' })), unreadTail] },
  ));

  assert.equal(tailReads, 0);
  assert.equal(h.store.getRun('root').request, null);
  assert.equal(h.store.getRun('root').requestCaptureCompleted, true);
  const persisted = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'root.json'), 'utf8'));
  assert.equal(persisted.request, null);
  assert.equal(persisted.requestCaptureCompleted, true);
});

test('new-run hook persists only a completed initial request representation', async (t) => {
  const scenarios = [
    ['sanitized text', [{ type: 'text', text: 'token=raw-secret' }], 'token=[REDACTED]'],
    ['text-free', [{ type: 'file', filename: 'context.bin' }], null],
  ];

  for (const [label, parts, expectedText] of scenarios) {
    await t.test(label, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'loop-request-atomic-'));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const baseStore = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
      const initialDocuments = [];
      let saveCalls = 0;
      const store = {
        loadRun: (runId) => baseStore.loadRun(runId),
        getRun: (runId) => baseStore.getRun(runId),
        async createRun(options) {
          const state = await baseStore.createRun(options);
          initialDocuments.push(JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', `${options.runId}.json`), 'utf8')));
          return state;
        },
        async saveRun() {
          saveCalls += 1;
          throw new Error('simulated follow-up save failure');
        },
      };
      const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 2 });
      const bindings = new Map();
      const journal = { enabled: true, includeUserRequest: true, semanticSearch: true, maxUserRequestChars: 8000 };
      const enforcement = createEnforcement({ settings: { worktree: dir, journal }, store, runner, bindings });

      await assert.doesNotReject(() => enforcement.onChatMessage(
        { sessionID: 'root', agent: 'graph-orchestrator' },
        { parts },
      ));

      assert.equal(initialDocuments.length, 1);
      assert.equal(saveCalls, 0);
      const [initial] = initialDocuments;
      assert.equal(initial.requestCaptureCompleted, true);
      assert.equal(initial.request?.text ?? null, expectedText);
      if (initial.request) assert.equal(initial.request.redactions, 1);
    });
  }
});

test('chat message input agent takes precedence over the output message agent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-agent-precedence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);

  await h.enforcement.onChatMessage(
    { sessionID: 'not-an-orchestrator', agent: 'graph-planner' },
    {
      message: { agent: 'graph-orchestrator' },
      parts: [{ type: 'text', text: 'Must not create a root run.' }],
    },
  );

  assert.equal(h.store.getRun('not-an-orchestrator'), null);
  assert.equal(h.bindings.has('not-an-orchestrator'), false);
});

test('text-free first root messages durably complete request capture', async (t) => {
  const scenarios = [
    ['blank', [{ type: 'text', text: ' \r\n ' }]],
    ['attachment-only', [{ type: 'file', filename: 'context.bin', data: 'not journal text' }]],
    ['bounded-empty', [{ type: 'text', text: `${' '.repeat(20_000)}text beyond the capture bound` }]],
  ];

  for (const [label, parts] of scenarios) {
    await t.test(label, async (t) => {
      const dir = await mkdtemp(join(tmpdir(), `loop-empty-request-${label}-`));
      t.after(() => rm(dir, { recursive: true, force: true }));
      let h = harness(dir);

      await h.enforcement.onChatMessage(
        { sessionID: 'root', agent: 'graph-orchestrator' },
        { parts },
      );
      assert.equal(h.store.getRun('root').request, null);
      assert.equal(h.store.getRun('root').requestCaptureCompleted, true);
      const persisted = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'root.json'), 'utf8'));
      assert.equal(persisted.request, null);
      assert.equal(persisted.requestCaptureCompleted, true);

      await h.store.releaseRun('root');
      h = harness(dir);
      await h.enforcement.onChatMessage(
        { sessionID: 'root', agent: 'graph-orchestrator' },
        { parts: [{ type: 'text', text: 'Later text must not become the initial request.' }] },
      );
      assert.equal(h.store.getRun('root').request, null);
      assert.equal(h.store.getRun('root').requestCaptureCompleted, true);
    });
  }
});

test('historical schema v1 runs never capture a post-upgrade message as their initial request', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-v1-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const legacy = newRun({ runId: 'root', rootSessionId: 'root', now: '2026-09-06T00:00:00.000Z' });
  legacy.schemaVersion = 1;
  delete legacy.request;
  delete legacy.requestCaptureCompleted;
  await writeFile(join(runsDir, 'root.json'), JSON.stringify(legacy));
  const h = harness(dir);

  await h.enforcement.onChatMessage(
    { sessionID: 'root', agent: 'graph-orchestrator' },
    { parts: [{ type: 'text', text: 'This post-upgrade message is not the historical initial request.' }] },
  );

  const migrated = h.store.getRun('root');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.request, null);
  assert.equal(migrated.requestCaptureCompleted, true);
});

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

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'fixed auth errors');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  const invalid = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/'], summary: 'bad claim' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(invalid.code, 'INVALID_FILE_CLAIM');
  assert.equal(invalid.retryable, true);
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 1);
  assert.equal(h.store.getRun('root').artifacts.plan.version, 1);
  assert.equal(h.store.getRun('root').nodes['review-1'].attempt, 1);
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
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 1);
  await bindChild(h, 'recovered-impl', 'graph-implementer');
  const after = h.store.getRun('root');
  assert.equal(after.nodes['impl-1'].state, 'RUNNING');
  assert.equal(after.nodes['impl-1'].attempt, 2);
  await assert.rejects(h.enforcement.onToolBefore({ tool: 'edit', sessionID: 'child-impl', callID: 'late' }, { args: { filePath: join(dir, 'src', 'a.ts') } }), /BINDING_UNAVAILABLE/);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'reconciled');
  const delivered = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'reconciled' }, ctx(h, 'recovered-impl', 'graph-implementer')));
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  await dispatch(h, 'graph-verifier');
  await bindChild(h, 'recovered-verify', 'graph-verifier');
  const verified = JSON.parse(await h.tools.graph_submit_verification.execute({ nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'fixture verification', exitCode: 0 }] }, ctx(h, 'recovered-verify', 'graph-verifier')));
  assert.equal(verified.ok, true);
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
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
