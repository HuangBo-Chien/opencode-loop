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
    spec('verify-1', 'verify', 'graph-verifier', { dependsOn: ['impl-1'], outputs: ['verification:impl-1'] }),
  ];
  return validateTaskGraph(specs);
}
function freshRun(graph = changeGraph()) {
  const state = newRun({ runId: 'run-1', rootSessionId: 'sess-root', now: NOW });
  const submission = runner.submitPlan(state, { intent: 'change', nodes: graph.nodes, now: NOW });
  assert.equal(submission.ok, true, JSON.stringify(submission));
  return state;
}
async function dispatchCriticAndPass(state, planVersion = 1) {
  const admit = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  assert.equal(admit.allowed, true, JSON.stringify(admit));
  runner.beginNode(state, admit.nodeId, { now: NOW, sessionId: 'sess-critic' });
  const review = runner.submitReview(state, { planVersion, verdict: 'PASS', findings: [], now: NOW });
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

test('scenario: critic FAIL terminates the run; implementer dispatch is rejected', () => {
  const state = freshRun();
  const critic = runner.admitDispatch(state, { agent: 'graph-plan-critic', now: NOW });
  runner.beginNode(state, critic.nodeId, { now: NOW, sessionId: 'c' });
  const review = runner.submitReview(state, { planVersion: 1, verdict: 'FAIL', findings: ['plan misses the error path'], now: NOW });
  assert.equal(review.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');

  const denied = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'RUN_TERMINATED');
  for (const agent of ['graph-explorer', 'graph-planner', 'graph-plan-critic', 'graph-verifier']) {
    assert.equal(runner.admitDispatch(state, { agent, now: NOW }).allowed, false, agent);
  }
  assert.equal(runner.submitPlan(state, { intent: 'change', nodes: changeGraph().nodes, now: NOW }).code, 'RUN_TERMINATED');
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
  assert.equal(third.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');
  assert.match(state.failReason, /revisions exhausted/);
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
  assert.equal(third.effect, 'run-failed');
  assert.equal(state.status, 'FAILED');
  assert.match(state.failReason, /repair loop exhausted/);
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
  assert.equal(reloaded.status, 'FAILED');
  assert.match(reloaded.failReason, /never delivered/);
});

test('single-writer: second implementer node cannot run while one is RUNNING', async () => {
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
  const first = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(first.nodeId, 'impl-1');
  runner.beginNode(state, 'impl-1', { now: NOW, sessionId: 'i1' });
  const second = runner.admitDispatch(state, { agent: 'graph-implementer', now: NOW });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'ALREADY_RUNNING');
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
