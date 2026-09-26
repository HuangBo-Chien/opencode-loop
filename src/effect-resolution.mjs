// Resolution is independent verifier evidence, not a rewrite of an error outcome.
import { stableHash } from './json-safe.mjs';

const uncertain = effect => effect.uncertain === true || effect.outcome === 'error';
const identity = effect => JSON.stringify([effect.sessionId, effect.callID, stableHash(effect)]);

export function resolveEffectClaims(state, node, claims, { verdict, artifacts, probed }) {
  if (!Array.isArray(claims) || claims.length > 128) return { ok: false, detail: 'resolvedEffects must be a bounded array' };
  if (!claims.length) return { ok: true, resolutions: [] };
  if (verdict !== 'PASS' || node.spec.baseline || !artifacts.length || !probed.length) {
    return { ok: false, detail: 'Effect resolution requires nonbaseline PASS, an existing evidence artifact and explicit probed scenarios' };
  }
  const seen = new Set(), resolutions = [];
  for (const claim of claims) {
    if (!claim || Object.keys(claim).sort().join(',') !== 'callID,sessionId' || !['sessionId', 'callID'].every(k => typeof claim[k] === 'string' && claim[k].length > 0 && claim[k].length <= 256)) {
      return { ok: false, detail: 'Each resolved effect requires exactly sessionId and callID' };
    }
    const effect = state.sideEffects.find(e => e.sessionId === claim.sessionId && e.callID === claim.callID);
    const source = effect && state.nodes[effect.nodeId]?.spec;
    const ownVerification = source?.kind === 'verify' && effect.nodeId === node.spec.id;
    const output = source?.kind === 'implement' ? 'change' : source?.kind === 'verify' ? (source.baseline ? 'baseline' : 'verification') : null;
    const consumedDependency = output && node.spec.dependsOn.includes(effect.nodeId)
      && (node.consumedRefs ?? []).some(ref => ref.startsWith(`${output}:${effect.nodeId}@`));
    if (!effect || !uncertain(effect) || !ownVerification && !consumedDependency) {
      return { ok: false, detail: 'Resolve only recorded uncertain effects of this verifier or directly consumed implement/verify dependencies' };
    }
    const key = identity(effect);
    if (seen.has(key)) return { ok: false, detail: 'Duplicate effect resolution' };
    seen.add(key);
    resolutions.push({ ...claim, effectHash: stableHash(effect) });
  }
  return { ok: true, resolutions };
}

export function unresolvedEffects(state) {
  const resolved = new Set();
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.kind !== 'verification' || artifact.status !== 'valid' || artifact.payload?.verdict !== 'PASS') continue;
    for (const e of artifact.payload.resolvedEffects ?? []) resolved.add(JSON.stringify([e.sessionId, e.callID, e.effectHash]));
  }
  return state.sideEffects.filter(e => uncertain(e) && !resolved.has(identity(e)));
}
