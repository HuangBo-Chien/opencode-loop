# PR1 implementation and validation

Baseline: `d6f512ab506af6009ae139e11b6b87d040141dc0`.
Implementation remains uncommitted in the existing workspace, as requested.

## Delivered

- Production run-store decorator with async-scoped candidates, durable publication,
  stable committed run identity, a latched infrastructure fence, and explicit
  recovery. Dispatch private authority is reconstructed from committed reservations
  following persistence failure. Existing Windows snapshot retry remains unchanged.
- `SETTLING`, a default 30-second configurable monotonic settlement budget,
  bounded host reads, final accepted-snapshot revalidation, and durable timeout or
  interrupted outcomes that retain outstanding host ownership.
- Automatic finalization from native terminal/effect evidence without a new model
  turn. Repeated/queued events do not renew budgets or require redelivery after
  private registry reconstruction.
- Evidence-bound resolution of historical uncertain effects: a valid nonbaseline
  PASS may resolve this verifier's effects or directly consumed implement/verify
  dependencies, with an existing evidence artifact and explicit probed findings.
  Exact effect hashes prevent changed outcomes from inheriting an old resolution.
- Optional phase accounting (`phaseAccounting`, default true): bounded observed
  intervals, root/child and role/phase usage, unknown coverage, and persistence
  outcomes. Coalesced per-process diagnostic files are outside run snapshots.
- Documentation and role guidance for failure/recovery, settlement, resolution
  claims, and measurement interpretation.

## Regression evidence

Tests were first exercised with the missing modules/behaviors and then re-run
after implementation. Public-hook regressions demonstrated the specific review,
change and verification publication failures with unchanged committed memory and
disk. Review reproducers caught and drove fixes for:

1. A terminal callback queued behind private registry reconstruction.
2. An unrecoverable faulted SETTLING state after failed final publication.
3. Historical implementer/verifier errors remaining permanently unresolved despite
   fresh verification evidence.
4. Getter-only host client properties.
5. File evidence changing between acceptance and final settlement.
6. A delayed diagnostic flush recreating a removed workspace.

The existing journal-composition test now supplies actual task terminal events
before expecting a final success summary; acceptance alone is insufficient.

## Final commands and results

```powershell
npm test
```

**1,102 tests: 1,100 passed, 2 platform-specific skips, 0 failed.**
The original baseline was 1,060 passed, 2 skips, 0 failed; 40 PR1 tests were added.

```powershell
bun test ./test/pr1-reliability.test.mjs ./test/pr1-settlement.test.mjs ./test/pr1-integration.test.mjs ./test/pr1-accounting.test.mjs ./test/pr1-host-read.test.mjs ./test/pr1-effect-resolution.test.mjs ./test/runtime-smoke.test.mjs
```

**Bun 1.3.13: 41 passed, 0 failed** (40 PR1 cases plus the runtime smoke case).

The Node suite includes packaging/import isolation, real filesystem persistence,
fault injection, and restart tests. `git diff --check` is the final whitespace check.

## Coverage boundaries

- No GLM model benchmark was rerun. These results establish deterministic behavior,
  not a measured improvement in model PASS rate or token cost.
- Supported host-read signatures remain the pinned plugin input's **SDK v1**
  contract. Read-only review also exercised the installed SDK v1 through plugin
  composition successfully. Supporting getter-only properties is not support for
  SDK v2's different flattened parameter signatures; that migration is separate.
- The actual OpenCode executable's end-to-end model workflow was not rerun here.
  The earlier native Windows EPERM evidence remains documented separately.
- Accounting covers current-process observed messages. Unknown provider helpers,
  missing usage, capacity overflow, and restart gaps are not counted as zero.
  Summed concurrent phase work is not wall elapsed duration. Phase attribution
  uses the first observed message event, not an inferred provider request start.
- Filesystem calls already running cannot be forcibly cancelled by a JavaScript
  deadline. Read-only late results are ignored; write outcomes retain the original
  durable-boundary and fault-fencing rules.

Restart OpenCode to load the changed production plugin.
