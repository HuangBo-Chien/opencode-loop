import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectClaims, unresolvedEffects } from '../src/effect-resolution.mjs';

const fixture = () => {
  const effect = { nodeId: 'i', sessionId: 'child', callID: 'call', outcome: 'error', uncertain: true, target: 'src/a.js' };
  const state = { nodes: { i: { spec: { kind: 'implement' } } }, artifacts: {}, sideEffects: [effect] };
  const node = { spec: { dependsOn: ['i'] }, consumedRefs: ['change:i@1'] };
  const evidence = { verdict: 'PASS', artifacts: ['evidence.log'], probed: ['target examined'] };
  const claim = { sessionId: 'child', callID: 'call' };
  return { state, node, evidence, claim };
};

test('PR1 effect resolution is tied to exact immutable outcome and current valid verification', () => {
  const h = fixture();
  const result = resolveEffectClaims(h.state, h.node, [h.claim], h.evidence);
  assert.equal(result.ok, true);
  h.state.artifacts.v = { kind: 'verification', status: 'valid', payload: { verdict: 'PASS', resolvedEffects: result.resolutions } };
  assert.equal(unresolvedEffects(h.state).length, 0);
  h.state.artifacts.v.status = 'stale';
  assert.equal(unresolvedEffects(h.state).length, 1);
  h.state.artifacts.v.status = 'valid';
  h.state.sideEffects[0].target = 'different';
  assert.equal(unresolvedEffects(h.state).length, 1);
});

for (const variant of ['wrong identity', 'duplicate', 'foreign node', 'missing consumption', 'baseline', 'FAIL', 'no artifact', 'no probes']) {
  test(`PR1 rejects unsafe effect resolution: ${variant}`, () => {
    const h = fixture();
    let claims = [h.claim];
    if (variant === 'wrong identity') claims = [{ ...h.claim, callID: 'foreign' }];
    if (variant === 'duplicate') claims.push(h.claim);
    if (variant === 'foreign node') h.node.spec.dependsOn = [];
    if (variant === 'missing consumption') h.node.consumedRefs = [];
    if (variant === 'baseline') h.node.spec.baseline = true;
    if (variant === 'FAIL') h.evidence.verdict = 'FAIL';
    if (variant === 'no artifact') h.evidence.artifacts = [];
    if (variant === 'no probes') h.evidence.probed = [];
    assert.equal(resolveEffectClaims(h.state, h.node, claims, h.evidence).ok, false);
    assert.equal(unresolvedEffects(h.state).length, 1);
  });
}
