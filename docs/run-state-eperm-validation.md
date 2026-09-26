# Windows run-state persistence: implementation and validation

Date: 2026-09-25. Baseline: `3613e09` / `0.3.0-alpha.18`.

## Change

`src/run-state-write.mjs` retains temp-file-plus-rename publication. Only Windows
rename `EPERM` is retried: seven backoffs of 10, 20, 40, 80, 160, 250 and 250 ms,
each with 0–9 ms jitter, at most eight attempts, and a monotonic 1,500 ms deadline.
The deadline bounds retry admission; it cannot cancel an already-running filesystem
call. Write failures, non-Windows EPERM, EIO, ENOSPC and EACCES propagate immediately.

Each operation retains its exact serialized bytes and temp path. The destination
is never unlinked or directly overwritten. Failed writes clean their owned temp
best-effort without masking the original error. A process crash can leave an
orphan temp; discovery ignores it and recovery reads only the authoritative JSON.

`src/run-state.mjs` freezes snapshots before FIFO admission, serializes writes per
run/store instance, and allows different runs to proceed independently. Failure
does not poison the next save. Release closes save admission and drains accepted
writes before unlocking. Initial creation publishes registration only after the
first successful commit and cleans its own lock on failure. Duplicate creation
does not erase the existing registration.

The existing dispatch mutation queue still owns state transitions. FIFO does not
merge stale snapshots, provide cross-process transactions, or replace the existing
cold-recovery/lock policy. Existing direct-store limitations around unregistered
release and concurrent load/release require a separate lock-ownership design;
this patch does not claim to resolve them.

## Diagnostics

The host adapter emits outcome summaries through `client.app.log`, service
`opencode-loop.persistence`. Normal first-attempt saves and individual retries
are not logged to the host. Recovered writes are warnings; exhausted/other failures
and cleanup failures are errors. Logging is advisory, not awaited by persistence,
and has a 1-second request timeout.

Events identify runtime, PID, run ID, operation UUID, snapshot SHA-256, target/temp
paths, sequence, stage, attempts and elapsed milliseconds. They contain no snapshot
payload. The internal callback also exposes retry events to diagnostic harnesses.
Lock cleanup failures have only run ID, stage and error code.

For an unexplained real failure, correlate these identifiers and timestamps with
Windows Process Monitor file operations on the exact target/temp paths. The
historical benchmark's lock holder remains unidentified; a recreated sharing
violation is not retrospective attribution.

## Automated tests

```powershell
node --test test/run-state-persistence.test.mjs
npm test
```

Final results: focused persistence suite **24 passed**; full suite **1,060 passed,
2 platform-specific skips, 0 failed** (1,062 total). `bun test
test/runtime-smoke.test.mjs` also passed (1 test). A read-only review found no new
production regressions; the pre-existing direct-store lifecycle limitations are
documented above. `git diff --check` passed.

The focused suite covers transient/permanent failure, unchanged destination,
same snapshot/temp retries, non-retryable failures, attempt/deadline caps,
partial writes, cleanup failure, diagnostic failures, FIFO and independent runs,
creation cleanup, release drain, failed foreign creation versus release,
disk-backed binding retry without duplicated attempts, and process interruption
immediately before/after replacement followed by reload and another save.

Existing dispatch, enforcement, submission and in-place recovery tests additionally
exercise fail-closed reservation, binding, settlement and verdict publication.

## No-model stress reproducer

Run from the repository. Requires Node or Bun; native sharing tests also need
Windows and PowerShell 7 (`pwsh`). Each invocation creates and removes its own
temporary workspace. Optional `--output <file>` saves its JSON report to an
existing parent directory. It does not read or modify benchmark specimens.

```powershell
node test/fixtures/run-state-stress.mjs --poll-ms 0 --iterations 100
node test/fixtures/run-state-stress.mjs --poll-ms 20 --iterations 100 --lock-ms 350
bun test/fixtures/run-state-stress.mjs --poll-ms 20 --iterations 100 --lock-ms 350
node test/fixtures/run-state-stress.mjs --poll-ms 20 --iterations 100 --lock-ms 3000 --expect-failure
bun test/fixtures/run-state-stress.mjs --poll-ms 20 --iterations 100 --lock-ms 3000 --expect-failure
```

Three runs each have four producers saving 100 snapshots (1,200 stress saves per
invocation). A separate process reads all three JSON files every 20 ms, checks
complete JSON and nondecreasing sequence numbers, and checks final generations.
All readers and reloads must observe the expected final sequence of 400 per run.

The native holder opens the destination using .NET `FileShare.ReadWrite` without
`FileShare.Delete`. A control single rename must fail with actual EPERM before
testing the new writer. The 350 ms case must recover; the 3,000 ms case must reject
with the prior snapshot intact, then subsequent stress writes must succeed.

### Observed results

| Runtime / scenario | Stress saves | Recovered writes* | Expected native failures | Reader errors | Stress p95 ms |
|---|---:|---:|---:|---:|---:|
| Node 25.9.0, no reader | 1200 | 0 | 0 | — | 5.26 |
| Node 25.9.0, 20 ms reader + 350 ms holder | 1200 | 29 | 0 | 0 | 20.38 |
| Bun 1.3.13, 20 ms reader + 350 ms holder | 1200 | 44 | 0 | 0 | 35.46 |
| Node 25.9.0, 20 ms reader + 3000 ms holder | 1200 | 42 | 1 | 0 | 27.00 |
| Bun 1.3.13, 20 ms reader + 3000 ms holder | 1200 | 50 | 1 | 0 | 38.11 |

*Includes the dedicated recovered native-lock write where applicable. No unexpected
write failures occurred. Permanent-holder failures returned after 914 ms (Node)
and 902 ms (Bun), preserving the old snapshot. These are diagnostic samples, not
controlled performance comparisons: some commands ran concurrently with tests.

Reports are saved under `C:/Users/b0420/AppData/Local/Temp/opencode/`:

- `eperm-node-no-reader.json`
- `eperm-node-reader-native-lock.json`
- `eperm-bun-reader-native-lock.json`
- `eperm-node-permanent-lock.json`
- `eperm-bun-permanent-lock.json`

## Actual OpenCode host

An isolated config loaded `test/fixtures/run-state-host-probe.mjs` through
`opencode debug config`, without a model request. The fixture uses the actual
store and host log adapter; the native holder/control/recovered-commit assertions
run during plugin initialization.

OpenCode **1.18.31** reported embedded **Bun 1.3.14**, distinct from both the Node
benchmark controller and the separately installed Bun. The single-rename control
failed with EPERM; the new save committed on attempt 6 after **387.89 ms**.
Evidence: `C:/Users/b0420/AppData/Local/Temp/opencode/eperm-host-probe/result.json`.

To reproduce, create a fresh config root containing `opencode/opencode.json` with
only this fixture's absolute file URL in `plugin`, and a separate empty workspace.
Run the following in a disposable PowerShell process from that workspace (replace
the paths for your checkout; the report parent must already exist):

```powershell
$env:XDG_CONFIG_HOME = 'C:\path\to\isolated-config-root'
$env:OPENCODE_DISABLE_PROJECT_CONFIG = '1'
$env:OPENCODE_DISABLE_DEFAULT_PLUGINS = '1'
$env:OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
$env:LOOP_PROBE_REPORT = 'C:\path\to\host-probe-result.json'
opencode debug config
```

The config output alone is not proof: inspect the report's `status`, runtime,
retry events and committed outcome. Do not install the diagnostic fixture into
your normal OpenCode configuration.

## Interpretation

The change now has fault-injection, real Windows sharing-conflict, cross-process
reader, crash-window and actual-host evidence. It preserves agent parallelism and
does not add a whole-dispatch retry or refund attempts. GLM T05/T06/T07 and the full
72-result benchmark were **not rerun** in this implementation pass; no model success
rate improvement is claimed. Loading the changed production plugin requires an
OpenCode restart.
