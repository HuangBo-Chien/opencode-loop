import test from 'node:test';
import assert from 'node:assert/strict';

test('PR1 host read is bounded even when SDK ignores abort; late result is discarded', async () => {
  const { createBoundedHostReader } = await import('../src/host-read.mjs');
  let finish;
  const reader = createBoundedHostReader({ session: { get: () => new Promise(resolve => { finish = resolve; }) } });
  await assert.rejects(reader.withBudget(() => 5, () => reader.client.session.get({ path: { id: 'child' } })), /deadline/);
  finish({ data: { id: 'child' } });
});

test('PR1 expired host budget does not initiate an SDK call', async () => {
  const { createBoundedHostReader } = await import('../src/host-read.mjs');
  let calls = 0;
  const reader = createBoundedHostReader({ session: { get: async () => { calls++; return {}; } } });
  await assert.rejects(reader.withBudget(() => 0, () => reader.client.session.get({})), /deadline/);
  assert.equal(calls, 0);
});

test('PR1 preserves getter-only host session properties with the pinned v1 method contract', async () => {
  const { createBoundedHostReader } = await import('../src/host-read.mjs');
  const session = { get: async ({ path }) => ({ data: { id: path.id } }) };
  const client = { get session() { return session; } };
  const reader = createBoundedHostReader(client);
  assert.equal((await reader.client.session.get({ path: { id: 'child' } })).data.id, 'child');
});
