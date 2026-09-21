// Bounded same-run verification recovery. No filesystem or host lifetime I/O:
// the public boundary supplies an observed snapshot, never new expected hashes.
import { stableHash } from './json-safe.mjs';
import { artifactRef, consumedRefs } from './artifact-dependencies.mjs';
import { canonicalOutput, matchScopePath, validateFileClaim } from './task-spec.mjs';
import { sanitizeRun } from './run-state.mjs';

const CORRECTABLE = new Set(['INSUFFICIENT_EVIDENCE', 'ARTIFACT_REQUIRED', 'INVALID_VERDICT']);
const CORRUPTION = new Set(['OUT_OF_SCOPE', 'LEDGER_MISMATCH', 'EXECUTED_DESPITE_DENY',
  'out-of-scope-claim', 'undisclosed-edit', 'executed-despite-deny', 'out-of-scope-edit', 'out-of-scope-write', 'out-of-scope-bash']);
const deny = (detail) => ({ ok: false, code: 'RETRY_INELIGIBLE', detail });
const same = (a, b) => stableHash(a) === stableHash(b);

function verifierOutputSlot(state, nodeId) {
  const name = `verification:${nodeId}`;
  const present = Object.hasOwn(state.artifacts, name);
  return { name, present, artifact: present ? structuredClone(state.artifacts[name]) : null };
}

// Current full artifacts are proof; Task1's edge-only historical lineage is
// not. Include healthy siblings as well as the target's dependency closure.
export function recoveryProof(state, pause) {
  const entries = {};
  const work = Object.entries(state.artifacts).filter(([, a]) => a.status === 'valid').map(([name, a]) => `${name}@${a.version}`);
  for (const node of Object.values(state.nodes)) {
    if (node.attempt > 0 && !['plan', 'explore', 'analyze'].includes(node.spec.kind)) {
      if (!Array.isArray(node.consumedRefs)) throw new TypeError('Missing retained consumption proof');
      work.push(...node.consumedRefs);
    }
    if (node.state === 'SUCCEEDED' && ['implement', 'verify', 'review'].includes(node.spec.kind)) {
      const ref = node.producedRef;
      if (!ref || ref.split('@')[0] !== canonicalOutput(node.spec)) throw new TypeError('Missing accepted output proof');
      work.push(ref);
    }
  }
  work.push(...pause.expectedRefs);
  for (let i = 0; i < work.length; i++) {
    const ref = work[i];
    if (Object.hasOwn(entries, ref)) continue;
    if (work.length > 8192 || Object.keys(entries).length >= 1000) throw new TypeError('Recovery provenance capacity exceeded');
    if (!/@[1-9]\d*$/.test(ref)) throw new TypeError('Unpinned retained provenance');
    const { artifact, missing } = artifactRef(state, ref);
    if (missing) throw new TypeError(`Insufficient retained proof: ${missing}`);
    entries[ref] = artifact;
    if (!Array.isArray(artifact.basedOn)) throw new TypeError('Missing retained dependency provenance');
    work.push(...artifact.basedOn);
  }
  const deleted = new Set();
  for (const artifact of Object.values(entries)) {
    if (artifact.kind !== 'change') continue;
    const claims = artifact.payload?.filesTouched;
    const removals = artifact.payload?.filesDeleted ?? [];
    if (!Array.isArray(claims) || !Array.isArray(removals) || removals.some((file) => !claims.includes(file))) throw new TypeError('Incomplete retained change claims');
    for (const file of claims) {
      const hash = artifact.snapshot?.[file];
      if (!validateFileClaim(file).ok || (removals.includes(file) ? hash !== 'MISSING' : !/^[a-f0-9]{64}$/.test(hash ?? ''))) {
        throw new TypeError(`Missing trustworthy snapshot coverage: ${file}`);
      }
    }
    for (const file of removals) deleted.add(file);
  }
  for (const effect of state.sideEffects) {
    if (!['edit', 'write'].includes(effect.tool) || effect.uncertain === true || effect.outcome === 'error') continue;
    const node = state.nodes[effect.nodeId];
    const claim = state.artifacts[`change:${effect.nodeId}`];
    if (!node || node.spec.kind !== 'implement' || !claim?.payload?.filesTouched?.includes(effect.target)
      || !node.spec.writeScope.some((scope) => matchScopePath(scope, effect.target))) throw new TypeError('Scope or ledger corruption in retained changes');
  }
  const expectedSnapshot = {};
  for (const artifact of [...Object.values(entries), pause.evidence]) {
    for (const [file, hash] of Object.entries(artifact.snapshot ?? {})) {
      if (!validateFileClaim(file).ok || !(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) || hash === 'MISSING' && deleted.has(file))) {
        throw new TypeError(`Untrustworthy expected snapshot: ${file}`);
      }
      if (Object.hasOwn(expectedSnapshot, file) && expectedSnapshot[file] !== hash) throw new TypeError(`Conflicting expected snapshots: ${file}`);
      expectedSnapshot[file] = hash;
    }
  }
  return { refs: Object.keys(entries).sort(), expectedSnapshot, digest: stableHash({ entries, expectedRefs: pause.expectedRefs, evidence: pause.evidence,
    outputSlot: pause.outputSlot,
    // Object keys are canonicalized by stableHash; array insertion order would
    // change when sanitizeRun sorts node keys on disk and break valid restarts.
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, node]) => [id, {
      spec: node.spec, consumedRefs: node.consumedRefs ?? null, producedRef: node.producedRef ?? null,
    }])) }) };
}

export function captureVerificationPause(state, node, evidence, rejectionCode = null) {
  const pause = { nodeId: node.spec.id, dispatchId: node.dispatchId ?? null, sessionId: node.sessionId ?? null,
    attempt: node.attempt, planVersion: state.artifacts.plan?.version ?? null,
    expectedRefs: structuredClone(node.consumedRefs ?? []), rejectionCode, evidence: structuredClone(evidence),
    // Includes superseded outputs (UNVERIFIED and prior rejection outputs),
    // which the valid dependency closure intentionally cannot authenticate.
    outputSlot: verifierOutputSlot(state, node.spec.id) };
  try { pause.proof = recoveryProof(state, pause); }
  catch (error) { pause.proof = null; pause.proofError = error.message; }
  return pause;
}

// Prepare, don't publish. Successful admission spends the single allowance;
// dispatch still owns the ordinary attempt charge and new token at binding.
export function prepareVerificationRetry(state, { expectedPauseId, reason, observedSnapshot, maxAttempts, now }) {
  const pause = state.pendingDecision;
  if (state.status !== 'AWAITING_USER_DECISION' || state.successorRunId) return deny('Only the latest paused run can retry');
  if (!Number.isSafeInteger(expectedPauseId) || expectedPauseId < 1 || expectedPauseId !== pause?.pauseId
    || state.pauseSequence !== pause.pauseId) return deny('expectedPauseId must match the current pauseId');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) return deny('A user-provided reason is required');
  if ((state.recoveryUsed ?? 0) !== 0 || (state.recoveryHistory?.length ?? 0) !== 0) return deny('The one same-run retry allowance is already used');
  if (pause.cause !== 'verification-unverified' && !(pause.cause === 'runner-rejection' && CORRECTABLE.has(pause.rejectionCode))) return deny('Pause cause is not eligible for verification retry');
  const node = state.nodes[pause.nodeId];
  if (!node || node.spec.kind !== 'verify' || node.spec.baseline === true || node.state !== 'PENDING'
    || typeof pause.dispatchId !== 'string' || !pause.dispatchId || typeof pause.sessionId !== 'string' || !pause.sessionId
    || node.dispatchId !== pause.dispatchId || node.sessionId !== pause.sessionId || node.attempt !== pause.attempt
    || !Number.isSafeInteger(node.attempt) || node.attempt < 1) return deny('Missing or changed original verifier generation');
  if (node.attempt >= (node.spec.maxAttempts ?? maxAttempts)) return deny('The verifier has no normal attempts remaining');
  if ((state.pendingEffects?.length ?? 0) || state.dispatchReservations !== undefined && (!Array.isArray(state.dispatchReservations) || state.dispatchReservations.length !== 0)) return deny('Outstanding effects or native reservations must settle');
  if (state.dispatchRecoveryIssues !== undefined && (!Array.isArray(state.dispatchRecoveryIssues) || state.dispatchRecoveryIssues.length !== 0)) return deny('Unrestorable outstanding lifetimes have insufficient identity proof');
  if (state.repairPlanRevision || state.pendingRepair || state.needsPlanRevision) return deny('Unresolved repair or plan revision work');
  for (const other of Object.values(state.nodes)) {
    if (other === node) continue;
    if (!['SUCCEEDED', 'SKIPPED'].includes(other.state) && !(other.state === 'PENDING' && other.attempt === 0)) return deny('Unrelated unfinished work cannot be resolved by retry');
  }
  if (Object.values(state.nodes).some((n) => CORRUPTION.has(n.lastFailure?.code))
    || state.violations.some((v) => CORRUPTION.has(v.kind) || CORRUPTION.has(v.code))) return deny('Scope, ledger or denied-execution corruption requires separate recovery');
  const plan = state.artifacts.plan;
  const review = state.artifacts.review;
  if (!plan || plan.status !== 'valid' || plan.version !== pause.planVersion || plan.payload?.intent !== state.mode
    || (state.mode !== 'light' && (!review || review.status !== 'valid' || review.payload?.verdict !== 'PASS'
      || !review.basedOn?.includes(`plan@${plan.version}`)))) return deny('Current plan approval is missing or changed');
  if (!pause.proof || !pause.evidence?.payload || !Array.isArray(pause.expectedRefs)) return deny('Original pause lacks sufficient retained evidence');
  try {
    // Compare the entire captured record, including absence, before accepting
    // any fresh observation. Never reconstruct expected identity from today's
    // slot; alias spelling, provenance, extra fields and generation all matter.
    if (!pause.outputSlot || !same(pause.outputSlot, verifierOutputSlot(state, pause.nodeId))) return deny('Original verifier output record or absence changed');
    if (pause.cause === 'verification-unverified') {
      const artifact = state.artifacts[`verification:${pause.nodeId}`];
      if (pause.evidence.payload.verdict !== 'UNVERIFIED' || !artifact || artifact.status !== 'superseded'
        || pause.evidence.ref !== `verification:${pause.nodeId}@${artifact.version}`
        || !same(artifact.payload, pause.evidence.payload) || !same(artifact.snapshot ?? {}, pause.evidence.snapshot)) return deny('Original UNVERIFIED evidence changed');
    } else if (node.rejectionStreak?.code !== pause.rejectionCode || node.rejectionStreak.count < 2
      || node.rejectionStreak.detail !== pause.evidence.detail) return deny('Original rejection evidence changed');
    if (!same(consumedRefs(state, node), pause.expectedRefs) || !same(recoveryProof(state, pause), pause.proof)) return deny('Accepted dependencies or expected evidence changed');
    for (const [file, hash] of Object.entries(pause.proof.expectedSnapshot)) {
      if (!Object.hasOwn(observedSnapshot ?? {}, file) || observedSnapshot[file] !== hash) return deny(`Workspace snapshot changed or is unverifiable: ${file}`);
    }
    const candidate = structuredClone(state);
    const decision = { action: 'retry', reason, expectedPauseId, at: now };
    candidate.recoveryHistory = [{ pause: structuredClone(pause), decision }];
    candidate.recoveryUsed = 1;
    candidate.decision = decision;
    candidate.pendingDecision = null;
    candidate.status = 'RUNNING';
    candidate.blockedReason = null;
    candidate.updatedAt = now;
    sanitizeRun(candidate); // the real persistence caps, including in-memory stores
    return { ok: true, candidate, nodeId: node.spec.id };
  } catch (error) { return deny(`Insufficient evidence or recovery capacity: ${error.message}`); }
}
