# PR1: durable submission, bounded settlement, and phase accounting

## Scope and baseline

Baseline: `d6f512ab506af6009ae139e11b6b87d040141dc0`.

Complete PR1 of the improvement proposal: infrastructure failures stay in the
program, accepted work has a finite settlement outcome, and recorded costs can
distinguish useful work from coordination and settlement. Preserve the existing
Windows EPERM writer, artifact provenance, permissions, attempt accounting,
compaction correlation, and recovery evidence.

Direct execution, automatic dispatch of graph nodes, and shared model execution
budgets belong to later PRs. This PR does not infer benchmark success from graph
status or silently restart model work.

## 1. Durable state publication

All mutations of authoritative run state must follow:

1. Enter the existing per-run mutation serialization boundary.
2. Construct an isolated candidate from the last published state.
3. Apply the transition and validate the candidate.
4. Persist the candidate using the existing frozen-snapshot writer.
5. Publish candidate fields into the stable live-state object only on success.
6. Publish associated binding, reservation, effect, and artifact authority only
   after the same durable boundary has succeeded.

The stable object identity matters because existing callers retain run references.
Replacing a Map entry alone does not make retained references transactional.
The store write FIFO orders serialized writes; it does not replace the mutation
queue or merge stale candidates. Private dispatch registries must either be
staged or restored if their transition fails. Never rerun a mutation callback as
part of an I/O retry.

Audit submission tools, enforcement effects, dispatch admission/binding/retirement,
request capture, recovery, decisions, and successor creation. Preserve existing
fail-closed gates and bounded settlement history.

### Persistence failure

Keep the existing Windows rename EPERM allowlist and bounded backoff. On exhausted
retry or a non-retryable persistence error:

- Retain the last committed graph and its artifact versions.
- Latch a per-run infrastructure fault before releasing the mutation queue.
- Deny new dispatches and new workspace side effects independently of the run
  JSON status. Do not misclassify the error as `PAYLOAD_INVALID`.
- Emit a bounded independent host diagnostic containing operation identity,
  stage, error code, and snapshot hash; never include the snapshot payload.
- Preserve owned host lifetimes and incoming settlement/effect evidence. A fault
  must not clear reservations or pretend that an admitted task was cancelled.
- Permit bounded programmatic persistence of settlement evidence, without
  reopening execution admission. A later successful write does not silently
  clear the fault or grant approval.

If storage remains unavailable, expose the volatile fault through inspection and
host logging. Do not claim it is durable. Restart recovery uses only committed
state and authenticated host evidence; it cannot assume an unsaved transition
occurred. Explicit recovery must establish a successful durable boundary before
new work is admitted, retaining all existing recovery restrictions.

## 2. Completion and bounded settlement

Separate graph acceptance from whole-run success. Necessary graph acceptance
means all required nodes passed or were legitimately skipped with current valid
artifacts. Once acceptance is satisfied, the run enters an observable settlement
phase rather than immediately publishing `SUCCEEDED`.

Whole-run `SUCCEEDED` requires:

- Necessary graph acceptance and valid artifact lineage.
- No outstanding admitted task/child lifetime.
- No pending or unresolved uncertain side effect.
- Successful persistence of the final state.
- No latched infrastructure fault.

Use existing native-call/turn correlation rules. Idle alone remains insufficient.
Artifact submission does not end a host lifetime. An authentic terminal event
can end a lifetime but cannot substitute for verification evidence.

### Controller behavior

A narrowly scoped settlement controller reacts to acceptance and host events.
It reuses the per-run queue and existing reconciliation helpers; it does not
dispatch graph nodes or ask an LLM to decide whether the run has ended.

- Default total settlement budget: `settlementTimeoutMs = 30000`.
- Accept only positive integer milliseconds, bounded to 1000–300000 inclusive.
- Begin the budget when necessary graph acceptance is first reached.
- Count queue delay, reconciliation calls, and retry delays against that budget.
- Use a monotonic clock for elapsed duration. Wall timestamps are provenance.
- Reconcile immediately, then at most once per second; prevent overlapping
  reconciliation and cap each host request by the remaining budget.
- Repeated events must not restart or extend the deadline.
- As soon as all completion predicates hold, commit success without an extra
  orchestrator model turn.
- At expiry, record `SETTLEMENT_TIMEOUT`, remaining blockers, and an unsuccessful
  completion outcome. Keep lifetime/effect ownership and deny new execution.
- Late terminal evidence may settle retained ownership but cannot upgrade an
  expired run to success or create a fresh allowance.
- If timeout publication fails, use the infrastructure fault path.

Timers must not retain the host process or leak after terminal completion.
Tests inject clocks and scheduling rather than wait for production deadlines.
No unsafe success-on-timeout or unconfirmed process-stop behavior is permitted.

### Restart policy

Persist settlement phase identity and consumed monotonic duration when updating
settlement evidence. Monotonic epochs do not survive process restarts. A restored
settling run therefore receives one immediate bounded reconciliation; if complete
termination cannot be established, it is recorded as interrupted settlement and
requires explicit recovery, rather than receiving a new automatic 30-second
budget. Existing historical runs remain readable; old `SUCCEEDED` values are not
retroactively changed merely by reading them.

## 3. Phase and usage accounting

Record bounded structured lifecycle measurements, with identities linking run,
node, dispatch, session, and attempt where applicable:

- Exploration/planning, implementation, verification, and settlement intervals.
- First confirmed successful modifying tool outcome. Label it as observed
  modification, not proof of semantic correctness or a complete diff.
- Accepted change and verification submissions.
- Final run completion or timeout/infrastructure failure.
- Persistence retry count and duration from existing writer events.

Durations within a live process use monotonic time. Overlapping child intervals
must not be summed and presented as wall elapsed duration. After restart, unknown
gaps stay unknown. Useful projections include time before first observed change,
accepted change to final completion, and acceptance to settlement outcome.

Capture host-reported usage from authenticated message events only. Deduplicate
and upsert by session/message identity because message updates may be partial or
repeated. Preserve unknown usage rather than assigning zero. Keep root and child
usage separately attributable. Cache/reasoning subfields must not be double-counted
in totals. Unsupported fields and unassignable phases remain explicitly unknown.
Do not imply complete provider/helper accounting when the plugin cannot observe it.

Keep accounting bounded and outside model-facing artifact bodies. Inspection
returns compact aggregates and coverage/unknown indicators. Detailed diagnostics
must not consume the authoritative snapshot's admission/settlement headroom.

## 4. Configuration and compatibility

Expose the settlement timeout through validated plugin options and pass it through
plugin composition. Document new phase/status and fault fields, inspection output,
the restart policy, and the distinction between graph acceptance and final success.

Compatibility switches may disable optional accounting or support controlled
settlement rollout. No switch may authorize dispatch from uncommitted state or
declare success with unresolved lifetimes/effects. Unknown options remain errors.

## 5. Acceptance and verification

Use fault injection and fake host events before spending model tokens:

1. Transient EPERM commits the same snapshot without new model requests or attempts.
2. Failed review/change/verdict publication leaves live and disk authority aligned.
3. Exhausted persistence blocks fresh task admission and modifying tools, while
   owned settlement evidence remains accountable.
4. Persistence errors are not reported as malformed payloads.
5. Artifact submission with an active child enters settlement, not final success.
6. Authentic terminal proof and settled effects automatically publish final success.
7. Duplicate, reordered, contradictory, and old terminal/idle events cannot retire
   the wrong lifetime, duplicate charges, or extend settlement time.
8. Missing terminal proof and unresponsive host APIs produce bounded unsuccessful
   settlement, without dropping reservations or asserting a stopped process.
9. Late evidence after timeout preserves ownership history but never changes failure
   to success. Restart cannot grant a fresh automatic settlement budget.
10. Final-save failure never exposes a successful run in live state.
11. Partial/repeated usage updates are not double-counted; missing usage and restart
    gaps remain unknown; overlapping durations are reported honestly.
12. Existing permissions, paused closeouts, repair selection, recovery, artifact
    provenance, and persistence tests remain passing.

Run targeted suites after each component and the full Node suite after integration.
Run available runtime smoke checks when changes touch plugin composition. Record
exact commands and outcomes. Any Windows/actual-host validation not performed in
this pass is explicitly listed as unverified, rather than inferred from unit tests.
