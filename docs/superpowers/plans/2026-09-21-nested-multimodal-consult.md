# Nested graph-multimodal Consultation — Revised Implementation Plan

## Goal and execution

Allow all five graph specialists (explorer, planner, plan-critic, implementer,
verifier), as well as the existing orchestrator, to request image interpretation.
Implement on `feature/nested-multimodal-consult`; use implementation and independent
review agents, then verify and open a PR. Do not merge the PR automatically.

This revision supersedes the original 2026-09-21 proposal. It explicitly covers
consult-only admission, caller isolation, bounded capacity, and restart recovery.

## Contract

- Root dispatch keeps its existing behavior.
- Native depth prerequisite (independent-review revision): the authoritative
  OpenCode schema defines top-level `subagent_depth` as a nonnegative integer;
  pinned v1.18.25 `TaskTool.execute` rejects caller depth at or above the native
  default 1 before child creation/metadata. The plugin defaults an unspecified
  host setting to 2, preserves explicit settings, and checks effective depth
  before reservation (root needs 1, specialist nesting needs 2). Arbitrary host
  errors remain fail-closed; they do not prove a reserved lifetime ended.
- A nested caller must be a current, authenticated binding in a RUNNING run and
  one of the five permitted specialist roles. Multimodal cannot dispatch.
- Nested dispatch targets only graph-multimodal. It is always a free consultation:
  no graph node, no node marker, no node attempt charged, and no findings artifact.
- The child returns observations, sources, uncertainty and limitations through
  the native task response. Its caller remains responsible for formal delivery.
- An explicit internal consult-only admission path bypasses ready-node selection,
  not run/role/identity gates. In particular, a ready analyze node is never taken.
- Nested consultations have a fixed run-wide limit of one outstanding consultation
  (therefore also at most one per caller), separate from ordinary reader capacity.
  An explorer occupying the last reader slot can still obtain image assistance.
  Denials explain that callers must not spin or wait on themselves.
- Continuation may reuse only a nested free consultation from the same run and
  the exact same caller/owning dispatch generation. Cross-caller, root/nested,
  and node-bound continuation reuse is rejected before reservation changes.
- Persist callerSessionId and caller dispatch provenance separately from
  rootSessionId. Legacy records lacking callerSessionId remain root dispatches.
- Call correlation uses actual caller session + callID throughout admission,
  collision checks, recovery indexing and host metadata verification.
- Parent execution revocation also revokes dependent nested execution; host
  lifetimes remain tracked until trustworthy completion evidence arrives.
  Parent completion/rebinding must not confer authority on stale consultations.
- Pause/replan/repair/restart do not lose nested lifetimes or release capacity
  without evidence. Nested findings are forbidden, including paused closeout.

## Task 1 — Admission and provenance

Files: src/runner.mjs, src/dispatch-bindings.mjs and focused tests.

Add explicit consult-only runner admission. Validate nested caller, target,
absence of node markers, continuation ownership, and fixed consultation capacity
inside the serialized admission section. Preserve root behavior and old records.
Persist provenance before publishing authority. Test ready analyze nodes,
full ordinary reader capacity, duplicate call IDs in different callers,
continuations, unauthorized roles, idle/revoked callers and persistence failure.
Include native depth config default/explicit-value tests and verify insufficient
depth creates neither a reservation nor an admission-history entry. Update the
host probe to check the effective top-level depth before native nested execution.

## Task 2 — Complete session and recovery integration

Files: src/dispatch-bindings.mjs and dispatch/recovery tests.

Audit bind, onSession, captureTurns, refreshTurns, observeMessage, hostIsIdle,
applyPart, managed, runForSession, resolveSession, consumeIdle, inspect,
revokeExecution, invalidate and recoverPaused. Separate run identity from actual
parent identity. Recover host metadata from each recorded caller, not only root.
Recover nested classification and provenance without requiring a currently active
parent for settlement. Validate lineage from durable reservations/settled records.
Preserve fail-closed handling of unknown/malformed/cross-run parentage.
Test metadata/event reordering, turn anchors, terminal evidence, parent revocation,
paused and revoked recovery, persistence failures and legacy root records.

## Task 3 — Permissions, enforcement and delivery

Files: src/agents.mjs, src/prompts.mjs, src/enforcement.mjs, src/submit.mjs;
corresponding plugin, permissions, enforcement and submit tests.

Permit only graph-multimodal task targets for the five callers. Replace conflicting
blanket no-delegation prompt instructions. Inject an authoritative nested-consult
delivery instruction at dispatch time rather than intentionally provoking a failed
findings submission. Exempt nested consultations from the shared structured-submit
requirement. Keep multimodal task denied. Route managed child task through admission
with active-binding checks; avoid nested acquisition of the same run lock. Attribute
rejections to the caller node and return useful consult rejection instructions.
Reject nested graph_submit_findings before normal or paused artifact/closeout writes.
Inspect exposes caller/nested provenance for diagnosis.

## Task 4 — Verification and documentation

Update README to explain specialist image consultation, bounded capacity and
result delivery. Run focused tests followed by the full npm test suite. Obtain
independent spec/code review and fix findings before final verification.

Add a reproducible host integration probe or documented procedure for the pinned
OpenCode host: orchestrator -> implementer -> multimodal -> PNG read -> result
returned to implementer -> formal caller delivery, with correct parentID, task
metadata, turn anchor and lifetime settlement. Existing runtime-smoke tests cover
stores/embeddings and are not evidence of native nested task support. If host or
model credentials are unavailable, explicitly report this test as unverified;
do not describe mock-based coverage as an actual host smoke pass.

## Acceptance

1. Every eligible specialist can request image interpretation during active work.
2. Nested work never consumes an analyze node or publishes global findings.
3. Saturated ordinary reader capacity does not prevent one nested consultation.
4. Caller/session/generation boundaries hold across fresh calls and continuation.
5. Pauses, revocation and restart retain all outstanding lifetime evidence.
6. Existing root dispatch, capacity and findings behavior remains covered.
7. Full tests and independent review pass; actual host verification status is stated.
