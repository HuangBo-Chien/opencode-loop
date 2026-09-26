# PR2: Direct execution with runner-owned acceptance

Status: approved by the user on 2026-09-26; implemented with validation recorded
in `docs/pr2-direct-validation.md`.

## Objective and existing behavior

Implement PR2 of `opencode-loop-improvement-plan.md`: bounded tasks with clear
acceptance use one worker for exploration, implementation and checks. Full Graph
remains available for decomposition and independent semantic review.

Baseline: `e4a9868`, including PR1 persistence fencing, settlement and accounting.
The existing `light` route still requires a planner, implementer and verifier.
`runner.submitChange` records model-provided `checksRun`; this is not trusted
execution evidence. `enforcement.onToolAfter` records effects but does not yet
persist an authenticated command exit code and its verified file revision.

## Alternatives and recommendation

1. Recommended: add an explicit Direct strategy to the existing runner, reusing
   dispatch bindings, scoped writes, artifacts, persistence and settlement.
   This reduces role dispatches while retaining the existing lifecycle.
2. Extend light mode by skipping only the planner. Smaller change, but still
   pays for a separate verifier to repeat mechanical checks.
3. Build a separate SDK controller. Larger host integration and permission
   surface; reserve automatic dispatch control for PR4.

## Routing and compatibility

- Add `executionStrategy: "auto" | "graph"`, default `"auto"`. `"graph"` is the
  rollback flag and preserves the current graph/light workflow.
- Persist the selected strategy and its contract in each run. Runs saved before
  this feature retain their existing graph semantics when resumed.
- Auto prefers Direct when scope is bounded and acceptance can be expressed as
  explicit checks and required artifacts. File count alone never selects Graph.
- Missing information permits bounded read-only investigation before committing
  the Direct contract. Use the existing attempt ceiling for this phase.
- Tasks needing independent semantic review or independently scheduled work use
  Graph. An explicit user request for Graph takes precedence over auto routing.
- Scope or acceptance changes require an explicit versioned contract transition;
  a worker cannot silently widen its own authorization.

## Direct contract and dispatch

The root establishes a structured contract through a dedicated runner tool:
user requirement, acceptance criteria, writeScope, required artifacts, named
commands with working directories, and a route rationale. The runner validates
the contract and persists it before admitting work. It generates the internal
node and artifact relationships; no planner-produced fake plan or PASS review
is required.

Use the existing implementer role with a Direct-specific prompt and tools. Its
bound session can inspect, edit, execute checks and submit a change. Existing
Graph mode role and review gates remain mode-specific. Direct submissions cannot
be used to bypass those gates on a Graph run.

## Acceptance evidence

Provide a dedicated permission-aware check tool for the worker to execute a named
command from the frozen contract. The runner owns command selection and records
the actual exit status, bounded output, run/dispatch/attempt identity, contract
version and workspace revision. Do not accept a caller-supplied exit code or
parse free-text shell output as proof of success.

Commands execute in the declared workspace directory, with finite timeout and
bounded output. Permission denial, timeout, missing evidence and nonzero exit
are distinct results. Register execution before starting it and commit results
through the PR1 transaction boundary. Failed persistence fences further work.

Supported check commands are foreground commands that finish their own children.
The executor records the admitted shell's completion; it is not an OS sandbox
and cannot attest deliberately detached processes. Background services require
Graph and independently managed lifecycle evidence. Inventory is bounded to
2,000 files / 128 MiB, excludes `.git`, `node_modules` and the configured state
directory, and rejects symbolic links. Unsupported workspaces route to Graph.

Acceptance requires all mandatory checks to pass against the submitted revision,
required artifacts to exist, actual changed paths to satisfy writeScope, and no
unresolved work. Compare the workspace with a captured starting inventory so
unreported changes, deletions and pre-existing dirty files are handled explicitly.
Later writes invalidate affected acceptance evidence; restart cannot promote
unsettled or stale evidence into a PASS.

Failing checks return precise evidence to the same active worker for bounded
local repair. Reuse its session after terminal dispatch only through the existing
authenticated dispatch mechanism. Count repair rounds across session reuse;
exhaustion pauses with evidence. Unknown outcomes require recovery.

## Completion and escalation

Successful mechanical acceptance publishes a runner-owned acceptance artifact.
Completion still requires durable state, settled accepted dispatches/tools and
resolved effects, using PR1 settlement deadlines. No extra LLM confirmation is
required. An artifact alone cannot finish a live child task.

Escalating to Graph waits for existing work to settle, retains changes and
evidence, invalidates incompatible acceptance, and requires the regular Graph
gates before further writes. PR2 does not implement PR3 handoff compression or
PR4 shared token budgets and automatic controller dispatch.

## Implementation and verification scope

Expected integration points: config, agents/prompts, runner, structured submit
tools, task specifications, run-state migration, enforcement/dispatch bindings,
file snapshots and a small dedicated Direct acceptance module.

Regression coverage must include:

- Direct ordinary task uses one worker and no planner/critic/verifier dispatch.
- Graph rollback flag, old saved runs, and explicit Graph requests.
- Real successful/failing/timeout checks; denied commands never execute.
- Forged, stale, wrong-session and wrong-contract evidence cannot pass.
- Out-of-scope and unreported edits/deletions, including initially dirty files.
- Same-session repair with bounded attempts and contract escalation.
- Persistence failure, restart, duplicate/late events and unfinished children.

Run the full existing test suite and a fixed-host integration probe. Synthetic
dispatch counts establish structural overhead reduction only. The claim that
external acceptance does not decrease requires matched-budget benchmark runs;
document that evidence separately and do not infer it from unit tests.
