# opencode-loop

opencode-loop is a seven-agent **runner-gated** graph workflow with local cross-run journal memory and a lesson knowledge base for the official OpenCode `1.18.25` plugin API. The coordinator still drives native `task` dispatch, but a mechanical runner owns run state: dispatch admission, write-scope confinement, attempt counters, verdict gates and version-bound evidence are enforced by plugin hooks, not by prompts alone. The package name is provisional; no public npm release is claimed.

## How the gate works

The model proposes; the runner decides. Every hook decision is persisted to a run document under `<worktree>/<stateDirectory>/runs/<encoded-runId>.json` (atomic writes, cross-instance lock file; the filename is the percent-encoded run id, so successor runs like `root:2` stay valid on Windows while colon-free names are unchanged), where `runId` is the orchestrator session id — a restart reloads it and continues with counters intact.

| Gate | Mechanism |
| --- | --- |
| Implementer/verifier may only be dispatched when a plan passed review | `tool.execute.before` on `task` consults the runner; illegal dispatches are rewritten into an explicit `RUNNER_REJECTED` child turn (soft block — the child session still spawns, reports the rejection, and burns no work) |
| Exhaustion and rejection pause the run for an explicit user decision; nothing may be dispatched while paused | Runner verdict table: PASS advances, REVISE returns to the planner (capped by `maxPlanRevisions`), FAIL and every exhausted budget (plan revisions, node attempts, the verification repair loop) move the run to `AWAITING_USER_DECISION` with a recorded `pendingDecision` cause; UNVERIFIED likewise pauses the run for a user decision (`AWAITING_USER_DECISION` via `graph_run_decide`), with the verdict and its evidence preserved as a superseded verification artifact; identical consecutive verification rejections (an unchanged payload resubmitted after a content-level rejection) trip a `runner-rejection` circuit breaker that pauses the run the same way. The user then decides through `graph_run_decide` (native `ask`): **abort** marks the run irreversibly `ABORTED` (terminal, all evidence preserved), **reset** archives the run in place and opens a fresh successor run |
| Writes stay inside the assigned `writeScope` | `permission.ask` denies out-of-scope `edit` **and `write`** (and implementer `bash` without `allowShell`) for bound graph sessions before execution; violations are recorded. For `allowShell` implementers and read-only specialists, a best-effort static screen also rejects shell commands whose write targets (redirections, `tee`/`cp`/`mv`/`rm`/`dd of=`/`sed -i`/`truncate`/heredocs) resolve inside the workspace but outside the allowed scope |
| `testsPassed`-style claims are not trusted | Verdicts travel only through `graph_submit_*` tools; `PASS` requires at least one cited command with `exitCode 0` (plus at least one existing `artifacts` evidence path when any verified implement node declared `deliverables` — missing files are rejected as `ARTIFACT_MISSING`); nonzero commands are tolerated only when they match a still-valid `baseline` entry (same command and exit code), and change submissions are cross-checked against the runner's own edit ledger (undisclosed files fail the node) |
| Reviews and verifications bind to versions | A review targets `plan@v`; a resubmitted plan supersedes the old PASS. Verifications bind change versions plus file-hash snapshots; on resume, drifted hashes mark stale evidence and its node `STALE` |
| Crashes never blindly redo side effects | A restart moves in-flight nodes to `RECOVERY_REQUIRED` and **refunds the attempt a crash interrupted** (the reconcile re-dispatch charges a fresh one, so a crash costs no budget); `graph_run_resume` revokes old dispatch bindings and reservations, classifies nodes, and the interrupted session can be picked back up by `task_id` (host metadata re-verifies parentage) — otherwise re-dispatch injects the recorded side-effect ledger so the implementer reconciles reality first |
| Child sessions cannot consume another task's queue entry | Reservations are keyed by root session and native task `callID`; host task metadata supplies `sessionId`, checked against child parentage. Attempts start only after binding. Session creation order is not used |

Explorer, planner and multimodal dispatch without a node binding on healthy runs (the critic still requires an admissible review node); explorer and multimodal dispatches run in parallel under a bounded reader capacity (`maxParallel`), and enforcement concentrates on the write path and the verdict gates.

## Structured handoff

Work packages are `TaskSpec` nodes (`id`, `kind`, `agent`, `dependsOn`, `inputs`/`outputs` artifact refs, `writeScope`, optional `deliverables`, `acceptance`, optional `baseline` on verify nodes, `maxAttempts`/`allowShell`). `deliverables` is an optional literal file list within the implement node's writeScope; `graph_inspect` uses it as the denominator for mechanical progress reporting (per-node side-effect counts, last activity, deliverable completion). Large or multi-phase work should be decomposed into smaller nodes rather than reporting mid-flight: a small node is a frequent, fully verified checkpoint whose progress the runner observes mechanically and whose failures stay isolated. For run-unique lanes, `writeScope`/`deliverables` entries may use the `{{run}}` token — the runner expands it to the run's unique path token before validation, echoes the expanded literal paths in the submit response, and repeats them in the dispatch ack so the bound implementer's ground truth comes from the runner; unsubstituted placeholders (`<run>`, `{{...}}` leftovers) are rejected at submission. `graph_submit_plan` validates the graph — unique ids, resolvable dependencies, no cycles, pairwise-disjoint write scopes, mandatory review-before-implement and implement-before-verify gates, no write nodes for plan-only intents, and the **artifact naming contract** (declared `outputs` must equal the runner-assigned name for the kind — `findings`, `plan`, `review`, `change:<id>`, `verification:<id>`, `baseline:<id>` — or be omitted, and `inputs` may only reference names some runner-managed artifact can satisfy, so a node can never wait on a name nothing produces) — before it ever reaches run state; an `INVALID_GRAPH` rejection carries a compact TaskSpec schema summary (kind↔agent mapping, bare artifact `outputs`, naming rules, gate rules) so the planner can fix the submission without guessing. Each role then delivers through its own tool: `graph_submit_review`, `graph_submit_change`, `graph_submit_verification`, `graph_submit_findings`; `graph_inspect` reports node states, attempts, blockers, artifact versions, per-node mechanical progress (side-effect counts, last activity, deliverable completion when declared) and a Mermaid diagram; `graph_run_resume` performs crash recovery; `graph_run_new` starts a successor run after a terminal one.

### Artifact liveness at plan submission

Validation has two layers: `validateTaskGraph` checks structure, naming and explicit dependencies; `runner.submitPlan` checks artifact availability and effective dependency cycles against the current run. Both public submissions and direct runner callers receive `INVALID_GRAPH` before an invalid plan can change the accepted nodes, mode, counters, artifacts or dispatch bindings. Cycle diagnostics name the node/artifact edges to correct, including dependencies implied by `inputs` and the evidence bindings a verifier derives from `dependsOn`.

The state-aware check runs after the existing version normalization: `plan` inputs bind to the newly assigned plan version and `review` inputs await the new review; all other explicit evidence pins remain exactly as authored. A missing future input must have a runnable producer whose **next publication** can satisfy the pin. Retry loops or extra unplanned publications are not assumed. `basedOn` and documentary explore/analyze/plan inputs must already be satisfiable at acceptance. Findings may predate the proposed graph and need no cosmetic producer nodes. Explore/analyze nodes are documentary completions, not promises to publish more findings; only the current authoritative findings slot satisfies inputs, not older `findingsLog` entries.

Replacement supersedes the old review and all baselines and invalidates evidence whose recorded provenance no longer resolves, transitively. An old PASS tied to the superseded approval cannot bootstrap the next approval. Independent, currently-valid historical evidence remains usable. If a planned publication would overwrite a pin (or its pinned provenance), validation checks a read-before-replacement edge and dispatch enforces that same ordering until the consumer finishes. An unavoidable overwrite-before-read cycle rejects with the relevant pin in the diagnostic. These checks apply to new submissions; existing histories remain loadable and inspectable without rewriting their graphs.

Read protection distinguishes historical evidence from current-plan publications: the submitted plan and successful nodes have already consumed their provenance, which stays recorded for audit without becoming inherited dispatch prerequisites. An unpinned input ordered after its producer's replacement consumes the new publication, so it does not preserve the old slot's provenance. Explicit old-version pins retain their read-before-replacement protection. Validation and dispatch use the same publication-aware rules, including ordering through unresolved artifact inputs.

A node may read its own currently-valid prior output before publishing its successor; this read-before-own-write needs no blocking self edge. Missing, future, stale or superseded own-slot references still reject, as do structural self-dependencies. Protection of that historical output's provenance against other publishers still applies. The plan installed by the current submission is not a prior own output.

### Light path (critic-free small changes)

`intent: "light"` is a routing lane for mechanical, low-risk fixes (copy, formatting, single-file typos): the review node is omitted, the single implement node depends directly on the plan node, and the critic session is skipped — **at most one implement node** is enforced at validation. Every mechanical gate is unchanged: writeScope confinement, the edit ledger cross-check, deliverables-backed artifact evidence and the verify-after-implement gate all still apply; only the advisory quality review is waived. The change artifact cites `plan@v` instead of `review@v`. Use the full `change` flow (with exploration) for cross-file, async, database or otherwise high-risk work — the orchestrator prompt encodes this routing.

### Baseline: separating pre-existing failures from regressions

On projects whose suite is already red, an honest verifier cannot cite an all-green command, so a `change` run used to burn repair attempts on failures it never caused. A plan may now declare a **baseline verify node** (`kind: "verify"`, `baseline: true`): it is dispatched *before* the implementer (it depends on the review node — the plan node in light graphs — and every implement node must depend on it, so the capture is mechanically ordered before any write). The verifier submits `verdict: "BASELINE"` with the commands it actually ran and their exit codes; the runner stores the versioned `baseline:<id>` artifact. A later `PASS` still requires at least one `exitCode 0` command, and every nonzero command is tolerated **only** when it matches a still-valid baseline entry (identical command string and exit code — purely mechanical, no output parsing, ecosystem-agnostic). A failure that got worse (different exit code), a new failure, or a stale baseline all reject the PASS. Replacing the plan supersedes existing baseline artifacts so pre-change evidence from a previous graph version can never tolerate failures under the new one.

### Selective verification repair

On a nonbaseline `FAIL`, `graph_submit_verification` accepts optional
`repairTargets: ["implement-a"]`: a nonempty, unique array of literal node IDs,
each a **direct implement dependency** of that verifier. Omission retains the
legacy default of all direct implement dependencies. Other verdicts, baseline
nodes, empty/duplicate lists, artifact refs, globs, unknown IDs, wrong kinds and
unrelated nodes reject before counters, evidence, bindings or disk change.

The effective targets are saved in FAIL evidence. Repair follows exact consumed
artifact versions forward to a fixed point through implementation consumers,
verifier chains, execution dependencies and artifact provenance. Selected
implementations become `PENDING`; affected completed/in-flight consumers become
`STALE`; never-started consumers await new evidence. A combined verifier becoming
stale does not reopen an independent successful prerequisite. Unrelated nodes,
versions and attempts are preserved, without no-op change submissions.

`beginNode` captures explicit inputs, dependency outputs and approval as exact
`consumedRefs`. Ordinary publication is not semantic invalidation. Reachable
historical lineage retains only provenance edges/status, not old payloads or a
history-reading API. Retention is bounded (1,024 visited refs, 4,096 edges and
128 KiB/6,000 JSON values); closure/snapshot scans are bounded too. Capacity
failures reject without discarding referenced lineage, with reserved settlement
headroom preserved. Verification snapshots cover transitive available evidence.

An obsolete explicit pin, invalidated approval or unverifiable legacy provenance
returns `needsPlanRevision: true` and `offendingRefs` in the result and inspection.
Pins are never silently rewritten by repair: use the existing planner route to
submit satisfiable evidence. The run stays `RUNNING` unless an existing pause
condition applies. The global repair cap still pauses at exhaustion and keeps
the FAIL evidence; affected verifiers otherwise reset their attempt budget for
new evidence. There is no user retry action.

FAIL and scoped execution revocation are persisted together before publishing
live state. Affected native lifetimes and pending effects retain their exact
identities; fresh dispatch and `task_id` replacement return
`REPAIR_SETTLEMENT_PENDING` until settlement. Resume cannot erase these fences.
Unrelated live siblings keep authority. Repair guidance goes only to selected
targets and affected consumers and survives a newer verifier publication.

### File claims and correction

`filesTouched` contains **literal workspace-relative file paths**, not directories, trailing `/`, globs, or absolute paths. New/modified files must be readable regular files; linked paths are not accepted as verifiable file claims. Explicit deletions are included in both `filesTouched` and optional `filesDeleted` and must be absent at submission:

```json
{
  "nodeId": "implement-main",
  "filesTouched": ["src/main.mjs", "src/obsolete.mjs"],
  "filesDeleted": ["src/obsolete.mjs"],
  "summary": "Updated main and removed obsolete module"
}
```

`INVALID_FILE_CLAIM` returns `retryable: true` and leaves the node RUNNING. Correct the claim and submit again within the same attempt; do not repeat successful disk work or rebuild the plan. Scope escapes and undisclosed edits remain strict failures, and rejection mutations are saved before returning. Submission `nodeId` must match the caller's bound node. Snapshots hash raw file bytes and represent explicitly deleted files with `MISSING`.

`filesTouched` remains bounded to 32 entries. Installation tasks should identify concrete deliverables and a manifest in their plan. Shell commands are recorded as commands, **not** as an exhaustive file-change ledger; report extra side effects in `summary`/`unresolved` and have the verifier check the manifest. Set `UV_CACHE_DIR` and `PIP_CACHE_DIR` within `writeScope` before the first uv/pip invocation, including interpreter discovery. Native glob tools may omit dot-directories; inspect explicit paths with read/list.

### Evidence fields

Structured submissions carry a bounded evidence vocabulary beyond file claims:

- `graph_submit_change` accepts `risks`: known hazards, boundary conditions or follow-up concerns that survive a successful delivery (distinct from `unresolved`, which lists unfinished work). Reported risks are relayed mechanically into the verifier's dispatch prompt with a mandate to probe them first.
- `graph_submit_verification` accepts `artifacts` (literal workspace-relative evidence file paths — logs, output files, screenshots; a `/tmp/`-prefixed absolute path is also accepted for verifier scratch), `probed` (adversarial scenarios actually exercised, with observed results) and `skipped` (scenarios ruled out with a one-line reason). Every artifact path is existence-checked at submission; a missing file returns `ARTIFACT_MISSING`, correctable within the same attempt without redoing verified work. When any verified implement node declared `deliverables`, a `PASS` additionally requires at least one `artifacts` entry (`ARTIFACT_REQUIRED`).
- `graph_submit_findings` accepts `learnings`: durable patterns, pitfalls and principles, kept distinct from the traceable `evidence` trail. Learnings from the newest 3 findings versions (newest first, each line tagged with its `findings@v` source) are injected into planner dispatch prompts, and into the bounded `carryOver` digest a user reset creates, always with a revalidation mandate. Every submission is also retained as a version in a bounded 8-entry history (`findingsLog`) surfaced by `graph_inspect` as `findingsHistory` (version, nodeId, learnings count, summary digest), so parallel explorers' outputs never overwrite each other; the latest-slot `findings` artifact remains authoritative.
- `graph_inspect` surfaces per-artifact counts (`{ artifacts, probed, skipped }` for verifications, `{ risks }` for changes, `{ learnings }` for findings, `{ commands }` for baselines) so progress and evidence density stay observable without dumping payloads.

### Dispatch and recovery

- **Strict dispatch targets:** every implementer/verifier dispatch must explicitly name its node, including `task_id` continuations and graphs with only one ready node. For native `task`, put a single `[nodeId: implement-setup]` marker **alone on the first prompt line**, with the task description starting on the next line. LF/CRLF and surrounding header whitespace are accepted; `[nodeId:impl-b] do B` is rejected. The hook also accepts an explicit `nodeId` argument when supplied by a caller; if both sources are present, both must be valid and equal. Missing writer targets return `NODE_ID_REQUIRED`, malformed targets return `INVALID_NODE_ID`, and conflicting sources return `CONFLICTING_NODE_ID`. No malformed or missing writer target falls back to sorted selection. Other roles retain their existing unmarked/free dispatch behavior; body quotations are not target metadata.
- The runner validates exactly the requested node (existence, role match, admissibility, attempts, writer capacity) and either binds it or rejects the dispatch with the precise reason (`NODE_NOT_FOUND`, `NODE_NOT_ADMISSIBLE`, `ATTEMPTS_EXHAUSTED`, `WRITER_CAPACITY`, `READER_CAPACITY`). Every bound dispatch confirms the assignment with a `[RUNNER] Assigned nodeId` prompt line and uses that same node for scope enforcement and submissions. This guarantees target identity, not the semantics of arbitrary prose: implementers/verifiers must stop and report if the task body contradicts the assigned node or scope.
- Implementers run in parallel under a bounded writer-capacity gate: at most `min(maxImplementerParallel, critic approvedParallel)` implement nodes may be RUNNING (or reserved) at once, and their write scopes are pairwise disjoint by plan validation. Concurrent dispatch reservations occupy the **explicitly requested** nodes; a duplicate reservation reports `DISPATCH_PENDING`. Host metadata correlates calls by parent session and callID, regardless of session creation or metadata arrival order. Verifiers, critics and planners keep one-in-flight semantics.
- Explorers and multimodal analysts run in parallel under a mirrored reader-capacity gate: at most `maxParallel` exploration/analysis tasks (free consultation reservations plus node-bound explore/analyze work, one shared budget) may be in flight at once; excess dispatches are rejected with `READER_CAPACITY`, and an active `task_id` continuation never self-blocks. The orchestrator prompt asks for same-turn multi-dispatch of independent exploration aspects.
- The critic is never freely admitted: its verdict can only travel through a bound review node, so when the review node exists but is not yet admissible the dispatch is rejected up front with `NO_READY_NODE` and the waiting reasons (plus the artifact-naming hint when an input references a name nothing produces) instead of stranding a child session that could never submit. Explorer, planner and multimodal keep free consultation because their findings/plan submissions do not require a node binding.
- `task_id` may continue the same active RUNNING attempt and role in the same run without charging another attempt. It may also **resume any node the session last worked on** when that node is `INCOMPLETE`/`PENDING`/`STALE` with attempts left — including a REVISE'd planner, a critic re-reviewing after a re-plan, or an implementer in the repair loop — because `submitPlan` preserves node session ids across plan replacement. A new attempt is charged, the recorded side-effect ledger travels with the dispatch, and the previous execution binding is superseded without erasing any outstanding host lifetime. Pre-dispatch idle receipts are retained as fenced, bounded hints; they are never completion authority for a new call. Read-only role sessions with a revoked or missing binding may still be continued by identity: the reservation carries the session id and host metadata plus the bounded parentage lookup re-verify the relationship before any work is trusted; write-role continuations always require state-verified identity. After a plugin restart the in-memory binding is rebuilt from run state the same way, so an interrupted implementer conversation can be picked back up instead of starting over. Sessions without a usable dispatch fail with an actionable `BINDING_UNAVAILABLE` that tells the child to stop and report instead of retrying.
- An explicit continuation target must match the node belonging to that session, including after restart. A mismatch returns `TASK_NODE_MISMATCH` **before** creating a reservation, charging an attempt or revoking the original binding. Continue with the original node's marker, or dispatch the other node using its own valid session or a fresh session. The rejected task is rewritten to a fresh `RUNNER_REJECTED` child turn; it is not sent into the original session. A valid active-attempt continuation still works at full writer capacity and is not charged twice.
- Revision and repair evidence is relayed mechanically: dispatching a plan node after a REVISE verdict injects the critic's findings into the task prompt, and dispatching an implement node after a FAILED verification (now recorded as a durable superseded `verification:<id>` artifact) injects the failure summary and failing commands — fresh sessions and task_id continuations both receive it, no coordinator relay required.
- Read-only tools (`read`, `glob`, `grep`, `list`, `graph_status`, `graph_inspect`, `graph_journal_search`, `graph_journal_read`) are never collaterally blocked by the dispatch-binding gate. Rejected or finished children resolve the owning run through the host-verified parent chain, so inspection and journal history stay available even after a run reaches a terminal state. Write paths keep failing closed.
- `graph_run_decide(action, reason)` delivers the user's decision for a run paused at `AWAITING_USER_DECISION` (or deliberately rotates/terminates a quiet run). A user-provided reason is required, and native permission `ask` means the host confirms with the human before the tool runs. **abort** irreversibly marks the run `ABORTED`: findings, plans, reviews, violations and dispatch history stay untouched, dispatch is closed (`RUN_TERMINATED`), and the terminal run projects a journal summary with the reason. **reset** archives the run in place — original status, `pendingDecision`, counters and evidence remain, plus a `decision` record and `successorRunId` — and creates a fresh successor run whose counters start at zero; it re-walks the explorer → planner → critic gates and never replays implementer work or recorded side effects. The successor run carries a bounded `carryOver` digest (predecessor id, reset reason, the archived run's final rejection findings, and a findings summary aggregating the last 3 retained versions: summaries joined and capped, learnings newest-first capped at 8 items) that is reported by `graph_inspect` and injected into the new explorer/planner dispatch prompts with a revalidation mandate, so prior lessons are consumed instead of re-derived — and re-rejected. Both actions require no `RUNNING` nodes and no outstanding dispatch reservations first.
- `graph_run_new` starts a successor run in the same orchestrator session once the current run is `SUCCEEDED`, `FAILED` or `ABORTED` (write journal insights first). The successor run id is `<session>:<n>`; the finished run records `successorRunId`, and a restart follows the chain (regardless of the archived predecessors' statuses) so the orchestrator rebinds to the newest run.
- A reservation awaiting host metadata blocks another dispatch of that node/role (`DISPATCH_PENDING`) without consuming an attempt. Exact foreground task completion releases it; an error/cancellation without positive completion proof remains unresolved.
- Both foreground running metadata and completed **background** task metadata are supported. Native metadata is published before prompt execution, and extensions can be queued behind earlier turns. Neither an acknowledgement, a reused `jobId`/session ID, an idle event, nor an empty status map proves that a call ended. Every admitted task call receives a durable unique token appended to its actual prompt, including active continuations that share a dispatch ID. Native child user messages must match that token, session, parent and agent. Terminal assistant evidence must link its `parentID` to that user message or its authenticated compaction descendant, have a genuine terminal finish and completion timestamp, and have settled tool evidence. An assistant containing ordinary tool calls is still intermediate even if a provider reports `stop`; compaction summaries, `tool-calls`, abort/error responses and intermediate timestamps are not task completion. All admitted calls must be accounted for before idle/status corroboration can retire the shared lifetime. Exact foreground task completion remains direct per-call evidence.
- Before child work, delayed metadata can be resolved through bounded host reads (64 parent messages, at most 256 parts per message, a 2-second request deadline). An unresolved session cannot silently bypass enforcement; it fails with `BINDING_UNAVAILABLE` until its relationship is established.
- `graph_run_resume` clears reservations and revokes old bindings for ordinary interrupted execution; late events cannot claim a fresh dispatch. A paused run keeps its settlement ownership and returns `AWAITING_DECISION`. Recorded attempts and side effects remain intact. This is recovery of interrupted work, not a general FAILED-node reset.

### Paused execution and settlement

`AWAITING_USER_DECISION` closes execution: no new task dispatch (including `task_id` continuations) or workspace effects through edit/write/bash. It preserves the **first** `pendingDecision` cause, detail, timestamp and `pauseId` even if another sibling exhausts its budget while ending. Pause IDs are monotonic integers within a run; `graph_inspect` exposes the active `pauseId`, the original verifier generation/evidence, `recoveryUsed` and `recoveryHistory`.

### One user-confirmed same-run verification retry

The root orchestrator may call `graph_run_decide({ action: "retry", reason, expectedPauseId })` after the user confirms the decision through the existing native **ask** permission. `reason` must faithfully report the user's reason. `expectedPauseId` is required only for retry and must exactly match the active pause. There is **at most one successful retry decision per run**, durable across replans and restarts.

- Eligible pauses: a **nonbaseline verifier** returned `UNVERIFIED`, or its repeated rejection was `INSUFFICIENT_EVIDENCE`, `ARTIFACT_REQUIRED` or `INVALID_VERDICT`. The original verifier must have a normal attempt remaining.
- All native lifetimes must have settled, including unbound reservations, queued calls and free consultations, and there must be no pending effects or `RUNNING` nodes. A settlement closeout, even one reporting PASS, is neither approval nor proof that a host call ended.
- The original plan and PASS review must still be valid (light uses its plan), with unchanged accepted dependencies and a satisfiable graph. Unrelated failed, incomplete, recovery-required or stale work, started pending work and Task1 `needsPlanRevision` blockers prevent retry.
- Full retained change claims and provenance must provide trustworthy expected snapshots. Existing files require SHA-256 hashes; `MISSING` is allowed only for declared `filesDeleted`. The public tool hashes actual files through the store and requires equality. Drift, unexpected absence, links/unreadable files, missing coverage, conflicting snapshots and historical edge-only evidence without retained proof all fail closed. Empty true no-op claims are allowed. Expected hashes are never replaced with newly observed hashes to make retry possible.
- `STALE_CHANGE`, baseline verification, functional FAIL/repair exhaustion, unknown causes, scope/ledger/denied-execution corruption and legacy pauses without sufficient identity/evidence are ineligible. No successor or additional attempts are granted.

Success keeps the same run and session ownership, sets the run to `RUNNING`, leaves the exact original verifier `PENDING`, and explicitly clears active `pendingDecision`. Dispatch that verifier through an ordinary fresh session or `task_id` continuation: binding generates a new dispatch token and charges one normal attempt. Successful siblings, artifact versions, attempt/revision counters and the rejection streak are preserved. An identical bad payload therefore re-pauses immediately; corrected accepted evidence clears the streak normally. A later functional FAIL still uses selective `repairTargets`.

The bounded recovery history retains the complete original pause, UNVERIFIED/rejection payload and user decision before the verifier's next publication replaces its artifact slot. Capacity is checked with the actual run sanitizer and dispatch settlement headroom, with no silent evidence truncation. The candidate is saved before memory is published; a failed save leaves the decision retryable. A crash after the saved decision but before dispatch needs no second decision and never refunds `recoveryUsed`. `graph_run_resume` continues to handle crash recovery separately. Snapshot equality is not proof that an external service is healthy: the retried verifier must satisfy every normal PASS gate.

### Closeout evidence and host lifetime completion

Already-owned attempts may still submit bounded closeout through their existing `graph_submit_*` tool. The usual role, exact node/session/dispatch identity, payload schema, file-claim and evidence checks apply. A successful response has `effect: "settlement"`: the report is saved in `closeouts`, **not** as a gating change, plan, review or verification artifact. Earlier accepted artifacts remain intact; dependents do not advance and the run cannot become successful through settlement. Each dispatch may close out once per submission tool; the run retains at most 64 closeouts, each limited to 8 KiB of plain JSON (1024 values, depth 16). `graph_inspect` lists closeout summaries.

Structured closeout does not end a host execution lifetime. Exact foreground completion or correlated terminal child turns retire the matching calls; retirement must persist before reservations are released. A bounded history of the latest 128 settled call identities and their witnesses also accepts delayed closeout if the host end event arrived first, provided the run is still paused and the exact attempt identity has not been superseded; it never reopens the host lifetime. Active children and admitted-but-unbound reservations continue to block `graph_run_decide`. Once completion is proven, the existing user **abort/reset** paths are reachable. Late after-hooks for effects already admitted before the pause retain their original attempt identity and are recorded once; this grants no permission to start more work for evidence.

Settlement follows each original dispatch lifetime, independently of the session's newest execution binding. Historical overlapping attempts retain their own call witnesses; ending an older lifetime can mutate a node only when its session and dispatch ID still match that exact attempt. Selective repair now fences replacement until affected lifetimes and effects settle. Same-attempt continuations still require completion proof for every call sharing the dispatch ID. Accepted plan publication durably revokes old execution while retaining settlement-only tracking of active calls, including the submitting planner and free or node-bound readers. Those calls cannot submit new graph evidence or paused closeout under the replacement plan, and still block abort/reset until authentic host completion. Rejected plans leave the existing graph and bindings intact; explicit new/reset retain their documented invalidation behavior, and resume cannot clear selective-repair fences.

After restart, a paused run restores its durable lifetime, per-call witnesses and pending-effect bookkeeping without refunding attempts, unpausing, or replaying effects. Recovery uses bounded native message scans (64 messages, at most 256 parts each) and exact message lookups with two-second request deadlines. Missing scan results are never interpreted as completion. Legacy or cancelled calls without a recoverable per-call witness remain unresolved; synthetic parent notifications identify only a session/description and cannot discharge them. This is deliberately not universal automatic recovery. `graph_run_resume` does not turn a pause into permission to execute or discard active children. Ordinary RUNNING-run crash recovery retains its existing refund/reconciliation behavior.

**Original-user provenance.** Only the native `chat.message` prompt-creation hook can establish the original user anchor, after matching the admitted call's token, child session, parent and agent. Its message ID and `userAnchorSource: "chat.message"` are persisted together. Message-history scans, `message.updated` events and exact message lookups cannot create or upgrade an original anchor: even a byte-identical prompt/token can be an overflow replay. Without recorded hook provenance, an unanchored call or legacy scan-derived witness remains unresolved. A previously persisted hook anchor can still support terminal-message recovery when the original user has left the bounded page.

**Native compaction lineage (v1.18.25).** Automatic compaction creates new user-message IDs, so the hook-proven original user ID is retained as the root of a durable `userLineage`, rather than assuming every later assistant still points directly to it. Scans may extend that existing root, never bootstrap one from the first visible copied token. A new link requires a complete, chronological native message-page sequence:

1. The current owned user message, followed by an `auto: true` compaction user/part with matching agent/model and no intervening user request.
2. A completed, error-free `summary: true` assistant from the native `compaction` agent, with `parentID` pointing to that compaction request.
3. The immediate follow-up user, matching the pinned native shape: either the synthetic `metadata.compaction_continue: true` message (including native text/timing/model checks), or an overflow replay whose copied user settings and parts match the owned source. Replay matching ignores only message/part identity fields and applies the native image/PDF attachment-to-text substitution; a copied token alone is insufficient.

The final non-summary assistant must point to the latest authenticated descendant. Compaction summaries and intermediate tool-call responses never discharge the task. These links survive restart without charging another attempt, even after ancestors leave the bounded scan. An incomplete proof can resolve when the missing native evidence arrives; unrelated synthetic text, changed replay content, intervening requests and unproven duplicate tokens remain insufficient.

This protocol is source-pinned to [native compaction.ts](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/compaction.ts), [message-v2.ts](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/message-v2.ts), and [prompt.ts](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/prompt.ts). The continuation marker is an internal native field, not a stable cross-version contract. Missing ancestry cannot be reconstructed from an exact lookup alone because it does not prove what intervened. Unsupported shapes, legacy conflicts without provenance, oversized replay payloads, or exhausted proof capacity stay unresolved. Replay comparisons are capped at 128 KiB / 2048 JSON values / depth 16; active and retained settled calls share bounds of 64 lineage links and 64 tracked ambiguous user IDs per run. Proof candidates roll back on persistence failure.

Partial task-terminal and child-turn witnesses are saved even while another continuation remains outstanding. Idle received before binding is durable but only a hint: up to 128 recent receipts retain at most 256 original ownership references in total. Retiring a reservation prunes its references and drops orphan receipts. Event deduplication is a rolling history of 256 hashes, not lifetime authority; evicting old duplicates cannot manufacture a new call's missing terminal turn. Save failures retain blockers until persistence succeeds.

Native `tool.execute.after` only covers successful tool execution. Exact native terminal tool parts also settle reserved edit/write/bash slots, including error/cancellation outcomes, and recovery can find them through bounded message lookup. Errors retain `outcome: "error"` and `uncertain: true` evidence with the original target and attempt identity: a thrown tool may have partial effects, so this never claims that nothing changed. Unproven outcomes stay pending and must not be blindly replayed.

An error/uncertain entry is an **attempted operation, not a confirmed edit**. It does not manufacture edited-file or deliverable coverage, and by itself cannot cause nonretryable `LEDGER_MISMATCH`. If an edit failed before writing, report `filesTouched: []` with an honest unresolved explanation; do not invent a deletion for a missing file. If an error left real partial changes, report those actual files normally. The same distinction applies to paused closeout validation. Uncertainty remains in the ledger, is labeled in reconciliation context, and is relayed to dependent verifiers (including unclaimed targets) for independent inspection. Genuine confirmed undisclosed edits remain strict failures.

New task, effect and closeout admissions validate aggregate persistence capacity before publishing their ledger mutations: at most 512 KiB / 12,000 values at admission, leaving headroom under the run store's 1 MiB / 20,000-value ceiling for witnesses and settlement. Pending effects plus recorded effects reserve at most 900 array slots. Closeout can return `CLOSEOUT_LIMIT` before its per-entry/count ceiling when aggregate headroom is exhausted. These are persistence-capacity checks, not extra attempt/retry budgets. Bounded hint histories cannot veto an otherwise proven terminal settlement.

Denied-tool calls retain their original run/node/session/dispatch/call identity in the violation ledger. A late after-hook records `executed-despite-deny` against that provenance; it taints a node only if that exact attempt is still running, never a newer attempt in the same session. Recovery restores the captured denial identities from the durable ledger.
- Consumed call IDs are retained in bounded run history (900 calls/run; 128 outstanding reservations), within the sanitizer's 1,000-element array ceiling, so recovery cannot reuse a revoked call ID. A failed binding save can be retried with the same dispatch identity without incrementing the attempt twice; inspect reports `BINDING_PERSISTENCE_FAILED` while the save is unresolved.
- `graph_inspect` includes pending/bound dispatches, remaining attempts, binding status, last submission failure and a recovery hint. Review attempts and `maxPlanRevisions` are independent budgets. Plan replacement is refused while a review, implementation or verification node is still RUNNING.

When upgrading from the earlier optional-target behavior, add an explicit first-line marker to all implementer/verifier task templates, including single-node and recovery calls. For example:

```text
[nodeId:implement-setup]
Implement the setup work package within its declared writeScope.
```

Quit and restart OpenCode after updating the plugin so the new hooks and agent prompts are loaded.

## Run journal

After authoritative run state is saved, terminal `SUCCEEDED` and `FAILED` runs are automatically projected into deterministic project `run-summary` entries. Projection is advisory and idempotent: it cannot change a verdict or block dispatch, recovery or persistence. Before each journal search, bounded backfill inspects at most 64 run IDs and projects missing terminal summaries; corrupt or nonterminal runs are skipped. `graph_status` reports bounded pending-backfill metadata without writing or projecting.

The journal is historical, non-authoritative context. It cannot satisfy any current runner, review or verification gate. The explorer must revalidate journal claims against current source; the planner and critic cite journal IDs and treat unconfirmed claims as assumptions; the verifier ignores journal content as PASS evidence and requires current worktree evidence, including an actually executed successful command.

Storage is local plaintext:

| Scope | Entries | Embedding index |
| --- | --- | --- |
| Project | `<worktree>/<stateDirectory>/journal/entries/` | `<worktree>/<stateDirectory>/journal/index/` |
| Global | `~/.config/opencode/opencode-loop/journal/entries/` | `~/.config/opencode/opencode-loop/journal/index/` |

Project entries are Markdown with JSON-compatible frontmatter; embedding vectors are JSON sidecars. Project run state remains under `<worktree>/<stateDirectory>/runs/`.

With semantic search enabled, the first semantic use lazily downloads the pinned `Xenova/all-MiniLM-L6-v2` model from Hugging Face at revision `751bff37182d3f1213fa05d7196b954e230abad9` and runs q8 inference locally through `@huggingface/transformers` `3.8.1`. Journal queries and content are not sent to a remote inference service. Model/download/inference failures do not block startup or the runner: searches without a query remain metadata-only, and text queries use `text-fallback`; `graph_status` reports `hybrid`, `text-fallback` or `disabled` as the current search mode.

The embedding provider owns token-aware indexing for the complete `title + "\n\n" + body` string. It forms source-ordered, non-overlapping windows of at most 256 model tokens including special tokens, indexes at most 12,000 content tokens across at most 48 windows, runs batches of at most eight and mean/L2-normalizes the window vectors. Canonical text that fits those budgets is embedded completely. Token-dense or legacy oversized text uses deterministic bounded spanning samples that retain the source prefix, midpoint and suffix instead of allowing one large entry to consume unbounded inference. Queries and cache-miss entries each cross the provider boundary once; the search layer does not apply a second character-based chunking pass.

Embedding sidecars include the complete embedding-space policy and its digest. Sidecars created under the former character-window policy remain harmless: schema version 2 is unchanged, but the different space digest makes them stale, so each sidecar is rebuilt lazily only if semantic search touches that entry. Metadata-only searches do not load the model or rebuild vectors.

Initialization is single-flight and limited to three attempts per plugin instance. After failure, a later query may retry after 30 seconds, then 60 seconds; there are no background retry timers. Exhausted initialization continues using text fallback. Status exposes safe stage codes, initialization attempt count and the next retry timestamp. Transformers.js controls its own cache (by default its package `.cache`), which is distinct from Python's Hugging Face Hub cache.

Diagnostics distinguish `JOURNAL_SCAN_FAILED`, `JOURNAL_BACKFILL_FAILED`, `EMBEDDING_INITIALIZATION_FAILED`, `EMBEDDING_INFERENCE_FAILED`, `JOURNAL_INDEX_READ_FAILED` and `JOURNAL_INDEX_WRITE_FAILED`. Raw provider errors and filesystem paths are not copied into these public errors. Storage scan failures remain errors, not successful empty search results. Directory cleanup supports both Node Promise-returning and Bun synchronous `close()` behavior.

By default, the first user request is retained in run state and terminal summaries, capped at 8,000 characters. Set `journal.includeUserRequest` to `false` before the first request to opt out, or adjust `journal.maxUserRequestChars` within its documented range. New indexed journal and lesson content is capped at 12,000 characters for the combined `title + "\n\n" + body`: generated summaries truncate safely with an explicit marker, while explicit insight/lesson authoring and promotion reject new over-limit content without writing it. Exact IDs from the former 32,000-character authoring policy can still be replayed idempotently when that entry already exists, but the compatibility path never creates an oversized entry. Requests, commands and insights receive best-effort redaction for common key, token, bearer, JWT, password and secret patterns, but this is not a guarantee: avoid placing secrets in requests and protect or remove the plaintext state directories according to local retention policy.

Global promotion never copies a project entry. It accepts only a project `insight` and requires separately supplied, project-neutral title/body/tags plus native permission `ask`. Run summaries, raw requests, project paths, run IDs and file lists are never written to the global journal.

## Lesson knowledge base

Lessons are the distilled record of *unexpected behavior and repeated mistakes*. They live in a store that is physically separate from the journal (`<stateDirectory>/lessons/`) but reuses the same storage code, sanitization, write-once semantics, hybrid search and trust rules: **non-authoritative historical context that can never satisfy a gate and must be revalidated against the current worktree**.

| Kind | Scope | Origin |
| --- | --- | --- |
| `lesson-observation` | project | Mechanical projection at run terminal — explorer `learnings`, FAIL/UNVERIFIED verification summaries (with failing commands) and recorded violations, each bounded (≤8 per source, ≤1,000 chars, redacted) |
| `lesson` | project | Orchestrator curation via `graph_lesson_record` after a terminal run — category (`pitfall`/`surprise`/`repeated-mistake`), generalized rule, trigger context, optional links to observations |
| `promoted-lesson` | global | Explicit promotion of separately supplied project-neutral content (native `ask`; identity metadata and path-like tokens from the source are leak-scanned) |

Repeated-mistake detection is append-only: observations are keyed by a fingerprint of their normalized text (whitespace-collapsed, lowercased), and reads consolidate identical fingerprints into occurrence counts with first/last-seen and source run IDs — no entry is ever mutated. This is exact-normalized matching, not semantic clustering: the same mistake phrased differently stays separate, and search results say so.

Explorer, planner and implementer dispatch prompts receive a bounded `[RUNNER] Known project lessons` block (top `lessons.injectMax`, embedding-free mechanical ranking: write-scope path overlap, keyword and tag overlap, occurrence count, recency) with an explicit revalidation mandate. Injection is fail-open — a lesson-store failure never blocks or delays a dispatch. Implementer and verifier keep zero journal/lesson *tools*; they only receive runner-injected context.

| Lesson tool | Allowed roles | Behavior |
| --- | --- | --- |
| `graph_lesson_search` | orchestrator, explorer, planner, plan critic | Bounded project/global search plus consolidated observation groups with occurrence counts |
| `graph_lesson_read` | orchestrator, explorer, planner, plan critic | Read one entry by scope and stable ID |
| `graph_lesson_record` | root orchestrator only | Write a curated lesson linked to the current terminal run |
| `graph_lesson_promote` | root orchestrator only, native `ask` | Write separately supplied project-neutral content to global scope |

## Project-local installation

Use Node.js 22 or newer. From this package directory run `npm install --ignore-scripts`, `npm test`, then `npm pack --ignore-scripts`. This produces `opencode-loop-<version>.tgz`, named after the `version` field in `package.json`; these commands do not publish or install globally. After installing changed plugin code, quit and restart OpenCode; running instances retain the previously loaded plugin.

From the project where you want to use the plugin, install that local tarball:

```powershell
npm install --ignore-scripts --save-dev C:\path\to\opencode-loop-<version>.tgz
node --input-type=module -e "import {pathToFileURL} from 'node:url'; import path from 'node:path'; console.log(pathToFileURL(path.resolve('node_modules/opencode-loop/src/index.mjs')).href)"
```

Use the printed absolute file URL in the project's `opencode.json` plugin tuple (merge with existing configuration). For example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///C:/path/to/project/node_modules/opencode-loop/src/index.mjs", {
      "maxAttempts": 3,
      "maxParallel": 4,
      "maxImplementerParallel": 2,
      "maxPlanRevisions": 3,
      "stateDirectory": ".opencode-loop",
      "journal": {
        "enabled": true,
        "includeUserRequest": true,
        "semanticSearch": true,
        "maxUserRequestChars": 8000
      }
    }]
  ]
}
```

Consider adding the state directory to `.gitignore`. Start OpenCode in that project and select `graph-orchestrator`. Example requests: `請找出登入流程並解釋,目前不要修改。`, `只產出改善登入錯誤處理的計畫。`, or `請實作登入錯誤處理並驗證結果。` After an OpenCode restart on the same session, ask the orchestrator to `graph_run_resume` then `graph_inspect`. To select this agent by default, add `"setDefaultAgent": true`. To override a model, add `"models": { "graph-multimodal": "provider/model-id" }`.

## Roles, permissions and tools

| Agent | Mode | Responsibility | Submit tool | Additional native permission |
| --- | --- | --- | --- | --- |
| `graph-orchestrator` | primary | Route, dispatch, recover, summarize | `graph_run_resume`, `graph_run_new`, `graph_run_decide` (ask) | `task` only to the six specialists; `question`, `todowrite` allowed |
| `graph-explorer` | subagent | Read source, gather versioned findings | `graph_submit_findings` | `bash` ask for non-mutating checks (workspace writes denied by the screen); `webfetch`, `websearch` ask |
| `graph-planner` | subagent | Submit a validated task graph | `graph_submit_plan` | `webfetch`, `websearch` ask |
| `graph-plan-critic` | subagent | Verdict bound to a plan version | `graph_submit_review` | `webfetch`, `websearch` ask |
| `graph-implementer` | subagent | Write within `writeScope` only | `graph_submit_change` | `edit`, `write`, `bash` ask (bash denied unless `allowShell`; screened write targets must stay in scope) |
| `graph-verifier` | subagent | Evidence-bound verification | `graph_submit_verification` | `bash` ask; no edit |
| `graph-multimodal` | subagent | Analyze supported visual inputs honestly | `graph_submit_findings` | `webfetch`, `websearch` ask |

All graph agents may call `graph_status` and `graph_inspect`; every role also receives `skill: 'allow'` through the shared permission baseline, and `skill` is classified as a read-only tool (it stays available to child sessions whose dispatch binding is gone, while write tools keep failing closed). Unknown tools (including arbitrary MCP tools) default to deny, and `read` explicitly denies `*.env`/`*.env.*`. `toolPermissions` can opt roles into LSP and named MCP tools as described below. Native agent definitions and the default agent remain intact unless `setDefaultAgent` is true. Any existing definition with one of the seven reserved names causes an atomic collision error.

Classifying `skill` as side-effect-free is an assumption based on OpenCode host 1.18.x behavior (the pinned SDK is `@opencode-ai/plugin@1.18.25`). If a newer host ever makes the `skill` tool mutate run state or the workspace, revisit both its `READ_ONLY_TOOLS` membership and the blanket `allow`.

Journal access is intentionally narrower. Prefer native `ask` when a journal operation, especially global promotion, needs user approval.

| Journal tool | Allowed roles | Behavior |
| --- | --- | --- |
| `graph_journal_search` | orchestrator, explorer, planner, plan critic | Bounded project/global search; performs bounded backfill first |
| `graph_journal_read` | orchestrator, explorer, planner, plan critic | Read one entry by scope and stable journal ID |
| `graph_journal_write_insight` | root orchestrator only | Write a project insight linked to the current terminal run summary |
| `graph_journal_promote` | root orchestrator only, native `ask` | Write separately supplied project-neutral content to global scope |

Implementer, verifier and multimodal roles receive none of the journal tools.

### Configurable MCP and LSP permissions

Add `toolPermissions` to the **options object of the existing plugin tuple** in
`opencode.jsonc`. Keep the current plugin path and other options. This is a
plugin option, not a new top-level OpenCode field. For example, the options
object can contain:

```jsonc
{
  "maxAttempts": 3,
  "toolPermissions": {
    "shared": {
      "lsp": "allow",
      "codegraph_codegraph_explore": "allow"
    },
    "agents": {
      "graph-multimodal": {
        "lsp": "deny",
        "codegraph_codegraph_explore": "deny"
      }
    }
  }
}
```

The example opts the other six roles into the CodeGraph query and LSP, while
leaving all other MCP tools denied. No MCP is built into this plugin's policy.
The MCP server must be declared separately in OpenCode's `mcp` configuration;
LSP must also be available in the host. Updating the source checkout alone does
not update a separately installed plugin: update the installation referenced by
the tuple, then **quit and restart OpenCode** to load the code and configuration.

Rules:

- Both `shared` and `agents` are optional and default to empty objects. Agent
  keys must be full names from the seven-role table. Values are exactly
  `allow`, `ask`, or `deny`; nested native permission objects are not supported.
- Precedence is **existing role baseline → shared → role-specific rules**.
  Within each layer, the last matching rule wins. Overridden keys move to the
  end of the role's rules; a role wildcard can override a shared exact rule.
  `ask` remains a native permission request; the runner never grants it.
- Keys are `lsp`, exact MCP tool names, or a literal MCP tool prefix with one
  trailing `*`. `codegraph_*` is supported, but includes **future tools** on that
  server. Prefer exact query names when only one operation is needed. Leading
  or interior wildcards, `?`, global `*`, native controls (`bash`, `edit`,
  `write`, `task`, etc.), and `graph_*` tools cannot be configured here.
  Native MCP resource helpers (`read_mcp_resource`, `list_mcp_resources`,
  `list_mcp_resource_templates`) are also excluded: they use the host's `read`
  permission and are not server-prefixed MCP operations.
- MCP names use the pinned host's naming rule:
  `sanitize(serverName) + '_' + sanitize(toolName)`, replacing characters outside
  `[a-zA-Z0-9_-]` with `_`. Thus server `codegraph` + tool `codegraph_explore`
  becomes `codegraph_codegraph_explore`. Rules must fit inside one configured
  server namespace. Ambiguous normalized names or overlapping namespaces
  (such as `code` and `code_graph` for `code_graph_*`) are rejected.
  Rule matching, reserved-name protection and collision checks follow the host:
  case-insensitive on Windows, case-sensitive on other platforms.
- At most 128 rules per map, at most seven role overrides, and at most 256
  characters per rule. Configuration is copied and deeply frozen. Unknown keys,
  invalid values, accessors and non-plain data are rejected. Shape validation
  also runs when the plugin is disabled; MCP namespace validation runs in the
  enabled plugin's config hook before any agents are registered.
- A disabled or unreachable MCP may still have a valid permission rule. No
  network connection or tool discovery occurs during validation; an exact tool
  name typo within a valid namespace cannot be detected here. `graph_status`
  reports the ordered compiled rules under `toolPermissions.agents`, with
  `validated` indicating config-hook validation and `availabilityChecked: false`.
  These are plugin-generated rules, not a host connection/availability check or
  a report of every effective host permission.

For example, this override lets a verifier use only one operation even when
the shared policy permits the whole server:

```jsonc
"toolPermissions": {
  "shared": { "codegraph_*": "allow" },
  "agents": {
    "graph-verifier": {
      "codegraph_*": "deny",
      "codegraph_codegraph_explore": "allow"
    }
  }
}
```

**Runner boundary:** configured MCP calls require a RUNNING run and an active,
verified child dispatch; the root requires a RUNNING run too. Paused, completed,
rejected and revoked work cannot start new MCP calls. Late after-hooks remain
processable. Permission does **not** classify an MCP as read-only, sandbox its
implementation, or add its internal writes to the edit/bash ledger. Use this
entry point for reviewed query operations that fit the role; it is not a grant
to write outside `writeScope`. Native LSP navigation is classified as read-only
and may be used after dispatch completion if native permissions allow it; this
assumes the pinned host's LSP lookup behavior, not arbitrary server extensions.

All roles now receive capability-aware navigation guidance: explorer locates
symbols, planner checks dependencies, critic checks omissions, implementer
checks impact before editing, and verifier locates regression checks. Project
instructions determine tool preference. For CodeGraph, check that the project
has an index, pass the current project's absolute `projectPath`, and treat
returned current source sections as already read. Fall back to read/glob/grep
for missing sections or unavailable indexing. Graph results never replace
actual verifier commands, and denied tools must not be routed through shell.

Verification after installation: in an indexed project, use a bounded query
through explorer/planner/critic/implementer/verifier, including an implementer
with `allowShell: false`. Check a role-specific deny and an unconfigured MCP
remain unavailable. Unit/hook tests exercise these policies without a real MCP;
real-model tool selection and host connectivity require this separate smoke test.

## Options

The default plugin function accepts `(context, options)`. Supported options are plain data:

| Key | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `true` | Boolean; false returns no hooks |
| `setDefaultAgent` | `false` | Boolean; true selects `graph-orchestrator` |
| `models` | `{}` | Map of seven full agent names to nonempty model strings, max 256 characters, no surrounding whitespace or control characters |
| `toolPermissions` | `{ shared: {}, agents: {} }` | Shared and per-role allow/ask/deny rules for LSP and configured MCP namespaces; see above |
| `maxAttempts` | `3` | Integer 1–20; enforced per-node attempt budget (including the first attempt) and the verification repair loop cap |
| `maxParallel` | `4` | Integer 1–16; maximum concurrent read-only exploration/analysis tasks (mechanical `READER_CAPACITY` gate shared by explorer and multimodal) |
| `maxImplementerParallel` | `2` | Integer 1–4; enforced cap on concurrently RUNNING (or reserved) implement nodes, narrowed by the critic's `approvedParallel`; write scopes stay pairwise disjoint by plan validation |
| `maxPlanRevisions` | = `maxAttempts` | Integer 1–20; enforced cap on REVISE loops before the run pauses for a user decision |
| `stateDirectory` | `.opencode-loop` | 1–4 forward-slash separated segments (`[A-Za-z0-9.][A-Za-z0-9._-]`), no `.`/`..`/backslashes |
| `enforcement` | `hooks` | The literal `'hooks'` (only supported mode) |
| `journal.enabled` | `true` | Boolean; disables projection/backfill/search/writes when false; registered journal tools reject with `JOURNAL_DISABLED` |
| `journal.includeUserRequest` | `true` | Boolean; retain the first user request when true, or opt out before capture when false |
| `journal.semanticSearch` | `true` | Boolean; local hybrid semantic/text search when true, text fallback when false |
| `journal.maxUserRequestChars` | `8000` | Integer 1–32000; maximum retained first-request characters |
| `lessons.enabled` | `true` | Boolean; disables lesson projection/backfill/search/record/promotion and dispatch injection when false; registered lesson tools reject with `LESSON_DISABLED` |
| `lessons.injectMax` | `4` | Integer 0–8; maximum lessons injected into explorer/planner/implementer dispatch prompts (0 disables injection only) |

Unknown keys, callbacks and invalid values fail initialization, including when disabled. Options are copied at initialization. The package entry exports only the default plugin function; internal modules are not supported public APIs.

## Verification limits

The unit suite covers the sanitizer, TaskSpec/graph validation, the run and journal stores, terminal projection and bounded backfill, injected semantic ranking and text fallback, journal permissions and trust rules, every runner transition table entry, the five consultant scenarios (FAIL-then-dispatch rejected; attempts surviving reload; stale evidence rejected; crash-window recovery; out-of-scope writes denied pre-execution), full hook simulation, prompt contracts and truthful status. The token-aware embedding layer is covered directly: canonical text within budget embeds the complete source without overlap, dense token-dense input repacks the full source within the window/token/batch caps, and token-expanding text falls back to deterministic bounded spanning samples that retain the source prefix, midpoint and suffix — across CJK, emoji, whitespace, code, giant no-space and non-monotonic WordPiece/BERT punctuation boundaries — with bounded tokenizer work before chunks are materialized, source-ordered aggregation across batches, final L2 normalization, overflow-safe scaling, a non-finite aggregate rejected as a safe inference failure, guaranteed splitting termination, and malformed batched output or tokenizer loss staying safe inference/initialization failures with normal cooldown semantics. Stale-sidecar migration is covered at the embedding-space digest: stale space, digest or dimensions are detected and rebuilt lazily, with exactly one provider crossing per trimmed query and per complete candidate entry. The 12,000-character indexed boundary is exercised on both write paths: new journal/lesson content over the combined `title + "\n\n" + body` limit is rejected without shortening it, generated summaries truncate safely with an explicit marker, astral characters never split into lone surrogates at raw or final truncation boundaries, and exact-ID legacy replay stays idempotent without creating oversized entries — including lesson fingerprint consolidation across historical aliases and rejection of forged fingerprints. A relocation test packs and unpacks the real tarball and imports it with the real SDK/tool dependency closure outside the workspace without loading or downloading the embedding model.

What remains explicitly **not** claimed:

- `RUNNER_REJECTED` is a soft block: the child session is created and consumes a small turn, because `tool.execute.before` cannot abort a call.
- Established graph bindings do not restrict read paths; read-only tools are exempt from the binding gate entirely. Unknown child bindings fail closed (except read-only tools) until host identity is resolved. Resource locks are not a shell sandbox — `allowShell` implementers and read-only specialists get a best-effort static write-target screen (redirections, common write commands, heredocs; tracked `cd`), which fails open on anything it cannot confidently resolve; commands with effects outside the workspace remain governed only by native permissions.
- Submit-tool caller binding relies on host-provided tool context, task progress metadata (`callID`, `parentSessionId`, `sessionId`) and child parentage. Event races and bounded lookup are covered by simulations; a host that changes these semantics needs re-verification on the pinned build.
- Verifier `bash` remains a native `ask`; the runner never answers prompts on the user's behalf except to DENY rule violations.
- Real-model workflow acceptance (does the graph reduce errors versus the advisory loop at fixed budget) is separate evidence; `graph_status` keeps `enforcementAttested: false` until a locked-host scripted integration passes.
- Journal redaction is best-effort, storage is plaintext, and historical entries can be stale; journal output is never current gate evidence.
- Lesson fingerprints are exact-normalized-text matches; differently phrased duplicates do not consolidate. Dispatch-time lesson ranking is mechanical (paths, keywords, tags, occurrences, recency) and never loads the embedding model; relevance quality beyond those signals is the caller's job via `graph_lesson_search`.
- Embeddings for token-dense or legacy oversized entries are bounded spanning samples (source prefix, midpoint and suffix), not full-content representations; semantic relevance for such entries is capped by that sampling. Sidecars written under the former character-window policy stay stale until semantic search lazily rebuilds them, and metadata-only use never triggers that rebuild.
- The internal effect boundary (`effect-boundary.mjs`) remains a tested but unwired design sketch; its replay protection is still single-instance.

Parallel implementers are gated at **admission time** (dispatch capacity over reserved + RUNNING nodes), unlike creation-time worker pools in team-style plugins; the gate sees the run's live DAG state, and per-node side-effect ledgers, file claims and scope enforcement are already per-writer. Scope denials are hard blocks: the `tool.execute.before` hook throws `RUNNER_DENIED(...)` with actionable guidance (the host's permission flow may auto-allow, so the throw is the only unbypassable deny), and a denied call that executes anyway strictly fails the attempt (`EXECUTED_DESPITE_DENY`, same class as out-of-scope claims) — tainted work can never reach SUCCEEDED. A per-member git-worktree isolation option (stronger than scope globs, at the cost of merge-back) is a possible future TaskSpec field. Attempt ceilings are per-node structured-submission budgets — much coarser than conversation-turn budgets — and exhaustion now pauses for a user reset decision rather than terminating, which is the intended pressure valve instead of larger budgets. Mid-flight progress is likewise mechanical, not signalled: every child mutation already serializes through the per-run dispatch queue, `graph_inspect` surfaces per-node ledger activity and deliverable completion (with a read-only existence check so bash-created artifacts like venv binaries count honestly), and finer-grained reporting is expressed by decomposing work into smaller nodes with declared `deliverables`, not by a self-reported status channel.
