# PR2 Direct execution validation

The implementation adds a distinct Direct contract to the existing runner.
It does not manufacture a planner plan or critic approval. One authenticated
implementer can inspect, edit, execute frozen foreground checks and repair a
failed check in its existing session. A runner-owned acceptance artifact leads
to PR1 settlement before final success.

## Verification on 2026-09-26

The pre-change baseline at `e4a9868` ran 1,102 tests: 1,100 passed, none failed,
and two were skipped. The final implemented change ran 1,136 tests: **1,134
passed, none failed, two skipped**. The 34 added tests comprise seven real
filesystem / subprocess tests and 27 Direct public-tool, runner, permission,
scope and lifecycle regressions. Independent spec review passed; final quality
review reran all 37 Direct and shell-scope tests successfully.

The full regression run required the existing test suite's normal external cache
access: sandboxed execution encountered npm/journal cache permission errors; the
authorized unrestricted rerun passed. `git diff --check` passed (Git emitted only
the repository's existing LF-to-CRLF conversion notices).

An opt-in native probe passed both scenarios on installed **OpenCode 1.18.31**:

| Scenario | Observed result |
| --- | --- |
| Frozen content check initially fails; worker writes the required content, repeats the check and submits | Exactly one native child session, one implementer attempt, no plan or review artifact; run reaches `SUCCEEDED` after settlement |
| Host shell permission denies the check | No check sentinel file is created, initial workspace content is unchanged and the run does not reach success |

The probe independently queries the isolated host database to count child
sessions and check-tool calls. Its deterministic local provider sends fixed
tool calls; it uses no external model credentials and measures no LLM quality.
Temporary projects, host state and local provider fixtures are removed afterward.

Run the default regressions:

```powershell
npm test
git diff --check
```

Run the optional real-host probe using the native executable rather than a shell
launcher:

```powershell
$env:OPENCODE_NATIVE_BINARY = 'C:\path\to\opencode.exe'
node --test test/native-direct.probe.mjs
```

## Evidence and supported boundary

- `executionStrategy: "auto"` enables Direct selection for eligible new runs.
  `"graph"` preserves Graph/light routing; old runs without a strategy load as
  Graph. Existing runs do not silently change route after restart.
- Root-only contract creation records requirement, rationale, literal file scope,
  required deliverables and 1–8 frozen checks. Contract revisions wait for host
  settlement and retain the original baseline and consumed budgets.
- A check obtains native `bash` permission before registering and executing its
  frozen command. Results bind to run, session, dispatch, attempt, contract and
  before/after workspace revision. Model-provided `checksRun` is not authority.
  The existing best-effort shell write screen also runs before permission and
  execution, resolving targets against the declared cwd; detectable out-of-scope
  redirects are denied before they can modify files.
- Pending checks fence edits, shell work, dispatch and acceptance. A failed
  completed check can be repaired within the existing worker; timeout or
  interruption leaves uncertainty and cannot become a PASS through resubmission.
  Failure-budget exhaustion and uncertain outcomes pause execution, retaining
  evidence for a user decision after the admitted host work settles.
- Scope validation compares actual workspace hashes against the starting
  inventory, preserving pre-existing dirty contents as the baseline. Acceptance
  requires complete touched/deleted claims, deliverables and current passing
  evidence. Final settlement captures the workspace again, including added files.
- Inventory rejects symbolic links and special files, bounds files at 2,000,
  entries at 10,000 and total contents at 128 MiB, and excludes `.git`,
  `node_modules` and the configured state directory. These excluded paths are
  outside Direct's acceptance boundary and cannot be declared as its write
  targets. Broader scopes and unsupported workspaces use Graph.
- Commands must run in the foreground and finish their own children. The shell
  exit is evidence for that admitted execution, not proof of OS-level process
  containment. Deliberately detached/unreferenced services are unsupported.
  Timeout/cancellation attempts process-tree termination and retains uncertainty.
  Inventory detects ordinary concurrent changes but is not an atomic filesystem
  snapshot or a defense against hostile external writers.

## What these results do not establish

The native probe establishes real custom-tool permission handling, one-child
dispatch, same-session repair and successful lifecycle settlement on 1.18.31.
The SDK remains pinned to 1.18.25; its native executable has not been tested here.

Structural reduction from planner/implementer/verifier to one implementer is
not a measured token or elapsed-time improvement. Equal-budget external benchmark
acceptance and real-model routing quality remain to be measured against the
original fixed task set and held-out tasks. No benchmark PASS-rate, token saving
or cost improvement is claimed by these deterministic tests. PR3 handoff
compression and PR4 shared budgets/controller dispatch are outside this change.
