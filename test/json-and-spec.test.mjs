import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanJson, stableHash } from '../src/json-safe.mjs';
import { validateTaskGraph, validateTaskSpec, matchScopePath, normalizeScopePath, KIND_AGENTS } from '../src/task-spec.mjs';

test('cleanJson freezes, sorts keys and rejects unsafe shapes', () => {
  const cleaned = cleanJson({ b: 1, a: { c: [1, 'x', null, true] } });
  assert.ok(Object.isFrozen(cleaned));
  assert.deepEqual(cleaned, { a: { c: [1, 'x', null, true] }, b: 1 });
  assert.equal(JSON.stringify(cleaned), '{"a":{"c":[1,"x",null,true]},"b":1}');
  assert.equal(cleanJson(-0), 0);
  for (const bad of [
    () => cleanJson({ x: NaN }), () => cleanJson({ x: undefined }), () => cleanJson(() => 1),
    () => cleanJson(new Date()), () => cleanJson([, 1]),
    () => cleanJson({ x: { y: 'self' }, set x2(v) {} }), () => { const a = {}; a.a = a; cleanJson(a); },
    () => cleanJson(Object.defineProperty({}, 'x', { get() { return 1; }, enumerable: true })),
  ]) assert.throws(bad, TypeError);
  assert.deepEqual(cleanJson(Object.create(null)), {});
  const deep = { root: [] };
  let cursor = deep.root;
  for (let index = 0; index < 30; index += 1) { cursor.push({ next: [] }); cursor = cursor[0].next; }
  assert.throws(() => cleanJson(deep), /structural|depth|limit/i);
  assert.throws(() => cleanJson('x'.repeat(300_000)), /byte/i);
});

test('stableHash is deterministic across key order and sensitive to content', () => {
  assert.equal(stableHash({ a: 1, b: [2, 3] }), stableHash({ b: [2, 3], a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
  assert.equal(stableHash({ n: -0 }), stableHash({ n: 0 }));
});

function baseSpec(overrides = {}) {
  return {
    id: 'explore-1', agent: 'graph-explorer', kind: 'explore',
    dependsOn: [], inputs: [], outputs: ['findings'], acceptance: ['find login flow'],
    ...overrides,
  };
}
const plan = (overrides = {}) => baseSpec({ id: 'plan-1', agent: 'graph-planner', kind: 'plan', outputs: ['plan'], ...overrides });
const review = (overrides = {}) => baseSpec({ id: 'review-1', agent: 'graph-plan-critic', kind: 'review', dependsOn: ['plan-1'], outputs: ['review'], ...overrides });
const implement = (overrides = {}) => baseSpec({
  id: 'impl-1', agent: 'graph-implementer', kind: 'implement', dependsOn: ['review-1'],
  writeScope: ['src/a.ts'], outputs: ['change:impl-1'], acceptance: ['returns 401'],
  ...overrides,
});
const verify = (overrides = {}) => baseSpec({ id: 'verify-1', agent: 'graph-verifier', kind: 'verify', dependsOn: ['impl-1'], outputs: ['verification:verify-1'], ...overrides });

test('validateTaskSpec accepts a minimal spec and normalizes nothing silently', () => {
  const { ok, errors } = validateTaskSpec(baseSpec());
  assert.equal(ok, true, errors.join('; '));
  for (const [overrides, pattern] of [
    [{ id: 'x y' }, /id/], [{ id: '../escape' }, /id/], [{ agent: 'graph-orchestrator' }, /agent/],
    [{ agent: 'build' }, /agent/], [{ kind: 'deploy' }, /kind/], [{ agent: 'graph-planner' }, /cannot be assigned/],
    [{ dependsOn: ['explore-1'] }, /dependsOn entry/], [{ dependsOn: 'explore-1' }, /dependsOn/],
    [{ inputs: ['findings@x'] }, /artifact/], [{ outputs: ['a@1'] }, /artifact name/],
    [{ acceptance: [''] }, /nonempty/], [{ maxAttempts: 0 }, /maxAttempts/], [{ maxAttempts: 99 }, /maxAttempts/],
    [{ allowShell: 'yes' }, /allowShell/], [{ title: '' }, /title/],
  ]) {
    const result = validateTaskSpec(baseSpec(overrides));
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(overrides)}`);
    assert.match(result.errors.join('; '), pattern);
  }
  assert.equal(validateTaskSpec(null).ok, false);
});

test('implement nodes require writeScope; other kinds may not declare one', () => {
  assert.equal(validateTaskSpec(implement()).ok, true);
  assert.equal(validateTaskSpec(implement({ writeScope: undefined })).ok, false);
  assert.equal(validateTaskSpec(baseSpec({ writeScope: ['src/x.ts'] })).ok, false);
  assert.equal(validateTaskSpec(implement({ writeScope: ['/abs/path'] })).ok, false);
  assert.equal(validateTaskSpec(implement({ writeScope: ['../up/one'] })).ok, false);
  assert.equal(validateTaskSpec(implement({ writeScope: ['src\\win.ts'] })).ok, false);
});

test('graph validation: order, cycles, unknown deps, mandatory gates', () => {
  const good = validateTaskGraph([baseSpec(), plan(), review(), implement(), verify()]);
  assert.equal(good.ok, true, good.errors.join('; '));
  assert.deepEqual(good.order, ['explore-1', 'plan-1', 'review-1', 'impl-1', 'verify-1']);

  const cyclic = validateTaskGraph([plan({ dependsOn: ['review-1'] }), review(), implement(), verify()]);
  assert.equal(cyclic.ok, false);
  assert.match(cyclic.errors.join('; '), /cycle/);

  const unknownDep = validateTaskGraph([baseSpec(), plan({ dependsOn: ['ghost'] }), review(), implement(), verify()]);
  assert.equal(unknownDep.ok, false);
  assert.match(unknownDep.errors.join('; '), /unknown node ghost/);

  assert.equal(validateTaskGraph([]).ok, false);
  const noImplementGate = validateTaskGraph([baseSpec(), plan(), review(), implement({ dependsOn: ['plan-1'] }), verify()]);
  assert.equal(noImplementGate.ok, false);
  assert.match(noImplementGate.errors.join('; '), /review gate/);
  const verifyWithoutImplement = validateTaskGraph([baseSpec(), plan(), review(), verify({ dependsOn: ['review-1'] })]);
  assert.equal(verifyWithoutImplement.ok, false);
  assert.match(verifyWithoutImplement.errors.join('; '), /at least one implement/);
  const twoPlans = validateTaskGraph([baseSpec(), plan(), plan({ id: 'plan-2' }), review(), implement(), verify()]);
  assert.equal(twoPlans.ok, false);
  assert.match(twoPlans.errors.join('; '), /exactly one plan/);
});

test('plan-only graphs reject write nodes; write scopes must be pairwise disjoint', () => {
  assert.equal(validateTaskGraph([baseSpec(), plan(), review()], { planOnly: true }).ok, true);
  const withWrite = validateTaskGraph([baseSpec(), plan(), review(), implement(), verify()], { planOnly: true });
  assert.equal(withWrite.ok, false);
  assert.match(withWrite.errors.join('; '), /plan-only/);

  const disjoint = validateTaskGraph([baseSpec(), plan(), review(), implement(), implement({
    id: 'impl-2', writeScope: ['docs/guide.md'], outputs: ['change:impl-2'],
  }), verify({ dependsOn: ['impl-1', 'impl-2'] })]);
  assert.equal(disjoint.ok, true, disjoint.errors.join('; '));

  for (const [a, b] of [['src/a.ts', 'src/a.ts'], ['src/*.ts', 'src/a.ts'], ['src/**', 'src/deep/x.ts'], ['src', 'src/x.ts']]) {
    const clash = validateTaskGraph([baseSpec(), plan(), review(), implement(), implement({
      id: 'impl-2', writeScope: [b], outputs: ['change:impl-2'],
    }), verify({ dependsOn: ['impl-1', 'impl-2'] })].map((spec) => spec.id === 'impl-1' ? { ...spec, writeScope: [a] } : spec));
    assert.equal(clash.ok, false, `expected overlap for ${a} vs ${b}`);
    assert.match(clash.errors.join('; '), /overlap/);
  }
  const separateDirs = validateTaskGraph([baseSpec(), plan(), review(), implement(), implement({
    id: 'impl-2', writeScope: ['docs/**'], outputs: ['change:impl-2'],
  }), verify({ dependsOn: ['impl-1', 'impl-2'] })]);
  assert.equal(separateDirs.ok, true, separateDirs.errors.join('; '));
});

test('scope path matching supports * and ** conservatively', () => {
  assert.equal(normalizeScopePath('src/a.ts'), 'src/a.ts');
  assert.equal(normalizeScopePath('./a'), null);
  assert.equal(normalizeScopePath('a//b'), null);
  assert.ok(matchScopePath('src/*.ts', 'src/a.ts'));
  assert.ok(!matchScopePath('src/*.ts', 'src/sub/a.ts'));
  assert.ok(matchScopePath('src/**', 'src/sub/a.ts'));
  assert.ok(matchScopePath('src/**/*.ts', 'src/sub/deep/a.ts'));
  assert.ok(matchScopePath('src/a.ts', 'src/a.ts'));
  assert.ok(!matchScopePath('src/a.ts', 'src/a.tsx'));
  assert.ok(!matchScopePath('src/**', '../outside.ts'));
});

test('kind agents cover every kind with exactly one specialist', () => {
  for (const kind of Object.keys(KIND_AGENTS)) assert.equal(KIND_AGENTS[kind].length, 1);
});

test('artifact naming contract: outputs must be runner-assigned and inputs producible', () => {
  // The failed-run shape: a plan node with a custom output name feeds a
  // review input that no runner-managed artifact can ever satisfy.
  const failedRunShape = validateTaskGraph([
    baseSpec(),
    plan({ outputs: ['isolated-efficientnet-runbook'] }),
    review({ inputs: ['isolated-efficientnet-runbook'] }),
  ]);
  assert.equal(failedRunShape.ok, false);
  assert.match(failedRunShape.errors.join('; '), /plan-1: outputs must be \[plan\]/);
  assert.match(failedRunShape.errors.join('; '), /review-1: inputs reference isolated-efficientnet-runbook/);
  assert.match(failedRunShape.errors.join('; '), /allowed names are findings, plan, review/);

  const wrongVerifyOutput = validateTaskGraph([baseSpec(), plan(), review(), implement(), verify({ outputs: ['verification:impl-1'] })]);
  assert.equal(wrongVerifyOutput.ok, false);
  assert.match(wrongVerifyOutput.errors.join('; '), /verify-1: outputs must be \[verification:verify-1\]/);

  const foreignChangeInput = validateTaskGraph([
    baseSpec(), plan(), review(),
    implement({ inputs: ['change:review-1'] }),
    implement({ id: 'impl-2', writeScope: ['docs/b.md'], outputs: ['change:impl-2'] }),
    verify({ dependsOn: ['impl-1', 'impl-2'], inputs: ['verification:verify-1', 'ghost-report'] }),
  ]);
  assert.equal(foreignChangeInput.ok, false);
  assert.match(foreignChangeInput.errors.join('; '), /impl-1: inputs reference change:review-1/);
  assert.match(foreignChangeInput.errors.join('; '), /verify-1: inputs reference ghost-report/);

  // Canonical names, omissions and version pins are all accepted.
  const canonical = validateTaskGraph([
    baseSpec({ outputs: [] }),
    plan({ inputs: ['findings@1'] }),
    review({ inputs: ['plan'] }),
    implement({ inputs: ['review@1', 'findings'] }),
    verify({ dependsOn: ['impl-1'], inputs: ['change:impl-1', 'verification:verify-1'] }),
  ]);
  assert.equal(canonical.ok, true, canonical.errors.join('; '));
});

test('deliverables: optional literal files within writeScope, implement nodes only', () => {
  const good = validateTaskGraph([
    baseSpec(), plan(), review(),
    implement({ writeScope: ['src/**'], deliverables: ['src/a.ts', 'src/generated/manifest.json'] }),
    verify(),
  ]);
  assert.equal(good.ok, true, good.errors.join('; '));

  const notImplement = validateTaskGraph([baseSpec(), plan(), review(), implement(), verify({ deliverables: ['logs/x.txt'] })]);
  assert.equal(notImplement.ok, false);
  assert.match(notImplement.errors.join('; '), /only implement nodes may declare deliverables/);

  const outOfScope = validateTaskGraph([baseSpec(), plan(), review(), implement({ deliverables: ['docs/outside.md'] }), verify()]);
  assert.equal(outOfScope.ok, false);
  assert.match(outOfScope.errors.join('; '), /docs\/outside.md is outside this node's writeScope/);

  for (const bad of [['src/'], ['src/*.ts'], ['/abs/path.ts'], ['../escape.ts']]) {
    const result = validateTaskGraph([baseSpec(), plan(), review(), implement({ deliverables: bad }), verify()]);
    assert.equal(result.ok, false, `expected rejection for ${bad[0]}`);
    assert.match(result.errors.join('; '), /deliverables:/);
  }

  const tooMany = validateTaskGraph([baseSpec(), plan(), review(), implement({ deliverables: Array.from({ length: 33 }, (_, index) => `src/f${index}.ts`) }), verify()]);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join('; '), /deliverables must be an array of strings \(max 32\)/);
});
