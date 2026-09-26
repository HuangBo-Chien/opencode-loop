# PR1 Reliability Implementation Plan

> **For agentic workers:** Use `executing-plans` for inline execution. Track steps below; do not commit or push without a user request.

**Goal:** Complete durable-publication isolation, finite host settlement, and observable phase costs for production plugin runs.

**Architecture:** Add a reliable store decorator with async-scoped candidate state and a latched infrastructure fence. Existing per-run dispatch serialization owns the transaction scope. Add an event-driven settlement controller and bounded accounting service, wired through production composition; existing historical state remains readable.

**Tech Stack:** Node/Bun ESM, AsyncLocalStorage, node:test, existing OpenCode hooks and SDK.

**Execution record:** All four tasks below are implemented and verified. The
original planning checklist is retained below for traceability; final outcomes,
review fixes, added effect-resolution/host-read modules, and coverage boundaries
are recorded in [PR1 validation](../../pr1-reliability-validation.md).

## Task 1 — Baseline and durable publication

Files: create `src/run-reliability.mjs`, `test/pr1-reliability.test.mjs`; modify `src/dispatch-bindings.mjs`, `src/submit.mjs`, `src/enforcement.mjs`, `src/index.mjs`.

- [x] Run `npm test`: baseline 1060 pass, 2 platform skips, 0 failures.
- [ ] Add failing tests for isolated live references, failed publication, unchanged disk state, and fault admission fences.
- [ ] Run `node --test test/pr1-reliability.test.mjs` and confirm missing behavior.
- [ ] Implement transaction scope with `AsyncLocalStorage`: `getRun` returns a candidate inside a serialized operation; `saveRun` persists a frozen clone before publishing into the stable committed reference. New/loaded runs join the active scope without leaking mutable committed references.
- [ ] On physical save failure, latch `PERSISTENCE_FAILED`; diagnostics remain independent. Classify model-facing persistence rejection separately from payload rejection.
- [ ] Add `store.transaction(runId, operation)` at the dispatch queue boundary. Restore private dispatch authority from its last durable checkpoint on failure; never discard committed admissions or settlement evidence.
- [ ] Gate fresh submissions, task execution, workspace tools and configured MCP calls on infrastructure health. Read-only inspection and actual owned terminal evidence remain usable.
- [ ] Explicit recovery may clear a latch only after authentic lifetime/effect settlement and a successful durable recovery boundary.
- [ ] Re-run focused persistence, enforcement, dispatch and recovery suites.

## Task 2 — Settlement state and controller

Files: create `src/settlement.mjs`, `test/pr1-settlement.test.mjs`; modify `src/run-state.mjs`, `src/runner.mjs`, `src/dispatch-bindings.mjs`, `src/enforcement.mjs`, `src/config.mjs`, `src/index.mjs`, `src/submit.mjs`.

- [ ] Add fake-clock tests: accepted graph with a live child is not final success; final terminal evidence completes; missing evidence expires; repeat events cannot renew deadline; final save failure stays unsuccessful.
- [ ] Run `node --test test/pr1-settlement.test.mjs` and confirm red.
- [ ] Introduce `SETTLING` for reliable runs. Preserve legacy pure-runner behavior for unversioned historical/test callers. Block new execution in SETTLING.
- [ ] Implement `settlementBlockers(state)` over reservations, recovery issues, pending effects and unresolved uncertain effects. Finite controller ticks reuse the run queue, never dispatch agents.
- [ ] Validate `settlementTimeoutMs` default 30000, integer range 1000–300000. Maintain a monotonic deadline independent of events; bound host probes with abortable requests and reject results after expiration.
- [ ] Persist FAILED/SETTLEMENT_TIMEOUT on expiry, retain ownership. Automatically commit SUCCEEDED only after predicates and storage succeed.
- [ ] Restore settlement-only ownership after restart; one bounded reconciliation then interrupted settlement rather than a refreshed allowance. Late evidence never upgrades failed runs.
- [ ] Add new-run/resume fences so they cannot erase surviving lifetimes or bypass settlement failure.
- [ ] Re-run targeted lifecycle suites.

## Task 3 — Accounting

Files: create `src/run-accounting.mjs`, `test/pr1-accounting.test.mjs`; modify `src/index.mjs`, `src/submit.mjs`, `src/enforcement.mjs`.

- [ ] Add tests for partial/repeated message usage, missing fields, bounded capacity, phase transitions and clock discontinuity.
- [ ] Run `node --test test/pr1-accounting.test.mjs` and confirm red.
- [ ] Record commit-observed node phase intervals and successful modifying-effect milestones with monotonic offsets. Distinguish per-attempt summed work from run wall duration.
- [ ] Authenticate usage by managed session identity; upsert by session/message ID, preserve unknowns, never add reasoning/cache subsets to total again.
- [ ] Keep detailed accounting outside run snapshots with bounded storage; surface compact aggregates and coverage through graph_inspect. Diagnostic write failure cannot affect execution authority.
- [ ] Record persistence outcomes using the existing callback, without snapshot bodies. Preserve unavailable historical intervals as unknown on restart.

## Task 4 — Integration and verification

Files: modify `README.md`, `src/prompts.mjs`; extend PR1 test files.

- [ ] Add public-hook tests of failed review/change/verdict submissions and accepted-but-live child settlement, including restart and final-save failure.
- [ ] Document status semantics, recovery fences, timeout option and accounting limitations; explain that model polling is unnecessary during settlement.
- [ ] Run `node --test test/pr1-*.test.mjs`.
- [ ] Run `npm test`; diagnose failures rather than relaxing assertions unrelated to intentional lifecycle changes.
- [ ] Run `bun test test/runtime-smoke.test.mjs` when Bun is available, then `git diff --check` and inspect the final diff.
- [ ] Report exact results and remaining host-validation limitations. Changes stay uncommitted in the user-selected current directory.
