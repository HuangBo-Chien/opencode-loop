# Selective Repair and In-place Recovery Implementation Plan

> Execute with fresh implementer per task, spec review followed by independent code-quality review, and fix/re-review loops. Continue between tasks without human check-ins.

**Goal:** Repair only affected reviewed work and retry an eligible verification in the same run without discarding valid work or replenishing counters.

**Architecture:** A focused artifact-dependency helper owns consumed-version provenance and affected-work closure. A focused recovery-policy helper owns pure retry eligibility/audit projection. The runner retains state transitions; submit tools own filesystem checks and persist-before-publish transactions; the existing native dispatcher owns lifetime identity.

**Tech stack:** Node.js >=22, ESM, node:test, OpenCode SDK 1.18.25 / native integration 1.18.31.

## Baseline and scope

- Start from 0251eb5, the A1+A2 milestone published as PR #15.
- Branch: feature/selective-repair-recovery, separate worktree based on PR #15.
- Baseline: npm ci --ignore-scripts and node --test --test-reporter=dot test/*.test.mjs passed (680 cases; 678 pass, 2 POSIX-specific skips in the prior verified full output).
- Preserve the PR branch and all native/historical evaluation evidence. Do not merge or expand PR #15 during this milestone.
- Subsequent GLM-5.3 max comparison and adaptive routing remain separate milestones. No paid model campaign here.

## Task 1: selective repair with affected-work invalidation

Files: new src/artifact-dependencies.mjs and test/selective-repair.test.mjs as appropriate; src/runner.mjs, src/submit.mjs, src/dispatch-bindings.mjs, src/enforcement.mjs, src/prompts.mjs, README.md, and corresponding existing tests as needed.

### API and policy

- graph_submit_verification gains optional repairTargets: exact unique nonempty node-ID array on non-baseline FAIL only. Each target must be a direct implement dependency of the verifier. Omission means all direct implement dependencies (existing conservative default).
- Wrong verdict, empty/duplicate/unknown/non-implement/unrelated targets reject before consuming a round or changing state. Pure runner callers must obey the same rule.
- Persist effective targets in FAIL evidence. Repair dispatch guidance names true targets/affected consumers, not healthy siblings.
- Functional repair retains existing capped global repair rounds and existing fresh-version verifier attempt behavior; user retry in Task 2 does not inherit any counter resets.

### Dependency integrity

- Capture exact consumed refs at beginNode using the same artifact-kind resolution as admission. Unpinned inputs resolve to actual versions consumed; relevant dependency outputs/approval are included.
- Preserve bounded provenance-only lineage when referenced historical versions leave latest slots; do not retain full payload history or enable new consumption of obsolete versions. Capacity failures must be atomic and actionable, never silent provenance loss.
- Compute the fixed-point affected closure from selected current change refs through consumed refs, explicit inputs, execution dependencies and artifact basedOn. Reopen selected implementations, stale their dependent implementations/verifiers and non-valid artifacts, leave unrelated successful siblings byte-for-byte unchanged.
- Walk forward, not backward: invalidating a combined verifier of A+B must not reopen B just because A failed.
- Ordinary publication is not semantic invalidation. Preserve A2 historical own-slot reads and legitimately consumed independent historical evidence; invalidation follows affected versions. Legacy incomplete provenance uses documented conservative graph-based invalidation or an explicit blocker, never unproven independence.
- Explicit obsolete pins are never automatically rewritten. Persist failure/invalidation and return an actionable needsPlanRevision/blocker with the offending refs; keep the existing planner route available rather than pretending the graph can run. Invalidated plan/review support likewise requires re-planning, not invalid approval reuse.
- Revoke execution only for affected in-flight attempts while preserving exact old host lifetimes/effects. Fence replacement dispatch (fresh and task_id) until old affected lifetimes and pending effects settle. Unrelated running siblings remain operational.
- Public FAIL transition and selective revocation must be one persist-before-publish operation. EIO/capacity failure leaves live graph, counters, private bindings and disk at their previous accepted state.

### Tests / execution

- [ ] RED tests: A+B default versus A-only; invalid targets and verdict misuse; healthy B preserved without resubmission.
- [ ] RED tests: verify->verify chain; implementation consumers through deps and artifact-only inputs; combined-verifier fanout without unrelated sibling repair.
- [ ] Implement version/provenance capture and bounded closure, then selective transition and guidance.
- [ ] Cover historical reads, obsolete pins, legacy evidence, plan/review invalidation, budget exhaustion, stale callbacks, affected active lifetimes, unaffected live sibling, restart and save/capacity faults.
- [ ] Run node --test test/selective-repair.test.mjs plus affected existing suites, then npm test.
- [ ] Independent spec review, fixes, re-review; independent quality review, fixes, re-review.
- [ ] Commit reviewed Task 1 separately.

## Task 2: bounded user-confirmed in-place verification retry

Files: new src/recovery-policy.mjs and test/in-place-recovery.test.mjs as appropriate; src/runner.mjs, src/submit.mjs, src/prompts.mjs, README.md; tests of submit, ownership, state and permissions as needed.

### API and eligibility

- Add action="retry" to graph_run_decide, keeping root-only native ask and required user reason. Existing abort/reset semantics remain; graph_run_resume remains crash recovery.
- Retry additionally requires expectedPauseId to identify the current pause. graph_inspect exposes it. Generate stable per-run monotonically increasing pause identities; first pause remains unchanged while active. Legacy pauses without sufficient identity/evidence are not guessed eligible.
- First version: at most ONE successful retry decision per run, persisted across restart/replan; ordinary node attempt budget must still have room. No decrement, hidden maxAttempts increase, revision-counter reset, new run, or successor creation.
- Allow verification-unverified and correctable runner-rejection codes INSUFFICIENT_EVIDENCE, ARTIFACT_REQUIRED, INVALID_VERDICT only. Exclude baseline-verifier retry initially, STALE_CHANGE, functional/repair exhaustion, scope/ledger/executed-despite-deny failures and unknown causes.
- Target is the exact paused non-baseline verifier and generation, not a caller-selected arbitrary node. It remains PENDING for ordinary fresh/same-session admission, with a new dispatch token and one attempt charged at binding.
- Require latest run, quiescent nodes and native reservations, no pending effects, matching plan/review/accepted dependency evidence, satisfiable inputs, and no unrelated failed/incomplete/recovery-required/stale work that this narrow retry cannot repair.
- Existing reviewed future PENDING work is not promoted or reset. Successful implementations and sibling verifications, scopes, snapshots, counters, closeouts and effects remain unchanged.

### Evidence / transaction / audit

- Read current file hashes before deciding on a candidate. Retained valid change claims need complete trustworthy snapshot coverage; actual hashes must match, deliberate declared deletions may match MISSING. Missing coverage, UNVERIFIABLE, unexpected missing/changed files, links or conflicting expected snapshots deny without replacing expected evidence.
- Evidence equality is not proof the external environment recovered: the retried verifier still performs normal verification and earns PASS.
- Preserve resolved pause, user decision and prior verifier/rejection evidence in a bounded recovery history before clearing active pendingDecision. A later pause gets a new ID/cause. A stale or duplicate retry request cannot resolve a later pause or spend another allowance.
- Prepare all changes on a candidate, validate capacity, persist, then publish state. EIO retry is safe. Do not reactivate old binding or discard native lifetime evidence to manufacture quiescence.
- Preserve rejection streak through retry; unchanged rejected payload re-pauses, corrected accepted verdict clears it normally. Functional FAIL after retry uses Task 1 selective repair.

### Tests / execution

- [ ] RED public happy path: UNVERIFIED -> user retry -> same-run fresh/same-session verification PASS, untouched implementation versions.
- [ ] Implement pure eligibility/audit projection plus strict snapshot checks and transactional decision.
- [ ] Cover allowlist/denials, attempt and single-decision allowance across restart/replan, stale expectedPauseId, native permission denial, effects/lifetimes still pending, forged closeouts, snapshot drift/deletion/links/missing coverage, pause evidence retention, identical rejection, functional FAIL into selective repair.
- [ ] Cover persistence faults, crash after saved retry before redispatch, successor run identity and late old events unable to affect new attempts.
- [ ] Run node --test test/in-place-recovery.test.mjs plus affected existing suites, then npm test.
- [ ] Independent spec review, fixes, re-review; independent quality review, fixes, re-review.
- [ ] Commit reviewed Task 2 separately.

## Integration and handoff

- [ ] Independent final review of the complete milestone, including interaction with A1/A2.
- [ ] Full tests, diff check and clean branch/source verification.
- [ ] Bounded real-host/local deterministic-provider smoke if feasible: one selective repair flow and one UNVERIFIED -> retry -> PASS flow; preserve source hashes and all failed harness attempts, no external model calls.
- [ ] Report exact verification strength and remaining native/real-model limits. Keep code separate from PR #15 unless the user explicitly chooses integration.
