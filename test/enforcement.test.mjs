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

function harness(worktree, { readerParallel } = {}) {
  const store = createRunStore({ worktree, stateDirectory: '.opencode-loop' });
  const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 2, readerParallel });
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
  if (!output.args.prompt.includes('RUNNER_REJECTED')) h.calls.push({ agent, callID, args: output.args });
  return { ...output, callID };
}
async function bindChild(h, sessionId, agent, callID) {
  const candidates = h.calls.filter((call) => call.agent === agent && (callID === undefined || call.callID === callID));
  assert.equal(candidates.length, 1, 'ambiguous same-role dispatches must bind by explicit callID');
  const index = h.calls.indexOf(candidates[0]);
  const [call] = h.calls.splice(index, 1);
  await h.enforcement.onEvent({ event: { type: 'session.created', properties: { info: { id: sessionId, parentID: 'root' } } } });
  await h.enforcement.onEvent({ event: { type: 'message.part.updated', properties: { part: {
    type: 'tool', tool: 'task', sessionID: 'root', callID: call.callID,
    state: { status: 'running', input: call.args, metadata: { parentSessionId: 'root', sessionId } },
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
          initialDocuments.push(JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', `${encodeURIComponent(options.runId)}.json`), 'utf8')));
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

  const blocked = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
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

  const early = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  assert.match(early.args.prompt, /RUNNER_REJECTED/);
  assert.match(early.args.prompt, /NODE_NOT_FOUND/);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const pass = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(pass.ok, true);

  const impl = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
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

  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  await bindChild(h, 'child-verify', 'graph-verifier');
  const weak = JSON.parse(await h.tools.graph_submit_verification.execute({ nodeId: 'verify-1', verdict: 'PASS', commands: [] }, ctx(h, 'child-verify', 'graph-verifier')));
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'INSUFFICIENT_EVIDENCE');
  await childIdle(h, 'child-verify');

  const repaired = await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
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
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');

  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'edit', sessionID: 'child-impl', callID: 'bad-edit', args: { filePath: join(dir, 'docs', 'other.md') } }, { args: { filePath: join(dir, 'docs', 'other.md') } }),
    /RUNNER_DENIED\(out-of-scope-edit\)/,
  );
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
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 1);

  // Simulate a restart: fresh bindings and stores over the same directory.
  h = harness(dir);
  await startRun(h);
  const state = h.store.getRun('root');
  assert.equal(state.status, 'RECOVERY_REQUIRED');
  assert.equal(state.nodes['impl-1'].state, 'RUNNING');
  // The interrupted attempt was refunded: a crash must not burn the budget.
  assert.equal(state.nodes['impl-1'].attempt, 0);

  const resume = JSON.parse(await h.tools.graph_run_resume.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.deepEqual(resume.report.recoveryRequired, ['impl-1']);
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 0);

  const before = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  assert.match(before.args.prompt, /副作用/);
  assert.match(before.args.prompt, /src\/a.ts/);
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 0);
  await bindChild(h, 'recovered-impl', 'graph-implementer');
  const after = h.store.getRun('root');
  assert.equal(after.nodes['impl-1'].state, 'RUNNING');
  // Refunded crash (0) + one fresh reconcile attempt = 1: the crash cost nothing.
  assert.equal(after.nodes['impl-1'].attempt, 1);
  await assert.rejects(h.enforcement.onToolBefore({ tool: 'edit', sessionID: 'child-impl', callID: 'late' }, { args: { filePath: join(dir, 'src', 'a.ts') } }), /BINDING_UNAVAILABLE/);
  // The same binding-less session may still invoke read-only tools: skill
  // must not fail closed while edit keeps rejecting above.
  await assert.doesNotReject(h.enforcement.onToolBefore({ tool: 'skill', sessionID: 'child-impl', callID: 'late-skill' }, { args: {} }));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'reconciled');
  const delivered = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'reconciled' }, ctx(h, 'recovered-impl', 'graph-implementer')));
  assert.equal(delivered.ok, true, JSON.stringify(delivered));
  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
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

  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
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

  // Unmarked writer dispatches are rejected; the marker selects impl-b.
  const plain = await dispatch(h, 'graph-implementer');
  assert.match(plain.args.prompt, /NODE_ID_REQUIRED/);
  assert.equal(h.store.getRun('root').nodes['impl-a'].attempt, 0);

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
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'write', sessionID: 'child-b', callID: 'w1' }, outside),
    /RUNNER_DENIED\(out-of-scope-write\)/,
  );
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
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-b', callID: 'b1' }, escape),
    /RUNNER_DENIED\(out-of-scope-bash\)/,
  );
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
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-explore', callID: 'x2' }, write),
    /RUNNER_DENIED\(out-of-scope-bash\)/,
  );
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
  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
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
  assert.equal(h.enforcement.internals.READ_ONLY_TOOLS.has('skill'), true);

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

  // B is admitted first, but A's host events arrive first. Pair by callID.
  const [second, first] = await Promise.all([
    dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-b]\nwork b' }),
    dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-a]\nwork a' }),
  ]);
  assert.ok(!first.args.prompt.includes('RUNNER_REJECTED'));
  assert.ok(!second.args.prompt.includes('RUNNER_REJECTED'));
  await bindChild(h, 'child-a', 'graph-implementer', first.callID);
  await bindChild(h, 'child-b', 'graph-implementer', second.callID);

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
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'write', sessionID: 'child-a', callID: 'w1' }, escape),
    /RUNNER_DENIED\(out-of-scope-write\)/,
  );
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

  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
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

test('parallel explorers: free dispatches run concurrently under the reader gate and both findings versions survive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-parallel-explorers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir, { readerParallel: 2 });
  await startRun(h);

  // Free exploration phase, no plan yet: two same-turn explorer dispatches
  // with distinct callIDs are both admitted against the shared reader gate.
  const first = await dispatch(h, 'graph-explorer');
  const second = await dispatch(h, 'graph-explorer');
  assert.ok(!first.args.prompt.includes('RUNNER_REJECTED'), first.args.prompt);
  assert.ok(!second.args.prompt.includes('RUNNER_REJECTED'), second.args.prompt);
  await bindChild(h, 'child-x1', 'graph-explorer', first.callID);
  await bindChild(h, 'child-x2', 'graph-explorer', second.callID);
  assert.equal(h.bindings.get('child-x1').active, true);
  assert.equal(h.bindings.get('child-x2').active, true);
  const inFlight = h.enforcement.dispatches.inspect('root').filter((entry) => entry.agent === 'graph-explorer');
  assert.deepEqual(inFlight.map((entry) => entry.sessionId), ['child-x1', 'child-x2']);
  assert.deepEqual(inFlight.map((entry) => entry.bound), [true, true]);

  // While both explorers are in flight a third dispatch fills 2/2 capacity.
  const third = await dispatch(h, 'graph-explorer');
  assert.match(third.args.prompt, /RUNNER_REJECTED/);
  assert.match(third.args.prompt, /READER_CAPACITY/);
  assert.match(third.args.prompt, /2\/2/);

  // Each parallel explorer registers its own findings version while bound.
  const v1 = JSON.parse(await h.tools.graph_submit_findings.execute(
    { summary: 'auth module map', evidence: ['src/auth.ts:1'], learnings: ['auth cache poisoning risk'] },
    ctx(h, 'child-x1', 'graph-explorer'),
  ));
  assert.equal(v1.ok, true, JSON.stringify(v1));
  assert.equal(v1.artifact, 'findings@1');
  const v2 = JSON.parse(await h.tools.graph_submit_findings.execute(
    { summary: 'token lifecycle map', evidence: ['src/token.ts:1'], learnings: ['token rotation window drift'] },
    ctx(h, 'child-x2', 'graph-explorer'),
  ));
  assert.equal(v2.ok, true, JSON.stringify(v2));
  assert.equal(v2.artifact, 'findings@2');
  assert.deepEqual(h.store.getRun('root').findingsLog.map((entry) => entry.version), [1, 2]);

  // Finishing the first explorer frees its reader slot for a fourth dispatch.
  await childIdle(h, 'child-x1');
  const fourth = await dispatch(h, 'graph-explorer');
  assert.ok(!fourth.args.prompt.includes('RUNNER_REJECTED'), fourth.args.prompt);

  // The free planner prompt aggregates learnings from BOTH explorers' versions.
  const planning = await dispatch(h, 'graph-planner');
  assert.ok(planning.args.prompt.includes('- (findings@1) auth cache poisoning risk'), planning.args.prompt);
  assert.ok(planning.args.prompt.includes('- (findings@2) token rotation window drift'), planning.args.prompt);

  // The denied third call is the only gate-blocked dispatch on the run.
  const gateBlocked = h.store.getRun('root').violations.filter((entry) => entry.kind === 'gate-blocked-dispatch');
  assert.equal(gateBlocked.length, 1);
  assert.match(gateBlocked[0].detail, /READER_CAPACITY/);
});

for (const agent of ['graph-explorer', 'graph-multimodal']) {
  test(`${agent} free dispatch ignores marker-like prose`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `loop-free-marker-${agent}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const h = harness(dir);
    await startRun(h);

    const result = await dispatch(h, agent, { prompt: 'Inspect the [nodeId: syntax in the parser documentation' });
    assert.ok(!result.args.prompt.includes('RUNNER_REJECTED'), result.args.prompt);
  });
}

test('crash on the final attempt: refund plus cross-restart task_id continuation avoids reset', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-crash-final-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  // The crash happened on the node's third and final attempt.
  const preCrash = h.store.getRun('root');
  preCrash.nodes['impl-1'].attempt = 3;
  await h.store.saveRun(preCrash);

  // Restart: fresh plugin state over the same directory.
  h = harness(dir);
  await startRun(h);
  const restarted = h.store.getRun('root');
  assert.equal(restarted.status, 'RECOVERY_REQUIRED');
  assert.equal(restarted.nodes['impl-1'].attempt, 2); // interrupted attempt refunded

  const resume = JSON.parse(await h.tools.graph_run_resume.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(resume.ok, true, JSON.stringify(resume));
  assert.equal(restarted.nodes['impl-1'].state, 'PENDING');
  assert.equal(restarted.nodes['impl-1'].sessionId, 'child-impl');

  // task_id continuation picks the interrupted session back up across the
  // restart; its side-effect ledger travels with the dispatch.
  const conflict = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:other-impl]\nwork elsewhere', task_id: 'child-impl' });
  assert.match(conflict.args.prompt, /TASK_NODE_MISMATCH/);
  assert.equal(Object.hasOwn(conflict.args, 'task_id'), false);
  assert.equal(restarted.nodes['impl-1'].state, 'PENDING');
  assert.equal(restarted.nodes['impl-1'].attempt, 2);
  assert.deepEqual(h.enforcement.dispatches.inspect('root'), []);
  const continuation = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-1]\ncontinue where you stopped', task_id: 'child-impl' });
  assert.ok(!continuation.args.prompt.includes('RUNNER_REJECTED'), continuation.args.prompt);
  assert.match(continuation.args.prompt, /Assigned nodeId: impl-1/);
  assert.match(continuation.args.prompt, /副作用/);
  await bindChild(h, 'child-impl', 'graph-implementer');
  const after = h.store.getRun('root');
  assert.equal(after.nodes['impl-1'].state, 'RUNNING');
  assert.equal(after.nodes['impl-1'].attempt, 3); // refunded crash + one fresh charge
  assert.equal(after.nodes['impl-1'].sessionId, 'child-impl');

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'recovered');
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'recovered after crash' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  await bindChild(h, 'child-verify', 'graph-verifier');
  const verdict = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('REVISE returns to the same planner and critic via task_id with injected findings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-revise-continue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'evidence for the plan', evidence: ['a.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'p1', 'graph-planner');
  const v1 = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'p1', 'graph-planner')));
  assert.equal(v1.ok, true, JSON.stringify(v1));
  await childIdle(h, 'p1');

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'c1', 'graph-plan-critic');
  const revise1 = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'REVISE', findings: ['add risk section'] }, ctx(h, 'c1', 'graph-plan-critic')));
  assert.equal(revise1.ok, true, JSON.stringify(revise1));
  await childIdle(h, 'c1');

  // The revision dispatch binds the plan node and mechanically carries the
  // critic's findings — no relay required.
  const round2 = await dispatch(h, 'graph-planner');
  assert.match(round2.args.prompt, /Assigned nodeId: plan-1/);
  assert.match(round2.args.prompt, /修訂要求/);
  assert.match(round2.args.prompt, /add risk section/);
  await bindChild(h, 'p2', 'graph-planner');
  const v2 = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'p2', 'graph-planner')));
  assert.equal(v2.ok, true, JSON.stringify(v2));

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'c2', 'graph-plan-critic');
  const revise2 = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 2, verdict: 'REVISE', findings: ['shrink scope'] }, ctx(h, 'c2', 'graph-plan-critic')));
  assert.equal(revise2.ok, true, JSON.stringify(revise2));
  await childIdle(h, 'c2');

  // The SAME planner session continues its next task after the second
  // rejection: sessionId survived the plan rebuild.
  const round3 = await dispatch(h, 'graph-planner', { prompt: 'apply the second round', task_id: 'p2' });
  assert.ok(!round3.args.prompt.includes('RUNNER_REJECTED'), round3.args.prompt);
  assert.match(round3.args.prompt, /Assigned nodeId: plan-1/);
  assert.match(round3.args.prompt, /修訂要求/);
  assert.match(round3.args.prompt, /shrink scope/);
  await bindChild(h, 'p2', 'graph-planner');
  const v3 = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'p2', 'graph-planner')));
  assert.equal(v3.ok, true, JSON.stringify(v3));

  // The SAME critic session re-reviews the new plan version.
  const criticAgain = await dispatch(h, 'graph-plan-critic', { prompt: 'review v3', task_id: 'c2' });
  assert.ok(!criticAgain.args.prompt.includes('RUNNER_REJECTED'), criticAgain.args.prompt);
  await bindChild(h, 'c2', 'graph-plan-critic');
  const pass = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 3, verdict: 'PASS', findings: [] }, ctx(h, 'c2', 'graph-plan-critic')));
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('user reset carries prior rejections and findings into the successor run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'auth flow spans three modules', evidence: ['src/auth.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.carryOver.reviewFindings, 1);

  const successor = h.store.getRun('root:2');
  assert.equal(successor.carryOver.predecessorRunId, 'root');
  assert.deepEqual(successor.carryOver.reviewFindings, ['misses token rotation entirely']);
  assert.equal(successor.carryOver.findingsDigest, 'auth flow spans three modules');
  const inspected = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(inspected.carryOver.predecessorRunId, 'root');

  const exploration = await dispatch(h, 'graph-explorer');
  assert.match(exploration.args.prompt, /前次 run 資訊/);
  assert.match(exploration.args.prompt, /root 因使用者 reset/);
  assert.match(exploration.args.prompt, /misses token rotation entirely/);
  assert.match(exploration.args.prompt, /auth flow spans three modules/);
  assert.match(exploration.args.prompt, /重新驗證/);
  const planning = await dispatch(h, 'graph-planner');
  assert.match(planning.args.prompt, /前次 run 資訊/);
});

test('repair dispatches carry the verifier failure evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-repair-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'first try');
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'first try' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  await childIdle(h, 'child-impl');
  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  await bindChild(h, 'child-verify', 'graph-verifier');
  const failed = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'FAIL', commands: [{ command: 'npm test', exitCode: 1 }], summary: 'regression in auth errors' },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(failed.effect, 'repair');
  await childIdle(h, 'child-verify');

  const repair = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  assert.match(repair.args.prompt, /修復要求/);
  assert.match(repair.args.prompt, /regression in auth errors/);
  assert.match(repair.args.prompt, /npm test \(exit 1\)/);
  // The failed verification is durable evidence, not a dropped verdict.
  assert.equal(h.store.getRun('root').artifacts['verification:verify-1'].payload.verdict, 'FAIL');
});

test('round-1 planner continues through task_id after REVISE and submits v2 (field regression)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-free-continue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'evidence', evidence: ['a.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');

  // Round 1: a FREE-bound planner session submits v1, then goes idle.
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'p1', 'graph-planner');
  const v1 = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'p1', 'graph-planner')));
  assert.equal(v1.ok, true, JSON.stringify(v1));
  await childIdle(h, 'p1');
  // A successful plan submission invalidates old dispatch bindings: the
  // round-1 session has neither a binding nor a node sessionId to resume.
  assert.equal(h.bindings.has('p1'), false);

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'c1', 'graph-plan-critic');
  const revise = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'REVISE', findings: ['cover token rotation'] }, ctx(h, 'c1', 'graph-plan-critic')));
  assert.equal(revise.ok, true, JSON.stringify(revise));
  await childIdle(h, 'c1');

  // The SAME round-1 session continues its next task: the plan node binds,
  // the attempt is charged and the critic's findings are injected. Before
  // this fix the continuation was rejected (FRESH_SESSION_REQUIRED) and the
  // leftover stale binding turned graph_submit_plan into BINDING_UNAVAILABLE.
  const continuation = await dispatch(h, 'graph-planner', { prompt: 'revise the plan', task_id: 'p1' });
  assert.ok(!continuation.args.prompt.includes('RUNNER_REJECTED'), continuation.args.prompt);
  assert.match(continuation.args.prompt, /Assigned nodeId: plan-1/);
  assert.match(continuation.args.prompt, /修訂要求/);
  assert.match(continuation.args.prompt, /cover token rotation/);
  await bindChild(h, 'p1', 'graph-planner');
  const state = h.store.getRun('root');
  assert.equal(state.nodes['plan-1'].state, 'RUNNING');
  assert.equal(state.nodes['plan-1'].sessionId, 'p1');
  assert.equal(h.bindings.get('p1').active, true);
  const v2 = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'p1', 'graph-planner')));
  assert.equal(v2.ok, true, JSON.stringify(v2));
  await childIdle(h, 'p1');

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'c2', 'graph-plan-critic');
  const pass = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 2, verdict: 'PASS', findings: [] }, ctx(h, 'c2', 'graph-plan-critic')));
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
});

test('declared deliverables surface as mechanical progress through graph_inspect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  const DELIVERY_SPECS = SPECS.map((spec) => spec.id === 'impl-1'
    ? { ...spec, writeScope: ['src/**'], deliverables: ['src/a.ts', 'src/notes.md'] }
    : spec);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: DELIVERY_SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');

  // One of two deliverables exists so far: inspect reports 1/2 mechanically.
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'a');
  await h.enforcement.onToolAfter({ tool: 'write', sessionID: 'child-impl', callID: 'w1', args: { filePath: join(dir, 'src', 'a.ts'), content: 'a' } }, { title: 'write', output: 'ok' });
  let inspected = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  let impl = inspected.nodes.find((node) => node.id === 'impl-1');
  assert.equal(impl.sideEffectCount >= 1, true);
  assert.equal(impl.lastActivityAt !== null, true);
  assert.deepEqual(impl.deliverables, { total: 2, done: 1, pending: ['src/notes.md'] });

  await writeFile(join(dir, 'src', 'notes.md'), 'notes');
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts', 'src/notes.md'], summary: 'both deliverables' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  inspected = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  impl = inspected.nodes.find((node) => node.id === 'impl-1');
  assert.deepEqual(impl.deliverables, { total: 2, done: 2, pending: [] });
});

test('{{run}} tokens expand before validation and reach the bound implementer', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-runtoken-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  const TOKEN_SPECS = SPECS.map((spec) => spec.id === 'impl-1'
    ? { ...spec, writeScope: ['lanes/{{run}}/**'], deliverables: ['lanes/{{run}}/out.txt'], allowShell: true }
    : spec);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: TOKEN_SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.runToken, 'root');
  assert.deepEqual(plan.lanes, [{ id: 'impl-1', writeScope: ['lanes/root/**'], deliverables: ['lanes/root/out.txt'] }]);

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));

  // The dispatch ack carries the runner-expanded authoritative scope.
  const out = await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-1]\nbuild lane' });
  assert.match(out.args.prompt, /\[RUNNER\] writeScope: lanes\/root\/\*\*\. Write only inside these literal paths\./);
  assert.match(out.args.prompt, /\[RUNNER\] deliverables: lanes\/root\/out\.txt\./);
  await bindChild(h, 'child-impl', 'graph-implementer');

  // Shell screening matches the expanded scope: inside passes, outside is denied.
  const fine = await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-impl', callID: 'tk1' }, { args: { command: 'mkdir -p lanes/root && echo hi > lanes/root/out.txt' } });
  assert.equal(fine ?? null, null);
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-impl', callID: 'tk2' }, { args: { command: 'echo hi > lanes/other/out.txt' } }),
    /RUNNER_DENIED\(out-of-scope-bash\)/,
  );
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'out-of-scope-bash' && entry.detail.includes('lanes/other/out.txt')));
});

test('plans with unsubstituted placeholders are rejected at submission', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-runtoken-reject-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  const BAD_SPECS = SPECS.map((spec) => spec.id === 'impl-1'
    ? { ...spec, writeScope: ['lanes/<run>/**'] }
    : spec);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: BAD_SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'INVALID_GRAPH');
  assert.match(plan.detail, /unsubstituted template placeholder/);
});

test('a denied bash that executes anyway taints the attempt (strict failure)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-taint-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');

  // SPECS' impl node has no allowShell: the before-hook hard-blocks...
  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-impl', callID: 'by1' }, { args: { command: 'uv venv .venv' } }),
    /RUNNER_DENIED\(blocked-bash\).*Do not retry bash/,
  );
  // ...but if the host executes it anyway, the attempt is strictly failed.
  await h.enforcement.onToolAfter({ tool: 'bash', sessionID: 'child-impl', callID: 'by1', args: { command: 'uv venv .venv' } }, { title: 'bash', output: 'ran' });
  const node = h.store.getRun('root').nodes['impl-1'];
  assert.equal(node.state, 'FAILED');
  assert.deepEqual(node.lastFailure, { code: 'EXECUTED_DESPITE_DENY', detail: 'bash executed despite runner denial', retryable: false });
  assert.ok(h.store.getRun('root').violations.some((entry) => entry.kind === 'executed-despite-deny'));
  // A tainted attempt can never reach SUCCEEDED: submission is rejected.
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: [], summary: 'x' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, false);
});

test('blocked-bash loop closes through unresolved report and plan revision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-blocked-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');

  await assert.rejects(
    () => h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-impl', callID: 'bx1' }, { args: { command: 'python3 -c "print(1)"' } }),
    /RUNNER_DENIED\(blocked-bash\)/,
  );
  // The implementer wraps up: submits its (empty) change with an unresolved
  // report asking for allowShell — the structured channel back to the
  // coordinator.
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: [], summary: 'blocked: shell required', unresolved: ['plan must set allowShell=true or split an install node'] }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  assert.equal(h.store.getRun('root').nodes['impl-1'].state, 'SUCCEEDED');

  // The planner revises: v2 sets allowShell on the same node id (attempt
  // and session are preserved), critic passes, the implementer is
  // re-dispatched and bash now goes through.
  const REVISED = SPECS.map((spec) => spec.id === 'impl-1' ? { ...spec, allowShell: true, writeScope: ['src/**'] } : spec);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner2', 'graph-planner');
  const revised = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: REVISED }, ctx(h, 'child-planner2', 'graph-planner')));
  assert.equal(revised.ok, true, JSON.stringify(revised));
  assert.equal(revised.planVersion, 2);
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic2', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 2, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic2', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { prompt: '[nodeId:impl-1]\nretry with shell' });
  await bindChild(h, 'child-impl2', 'graph-implementer');
  const rerun = await h.enforcement.onToolBefore({ tool: 'bash', sessionID: 'child-impl2', callID: 'bx2' }, { args: { command: 'python3 -c "print(1)"' } });
  assert.equal(rerun ?? null, null);
  assert.equal(h.store.getRun('root').nodes['impl-1'].attempt, 2);
});

test('graph_inspect counts on-disk deliverables the ledger never saw', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-fs-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);
  const FS_SPECS = SPECS.map((spec) => spec.id === 'impl-1'
    ? { ...spec, writeScope: ['src/**', '.tmp-environment/**'], deliverables: ['src/a.ts', '.tmp-environment/venv/bin/python'] }
    : spec);
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  await h.tools.graph_submit_plan.execute({ intent: 'change', specs: FS_SPECS }, ctx(h, 'child-planner', 'graph-planner'));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic'));
  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');

  // The venv python was created by bash: it is on disk but absent from the
  // edit/write ledger. inspect's fs fallback must still count it as done.
  await mkdir(join(dir, '.tmp-environment', 'venv', 'bin'), { recursive: true });
  await writeFile(join(dir, '.tmp-environment', 'venv', 'bin', 'python'), '#!python');
  const report = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'child-impl', 'graph-implementer')));
  const impl = report.nodes.find((node) => node.id === 'impl-1');
  assert.deepEqual(impl.deliverables, { total: 2, done: 1, pending: ['src/a.ts'] });
});

test('evidence fields flow end to end: learnings reach the planner, risks reach the verifier, artifacts gate PASS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-evidence-fields-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  const findings = JSON.parse(await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow located', evidence: ['src/auth.ts:1'], learnings: ['token refresh is rate-limited per session'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  ));
  assert.equal(findings.ok, true, JSON.stringify(findings));
  await childIdle(h, 'child-explore');

  const planning = await dispatch(h, 'graph-planner');
  // Header is version-agnostic since learnings are individually tagged.
  assert.match(planning.args.prompt, /Explorer learnings \(incorporate these/);
  assert.match(planning.args.prompt, /- \(findings@1\) token refresh is rate-limited per session/);
  await bindChild(h, 'child-planner', 'graph-planner');
  const deliverableSpecs = SPECS.map((entry) => (entry.id === 'impl-1' ? { ...entry, deliverables: ['src/a.ts'] } : entry));
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: deliverableSpecs }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));

  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const pass = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(pass.ok, true);

  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'fixed auth errors');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  const change = JSON.parse(await h.tools.graph_submit_change.execute(
    { nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'fixed auth errors', risks: ['empty input still falls through to the legacy path'] },
    ctx(h, 'child-impl', 'graph-implementer'),
  ));
  assert.equal(change.ok, true, JSON.stringify(change));
  await childIdle(h, 'child-impl');

  const verifying = await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  assert.match(verifying.args.prompt, /implementer-reported risks/);
  assert.match(verifying.args.prompt, /empty input still falls through/);
  await bindChild(h, 'child-verify', 'graph-verifier');

  const missing = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }], artifacts: ['logs/missing.log'] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ARTIFACT_MISSING');
  assert.equal(missing.retryable, undefined); // plain rejected reply, no claim failure recorded
  assert.equal(h.store.getRun('root').nodes['verify-1'].state, 'RUNNING');

  const bare = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'ARTIFACT_REQUIRED');
  assert.match(bare.hint, /artifact path/);
  assert.equal(h.store.getRun('root').nodes['verify-1'].state, 'RUNNING');

  await mkdir(join(dir, 'logs'), { recursive: true });
  await writeFile(join(dir, 'logs', 'run.log'), 'ok');
  const rich = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 0 }], artifacts: ['logs/run.log'], probed: ['malformed input rejected with 400'], skipped: ['concurrency n/a: single-threaded CLI'] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(rich.ok, true, JSON.stringify(rich));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  const inspected = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  const verification = inspected.artifacts.find((entry) => entry.name === 'verification:verify-1');
  assert.deepEqual(verification.counts, { artifacts: 1, probed: 1, skipped: 1 });
  const changeEntry = inspected.artifacts.find((entry) => entry.name === 'change:impl-1');
  assert.deepEqual(changeEntry.counts, { risks: 1 });
  const findingsEntry = inspected.artifacts.find((entry) => entry.name === 'findings');
  assert.deepEqual(findingsEntry.counts, { learnings: 1 });
});

test('reset carry-over includes explorer learnings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-learnings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow spans three modules', evidence: ['src/auth.ts:1'], learnings:['rotate tokens before refresh-window expiry'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(reset.carryOver.learnings, 1);
  const successor = h.store.getRun('root:2');
  assert.deepEqual(successor.carryOver.learnings, ['rotate tokens before refresh-window expiry']);
  const planning = await dispatch(h, 'graph-planner');
  assert.match(planning.args.prompt, /learnings/);
  assert.match(planning.args.prompt, /rotate tokens before refresh-window expiry/);
});

test('reset carry-over digest aggregates recent findings versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-digest-agg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'auth spans three modules', evidence: ['src/auth.ts:1'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await h.tools.graph_submit_findings.execute({ summary: 'token rotation windows differ', evidence: ['src/token.ts:4'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  const successor = h.store.getRun('root:2');
  // Oldest→newest so the digest reads chronologically.
  assert.equal(successor.carryOver.findingsDigest, 'auth spans three modules | token rotation windows differ');
});

test('reset carry-over learnings aggregate across versions, newest first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-learnings-agg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute({ summary: 'auth spans three modules', evidence: [], learnings: ['l-old'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await h.tools.graph_submit_findings.execute({ summary: 'token rotation windows differ', evidence: [], learnings: ['l-new'] }, ctx(h, 'child-explore', 'graph-explorer'));
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  const successor = h.store.getRun('root:2');
  assert.deepEqual(successor.carryOver.learnings, ['l-new', 'l-old']);
});

test('reset carry-over learnings cap at 8 with the newest version draining first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-learnings-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'auth spans three modules', evidence: [], learnings: Array.from({ length: 6 }, (_unused, index) => `old-${index + 1}`) },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await h.tools.graph_submit_findings.execute(
    { summary: 'token rotation windows differ', evidence: [], learnings: Array.from({ length: 6 }, (_unused, index) => `new-${index + 1}`) },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  const successor = h.store.getRun('root:2');
  assert.equal(successor.carryOver.learnings.length, 8);
  // The freshest version's learnings survive the cap; the budget then drains
  // the older version from its first learning.
  assert.deepEqual(
    successor.carryOver.learnings,
    [
      ...Array.from({ length: 6 }, (_unused, index) => `new-${index + 1}`),
      ...Array.from({ length: 2 }, (_unused, index) => `old-${index + 1}`),
    ],
  );
});

test('reset carry-over falls back to the latest artifact without findings history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-carryover-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow spans three modules', evidence: ['src/auth.ts:1'], learnings: ['rotate tokens before refresh-window expiry'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');
  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'plan-only', specs: PLAN_ONLY_SPECS() }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const fail = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'FAIL', findings: ['misses token rotation entirely'] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(fail.effect, 'await-decision');
  await childIdle(h, 'child-critic');

  // Simulate a pre-retention run file: history is absent, artifact remains.
  delete h.store.getRun('root').findingsLog;
  const reset = JSON.parse(await h.tools.graph_run_decide.execute({ action: 'reset', reason: 'user wants the rotation handled' }, ctx(h, 'root', 'graph-orchestrator')));
  assert.equal(reset.ok, true, JSON.stringify(reset));
  const successor = h.store.getRun('root:2');
  assert.equal(successor.carryOver.findingsDigest, 'auth flow spans three modules');
  assert.deepEqual(successor.carryOver.learnings, ['rotate tokens before refresh-window expiry']);
});

test('findings submissions retain bounded multi-version history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-findings-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  const first = JSON.parse(await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow located', evidence: Array.from({ length: 10 }, (_unused, index) => `ev-${index + 1}`), learnings: ['cache poison risk'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  ));
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = JSON.parse(await h.tools.graph_submit_findings.execute(
    { summary: 'token rotation mapped', evidence: ['src/token.ts:4'], learnings: ['token rotation window'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  ));
  assert.equal(second.ok, true, JSON.stringify(second));

  // The latest slot stays authoritative; history keeps each version's own
  // summary/learnings and bounds evidence at 8 entries.
  const state = h.store.getRun('root');
  assert.equal(state.artifacts.findings.version, 2);
  assert.ok(Array.isArray(state.findingsLog));
  assert.deepEqual(state.findingsLog.map((entry) => entry.version), [1, 2]);
  assert.equal(state.findingsLog[0].summary, 'auth flow located');
  assert.deepEqual(state.findingsLog[0].learnings, ['cache poison risk']);
  assert.equal(state.findingsLog[1].summary, 'token rotation mapped');
  assert.deepEqual(state.findingsLog[1].learnings, ['token rotation window']);
  assert.deepEqual(state.findingsLog[0].evidence, Array.from({ length: 8 }, (_unused, index) => `ev-${index + 1}`));
  await childIdle(h, 'child-explore');
});

test('findings history is FIFO-capped at 8 retained versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-findings-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  for (let round = 1; round <= 10; round += 1) {
    const outcome = JSON.parse(await h.tools.graph_submit_findings.execute(
      { summary: `sweep ${round}`, evidence: [], learnings: [] },
      ctx(h, 'child-explore', 'graph-explorer'),
    ));
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
  }
  const state = h.store.getRun('root');
  assert.equal(state.findingsLog.length, 8);
  assert.deepEqual(state.findingsLog.map((entry) => entry.version), [3, 4, 5, 6, 7, 8, 9, 10]);
  await childIdle(h, 'child-explore');
});

test('planner dispatch aggregates learnings across recent findings versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-learnings-agg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow located', evidence: [], learnings: ['cache poison risk'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await h.tools.graph_submit_findings.execute(
    { summary: 'token rotation mapped', evidence: [], learnings: ['token rotation window'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');

  const planning = await dispatch(h, 'graph-planner');
  assert.match(planning.args.prompt, /Explorer learnings \(incorporate these/);
  assert.ok(planning.args.prompt.includes('- (findings@2) token rotation window'));
  assert.ok(planning.args.prompt.includes('- (findings@1) cache poison risk'));
  // Newest version first so the freshest learnings survive the line cap.
  assert.ok(
    planning.args.prompt.indexOf('- (findings@2) token rotation window')
      < planning.args.prompt.indexOf('- (findings@1) cache poison risk'),
    planning.args.prompt,
  );
});

test('legacy runs without findings history fall back to the latest artifact', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-learnings-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'auth flow located', evidence: [], learnings: ['token refresh is rate-limited per session'] },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');

  // Simulate a pre-retention run file: history is absent, artifact remains.
  delete h.store.getRun('root').findingsLog;
  const planning = await dispatch(h, 'graph-planner');
  assert.match(planning.args.prompt, /- \(findings@1\) token refresh is rate-limited per session/);
});

test('learnings aggregation caps at 16 lines, newest version first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-learnings-linecap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-explorer');
  await bindChild(h, 'child-explore', 'graph-explorer');
  await h.tools.graph_submit_findings.execute(
    { summary: 'first sweep', evidence: [], learnings: Array.from({ length: 10 }, (_unused, index) => `old-${index + 1}`) },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await h.tools.graph_submit_findings.execute(
    { summary: 'second sweep', evidence: [], learnings: Array.from({ length: 10 }, (_unused, index) => `new-${index + 1}`) },
    ctx(h, 'child-explore', 'graph-explorer'),
  );
  await childIdle(h, 'child-explore');

  const planning = await dispatch(h, 'graph-planner');
  const lines = planning.args.prompt.split('\n').filter((line) => /^- \(findings@\d+\)/.test(line));
  assert.equal(lines.length, 16);
  assert.equal(lines.filter((line) => line.startsWith('- (findings@2)')).length, 10);
  // The remaining budget drains the older version from its first learning.
  assert.deepEqual(
    lines.filter((line) => line.startsWith('- (findings@1)')),
    Array.from({ length: 6 }, (_unused, index) => `- (findings@1) old-${index + 1}`),
  );
});

test('light path: small fix runs plan → implement → verify without a critic', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-light-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({
    intent: 'light',
    specs: [
      { id: 'plan-1', kind: 'plan', agent: 'graph-planner', dependsOn: [], inputs: [], outputs: [], acceptance: ['plan'] },
      { id: 'impl-1', kind: 'implement', agent: 'graph-implementer', dependsOn: ['plan-1'], inputs: [], outputs: [], writeScope: ['README.md'], acceptance: ['typo fixed'] },
      { id: 'verify-1', kind: 'verify', agent: 'graph-verifier', dependsOn: ['impl-1'], inputs: [], outputs: [], acceptance: ['verify'] },
    ],
  }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.mode, 'light');
  assert.match(plan.next, /critic-free/);

  const impl = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  assert.ok(!impl.args.prompt.includes('RUNNER_REJECTED'));
  assert.match(impl.args.prompt, /Assigned nodeId: impl-1/);
  await bindChild(h, 'child-impl', 'graph-implementer');
  await writeFile(join(dir, 'README.md'), '#fixed typo');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'README.md') } }, { title: 'edit', output: 'ok' });
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['README.md'], summary: 'fixed typo' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  await childIdle(h, 'child-impl');

  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  await bindChild(h, 'child-verify', 'graph-verifier');
  const pass = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: "grep -q fixed README.md", exitCode: 0 }] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  assert.deepEqual(h.store.getRun('root').artifacts['change:impl-1'].basedOn, ['plan@1']);
});

test('baseline flow end to end: pre-change red suite does not block an honest PASS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-baseline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness(dir);
  await startRun(h);

  const BASELINE_SPECS = SPECS.map((entry) => {
    if (entry.id === 'impl-1') return { ...entry, dependsOn: ['review-1', 'base-1'] };
    return entry;
  }).concat([
    { id: 'base-1', kind: 'verify', agent: 'graph-verifier', dependsOn: ['review-1'], inputs: [], outputs: ['baseline:base-1'], baseline: true, acceptance: ['capture baseline'] },
  ]);

  await dispatch(h, 'graph-planner');
  await bindChild(h, 'child-planner', 'graph-planner');
  const plan = JSON.parse(await h.tools.graph_submit_plan.execute({ intent: 'change', specs: BASELINE_SPECS }, ctx(h, 'child-planner', 'graph-planner')));
  assert.equal(plan.ok, true, JSON.stringify(plan));
  await dispatch(h, 'graph-plan-critic');
  await bindChild(h, 'child-critic', 'graph-plan-critic');
  const review = JSON.parse(await h.tools.graph_submit_review.execute({ planVersion: 1, verdict: 'PASS', findings: [] }, ctx(h, 'child-critic', 'graph-plan-critic')));
  assert.equal(review.ok, true, JSON.stringify(review));

  // The implementer must wait for the baseline: only the baseline verifier is admissible now.
  const earlyImpl = await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  assert.match(earlyImpl.args.prompt, /RUNNER_REJECTED/);
  assert.match(earlyImpl.args.prompt, /base-1/);

  await dispatch(h, 'graph-verifier', { nodeId: 'base-1' });
  await bindChild(h, 'child-base', 'graph-verifier');
  assert.equal(h.bindings.get('child-base').nodeId, 'base-1');
  const baseline = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'base-1', verdict: 'BASELINE', commands: [{ command: 'npm test', exitCode: 1 }, { command: 'npm run lint', exitCode: 0 }], summary: 'suite partially red before the change' },
    ctx(h, 'child-base', 'graph-verifier'),
  ));
  assert.equal(baseline.ok, true, JSON.stringify(baseline));
  await childIdle(h, 'child-base');

  await dispatch(h, 'graph-implementer', { nodeId: 'impl-1' });
  await bindChild(h, 'child-impl', 'graph-implementer');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'fixed auth errors');
  await h.enforcement.onToolAfter({ tool: 'edit', sessionID: 'child-impl', callID: 'e1', args: { filePath: join(dir, 'src', 'a.ts') } }, { title: 'edit', output: 'ok' });
  const change = JSON.parse(await h.tools.graph_submit_change.execute({ nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'fixed auth errors' }, ctx(h, 'child-impl', 'graph-implementer')));
  assert.equal(change.ok, true, JSON.stringify(change));
  await childIdle(h, 'child-impl');

  await dispatch(h, 'graph-verifier', { nodeId: 'verify-1' });
  await bindChild(h, 'child-verify', 'graph-verifier');
  // npm test still fails exactly as it did before the change (baseline match) + a green command.
  const pass = JSON.parse(await h.tools.graph_submit_verification.execute(
    { nodeId: 'verify-1', verdict: 'PASS', commands: [{ command: 'npm test', exitCode: 1 }, { command: 'grep -q fixed src/a.ts', exitCode: 0 }], probed: ['pre-existing failure matched baseline: npm test exit 1'] },
    ctx(h, 'child-verify', 'graph-verifier'),
  ));
  assert.equal(pass.ok, true, JSON.stringify(pass));
  assert.equal(h.store.getRun('root').status, 'SUCCEEDED');
  const inspected = JSON.parse(await h.tools.graph_inspect.execute({}, ctx(h, 'root', 'graph-orchestrator')));
  const baselineEntry = inspected.artifacts.find((entry) => entry.name === 'baseline:base-1');
  assert.deepEqual(baselineEntry.counts, { commands: 2 });
});
