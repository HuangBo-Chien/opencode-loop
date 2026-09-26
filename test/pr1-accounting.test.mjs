import test from 'node:test';
import assert from 'node:assert/strict';
import { newRun } from '../src/run-state.mjs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOptions } from '../src/config.mjs';

async function fixture(options = {}) {
  const { createRunAccounting } = await import('../src/run-accounting.mjs');
  let now = 0;
  const meter = createRunAccounting({ clock: () => now, ...options });
  const state = newRun({ runId: 'root', rootSessionId: 'root', now: 'start' });
  meter.commit(state, null);
  return { meter, state, advance: ms => { now += ms; } };
}

test('PR1 repeated/partial usage is upserted, unknowns retained and cache not added twice', async () => {
  const { meter } = await fixture();
  const binding = { runId: 'root', root: true, agent: 'graph-orchestrator' };
  meter.message({ id: 'm', sessionID: 'root', role: 'assistant', tokens: { input: 100 } }, binding);
  assert.equal(meter.inspect('root').usage.root.total, null);
  const complete = { id: 'm', sessionID: 'root', role: 'assistant', time: { completed: 10 }, tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 80, write: 0 } } };
  meter.message(complete, binding);
  meter.message(complete, binding);
  meter.message({ id: 'm', sessionID: 'root', role: 'assistant', tokens: { input: 90 } }, binding);
  const report = meter.inspect('root');
  assert.equal(report.usage.root.messages, 1);
  assert.equal(report.usage.root.total, 120);
  assert.equal(report.usage.root.reasoning, 10);
  meter.message({ id: 'foreign', sessionID: 'foreign', role: 'assistant', tokens: { input: 100, output: 100 } }, null);
  assert.equal(meter.inspect('root').usage.root.messages, 1);
});

test('PR1 phase times are monotonic observed durations and partial coverage is explicit', async () => {
  const h = await fixture();
  h.advance(20);
  let before = structuredClone(h.state);
  h.state.nodes.i = { spec: { id: 'i', kind: 'implement' }, state: 'RUNNING', attempt: 1, dispatchId: 'd' };
  h.meter.commit(h.state, before);
  h.advance(10);
  before = structuredClone(h.state);
  h.state.sideEffects.push({ sessionId: 'child', callID: 'edit', tool: 'edit' });
  h.meter.commit(h.state, before);
  h.advance(70);
  before = structuredClone(h.state);
  h.state.nodes.i.state = 'SUCCEEDED';
  h.meter.commit(h.state, before);
  h.advance(100);
  before = structuredClone(h.state);
  h.state.status = 'SUCCEEDED';
  h.meter.commit(h.state, before);
  const report = h.meter.inspect('root');
  assert.equal(report.timings.beforeFirstObservedModificationMs, 30);
  assert.equal(report.phases.implement.completedWorkMs, 80);
  assert.equal(report.timings.changeToRunEndMs, 100);
  assert.equal(report.coverage, 'current-process-observed');
});

test('PR1 bounded accounting never evicts message identities and then recounts replays', async () => {
  const { meter } = await fixture({ maxMessages: 2 });
  const b = { runId: 'root', root: true, agent: 'graph-orchestrator' };
  for (const id of ['a', 'b', 'c', 'a', 'c']) meter.message({ id, sessionID: 'root', role: 'assistant', time: { completed: 1 }, tokens: { input: 1, output: 1 } }, b);
  const report = meter.inspect('root');
  assert.equal(report.usage.root.messages, 2);
  assert.equal(report.capacityExceeded, true);
  assert.equal(report.usage.root.total, null);
  assert.equal(report.usage.root.knownSubtotal, 4);
});

test('PR1 a completed message can acquire delayed usage without regressing known fields', async () => {
  const { meter } = await fixture();
  const b = { runId: 'root', root: true, agent: 'graph-orchestrator' };
  meter.message({ id: 'm', sessionID: 'root', role: 'assistant', time: { completed: 1 } }, b);
  meter.message({ id: 'm', sessionID: 'root', role: 'assistant', tokens: { input: 10, output: 2 } }, b);
  assert.equal(meter.inspect('root').usage.root.total, 12);
});

test('PR1 accounting has an optional rollout switch and writes isolated per-process diagnostics', async t => {
  assert.equal(parseOptions({ phaseAccounting: false }).phaseAccounting, false);
  const disabled = await fixture({ enabled: false });
  assert.deepEqual(disabled.meter.inspect('root'), { enabled: false });
  const worktree = await mkdtemp(join(tmpdir(), 'loop-pr1-metrics-'));
  const h = await fixture({ worktree });
  t.after(async () => { await h.meter.close(); await rm(worktree, { recursive: true, force: true }); });
  await h.meter.flush('root');
  const files = await readdir(join(worktree, '.opencode-loop/metrics'));
  assert.equal(files.length, 1);
  const report = JSON.parse(await readFile(join(worktree, '.opencode-loop/metrics', files[0]), 'utf8'));
  assert.equal(report.coverage, 'current-process-observed');
  assert.equal(report.usage.root.total, null);
});

test('PR1 diagnostic flush does not recreate a removed workspace', async t => {
  const worktree = await mkdtemp(join(tmpdir(), 'loop-pr1-removed-'));
  const h = await fixture({ worktree });
  t.after(async () => { await h.meter.close(); await rm(worktree, { recursive: true, force: true }); });
  await rm(worktree, { recursive: true, force: true });
  await h.meter.flush('root');
  await assert.rejects(readdir(worktree), { code: 'ENOENT' });
  assert.equal(h.meter.inspect('root').diagnosticError, true);
});
