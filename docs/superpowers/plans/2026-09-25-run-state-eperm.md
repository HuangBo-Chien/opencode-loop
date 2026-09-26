# Run-state EPERM Implementation Plan

> Execute inline using the executing-plans workflow. User approved the design and implementation in the current workspace. Do not commit without a separate request.

**Goal:** Absorb bounded transient Windows rename failures without replaying agent work, while preserving atomic snapshots, per-run ordering and recovery contracts.

**Architecture:** Keep the existing JSON format and upper-layer mutation queue. Add a focused atomic-write helper with Windows-only EPERM backoff, independent diagnostics and best-effort temporary cleanup. Serialize store writes per run, freeze snapshots before queuing, and drain writes before releasing the lock.

**Tech Stack:** ESM JavaScript, node:fs/promises, node:test; Windows runtime and cross-platform fault injection.

## Tasks

- [x] Establish baseline: `node --test test/runner-and-state.test.mjs test/dispatch-bindings.test.mjs test/in-place-recovery.test.mjs` (416 passed, 1 skipped).
- [x] Add `test/run-state-persistence.test.mjs`: inject transient/permanent rename failures against real temporary files; assert complete old/new JSON, same temp across retries, cleanup, bounded retry, FIFO snapshots, independent runs, initial-create failure cleanup and release drain. Initial red run: 9 expected failures, 2 existing behaviors passed.
- [x] Add `src/run-state-write.mjs`: bounded Windows EPERM-only rename retry (same temp/content), private unique temp, cleanup without masking the primary error, diagnostic events without payload content. Never delete the target or retry the entire caller operation.
- [x] Update `src/run-state.mjs`: per-run FIFO, admission-time snapshot, creation cleanup and release lifecycle. Keep mutation and binding semantics at their existing upper-layer boundary.
- [x] Add disk-backed dispatch tests in `test/run-state-persistence.test.mjs`: transient binding persistence, exhausted failure followed by authentic repeated metadata, unchanged attempt count and preserved reservation. Add actual process-interruption tests before/after replacement.
- [x] Add a no-model Windows stress script under `test/fixtures/` that runs actual readers in another process, samples save latency and validates monotonic complete snapshots. Include a native no-delete-sharing holder for real Windows contention. Run with/without 20 ms polling (6,000 stress saves, no unexpected failures).
- [x] Integrate bounded diagnostics with host logging in `src/index.mjs`; logging errors must not affect authoritative commits. Actual OpenCode 1.18.31 / embedded Bun 1.3.14 probe recovered native EPERM.
- [x] Run targeted regression then `npm test`; final result: 1,060 passed, 2 platform skips, 0 failures. Focused persistence suite: 24 passed. Bun runtime smoke: 1 passed. Read-only production review found no new regressions; pre-existing lifecycle limitations are recorded in `docs/run-state-eperm-validation.md`. Real-model checks remain explicitly unexercised.

## Contracts and review gates

1. Retry only rename EPERM on Windows, with at most eight attempts and a monotonic elapsed retry deadline of 1500 ms (an already-running OS call cannot be cancelled). Other failures propagate immediately.
2. Retry the identical frozen snapshot and temporary file. The old destination is never unlinked. Best-effort cleanup affects only the owned temp.
3. Same-run saves are FIFO; distinct runs do not share a queue. A failed save rejects its caller without poisoning subsequent saves. Queueing does not merge stale caller state.
4. Release closes admission immediately, drains accepted saves, then removes the lock. Failed lock removal retains registration so release can be retried.
5. Creation publishes registration only after persistence succeeds; a failed first write cleans its own lock and temp. Duplicate in-process creation is rejected before it can replace an existing registration.
6. No new schema, user options, parallelism reduction, target-delete fallback, whole-dispatch retries or model-budget changes.
7. True lock-owner attribution remains a separate evidence question: native sharing contention proves handling, not the historical benchmark lock holder.
