import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { lstat, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore, newRun, SCHEMA_VERSION } from '../src/run-state.mjs';
import { createRunner } from '../src/runner.mjs';
import { validateTaskGraph } from '../src/task-spec.mjs';

const NOW = '2026-09-07T00:00:00.000Z';
const runner = createRunner({ maxAttempts: 3, maxPlanRevisions: 2 });

function spec(id, kind, agent, overrides = {}) {
  return { id, kind, agent, dependsOn: [], inputs: [], outputs: [], acceptance: ['done'], ...overrides };
}
function changeGraph({ writeScope = ['src/a.ts'] } = {}) {
  const specs = [
    spec('explore-1', 'explore', 'graph-explorer', { outputs: ['findings'] }),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'], outputs: ['plan'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'], outputs: ['review'] }),
    spec('impl-1', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope, outputs: ['change:impl-1'] }),
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1'], outputs: ['verification:verify-1'] }),
  ];
  return validateTaskGraph(specs);
}
function freshRun(graph = changeGraph()) {
  const state = newRun({ runId: 'run-1', rootSessionId: 'sess-root', now: NOW });
  const submission = runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  assert.equal(submission.ok, true, JSON.stringify(submission));
  return state;
}
async function dispatchCriticAndPass(state, planVersion = 1, approvedParallel = null) {
  const admit = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-critic' });
  const review = runner.submitReview(state, { planVersion, verdict: 'PASS', findings: [], approvedParallel, now: NOW });
  assert.equal(review.ok, true, JSON.stringify(review));
  return admit;
}
async function dispatchImplementerAndSucceed(state, { snapshot = {} } = {}) {
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-impl' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });
  const change = runner.submitChange(state, { nodeId: admit.nodeId, filesTouched: ['src/a.ts'], summary: 'fixed', snapshot, now: NOW });
  assert.equal(change.ok, true, JSON.stringify(change));
  return admit;
}
async function dispatchVerifier(state, verdict, commands = [{ command: 'npm test', exitCode: 0 }], snapshot = { 'src/a.ts': 'hash-post' }) {
  const admit = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-verify' });
  const result = runner.submitVerification(state, { nodeId: admit.nodeId, verdict, commands, snapshot, now: NOW });
  if (!result.ok) runner.markIncomplete(state, { nodeId: admit.nodeId, now: NOW });
  return result;
}

test('new runs use schema v2 and initialize request capture as incomplete', () => {
  const state = newRun({ runId: 'schema-v2', rootSessionId: 'schema-v2', now: NOW });
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.request, null);
  assert.equal(state.requestCaptureCompleted, false);
});

test('createRun leaves no in-memory residue when persistence fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-persist-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocker = join(dir, 'blocker');
  await writeFile(blocker, 'x');
  const store = createRunStore({ worktree: blocker });
  await assert.rejects(store.createRun({ runId: 'residue', rootSessionId: 'residue', now: NOW }));
  assert.equal(store.getRun('residue'), null);
});

test('newRun and createRun accept completed initial request metadata', async (t) => {
  const request = {
    text: 'Sanitized initial request',
    truncated: true,
    redactions: 2,
    capturedAt: NOW,
  };
  const state = newRun({
    runId: 'initial-request',
    rootSessionId: 'initial-request',
    now: NOW,
    request,
    requestCaptureCompleted: true,
  });
  assert.deepEqual(state.request, request);
  assert.equal(state.requestCaptureCompleted, true);

  const dir = await mkdtemp(join(tmpdir(), 'loop-store-initial-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  await store.createRun({
    runId: 'initial-request',
    rootSessionId: 'initial-request',
    now: NOW,
    request,
    requestCaptureCompleted: true,
  });
  const persisted = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'initial-request.json'), 'utf8'));
  assert.deepEqual(persisted.request, request);
  assert.equal(persisted.requestCaptureCompleted, true);
});

test('run-state persists atomically, reloads, and locks across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  const state = await store.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW });
  state.mode = 'change';
  await store.saveRun(state);

  const disk = JSON.parse(await readFile(join(dir, '.opencode-loop', 'runs', 'abc123.json'), 'utf8'));
  assert.equal(disk.runId, 'abc123');
  assert.equal(disk.mode, 'change');

  const second = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  const reloaded = await second.loadRun('abc123');
  assert.notEqual(reloaded, state);
  assert.equal(reloaded.mode, 'change');
  reloaded.mode = 'plan-only';
  await second.saveRun(reloaded);
  assert.equal((await store.loadRun('abc123')).mode, 'plan-only');

  await assert.rejects(second.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW }), /locked/);
  await second.releaseRun('abc123');
  const third = createRunStore({ worktree: dir, stateDirectory: '.opencode-loop' });
  await third.createRun({ runId: 'abc123', rootSessionId: 'abc123', now: NOW });

  await assert.rejects(store.createRun({ runId: '../escape', rootSessionId: 'x', now: NOW }), TypeError);
  assert.equal(await store.loadRun('../escape'), null);
  assert.equal(await store.loadRun('missing-run'), null);
});

test('listRunIds offsets valid in-memory run ids and validates the bounded offset', async () => {
  const store = createRunStore();
  const runIds = Array.from({ length: 6 }, (_, index) => `memory-offset-${index}`);
  for (const runId of runIds) await store.createRun({ runId, rootSessionId: runId, now: NOW });

  assert.deepEqual(await store.listRunIds({ limit: 3, offset: 2 }), runIds.slice(2, 5));
  assert.deepEqual(await store.listRunIds({ limit: 3, offset: 6 }), []);
  assert.deepEqual(await store.listRunIds({ limit: 3, offset: 1_000_000 }), []);
  for (const offset of [-1, 1_000_001, 1.5, Number.POSITIVE_INFINITY, '1', null]) {
    await assert.rejects(() => store.listRunIds({ offset }), TypeError);
  }
});

test('persistent listRunIds skips valid run ids by offset and still bounds the page', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-offset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  await Promise.all([
    writeFile(join(runsDir, 'alpha.json'), '{}'),
    writeFile(join(runsDir, 'invalid name.json'), '{}'),
    writeFile(join(runsDir, 'noise.txt'), '{}'),
    writeFile(join(runsDir, 'bravo.json'), '{}'),
    writeFile(join(runsDir, 'charlie.json'), '{}'),
    mkdir(join(runsDir, 'directory.json')),
  ]);
  const store = createRunStore({ worktree: dir });
  const all = await store.listRunIds({ limit: 64 });

  assert.equal(all.length, 3);
  assert.deepEqual(await store.listRunIds({ limit: 2, offset: 1 }), all.slice(1, 3));
  assert.deepEqual(await store.listRunIds({ limit: 2, offset: 3 }), []);
});

test('run-state atomic writes request private temp mode and preserve it after rename', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-mode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const originalWriteFile = fsPromises.writeFile;
  const temporaryModes = [];
  fsPromises.writeFile = async (path, data, options) => {
    if (String(path).includes('.tmp-')) temporaryModes.push(typeof options === 'object' ? options.mode : undefined);
    return originalWriteFile(path, data, options);
  };
  syncBuiltinESMExports();

  try {
    const store = createRunStore({ worktree: dir });
    await store.createRun({ runId: 'private-mode', rootSessionId: 'private-mode', now: NOW });
  } finally {
    fsPromises.writeFile = originalWriteFile;
    syncBuiltinESMExports();
  }

  assert.deepEqual(temporaryModes, [0o600]);
  if (process.platform !== 'win32') {
    const target = join(dir, '.opencode-loop', 'runs', 'private-mode.json');
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
  }
});

test('run-state migrates historical schema v1 without a request as capture-complete v2', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const legacy = newRun({ runId: 'legacy1', rootSessionId: 'legacy1', now: NOW });
  legacy.schemaVersion = 1;
  delete legacy.request;
  delete legacy.requestCaptureCompleted;
  legacy.mode = 'plan-only';
  legacy.revisionCounters['plan-review'] = 2;
  legacy.violations.push({ nodeId: null, kind: 'legacy', detail: 'preserve me', at: NOW });
  await writeFile(join(runsDir, 'legacy1.json'), JSON.stringify(legacy));

  const store = createRunStore({ worktree: dir });
  const migrated = await store.loadRun('legacy1');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.request, null);
  assert.equal(migrated.requestCaptureCompleted, true);
  assert.equal(migrated.mode, 'plan-only');
  assert.equal(migrated.revisionCounters['plan-review'], 2);
  assert.deepEqual(migrated.violations, legacy.violations);
  assert.equal(store.getRun('legacy1'), migrated);

  await store.saveRun(migrated);
  const saved = JSON.parse(await readFile(join(runsDir, 'legacy1.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.request, null);
  assert.equal(saved.requestCaptureCompleted, true);
  assert.equal(saved.mode, 'plan-only');
  assert.equal(saved.revisionCounters['plan-review'], 2);
  assert.deepEqual(saved.violations, legacy.violations);
});

test('run-state migration discards an unexpected historical request and marks capture complete', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-v1-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const request = { text: 'token=raw-legacy-secret', truncated: false, redactions: 0, capturedAt: NOW };
  const legacy = newRun({ runId: 'legacy_request', rootSessionId: 'legacy_request', now: NOW });
  legacy.schemaVersion = 1;
  legacy.request = request;
  delete legacy.requestCaptureCompleted;
  await writeFile(join(runsDir, 'legacy_request.json'), JSON.stringify(legacy));

  const store = createRunStore({ worktree: dir });
  const migrated = await store.loadRun('legacy_request');
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.request, null);
  assert.equal(migrated.requestCaptureCompleted, true);
  assert.equal(JSON.stringify(migrated).includes('raw-legacy-secret'), false);

  await store.saveRun(migrated);
  const saved = await readFile(join(runsDir, 'legacy_request.json'), 'utf8');
  assert.equal(saved.includes('raw-legacy-secret'), false);
});

test('run-state rejects v2 documents with omitted or malformed request metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const store = createRunStore({ worktree: dir });
  const valid = { text: 'request', truncated: false, redactions: 0, capturedAt: NOW };
  const invalid = [
    ['omitted request', undefined],
    ['non-object request', 'request'],
    ['missing text', { truncated: false, redactions: 0, capturedAt: NOW }],
    ['empty text', { ...valid, text: '' }],
    ['non-string text', { ...valid, text: 1 }],
    ['missing truncated', { text: 'request', redactions: 0, capturedAt: NOW }],
    ['non-boolean truncated', { ...valid, truncated: 'false' }],
    ['missing redactions', { text: 'request', truncated: false, capturedAt: NOW }],
    ['negative redactions', { ...valid, redactions: -1 }],
    ['fractional redactions', { ...valid, redactions: 1.5 }],
    ['missing capturedAt', { text: 'request', truncated: false, redactions: 0 }],
    ['empty capturedAt', { ...valid, capturedAt: '' }],
    ['non-string capturedAt', { ...valid, capturedAt: 1 }],
  ];

  for (const [index, [name, request]] of invalid.entries()) {
    await t.test(name, async () => {
      const runId = `bad_request_${index}`;
      const document = newRun({ runId, rootSessionId: runId, now: NOW });
      if (request === undefined) delete document.request;
      else document.request = request;
      await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(document));
      await assert.rejects(store.loadRun(runId), TypeError);
    });
  }
});

test('run-state rejects v2 documents with omitted, malformed, or inconsistent request capture markers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-request-marker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const store = createRunStore({ worktree: dir });
  const request = { text: 'request', truncated: false, redactions: 0, capturedAt: NOW };
  const invalid = [
    ['omitted marker', undefined, null],
    ['null marker', null, null],
    ['string marker', 'false', null],
    ['request with incomplete capture', false, request],
  ];

  for (const [index, [name, marker, storedRequest]] of invalid.entries()) {
    await t.test(name, async () => {
      const runId = `bad_request_marker_${index}`;
      const document = newRun({ runId, rootSessionId: runId, now: NOW });
      document.request = storedRequest;
      if (marker === undefined) delete document.requestCaptureCompleted;
      else document.requestCaptureCompleted = marker;
      await writeFile(join(runsDir, `${runId}.json`), JSON.stringify(document));
      await assert.rejects(store.loadRun(runId), TypeError);
    });
  }
});

test('run-state validates request metadata before saving v2 documents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-save-request-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  const state = await store.createRun({ runId: 'bad_save_request', rootSessionId: 'bad_save_request', now: NOW });
  state.request = { text: 'request', truncated: false, redactions: -1, capturedAt: NOW };
  await assert.rejects(store.saveRun(state), TypeError);

  const markerState = await store.createRun({ runId: 'bad_save_request_marker', rootSessionId: 'bad_save_request_marker', now: NOW });
  markerState.requestCaptureCompleted = 'false';
  await assert.rejects(store.saveRun(markerState), TypeError);
});

test('run-state fails closed on corrupted or foreign schema documents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-store-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  await mkdir(join(dir, '.opencode-loop', 'runs'), { recursive: true });
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad1.json'), JSON.stringify({ ...newRun({ runId: 'bad1', rootSessionId: 'bad1', now: NOW }), schemaVersion: 99 }));
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad2.json'), '{not json');
  await writeFile(join(dir, '.opencode-loop', 'runs', 'bad3.json'), JSON.stringify({ ...newRun({ runId: 'bad3', rootSessionId: 'bad3', now: NOW }), status: 'EXPLODING' }));
  for (const id of ['bad1', 'bad2', 'bad3']) await assert.rejects(store.loadRun(id));
});

test('hashFiles snapshots literals, reports globs and missing files conservatively', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-hash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
  const store = createRunStore({ worktree: dir });
  const snapshot = await store.hashFiles(['a.ts', 'missing.ts', 'src/*.ts']);
  assert.match(snapshot['a.ts'], /^[0-9a-f]{64}$/);
  assert.equal(snapshot['missing.ts'], 'MISSING');
  assert.equal(snapshot['src/*.ts'], 'UNVERIFIABLE');
  const memory = createRunStore({});
  assert.equal((await memory.hashFiles(['a.ts']))['a.ts'], 'UNVERIFIABLE');
});

test('scenario: critic FAIL pauses the run for a user decision; dispatch is rejected', () => {
  const state = freshRun();
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const review = runner.submitReview(state, { planVersion: 1, verdict: 'FAIL', findings: ['plan misses the error path'], now: NOW });
  assert.equal(review.effect, 'await-decision');
  assert.equal(state.status, 'AWAITING_USER_DECISION');
  assert.equal(state.pendingDecision.cause, 'plan-rejected-by-critic');
  assert.match(state.pendingDecision.detail, /plan rejected by critic/);
  assert.equal(state.nodes['review-1'].state, 'PENDING');
  assert.equal(state.artifacts.review.payload.verdict, 'FAIL');

  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'AWAITING_DECISION');
  assert.match(denied.detail, /graph_run_decide/);
  for (const agent of ['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-verifier']) {
    assert.equal(runner.admitDispatch(state, { agent, now: NOW }).allowed, false, agent);
  }
  // The pause cannot be bypassed by replacing the plan, and resume is a no-op.
  assert.equal(runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW }).code, 'AWAITING_DECISION');
  assert.equal(runner.resumeRun(state, { now: NOW }).code, 'AWAITING_DECISION');
  assert.equal(runner.inspect(state).pendingDecision.cause, 'plan-rejected-by-critic');

  // The user's abort decision terminates irreversibly while keeping evidence.
  runner.abortRun(state, { reason: 'user gave up on this goal', now: NOW });
  assert.equal(state.status, 'ABORTED');
  assert.match(state.failReason, /aborted by user: user gave up on this goal/);
  assert.equal(state.decision.action, 'abort');
  assert.equal(runner.admitDispatch(state, { agent: 'graph-explorer', now: NOW }).code, 'RUN_TERMINATED');
  assert.equal(state.artifacts.review.payload.verdict, 'FAIL');
});

test('scenario: implementer cannot be dispatched before review PASS (gate skip rejected)', () => {
  const state = freshRun();
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'NO_READY_NODE');
  assert.match(denied.detail, /review-1/);

  const verifier = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  assert.equal(verifier.allowed, false);
  assert.equal(verifier.code, 'NO_READY_NODE');
});

test('REVISE returns to planner, is capped, and burns the plan artifact version', () => {
  const state = freshRun();
  for (let round = 1; round <= 2; round += 1) {
    const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
    runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
    const verdict = runner.submitReview(state, { planVersion: round, verdict: 'REVISE', findings: [`fix ${round}`], now: NOW });
    assert.equal(verdict.effect, 'revise');
    assert.equal(state.artifacts.plan.status, 'superseded');
    const replan = runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
    assert.equal(replan.version, round + 1);
  }
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const third = runner.submitReview(state, { planVersion: 3, verdict: 'REVISE', findings: ['again'], now: NOW });
  assert.equal(third.effect, 'await-decision');
  assert.equal(state.status, 'AWAITING_USER_DECISION');
  assert.equal(state.pendingDecision.cause, 'plan-revisions-exhausted');
  assert.match(state.pendingDecision.detail, /maxPlanRevisions=2/);
  assert.equal(state.nodes['review-1'].state, 'PENDING');
  assert.equal(state.nodes['plan-1'].state, 'PENDING');
});

test('review verdict must target the current plan version (no stale PASS)', () => {
  const state = freshRun();
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const stale = runner.submitReview(state, { planVersion: 99, verdict: 'PASS', now: NOW });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_PLAN_VERSION');
  assert.equal(state.nodes['review-1'].state, 'RUNNING');

  const resubmitted = runner.submitReview(state, { planVersion: 1, verdict: 'REVISE', findings: ['x'], now: NOW });
  assert.equal(resubmitted.ok, true);
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  const critic2 = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic2.nodeId, { now: NOW, sessionId: 'c' });
  const oldPass = runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now: NOW });
  assert.equal(oldPass.code, 'STALE_PLAN_VERSION');
});

test('happy path: PASS chain completes the run and requires command evidence', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state, { snapshot: { 'src/a.ts': '1'.repeat(64) } });

  const weak = await dispatchVerifier(state, 'PASS', []);
  assert.equal(weak.ok, false);
  assert.equal(weak.code, 'INSUFFICIENT_EVIDENCE');
  const failing = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(failing.ok, false);

  const strong = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 0 }]);
  assert.equal(strong.ok, true, JSON.stringify(strong));
  assert.equal(state.status, 'SUCCEEDED');
  const after = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(after.code, 'RUN_TERMINATED');
});

test('verification FAIL triggers a capped repair loop and supersedes the change', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state);
  const first = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(first.effect, 'repair');
  assert.equal(state.nodes['impl-1'].state, 'PENDING');
  assert.equal(state.artifacts['change:impl-1'].status, 'superseded');

  await dispatchImplementerAndSucceed(state);
  const second = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(second.effect, 'repair');
  await dispatchImplementerAndSucceed(state);
  const third = await dispatchVerifier(state, 'FAIL', [{ command: 'npm test', exitCode: 1 }]);
  assert.equal(third.effect, 'await-decision');
  assert.equal(state.status, 'AWAITING_USER_DECISION');
  assert.equal(state.pendingDecision.cause, 'verification-repair-exhausted');
});

test('UNVERIFIED blocks the run without faking success', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state);
  const result = await dispatchVerifier(state, 'UNVERIFIED', []);
  assert.equal(result.effect, 'blocked');
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.blockedReason.kind, 'info');
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RUN_BLOCKED');
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  assert.equal(state.status, 'RUNNING');
});

test('change submission cross-checks the side-effect ledger and writeScope', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/secret.ts', now: NOW });

  const undisclosed = runner.submitChange(state, { nodeId: admit.nodeId, filesTouched: ['src/a.ts'], summary: 'x', now: NOW });
  assert.equal(undisclosed.code, 'LEDGER_MISMATCH');
  assert.equal(state.nodes['impl-1'].state, 'FAILED');
  assert.ok(state.violations.some((entry) => entry.kind === 'undisclosed-edit'));

  const state2 = freshRun();
  await dispatchCriticAndPass(state2);
  const admit2 = runner.admitDispatch(state2, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state2, admit2.nodeId, { now: NOW, sessionId: 'i2' });
  const outOfScope = runner.submitChange(state2, { nodeId: admit2.nodeId, filesTouched: ['docs/readme.md'], summary: 'x', now: NOW });
  assert.equal(outOfScope.code, 'OUT_OF_SCOPE');
  assert.equal(state2.nodes['impl-1'].state, 'FAILED');
});

test('attempts persist across reload and are not reset by restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-attempts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });
  let state = await store.createRun({ runId: 'r1', rootSessionId: 'r1', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  await dispatchCriticAndPass(state);
  for (let round = 1; round <= 2; round += 1) {
    const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
    runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
    runner.markIncomplete(state, { nodeId: admit.nodeId, now: NOW });
  }
  assert.equal(state.nodes['impl-1'].attempt, 2);
  assert.equal(state.nodes['impl-1'].state, 'INCOMPLETE');
  await store.saveRun(state);

  const reloaded = await store.loadRun('r1');
  assert.equal(reloaded.nodes['impl-1'].attempt, 2);
  const admit = runner.admitDispatch(reloaded, { agent: 'graph-implementer', now: NOW });
  assert.equal(admit.allowed, true);
  runner.beginNode(reloaded, admit.nodeId, { now: NOW, sessionId: 'i' });
  assert.equal(reloaded.nodes['impl-1'].attempt, 3);
  runner.markIncomplete(reloaded, { nodeId: admit.nodeId, now: NOW });
  assert.equal(reloaded.status, 'AWAITING_USER_DECISION');
  assert.equal(reloaded.pendingDecision.cause, 'attempt-budget-exhausted');
  assert.match(reloaded.pendingDecision.detail, /never delivered/);
});

test('writer capacity: disjoint implement nodes run in parallel up to the cap', async () => {
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
    spec('impl-1', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['src/a.ts'] }),
    spec('impl-2', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['docs/b.md'] }),
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1', 'impl-2'] }),
  ]);
  const state = newRun({ runId: 'r2', rootSessionId: 'r2', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  await dispatchCriticAndPass(state);
  assert.equal(runner.implementerCapacity(state), 2);

  const first = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(first.nodeId, 'impl-1');
  runner.beginNode(state, 'impl-1', { now: NOW, sessionId: 'i1' });
  // Default capacity 2: a second disjoint writer is admitted while the first runs.
  const second = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(second.allowed, true);
  assert.equal(second.nodeId, 'impl-2');
  runner.beginNode(state, 'impl-2', { now: NOW, sessionId: 'i2' });
  assert.equal(state.nodes['impl-1'].state, 'RUNNING');
  assert.equal(state.nodes['impl-2'].state, 'RUNNING');
  const third = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(third.allowed, false);
  assert.equal(third.code, 'WRITER_CAPACITY');
  assert.match(third.detail, /2\/2/);

  // A critic downgrade to approvedParallel=1 mechanically narrows the gate.
  const capped = newRun({ runId: 'r2b', rootSessionId: 'r2b', now: NOW });
  runner.submitPlan(capped, { intent: 'change', nodes: graph.nodes, now: NOW });
  await dispatchCriticAndPass(capped, 1, 1);
  assert.equal(runner.implementerCapacity(capped), 1);
  const cappedFirst = runner.admitDispatch(capped, { agent: 'graph-implementer', now: NOW });
  assert.equal(cappedFirst.allowed, true);
  runner.beginNode(capped, cappedFirst.nodeId, { now: NOW, sessionId: 'i3' });
  const cappedSecond = runner.admitDispatch(capped, { agent: 'graph-implementer', now: NOW });
  assert.equal(cappedSecond.allowed, false);
  assert.equal(cappedSecond.code, 'WRITER_CAPACITY');
  assert.match(cappedSecond.detail, /1\/1/);

  // A runner explicitly configured for single-writer keeps the old semantics.
  const single = createRunner({ maxAttempts: 3, maxPlanRevisions: 2, implementerParallel: 1 });
  const solo = newRun({ runId: 'r2c', rootSessionId: 'r2c', now: NOW });
  runner.submitPlan(solo, { intent: 'change', nodes: graph.nodes, now: NOW });
  const soloCritic = single.admitDispatch(solo, { agent: 'graph-plan-critic', now: NOW });
  single.beginNode(solo, soloCritic.nodeId, { now: NOW, sessionId: 'c' });
  single.submitReview(solo, { planVersion: 1, verdict: 'PASS', findings: [], now: NOW });
  const soloFirst = single.admitDispatch(solo, { agent: 'graph-implementer', now: NOW });
  single.beginNode(solo, soloFirst.nodeId, { now: NOW, sessionId: 'i4' });
  const soloSecond = single.admitDispatch(solo, { agent: 'graph-implementer', now: NOW });
  assert.equal(soloSecond.code, 'WRITER_CAPACITY');

  // Verifiers keep one-in-flight semantics regardless of writer capacity.
  const verifierBusy = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  assert.equal(verifierBusy.code, 'NO_READY_NODE'); // impl deps not SUCCEEDED yet
});

test('resume: crash windows classify conservatively and keep counters', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: admit.nodeId, tool: 'edit', target: 'src/a.ts', now: NOW });

  const result = runner.resumeRun(state, { now: NOW });
  assert.deepEqual(result.report.recoveryRequired, ['impl-1']);
  assert.equal(state.status, 'RECOVERY_REQUIRED');
  assert.equal(state.nodes['impl-1'].state, 'RECOVERY_REQUIRED');

  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RECOVERY_REQUIRED');

  const reconciled = runner.reconcileNode(state, 'impl-1', { now: NOW });
  assert.equal(reconciled.ok, true);
  assert.equal(state.status, 'RUNNING');
  assert.equal(state.nodes['impl-1'].state, 'PENDING');
  assert.equal(state.nodes['impl-1'].attempt, 1);
  const redispatch = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(redispatch.allowed, true);
  assert.equal(redispatch.reconcile, true);
  runner.beginNode(state, redispatch.nodeId, { now: NOW, sessionId: 'i' });
  const change = runner.submitChange(state, { nodeId: 'impl-1', filesTouched: ['src/a.ts'], summary: 'reconciled', now: NOW });
  assert.equal(change.ok, true);

  const clean = freshRun();
  const admitClean = runner.admitDispatch(clean, { agent: 'graph-verifier', now: NOW });
  assert.equal(admitClean.code, 'NO_READY_NODE');
});

test('revalidation: hash mismatch invalidates stale verification evidence', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  await dispatchImplementerAndSucceed(state, { snapshot: { 'src/a.ts': '1'.repeat(64) } });
  const verified = await dispatchVerifier(state, 'PASS', [{ command: 'npm test', exitCode: 0 }], { 'src/a.ts': '1'.repeat(64) });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(state.status, 'SUCCEEDED');

  const drifted = runner.revalidateArtifacts(state, { currentSnapshot: { 'src/a.ts': 'hash-2' }, now: NOW });
  assert.deepEqual(drifted.invalidated, ['change:impl-1@1', 'verification:verify-1@1']);
  assert.equal(state.artifacts['verification:verify-1'].status, 'stale');
  assert.equal(state.nodes['verify-1'].state, 'STALE');
});

test('plan-only runs admit reviewers but never implementers', () => {
  const state = newRun({ runId: 'r3', rootSessionId: 'r3', now: NOW });
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
  ]);
  runner.submitPlan(state, { intent: 'plan-only', nodes: graph.nodes, now: NOW });
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(critic.allowed, true);
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  assert.equal(runner.submitReview(state, { planVersion: 1, verdict: 'PASS', now: NOW }).ok, true);
  assert.equal(state.status, 'SUCCEEDED');
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.code, 'RUN_TERMINATED');
});

test('read-only agents dispatch freely on healthy runs and need no node', () => {
  const state = newRun({ runId: 'r4', rootSessionId: 'r4', now: NOW });
  const free = runner.admitDispatch(state, { agent: 'graph-explorer', now: NOW });
  assert.deepEqual({ allowed: free.allowed, nodeId: free.nodeId, free: free.free }, { allowed: true, nodeId: null, free: true });
  const invalid = runner.admitDispatch(state, { agent: 'build', now: NOW });
  assert.equal(invalid.code, 'INVALID_AGENT');
});

test('captureRequest stores only the first request without changing runner gates', () => {
  const state = freshRun();
  const before = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  const first = {
    text: 'Implement durable journal memory.',
    truncated: false,
    redactions: 0,
    capturedAt: '2026-09-07T00:01:00.000Z',
  };
  assert.deepEqual(runner.captureRequest(state, first), { changed: true });
  assert.deepEqual(state.request, first);
  assert.equal(state.requestCaptureCompleted, true);
  assert.equal(state.updatedAt, first.capturedAt);
  assert.deepEqual(runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW }), before);

  const second = {
    text: 'Do not replace the original request.',
    truncated: true,
    redactions: 2,
    capturedAt: '2026-09-07T00:02:00.000Z',
  };
  assert.deepEqual(runner.captureRequest(state, second), { changed: false });
  assert.deepEqual(state.request, first);
  assert.equal(state.requestCaptureCompleted, true);
  assert.equal(state.updatedAt, first.capturedAt);
  assert.deepEqual(runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW }), before);
});

test('completeRequestCapture consumes a text-free first attempt without storing a request', () => {
  const state = newRun({ runId: 'empty-request', rootSessionId: 'empty-request', now: NOW });
  const completedAt = '2026-09-07T00:01:00.000Z';
  assert.deepEqual(runner.completeRequestCapture(state, { now: completedAt }), { changed: true });
  assert.equal(state.request, null);
  assert.equal(state.requestCaptureCompleted, true);
  assert.equal(state.updatedAt, completedAt);

  const later = {
    text: 'This later message is not the initial request.',
    truncated: false,
    redactions: 0,
    capturedAt: '2026-09-07T00:02:00.000Z',
  };
  assert.deepEqual(runner.captureRequest(state, later), { changed: false });
  assert.equal(state.request, null);
  assert.equal(state.updatedAt, completedAt);
});

test('captureRequest rejects malformed request metadata', () => {
  const valid = {
    text: 'request',
    truncated: false,
    redactions: 0,
    capturedAt: NOW,
  };
  const invalid = [
    null,
    { ...valid, text: '' },
    { ...valid, text: 1 },
    { ...valid, truncated: 'false' },
    { ...valid, redactions: -1 },
    { ...valid, redactions: 1.5 },
    { ...valid, capturedAt: '' },
    { ...valid, capturedAt: 1 },
  ];
  for (const request of invalid) {
    const state = newRun({ runId: 'invalid-request', rootSessionId: 'invalid-request', now: NOW });
    assert.throws(() => runner.captureRequest(state, request), TypeError);
    assert.equal(state.request, null);
    assert.equal(state.updatedAt, NOW);
  }
});

test('captureRequest rejects accessor metadata without invoking getters', () => {
  const state = newRun({ runId: 'accessor-request', rootSessionId: 'accessor-request', now: NOW });
  const request = {};
  let reads = 0;
  for (const [key, value] of Object.entries({ text: 'request', truncated: false, redactions: 0, capturedAt: NOW })) {
    Object.defineProperty(request, key, {
      enumerable: true,
      get() {
        reads += 1;
        return value;
      },
    });
  }

  assert.throws(() => runner.captureRequest(state, request), TypeError);
  assert.equal(reads, 0);
  assert.equal(state.request, null);
  assert.equal(state.updatedAt, NOW);
});

test('captureRequest rejects non-plain request metadata', () => {
  class RequestMetadata {
    constructor() {
      this.text = 'request';
      this.truncated = false;
      this.redactions = 0;
      this.capturedAt = NOW;
    }
  }
  const state = newRun({ runId: 'class-request', rootSessionId: 'class-request', now: NOW });

  assert.throws(() => runner.captureRequest(state, new RequestMetadata()), TypeError);
  assert.equal(state.request, null);
  assert.equal(state.updatedAt, NOW);
});

test('inspect reports blockers, counters, artifacts and a mermaid graph', async () => {
  const state = freshRun();
  const report = runner.inspect(state);
  assert.equal(report.status, 'RUNNING');
  assert.equal(report.mode, 'change');
  const impl = report.nodes.find((node) => node.id === 'impl-1');
  assert.equal(impl.ready, false);
  assert.equal(impl.remainingAttempts, impl.maxAttempts);
  assert.equal(impl.bindingStatus, 'none');
  assert.match(impl.waitingOn.join('; '), /review-1/);
  assert.match(report.mermaid, /graph TD/);
  assert.match(report.mermaid, /review-1 --> impl-1/);
  assert.ok(report.artifacts.some((artifact) => artifact.name === 'plan' && artifact.version === 1));
  await dispatchCriticAndPass(state);
  const after = runner.inspect(state);
  assert.equal(after.nodes.find((node) => node.id === 'impl-1').ready, true);
});

test('coordinator-targeted dispatch validates the requested node specifically', () => {
  const state = newRun({ runId: 'targeted', rootSessionId: 'targeted', now: NOW });
  const graph = validateTaskGraph([
    spec('plan-1', 'plan', 'graph-planner'),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
    spec('impl-a', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['a/**'] }),
    spec('impl-b', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['b/**'] }),
  ]);
  runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });

  // Before review PASS the targeted node is not admissible.
  const gated = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-b' });
  assert.equal(gated.code, 'NODE_NOT_ADMISSIBLE');
  assert.match(gated.detail, /review-1/);

  runner.beginNode(state, 'review-1', { now: NOW, sessionId: 'sess-critic' });
  runner.submitReview(state, { planVersion: 1, verdict: 'PASS', findings: [], now: NOW });

  // impl-a sorts first without targeting; explicit targeting selects impl-b.
  const sorted = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(sorted.nodeId, 'impl-a');
  const targeted = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-b' });
  assert.equal(targeted.allowed, true);
  assert.equal(targeted.nodeId, 'impl-b');
  assert.equal(targeted.reconcile, false);

  const wrongRole = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW, nodeId: 'impl-b' });
  assert.equal(wrongRole.code, 'NODE_NOT_FOUND');
  const unknown = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-zzz' });
  assert.equal(unknown.code, 'NODE_NOT_FOUND');

  // Targeting a node that is RUNNING is rejected, not silently reassigned;
  // a different free node within capacity is admitted alongside.
  runner.beginNode(state, 'impl-b', { now: NOW, sessionId: 'sess-b' });
  const running = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-b' });
  assert.equal(running.code, 'NODE_NOT_ADMISSIBLE');
  assert.match(running.detail, /RUNNING/);
  const alongside = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-a' });
  assert.equal(alongside.allowed, true);
  assert.equal(alongside.nodeId, 'impl-a');
  runner.beginNode(state, 'impl-a', { now: NOW, sessionId: 'sess-a' });
  const full = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-a' });
  assert.equal(full.code, 'WRITER_CAPACITY');
});

test('targeted dispatch of an exhausted node keeps sorted-path failure semantics', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  state.nodes['impl-1'].attempt = 3; // node maxAttempts
  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-1' });
  assert.equal(denied.code, 'ATTEMPTS_EXHAUSTED');
  assert.equal(state.nodes['impl-1'].state, 'FAILED');
  assert.equal(state.status, 'AWAITING_USER_DECISION');
  assert.equal(state.pendingDecision.cause, 'attempt-budget-exhausted');
});

test('recorded side effects mark redispatches as reconcile work', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  runner.beginNode(state, 'impl-1', { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: 'impl-1', tool: 'edit', target: 'src/a.ts', now: NOW });
  runner.markIncomplete(state, { nodeId: 'impl-1', now: NOW });
  const redispatch = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, nodeId: 'impl-1' });
  assert.equal(redispatch.allowed, true);
  assert.equal(redispatch.reconcile, true);
});

test('critics are never freely admitted; a not-ready review rejects dispatch up front', () => {
  const state = newRun({ runId: 'critic-free', rootSessionId: 'critic-free', now: NOW });
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'], inputs: ['findings'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'], inputs: ['findings'] }),
  ]);
  runner.submitPlan(state, { intent: 'plan-only', nodes: graph.nodes, now: NOW });

  // The review node waits on findings that were never registered.
  const denied = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(denied.code, 'NO_READY_NODE');
  assert.match(denied.detail, /review-1\(.*findings/);
  assert.match(denied.detail, /resubmit a corrected plan/);

  // Other read-only roles keep free consultation.
  const explorer = runner.admitDispatch(state, { agent: 'graph-explorer', now: NOW });
  assert.deepEqual({ allowed: explorer.allowed, nodeId: explorer.nodeId, free: explorer.free }, { allowed: true, nodeId: null, free: true });
  const planner = runner.admitDispatch(state, { agent: 'graph-planner', now: NOW });
  assert.deepEqual({ allowed: planner.allowed, nodeId: planner.nodeId, free: planner.free }, { allowed: true, nodeId: null, free: true });

  // Once findings exist the review becomes admissible and binds.
  state.artifacts.findings = { kind: 'findings', nodeId: 'free', version: 1, basedOn: [], payload: {}, status: 'valid', createdAt: NOW };
  const admitted = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.nodeId, 'review-1');
});

test('excludeNodeIds steers the sorted pick away from reserved nodes', async () => {
  const graph = validateTaskGraph([
    spec('plan-1', 'plan', 'graph-planner'),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
    spec('impl-a', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['a/**'] }),
    spec('impl-b', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['b/**'] }),
  ]);
  const state = newRun({ runId: 'excl', rootSessionId: 'excl', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  await dispatchCriticAndPass(state);

  const skipped = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, excludeNodeIds: new Set(['impl-a']) });
  assert.equal(skipped.allowed, true);
  assert.equal(skipped.nodeId, 'impl-b');

  const bothExcluded = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW, excludeNodeIds: ['impl-a', 'impl-b'] });
  assert.equal(bothExcluded.code, 'NO_READY_NODE');
});

test('submitPlan preserves the sessionId of same-id nodes for task_id continuation', async () => {
  const state = freshRun();
  await dispatchCriticAndPass(state);
  // A planner round binds the plan node (REVISE path) and sets its session.
  state.nodes['plan-1'].state = 'PENDING';
  state.nodes['plan-1'].sessionId = 'planner-session-1';
  state.nodes['plan-1'].attempt = 1;
  const resubmission = runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  assert.equal(resubmission.ok, true, JSON.stringify(resubmission));
  assert.equal(state.nodes['plan-1'].sessionId, 'planner-session-1');
  assert.equal(state.nodes['plan-1'].attempt, 1);
  assert.equal(state.nodes['plan-1'].state, 'SUCCEEDED'); // plan nodes auto-complete
  // The critic's session survives re-planning the same way.
  state.nodes['review-1'].sessionId = 'critic-session-1';
  const third = runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  assert.equal(third.ok, true, JSON.stringify(third));
  assert.equal(state.nodes['review-1'].sessionId, 'critic-session-1');
  assert.equal(state.nodes['review-1'].state, 'PENDING');
});

test('admission carries bounded revision and repair context from artifacts', async () => {
  const state = freshRun();
  // Plan admission after a REVISE verdict carries the critic's findings.
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  runner.submitReview(state, { planVersion: 1, verdict: 'REVISE', findings: ['tighten scope', 'add risk section'], now: NOW });
  const plannerAdmit = runner.admitDispatch(state, { agent: 'graph-planner', now: NOW });
  assert.equal(plannerAdmit.allowed, true, JSON.stringify(plannerAdmit));
  assert.equal(plannerAdmit.nodeId, 'plan-1');
  assert.deepEqual(plannerAdmit.reviseFindings, ['tighten scope', 'add risk section']);
  const replan = runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW });
  assert.equal(replan.ok, true, JSON.stringify(replan));

  // Implement admission after a FAILED verification carries the evidence.
  await dispatchCriticAndPass(state, 2);
  await dispatchImplementerAndSucceed(state);
  const verifier = runner.admitDispatch(state, { agent: 'graph-verifier', now: NOW });
  runner.beginNode(state, verifier.nodeId, { now: NOW, sessionId: 'v' });
  runner.submitVerification(state, {
    nodeId: verifier.nodeId, verdict: 'FAIL', commands: [{ command: 'npm test', exitCode: 1 }],
    summary: 'tests fail on the new path', now: NOW,
  });
  const repairAdmit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(repairAdmit.allowed, true, JSON.stringify(repairAdmit));
  assert.equal(repairAdmit.repairEvidence.verifier, 'verify-1');
  assert.equal(repairAdmit.repairEvidence.summary, 'tests fail on the new path');
  assert.deepEqual(repairAdmit.repairEvidence.commands, ['npm test (exit 1)']);
});

test('inspect reports mechanical per-node progress from the ledger and deliverables', async () => {
  const graph = validateTaskGraph([
    spec('explore-1', 'explore', 'graph-explorer'),
    spec('plan-1', 'plan', 'graph-planner', { dependsOn: ['explore-1'] }),
    spec('review-1', 'review', 'graph-plan-critic', { dependsOn: ['plan-1'] }),
    spec('impl-1', 'implement', 'graph-implementer', { dependsOn: ['review-1'], writeScope: ['src/**'], deliverables: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1'] }),
  ]);
  const state = newRun({ runId: 'progress', rootSessionId: 'progress', now: NOW });
  runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  await dispatchCriticAndPass(state);

  const admit = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'i' });
  runner.recordSideEffect(state, { nodeId: 'impl-1', tool: 'edit', target: 'src/a.ts', now: '2026-09-12T01:00:01.000Z' });
  runner.recordSideEffect(state, { nodeId: 'impl-1', tool: 'bash', target: 'ls src/', now: '2026-09-12T01:00:02.000Z' });

  let report = runner.inspect(state);
  let impl = report.nodes.find((node) => node.id === 'impl-1');
  assert.equal(impl.sideEffectCount, 2);
  assert.equal(impl.lastActivityAt, '2026-09-12T01:00:02.000Z');
  assert.deepEqual(impl.deliverables, { total: 3, done: 1, pending: ['src/b.ts', 'src/c.ts'] });
  const review = report.nodes.find((node) => node.id === 'review-1');
  assert.equal(review.sideEffectCount, 0);
  assert.equal(review.deliverables, undefined);

  // After submission the claimed file list is the authoritative denominator.
  runner.submitChange(state, { nodeId: 'impl-1', filesTouched: ['src/a.ts', 'src/b.ts', 'src/c.ts'], summary: 'done', now: NOW });
  report = runner.inspect(state);
  impl = report.nodes.find((node) => node.id === 'impl-1');
  assert.equal(impl.state, 'SUCCEEDED');
  assert.deepEqual(impl.deliverables, { total: 3, done: 3, pending: [] });

  // Pending lists are bounded at eight entries.
  const wide = newRun({ runId: 'wide', rootSessionId: 'wide', now: NOW });
  const wideGraph = validateTaskGraph([
    spec('plan-w', 'plan', 'graph-planner'),
    spec('review-w', 'review', 'graph-plan-critic', { dependsOn: ['plan-w'] }),
    spec('impl-w', 'implement', 'graph-implementer', { dependsOn: ['review-w'], writeScope: ['w/**'], deliverables: Array.from({ length: 10 }, (_, index) => `w/f${index}.ts`) }),
  ]);
  runner.submitPlan(wide, { intent: 'change', nodes: wideGraph.nodes, now: NOW });
  const criticW = runner.admitDispatch(wide, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(wide, criticW.nodeId, { now: NOW, sessionId: 'cw' });
  runner.submitReview(wide, { planVersion: 1, verdict: 'PASS', findings: [], now: NOW });
  const admitW = runner.admitDispatch(wide, { agent: 'graph-implementer', now: NOW });
  runner.beginNode(wide, admitW.nodeId, { now: NOW, sessionId: 'iw' });
  const wideReport = runner.inspect(wide);
  const wideImpl = wideReport.nodes.find((node) => node.id === 'impl-w');
  assert.equal(wideImpl.deliverables.pending.length, 8);
});

test('run ids with colons persist to platform-safe encoded filenames', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-encoded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createRunStore({ worktree: dir });

  await store.createRun({ runId: 'root:2', rootSessionId: 'root', now: NOW });
  const state = store.getRun('root:2');
  state.failReason = 'x';
  await store.saveRun(state);
  await store.releaseRun('root:2');

  const runsDir = join(dir, '.opencode-loop', 'runs');
  const names = await fsPromises.readdir(runsDir);
  assert.ok(names.includes('root%3A2.json'), `expected encoded file, got ${names.join(', ')}`);
  assert.equal(names.some((name) => name.includes(':')), false);

  const fresh = createRunStore({ worktree: dir });
  const loaded = await fresh.loadRun('root:2');
  assert.equal(loaded.runId, 'root:2');
  assert.equal(loaded.failReason, 'x');
  assert.ok((await fresh.listRunIds()).includes('root:2'));
});

test('legacy colon filenames are lazily migrated and never duplicated', { skip: process.platform === 'win32' ? 'raw colon filenames are only representable on POSIX' : false }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'loop-legacy-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const legacy = newRun({ runId: 'old:1', rootSessionId: 'root', now: NOW });
  await writeFile(join(runsDir, 'old:1.json'), JSON.stringify(legacy));

  // Direct load still sees the legacy file during the transition.
  const store = createRunStore({ worktree: dir });
  const direct = await store.loadRun('old:1');
  assert.equal(direct.runId, 'old:1');

  // Listing migrates the file to its encoded name and reports the logical id.
  assert.ok((await store.listRunIds()).includes('old:1'));
  const names = await fsPromises.readdir(runsDir);
  assert.ok(names.includes('old%3A1.json'));
  assert.equal(names.includes('old:1.json'), false);
});

test('runFileKey output is Windows-filename safe for every representable id', async () => {
  const { runFileKey } = await import('../src/run-state.mjs');
  for (const id of ['root', 'root:2', 'ses_abc123', 'ses_x:12', 'a.b-c_d']) {
    const key = runFileKey(id);
    assert.match(key, /^[A-Za-z0-9._~-]+(?:%[0-9A-F]{2}[A-Za-z0-9._~-]*)*$/);
    assert.equal(key.includes(':'), false);
    assert.equal(decodeURIComponent(key), id);
  }
});

test('pre-existing encoded run files are discovered and read by logical id', async (t) => {
  // Windows-safe companion to the POSIX-only migration test: a hand-written
  // encoded file (the canonical name since the filename split) must be
  // decoded by listRunIds and loadable without any rename.
  const dir = await mkdtemp(join(tmpdir(), 'loop-encoded-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runsDir = join(dir, '.opencode-loop', 'runs');
  await mkdir(runsDir, { recursive: true });
  const state = newRun({ runId: 'old:1', rootSessionId: 'root', now: NOW });
  await writeFile(join(runsDir, 'old%3A1.json'), JSON.stringify(state));

  const store = createRunStore({ worktree: dir });
  assert.deepEqual(await store.listRunIds(), ['old:1']);
  const loaded = await store.loadRun('old:1');
  assert.equal(loaded.runId, 'old:1');
  const names = await fsPromises.readdir(runsDir);
  assert.deepEqual(names.filter((name) => name.endsWith('.json')), ['old%3A1.json']);
});
