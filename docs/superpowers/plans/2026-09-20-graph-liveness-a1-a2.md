# Graph Liveness A1 + A2 Implementation Plan

> Execute with subagent-driven-development: fresh implementer per task, spec review then quality review, fixes and re-review before moving on.

**Goal:** Make paused graph runs settle safely and reject artifact-induced deadlocks before replacing an accepted plan.

**Architecture:** Separate dispatch ownership/settlement from permission to perform work. Validate the effective node and artifact dependency graph against the artifacts that the proposed plan can actually consume. Preserve gates, original pause reasons, attempt accounting, and evidence provenance.

**Tech stack:** Node.js >=22, ESM, node:test, OpenCode 1.18.x plugin hooks.

## Scope and baseline

- Approved first implementation milestone: A1 and A2. Selective repair, new in-place resume policy, infrastructure budgets, schema ergonomics, adaptive routing (B), and real-model campaigns follow in separate milestones.
- Main evaluation model for subsequent campaigns: zai-coding-plan/glm-5.3, max; audit actual provider requests.
- Baseline commit: 229a351 (alpha.17).
- Isolated branch: fix/graph-liveness-a1-a2. Do not modify the live plugin checkout or LF2 histories.
- Baseline: npm ci --ignore-scripts; npm test -> 493 tests, 491 pass, 2 POSIX-specific skips, 0 failures (Node 25.9.0).
- Each implementer follows TDD, runs targeted tests and self-review. Controller performs the two independent review stages and integration checks. Commits contain only reviewed intended files; do not publish or merge.

## Task 1 / A1: paused settlement and decision reachability

Files: src/dispatch-bindings.mjs, src/runner.mjs, src/submit.mjs, src/enforcement.mjs as needed; src/prompts.mjs and README.md for changed public behavior. Tests: test/dispatch-bindings.test.mjs, test/enforcement.test.mjs, test/runner-and-state.test.mjs, test/strict-dispatch.test.mjs, test/workflow.test.mjs as applicable.

Reproduction: two bound implementers A (maxAttempts=1) and B run concurrently. A ends without submitting, pausing the run. B's host completion currently cannot clear RUNNING because finish() requires current(), which requires run.status=RUNNING. All dispatch records can be gone while graph_run_decide returns RUN_BUSY and resume returns AWAITING_DECISION.

Required behavior:

1. Separate proof of ownership of an admitted attempt from permission to continue work. Ownership includes the exact session, node, dispatch identity, and reservation where applicable.
2. Paused runs admit no new dispatch or new workspace side effects. Existing current-attempt settlement must remain possible and durable; it must not advance dependent nodes, erase the pause, or turn the run into SUCCEEDED.
3. Record late tool-after evidence for already-started effects honestly. Do not allow paused tools to start new work merely to produce that evidence.
4. Authenticated child terminal/idle events retire the matching in-flight state even while paused. Real active children still block decisions. No forged identity, stale event, or old binding can settle a new attempt.
5. Accept/preserve structured closeout information from owned attempts while paused without minting an approval/change that advances the graph. Keep accepted work from before the pause intact. Bound and validate newly persisted closeout data.
6. Preserve the first pendingDecision and its timestamp/cause. Secondary sibling exhaustion must not overwrite it. No extra attempt charge/refund from duplicate settlement.
7. Cover foreground/background events, reversed arrival, repeated idle/terminal events, admitted-but-unbound reservations, binding/settlement save failures, and restart recovery of a paused run with lingering nodes.
8. Once all real children/reservations have ended, the existing abort/reset paths must work. Recovery of stale paused bookkeeping must not unpause the run or replay effects.
9. Update prompts/docs to explain settlement versus execution. No new user decision policy or automatic success fallback.

Execution:

- [x] Add failing host-event and public-submit regression tests for the reproduction and paused closeout.
- [x] Run node --test test/dispatch-bindings.test.mjs test/enforcement.test.mjs test/runner-and-state.test.mjs; confirm failure is the expected bug.
- [x] Implement the minimal ownership/settlement changes and bounded closeout handling.
- [x] Add adversarial persistence, stale-event, restart and pause-preservation cases.
- [x] Run affected tests (including strict-dispatch/workflow when modified) and npm test.
- [x] Spec review, resolve findings, re-review; then quality review, resolve findings, re-review.
- [x] Commit the reviewed A1 change (b546c1a).

## Task 2 / A2: effective artifact dependency liveness

Files: src/task-spec.mjs, src/runner.mjs, src/submit.mjs; README.md and src/prompts.mjs if public error guidance changes. Tests: test/json-and-spec.test.mjs, test/runner-and-state.test.mjs, test/enforcement.test.mjs, plus test/workflow.test.mjs if needed.

Reproduction: ordinary p -> review -> implement -> verify graph, with review.inputs=[verification:verify]. The current validator accepts dependsOn as acyclic but no node can start once p is complete.

Required behavior:

1. Include artifact producer dependencies in liveness validation, not only dependsOn. Reject self-reference and indirect cycles with actionable node/artifact chain diagnostics.
2. Validate state-dependent references before mutating run mode, existing nodes, counters, artifacts, bindings or accepted plan. Rejected plans leave the old run intact.
3. Evaluate the effective plan after the existing plan/review input normalization; do not break runner-assigned version semantics.
4. Pre-existing evidence may be consumed when currently valid and version-compatible. Findings can predate the proposed graph. Missing, stale, superseded or permanently unsatisfiable pins cannot silently strand required work.
5. Account for which artifacts the proposed plan actually preserves, replaces, supersedes or creates. In particular, old review/baseline evidence cannot mask a dependency cycle in the replacement plan.
6. A needed future artifact without a satisfiable producer/version must be rejected. Do not invent artifacts, rewrite authored evidence pins to unrelated evidence, or silently add exemptions.
7. Preserve valid full, light, plan-only, baseline, offline-to-live chains, independent work packages, existing findings, and legitimate re-planning.
8. Existing historical accepted graphs remain loadable/inspectable; this milestone validates new submissions rather than mutating histories.
9. Keep validator/runner responsibilities explicit and avoid duplicated inconsistent artifact naming logic. No unrelated scope-glob or verification-policy redesign.

Execution:

- [x] Add failing self-cycle, indirect artifact-cycle and atomic rejection tests.
- [x] Run node --test test/json-and-spec.test.mjs test/runner-and-state.test.mjs test/enforcement.test.mjs; confirm expected red cases.
- [x] Implement producer-aware structural and state-aware admission checks before mutation.
- [x] Add positive cases for all supported lanes and replan/version semantics plus adversarial future/missing evidence cases.
- [x] Run affected tests and npm test.
- [x] Spec review, resolve findings, re-review; then quality review, resolve findings, re-review.
- [x] Commit the reviewed A2 change (6295eaa).

## Final integration and evidence

### Integration corrections discovered by independent review and native host

- Native OpenCode 1.18.31 retains the original tool argument object: replace-by-assignment does not transport runner guidance or per-call tokens. Mutate the original argument object in place, including intentional removal of stale fields on rejected dispatches. Add native-shaped identity-preserving hook tests and re-run the isolated fake-provider host harness.
- Plan publication must revoke execution authority without deleting still-active host lifetimes, including the submitting background planner. Preserve durable settlement-only tracking across plan replacement; exact completion is still required before abort/reset.
- A resumed attempt must not orphan a previous dispatch in the same session. Settle proven old reservations independently of the current execution binding and mutate node state only on exact attempt identity; cover repair/retry overlap before the old host turn finishes.
- These are corrections to A1/A2 integration, not new workflow policy. Use a fresh implementer, followed by spec and quality review. The native harness and its immutable initial evidence live outside the repository under the approved temp root.

Integration spec and quality re-review approved the corrections, including persist-before-publish rollback-free plan admission and admission-ordered free-session ownership restoration. The first native check failed token transport; the second check passed light-flow correlation and atomic cycle rejection. Final-code native revalidation is part of the remaining handoff check.

Implementation clarification: native idle/status alone cannot prove that queued tasks finished. Original per-call user anchors require observed native chat.message provenance; authenticated compaction descendants can extend them. Legacy/cancelled calls lacking positive completion proof remain unresolved. This milestone does not claim automatic recovery of host facts the public API cannot establish.

- [x] Independent overall code review against both tasks and base commit; identified integration corrections received separate spec and quality approval.
- [ ] Run npm test and git diff --check on the final bytes.
- [ ] Inspect real-host smoke infrastructure and run a bounded deterministic/fake-provider host test if supported. Distinguish host simulation, real host, and real-model evidence.
- [ ] Check clean status and intended commit/file list; confirm original checkout remains unchanged.
- [ ] Report results, branch/worktree, unresolved limits, and the next A milestone. Do not claim model-level superiority without a new paired campaign.

## Future evaluation policy (not executed by this milestone)

Use fresh matched Build runs; keep old reports immutable. Freeze plugin/host/model/budgets and independent external oracles per campaign. Existing twelve tasks are a regression bank; new held-out tasks evaluate generalization. Compare native Build, repaired full graph (A), and adaptive graph (A+B). Separate cold-start delivery from longitudinal memory experiments; count memory preparation and failed-run costs, and provide Build a predefined reasonable longitudinal context. Record first edit, rejection rounds, zero-edit resubmissions, actual repair fanout, verified-delivery time, user-response time and later knowledge-projection cost. Define real-model sample counts and spending before launching campaigns.
