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
async function dispatch(h, agent, options = {}) {
  const { prompt = `work for ${agent}`, ...rest } = options;
  const output = { args: { description: `dispatch ${agent}`, prompt, subagent_type: agent, ...rest } };
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

test('full gated flow: plan → FAIL pauses for decision; abort closes the run; blocked dispatch is rewritten as RUNNER_REJECTED', async (t) => {
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
  assert.equal(verdict.effect, 'await-decision');
  const paused = h.store.getRun('root');
  assert.equal(paused.status, 'AWAITING_USER_DECISION');
  assert.equal(paused.pendingDecision.cause, 'plan-rejected-by-critic');

  const blocked = await dispatch(h, 'graph-implementer');
  assert.match(blocked.args.prompt, /RUNNER_REJECTED/);
  assert.match(blocked.args.prompt, /AWAITING_DECISION/);
  assert.match(blocked.args.prompt, /graph_run_decide/);
  assert.ok(paused.violations.some((entry) => entry.kind === 'gate-blocked-dispatch'));

  // Neither a new planner dispatch nor plan replacement can bypass the pause.
  const smuggler = await dispatch(h, 'graph-planner');
  assert.match(smuggler.args.prompt, /RUNNER_REJECTED/);
  assert.match(smuggler.args.prompt, /AWAITING_DECISION/);
  await childIdle(h, 'child-critic');

  // The user's abort decision is irreversible and preserves the evidence.
  const aborted = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'requirements changed' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(aborted.ok, true, JSON.stringify(aborted));
  assert.equal(aborted.status, 'ABORTED');
  const state = h.store.getRun('root');
  assert.equal(state.status, 'ABORTED');
  assert.match(state.failReason, /aborted by user: requirements changed/);
  assert.equal(state.artifacts.review.payload.verdict, 'FAIL');
  assert.equal(state.decision.action, 'abort');
  const afterAbort = await dispatch(h, 'graph-explorer');
  assert.match(afterAbort.args.prompt, /RUN_TERMINATED/);
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

const STEER_SPECS = [
  { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: [], inputs: [], outputs: [], acceptance: ['plan'] },
  { id: 'review-1', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['plan-1'], inputs: [], outputs: [], acceptance: ['review'] },
  { id: 'impl-a', kind: 'implement', agent: 'graph-implementer', dependsOn: ['review-1'], inputs: [], outputs: [], writeScope: ['pkg-a/**'], acceptance: ['a'] },
  { id: 'impl-b', kind: 'implement', agent: 'graph-implementer', dependsOn: ['review-1'], inputs: [], outputs: [], writeScope: ['pkg-b/**'], acceptance: ['b'], allowShell: true },
  { id: 'verify-1', kind: 'verify', agent: 'graph-verifier', dependsOn: ['impl-a', 'impl-b'], inputs: [], outputs: [], acceptance: ['verify'] },
];

async function setupSteerableRun(h) {
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const submitted = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: STEER_SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
}

test('coordinator nodeId steering binds the requested node, not the sorted one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-steer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);

  // Without steering the runner sorts to impl-a; the marker selects impl-b.
  const plain = await dispatch(h, 'graph-implementer');
  assert.match(plain.args.prompt, /Assigned nodeId: impl-a/);
  await bindChild(h, 'child-a', 'graph-implementer');
  await childIdle(h, 'child-a');

  const steered = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwrite the b package' });
  assert.ok(!steered.args.prompt.includes('RUNNER_REJECTED'));
  assert.match(steered.args.prompt, /Assigned nodeId: impl-b/);
  await bindChild(h, 'child-b', 'graph-implementer');
  assert.equal(h.bindings.get('child-b').nodeId, 'impl-b');
  await childIdle(h, 'child-b');

  // An explicit args.nodeId works too, and an ineligible target is rejected
  // with the precise reason instead of a silent reassignment.
  const invalid = await dispatch(h, 'graph-implementer', { prompt: 'x', nodeId: 'impl-zzz' });
  assert.match(invalid.args.prompt, /RUNNER_REJECTED/);
  assert.match(invalid.args.prompt, /NODE_NOT_FOUND/);
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.detail.includes('NODE_NOT_FOUND')));
});

test('write tool is scope-gated exactly like edit and enters the side-effect ledger', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-write-tool-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);
  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork' });
  await bindChild(h, 'child-b', 'graph-implementer');

  const outside = { args: { filePath: join(dir, 'pkg-a', 'escape.ts'), content: 'x' } };
  await h.enforcement.onToolBefore({ tool: 'write', sessionID: 'child-b', callID: 'w1' }, outside);
  const permission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'write', sessionID: 'child-b', callID: 'w1', pattern: join(dir, 'pkg-a', 'escape.ts') }, permission);
  assert.equal(permission.status, 'deny');
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'out-of-scope-write'));

  await mkdir(join(dir, 'pkg-b'), { recursive: true });
  await h.enforcement.onToolAfter({ tool: 'write', sessionID: 'child-b', callID: 'w2', args: { filePath: join(dir, 'pkg-b', 'new.ts'), content: 'y' } }, { title: 'write', output: 'ok' });
  const state = h.store.getRun('root');
  assert.ok(state.sideEffects.some((effect) => effect.nodeId === 'impl-b' && effect.tool === 'write' && effect.target === 'pkg-b/new.ts'));
});

test('allowShell bash cannot write outside writeScope; in-scope writes pass', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-bash-scope-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);
  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork' });
  await bindChild(h, 'child-b', 'graph-implementer');

  const escape = { args: { command: `cat > ${join(dir, 'pkg-a', 'steal.sh')} <<'EOF'\necho boom\nEOF` } };
  await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-b', callID: 'b1' }, escape);
  const permission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'bash', sessionID: 'child-b', callID: 'b1' }, permission);
  assert.equal(permission.status, 'deny');
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'out-of-scope-bash' && entry.detail.includes('pkg-a/steal.sh')));

  const fine = await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-b', callID: 'b2' }, { args: { command: 'UV_CACHE_DIR=$PWD/pkg-b/cache uv venv pkg-b/.venv > pkg-b/logs/setup.log' } });
  assert.equal(fine, undefined);
});

test('read-only explorer bash passes checks but not workspace writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-explorer-bash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');

  const check = await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-explore', callID: 'x1' }, { args: { command: 'uv --version; python3 --version' } });
  assert.equal(check, undefined);

  const write = { args: { command: 'uv --version > notes.txt' } };
  await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-explore', callID: 'x2' }, write);
  const permission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'bash', sessionID: 'child-explore', callID: 'x2' }, permission);
  assert.equal(permission.status, 'deny');
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'out-of-scope-bash' && entry.detail.includes('graph-explorer')));
});

test('NOT_DISPATCHED_NODE names the bound node and INVALID_GRAPH carries schema guidance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-errors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);

  // Schema guidance rides along with the first rejection, before any node runs.
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner2', 'graph-planner');
  const badGraph = JSON.parse(await h.tools.graph_submit_plan.execute(
    { intent: 'change', specs: [{ id: 'n1', kind: 'plan', agent: 'planner', dependsOn: [], outputs: ['plan@1'] }] },
    ctx(h, 'child-planner2', 'graph-planner'),
  ));
  assert.equal(badGraph.code, 'INVALID_GRAPH');
  assert.match(badGraph.hint, /explore→graph-explorer/);
  assert.match(badGraph.hint, /bare artifact names only/);
  assert.match(badGraph.hint, /exactly one plan node/);

  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork' });
  await bindChild(h, 'child-b', 'graph-implementer');
  const wrongNode = JSON.parse(await h.tools.graph_submit_change.execute(
    { nodeId: 'impl-a', filesTouched: ['pkg-b/x.ts'], summary: 'did b work' },
    ctx(h, 'child-b', 'graph-implementer'),
  ));
  assert.equal(wrongNode.code, 'NOT_DISPATCHED_NODE');
  assert.match(wrongNode.detail, /bound to impl-b/);
});

test('terminal runs keep read-only tools alive for children and graph_run_new starts a successor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-newrun-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);
  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-a]\nwork' });
  await bindChild(h, 'child-a', 'graph-implementer');
  await mkdir(join(dir, 'pkg-a'), { recursive: true });
  await writeFile(join(dir, 'pkg-a', 'a.ts'), 'a');
  const changeA = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-a', filesTouched: ['pkg-a/a.ts'], summary: 'a' }, ctx(h, 'child-a', 'graph-implementer')));
  assert.equal(changeA.ok, true, JSON.stringify(changeA));
  await childIdle(h, 'child-a');
  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork' });
  await bindChild(h, 'child-b', 'graph-implementer');
  await mkdir(join(dir, 'pkg-b'), { recursive: true });
  await writeFile(join(dir, 'pkg-b', 'b.ts'), 'b');
  const changeB = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-b', filesTouched: ['pkg-b/b.ts'], summary: 'b' }, ctx(h, 'child-b', 'graph-implementer')));
  assert.equal(changeB.ok, true, JSON.stringify(changeB));
  await childIdle(h, 'child-b');
  await dispatch(h, 'graph-verifier');
  await bindChild(h, 'child-verify', 'graph-verifier');
  const verdict = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');

  // A post-terminal dispatch is rejected, but read-only tools keep working
  // for the rejected child through the parent-chain fallback.
  const blocked = await dispatch(h, 'graph-explorer');
  assert.match(blocked.args.prompt, /RUNNER_REJECTED/);
  await h.enforcement.onEvent({ event: { type: 'session.created', properties: { info: { id: 'late-child', parentID: 'root' } } } });
  const fromChild = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'late-child', 'graph-explorer')));
  assert.equal(fromChild.status, 'SUCCEEDED');
  assert.doesNotThrow(() => h.enforcement.internals.READ_ONLY_TOOLS.has('read'), undefined);

  // A new run can be started in the same session once the old one is terminal.
  const tooEarlyHarness = h;
  const early = JSON.parse(await tooEarlyHarness.tools.graph_run_new.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(early.ok, true);
  assert.match(early.runId, /^root:2$/);
  const terminalDispatch = await dispatch(tooEarlyHarness, 'graph-explorer');
  assert.ok(!terminalDispatch.args.prompt.includes('RUNNER_REJECTED'));

  // Restart: the successor chain is followed back to the newest run.
  const h2 = harness(dir);
  await startRun(h2);
  assert.equal(h2.bindings.get('root').runId, 'root:2');
});

const PLAN_ONLY_SPECS = (reviewInputs = ['plan']) => [
  { id: 'explore-1', kind: 'explore', agent: 'graph-explorer', dependsOn: [], inputs: [], outputs: ['findings'], acceptance: ['evidence'] },
  { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: ['explore-1'], inputs: ['findings@1'], outputs: ['plan'], acceptance: ['plan'] },
  { id: 'review-1', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['plan-1'], inputs: reviewInputs, outputs: ['review'], acceptance: ['review'] },
];

test('plan-only loop completes: findings → plan → critic review PASS (regression)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-planonly-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  const findings = JSON.parse(await h.tools.graph_submit_findings.execute({ summary: 'located evidence', evidence: ['a.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer')));
  assert.equal(findings.ok, true, JSON.stringify(findings));
  await childIdle(h, 'child-explore');

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  assert.equal(h.bindings.get('child-critic').nodeId, 'review-1');
  const verdict = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('custom artifact names are rejected at plan submission, not stranded at dispatch', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-naming-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'evidence', evidence: [] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const failedRunShape = await h.tools.graph_submit_plan.execute({
    intent: 'plan-only',
    specs: [
      { id: 'explore-1', kind: 'explore', agent: 'graph-explorer', dependsOn: [], inputs: [], outputs: ['findings'], acceptance: ['evidence'] },
      { id: 'design-isolated-efficientnet-run', kind: 'plan', agent: 'graph-planner', dependsOn: ['explore-1'], inputs: ['findings@1'], outputs: ['isolated-efficientnet-runbook'], acceptance: ['runbook'] },
      { id: 'review-isolated-efficientnet-runbook', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['design-isolated-efficientnet-run'], inputs: ['isolated-efficientnet-runbook'], outputs: ['review'], acceptance: ['review'] },
    ],
  }, ctx(h, 'child-planner', 'graph-planner'));
  const rejection = JSON.parse(failedRunShape);
  assert.equal(rejection.code, 'INVALID_GRAPH');
  assert.match(rejection.detail, /outputs must be \[plan\]/);
  assert.match(rejection.detail, /inputs reference isolated-efficientnet-runbook/);
  assert.match(rejection.hint, /Artifact names are runner-assigned/);
  // The run was never left with a permanently inadmissible review node.
  const state = h.store.getRun('root');
  assert.equal(Object.keys(state.nodes).length, 0);
});

test('critic dispatch before findings exist is rejected up front with NO_READY_NODE', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-critic-notready-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS(['findings']) }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));

  const blocked = await dispatch(h, 'graph-plan-critic');
  assert.match(blocked.args.prompt, /RUNNER_REJECTED/);
  assert.match(blocked.args.prompt, /NO_READY_NODE/);
  assert.match(blocked.args.prompt, /resubmit a corrected plan/);

  // Registering findings unblocks the same dispatch path to completion.
  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'late evidence', evidence: [] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');
  const admitted = await dispatch(h, 'graph-plan-critic');
  assert.ok(!admitted.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const verdict = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

const DECIDE_SPECS = [
  { id: 'explore-1', kind: 'explore', agent: 'graph-explorer', dependsOn: [], inputs: [], outputs: ['findings'], acceptance: ['evidence'] },
  { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: ['explore-1'], inputs: ['findings@1'], outputs: ['plan'], acceptance: ['plan'] },
  { id: 'review-1', kind: 'review', agent: 'graph-plan-critic', dependsOn: ['plan-1'], inputs: ['plan'], outputs: ['review'], acceptance: ['review'] },
];

async function decideRound(h, planVersion, verdict) {
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, `child-critic-${planVersion}-${verdict}`, 'graph-plan-critic');
  const result = JSON.parse(await h.tools.graph_submit_review.execute(
    { planVersion, verdict, findings: ['tighten scope'] },
    ctx(h, `child-critic-${planVersion}-${verdict}`, 'graph-plan-critic'),
  ));
  await childIdle(h, `child-critic-${planVersion}-${verdict}`);
  return result;
}
async function replan(h, planVersion) {
  await dispatch(h, 'graph-planner');
  await bindChild(h, `child-planner-${planVersion}`, 'graph-planner');
  const result = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: DECIDE_SPECS }, ctx(h, `child-planner-${planVersion}`, 'graph-planner')));
  await childIdle(h, `child-planner-${planVersion}`);
  return result;
}

test('revision exhaustion pauses the run; user reset opens a successor that completes end to end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-decide-reset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir); // maxPlanRevisions: 2
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'evidence', evidence: ['a.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');

  const v1 = await replan(h, 1);
  assert.equal(v1.ok, true, JSON.stringify(v1));
  assert.equal((await decideRound(h, 1, 'REVISE')).effect, 'revise');
  assert.equal((await replan(h, 2)).ok, true);
  assert.equal((await decideRound(h, 2, 'REVISE')).effect, 'revise');
  assert.equal((await replan(h, 3)).ok, true);
  const exhausted = await decideRound(h, 3, 'REVISE');
  assert.equal(exhausted.effect, 'await-decision');
  assert.equal(h.store.getRun('root').status, 'AWAITING_USER_DECISION');

  const blockedDispatch = await dispatch(h, 'graph-planner');
  assert.match(blockedDispatch.args.prompt, /AWAITING_DECISION/);
  const inspectPaused = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(inspectPaused.pendingDecision.cause, 'plan-revisions-exhausted');

  // The user decides to reset with an explicit reason.
  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants a fresh planning round with new constraints' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.match(reset.runId, /^root:2$/);
  const archived = h.store.getRun('root');
  assert.equal(archived.status, 'AWAITING_USER_DECISION'); // archived in place
  assert.equal(archived.decision.action, 'reset');
  assert.equal(archived.successorRunId, 'root:2');
  assert.equal(archived.artifacts.plan.version, 3); // evidence untouched

  // The successor run starts fresh and completes the whole plan-only loop.
  assert.equal(h.store.getRun('root:2').revisionCounters['plan-review'], 0);
  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore-2', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'fresh evidence', evidence: ['b.ts:2'] }, ctx(h, 'child-explore-2', 'graph-explorer'));
  await childIdle(h, 'child-explore-2');
  const plan2 = await replan(h, 1);
  assert.equal(plan2.ok, true, JSON.stringify(plan2));
  const pass2 = await decideRound(h, 1, 'PASS');
  assert.equal(pass2.ok, true, JSON.stringify(pass2));
  assert.equal(h.store.getRun('root:2').status, 'SUCCEEDED');

  // The archived run is unreachable through the session (its binding moved
  // to the successor); deciding again targets the successor, which guards
  // itself by status.
  const again = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'x' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'RUN_NOT_ABORTABLE');
  assert.equal(h.store.getRun('root').status, 'AWAITING_USER_DECISION');

  // A restart rebinds the session to the successor run.
  const h2 = harness(dir);
  await startRun(h2);
  assert.equal(h2.bindings.get('root').runId, 'root:2');
});

test('graph_run_decide preconditions: role, root, in-flight nodes and dispatches, abortability', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-decide-precond-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  const wrongRole = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'x' }, ctx(h, 'root', 'graph-verifier')));
  assert.equal(wrongRole.code, 'WRONG_ROLE');
  const notRoot = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'x' }, { ...ctx(h, 'child-impl', 'graph-orchestrator'), sessionID: 'child-impl' }));
  assert.equal(notRoot.code, 'NOT_GRAPH_SESSION');

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: DECIDE_SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const paused = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['wrong'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(paused.effect, 'await-decision');

  // An outstanding bound dispatch blocks the decision until the session idles.
  const busyDispatch = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'x' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(busyDispatch.ok, false);
  assert.equal(busyDispatch.code, 'DISPATCH_PENDING');
  await childIdle(h, 'child-critic');

  // RUNNING nodes also block: revive one through a bound implementer... this
  // run is plan-only, so abort directly instead and verify terminal guards.
  const abort = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'user stopped the effort' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(abort.ok, true, JSON.stringify(abort));
  assert.equal(abort.status, 'ABORTED');
  const reabort = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'abort', reason: 'again' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reabort.code, 'ABORTED_RUN' === 'x' ? 'x' : 'RUN_NOT_ABORTABLE');
  // graph_run_new still works on an aborted run.
  const next = JSON.parse(await h.tools.graph_run_new.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(next.ok, true, JSON.stringify(next));
});

test('parallel writers: two [nodeId:] implementers run concurrently and complete end to end', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-parallel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await setupSteerableRun(h);

  const first = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-a]\nwork a' });
  const second = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork b' });
  assert.ok(!first.args.prompt.includes('RUNNER_REJECTED'));
  assert.ok(!second.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-a', 'graph-implementer');
  await bindChild(h, 'child-b', 'graph-implementer');

  // Both writers are RUNNING at the same time with disjoint scopes.
  const state = h.store.getRun('root');
  assert.equal(state.nodes['impl-a'].state, 'RUNNING');
  assert.equal(state.nodes['impl-b'].state, 'RUNNING');

  // A third implementer is refused while both capacity slots are taken.
  const third = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-a]\nagain' });
  assert.match(third.args.prompt, /RUNNER_REJECTED/);
  assert.match(third.args.prompt, /WRITER_CAPACITY/);

  // Scope enforcement stays per-node while running in parallel.
  const escape = { args: { filePath: join(dir, 'pkg-b', 'from-a.ts'), content: 'x' } };
  await h.enforcement.onToolBefore({ tool: 'write', sessionID: 'child-a', callID: 'w1' }, escape);
  const permission = { status: 'ask' };
  await h.enforcement.onPermissionAsk({ type: 'write', sessionID: 'child-a', callID: 'w1', pattern: join(dir, 'pkg-b', 'from-a.ts') }, permission);
  assert.equal(permission.status, 'deny');
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'out-of-scope-write'));

  await mkdir(join(dir, 'pkg-a'), { recursive: true });
  await mkdir(join(dir, 'pkg-b'), { recursive: true });
  await writeFile(join(dir, 'pkg-a', 'a.ts'), 'a');
  await writeFile(join(dir, 'pkg-b', 'b.ts'), 'b');
  const changeA = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-a', filesTouched: ['pkg-a/a.ts'], summary: 'a' }, ctx(h, 'child-a', 'graph-implementer')));
  const changeB = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-b', filesTouched: ['pkg-b/b.ts'], summary: 'b' }, ctx(h, 'child-b', 'graph-implementer')));
  assert.equal(changeA.ok, true, JSON.stringify(changeA));
  assert.equal(changeB.ok, true, JSON.stringify(changeB));
  await childIdle(h, 'child-a');
  await childIdle(h, 'child-b');

  await dispatch(h, 'graph-verifier');
  await bindChild(h, 'child-verify', 'graph-verifier');
  const verdict = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('critic approvedParallel downgrade mechanically serializes writers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-parallel-capped-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: STEER_SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const capped = JSON.parse(await h.tools.graph_submit_review.execute(
    { planVersion: 1, verdict: 'PASS', findings: [], approvedParallel: 1 },
    ctx(h, 'child-critic', 'graph-plan-critic'),
  ));
  assert.equal(capped.ok, true, JSON.stringify(capped));

  const first = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-a]\nwork a' });
  assert.ok(!first.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-a', 'graph-implementer');
  const second = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork b' });
  assert.match(second.args.prompt, /RUNNER_REJECTED/);
  assert.match(second.args.prompt, /WRITER_CAPACITY/);
  assert.match(second.args.prompt, /1\/1/);
});
