# Targeted Recovery Fixes Implementation Plan

**Goal:** Repair journal runtime compatibility, recoverable file claims, and dispatch/session correlation without resetting failed runs or review budgets.

**Architecture:** Keep the runner as decision core; use a call-ID keyed dispatch registry at the host boundary, typed file claims at submission, and bounded advisory journal diagnostics/retries.

**Tech stack:** ES modules, node:test, OpenCode plugin API 1.18.25, Node and Bun.

Approved in conversation. Execute inline in the existing feature/run-journal-memory checkout; preserve the user's .gitignore change. No commits or publication requested.

## Sequence and acceptance

- [x] Directory cleanup: await close in try/catch (ignore only ERR_DIR_CLOSED), including failures after opendir. Test synchronous and asynchronous close behavior, early termination, and real Node/Bun scans. Runtime testing also identified and fixed Bun's deferred ENOENT during directory iteration.
- [x] File claims: validate literal relative files separately from scopes; format/directory/missing-file mistakes remain RUNNING and retryable. Keep scope and ledger failures strict. Add filesDeleted as an absent subset of filesTouched. Snapshot raw bytes and explicit deletions; persist rejection mutations. Check caller node identity before I/O.
- [x] Dispatch lifecycle: reserve by root/callID; bind from host task metadata.sessionId, never session-created FIFO. Count attempts only on binding. Same active attempt may continue; retries need fresh sessions. Clear reservations and revoke old bindings on recovery. Reject delayed/conflicting events and serialize run mutations. Resolve delayed events through bounded host reads before managed child work.
- [x] Journal diagnostics: fixed safe stage codes for listing/backfill/init/inference/index. Three initialization attempts, query-driven cooldowns of 30s and 60s, single flight and fake-clock tests. Preserve metadata-only and text fallback behavior.
- [x] Inspect/prompts/docs: expose binding and retry information; document claims, deletion, cache setup before the first command, and hidden directories.
- [x] Automated verification: targeted suites then npm test; Node/Bun runtime smoke and a simulated host flow with corrected submission and recovery. Actual-host acceptance reported separately below.

## Test commands

```sh
node --test test/runtime-close.test.mjs test/runner-and-state.test.mjs test/journal-store.test.mjs
node --test test/file-claims.test.mjs test/dispatch-bindings.test.mjs test/enforcement.test.mjs
node --test test/journal-search.test.mjs test/journal.test.mjs test/journal-tools.test.mjs test/plugin.test.mjs
npm test
```

Baseline: 249 tests, 248 passed, 1 platform-specific skip, 0 failures (Node v24.15.0).

## Final verification

- `npm test`: 272 tests; 271 passed, 1 Windows-specific skip, 0 failures (Node v24.15.0). Includes packed-package relocation/import.
- `bun test test/runtime-smoke.test.mjs test/dispatch-bindings.test.mjs test/file-claims.test.mjs`: 19 passed, 0 failures (Bun 1.3.13, Windows executable accessed from WSL).
- `bun test -t 'full gated flow|evidence gates|crash window|session idle|out-of-scope|invalid graphs' test/enforcement.test.mjs`: 6 passed, 7 filtered out, 0 failures. The full existing Node suite has nested subtests unsupported by this Bun release; it is not claimed as a full Bun pass.
- Direct read-only Bun diagnostics against the original project: run listing succeeds; bounded journal scan loads the existing 2 entries / 15,250 bytes without the original close error.
- `git diff --check`: passed.
- Independent review findings reproduced and covered: unknown-session fail-closed behavior, pending continuations, completed-background metadata, persistence/idle races, repeated idle event IDs, late idle evidence, revoked call-ID replay, and terminal events during failed binding persistence.

Actual model-driven acceptance on OpenCode 1.18.25 is not run. The installed CLI reports 1.18.30; pinned 1.18.25 task/plugin/status source was inspected and simulated. `enforcementAttested` remains false. No model download, installation, commit, push, or release was performed.
