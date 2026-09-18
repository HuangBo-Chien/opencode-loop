# opencode-loop

`0.3.0-alpha.14` is a seven-agent **runner-gated** graph workflow with local cross-run journal memory and a lesson knowledge base for the official OpenCode `1.18.25` plugin API. The coordinator still drives native `task` dispatch, but a mechanical runner owns run state: dispatch admission, write-scope confinement, attempt counters, verdict gates and version-bound evidence are enforced by plugin hooks, not by prompts alone. The package name is provisional; no public npm release is claimed.

## How the gate works

The model proposes; the runner decides. Every hook decision is persisted to a run document under `<worktree>/<stateDirectory>/runs/<encoded-runId>.json` (atomic writes, cross-instance lock file; the filename is the percent-encoded run id, so successor runs like `root:2` stay valid on Windows while colon-free names are unchanged), where `runId` is the orchestrator session id — a restart reloads it and continues with counters intact.

| Gate | Mechanism |
| --- | --- |
| Implementer/verifier may only be dispatched when a plan passed review | `tool.execute.before` on `task` consults the runner; illegal dispatches are rewritten into an explicit `RUNNER_REJECTED` child turn (soft block — the child session still spawns, reports the rejection, and burns no work) |
| Exhaustion and rejection pause the run for an explicit user decision; nothing may be dispatched while paused | Runner verdict table: PASS advances, REVISE returns to the planner (capped by `maxPlanRevisions`), FAIL and every exhausted budget (plan revisions, node attempts, the verification repair loop) move the run to `AWAITING_USER_DECISION` with a recorded `pendingDecision` cause; UNVERIFIED blocks it honestly. The user then decides through `graph_run_decide` (native `ask`): **abort** marks the run irreversibly `ABORTED` (terminal, all evidence preserved), **reset** archives the run in place and opens a fresh successor run |
| Writes stay inside the assigned `writeScope` | `permission.ask` denies out-of-scope `edit` **and `write`** (and implementer `bash` without `allowShell`) for bound graph sessions before execution; violations are recorded. For `allowShell` implementers and read-only specialists, a best-effort static screen also rejects shell commands whose write targets (redirections, `tee`/`cp`/`mv`/`rm`/`dd of=`/`sed -i`/`truncate`/heredocs) resolve inside the workspace but outside the allowed scope |
| `testsPassed`-style claims are not trusted | Verdicts travel only through `graph_submit_*` tools; `PASS` requires at least one cited command with `exitCode 0` (plus at least one existing `artifacts` evidence path when any verified implement node declared `deliverables` — missing files are rejected as `ARTIFACT_MISSING`); nonzero commands are tolerated only when they match a still-valid `baseline` entry (same command and exit code), and change submissions are cross-checked against the runner's own edit ledger (undisclosed files fail the node) |
| Reviews and verifications bind to versions | A review targets `plan@v`; a resubmitted plan supersedes the old PASS. Verifications bind change versions plus file-hash snapshots; on resume, drifted hashes mark stale evidence and its node `STALE` |
| Crashes never blindly redo side effects | A restart moves in-flight nodes to `RECOVERY_REQUIRED` and **refunds the attempt a crash interrupted** (the reconcile re-dispatch charges a fresh one, so a crash costs no budget); `graph_run_resume` revokes old dispatch bindings and reservations, classifies nodes, and the interrupted session can be picked back up by `task_id` (host metadata re-verifies parentage) — otherwise re-dispatch injects the recorded side-effect ledger so the implementer reconciles reality first |
| Child sessions cannot consume another task's queue entry | Reservations are keyed by root session and native task `callID`; host task metadata supplies `sessionId`, checked against child parentage. Attempts start only after binding. Session creation order is not used |

Explorer, planner and multimodal dispatch without a node binding on healthy runs (the critic still requires an admissible review node); explorer and multimodal dispatches run in parallel under a bounded reader capacity (`maxParallel`), and enforcement concentrates on the write path and the verdict gates.

## Structured handoff

Work packages are `TaskSpec` nodes (`id`, `kind`, `agent`, `dependsOn`, `inputs`/`outputs` artifact refs, `writeScope`, optional `deliverables`, `acceptance`, optional `baseline` on verify nodes, `maxAttempts`/`allowShell`). `deliverables` is an optional literal file list within the implement node's writeScope; `graph_inspect` uses it as the denominator for mechanical progress reporting (per-node side-effect counts, last activity, deliverable completion). Large or multi-phase work should be decomposed into smaller nodes rather than reporting mid-flight: a small node is a frequent, fully verified checkpoint whose progress the runner observes mechanically and whose failures stay isolated. For run-unique lanes, `writeScope`/`deliverables` entries may use the `{{run}}` token — the runner expands it to the run's unique path token before validation, echoes the expanded literal paths in the submit response, and repeats them in the dispatch ack so the bound implementer's ground truth comes from the runner; unsubstituted placeholders (`<run>`, `{{...}}` leftovers) are rejected at submission. `graph_submit_plan` validates the graph — unique ids, resolvable dependencies, no cycles, pairwise-disjoint write scopes, mandatory review-before-implement and implement-before-verify gates, no write nodes for plan-only intents, and the **artifact naming contract** (declared `outputs` must equal the runner-assigned name for the kind — `findings`, `plan`, `review`, `change:<id>`, `verification:<id>`, `baseline:<id>` — or be omitted, and `inputs` may only reference names some runner-managed artifact can satisfy, so a node can never wait on a name nothing produces) — before it ever reaches run state; an `INVALID_GRAPH` rejection carries a compact TaskSpec schema summary (kind↔agent mapping, bare artifact `outputs`, naming rules, gate rules) so the planner can fix the submission without guessing. Each role then delivers through its own tool: `graph_submit_review`, `graph_submit_change`, `graph_submit_verification`, `graph_submit_findings`; `graph_inspect` reports node states, attempts, blockers, artifact versions, per-node mechanical progress (side-effect counts, last activity, deliverable completion when declared) and a Mermaid diagram; `graph_run_resume` performs crash recovery; `graph_run_new` starts a successor run after a terminal one.

### Light path (critic-free small changes)

`intent: "light"` is a routing lane for mechanical, low-risk fixes (copy, formatting, single-file typos): the review node is omitted, the single implement node depends directly on the plan node, and the critic session is skipped — **at most one implement node** is enforced at validation. Every mechanical gate is unchanged: writeScope confinement, the edit ledger cross-check, deliverables-backed artifact evidence and the verify-after-implement gate all still apply; only the advisory quality review is waived. The change artifact cites `plan@v` instead of `review@v`. Use the full `change` flow (with exploration) for cross-file, async, database or otherwise high-risk work — the orchestrator prompt encodes this routing.

### Baseline: separating pre-existing failures from regressions

On projects whose suite is already red, an honest verifier cannot cite an all-green command, so a `change` run used to burn repair attempts on failures it never caused. A plan may now declare a **baseline verify node** (`kind: "verify"`, `baseline: true`): it is dispatched *before* the implementer (it depends on the review node — the plan node in light graphs — and every implement node must depend on it, so the capture is mechanically ordered before any write). The verifier submits `verdict: "BASELINE"` with the commands it actually ran and their exit codes; the runner stores the versioned `baseline:<id>` artifact. A later `PASS` still requires at least one `exitCode 0` command, and every nonzero command is tolerated **only** when it matches a still-valid baseline entry (identical command string and exit code — purely mechanical, no output parsing, ecosystem-agnostic). A failure that got worse (different exit code), a new failure, or a stale baseline all reject the PASS. Replacing the plan supersedes existing baseline artifacts so pre-change evidence from a previous graph version can never tolerate failures under the new one.

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

- The coordinator can steer dispatch: an explicit `nodeId` task argument, or a single `[nodeId: implement-setup]` marker on the first prompt line, targets a specific node. The runner validates exactly that node (existence, role match, admissibility, attempts, writer capacity) and either binds it or rejects the dispatch with the precise reason (`NODE_NOT_FOUND`, `NODE_NOT_ADMISSIBLE`, `ATTEMPTS_EXHAUSTED`, `WRITER_CAPACITY`, `READER_CAPACITY`); it never silently reassigns the request to a different node. Unmarked dispatches keep the runner's own ordering, and every bound dispatch confirms the assignment with a `[RUNNER] Assigned nodeId` prompt line.
- Implementers run in parallel under a bounded writer-capacity gate: at most `min(maxImplementerParallel, critic approvedParallel)` implement nodes may be RUNNING (or reserved) at once, and their write scopes are pairwise disjoint by plan validation. Concurrent dispatch reservations always occupy **distinct** nodes (reserved nodes are excluded from the sorted pick and a targeted duplicate reports `DISPATCH_PENDING`), so parallel `[nodeId:...]` dispatches never collide. Verifiers, critics and planners keep one-in-flight semantics.
- Explorers and multimodal analysts run in parallel under a mirrored reader-capacity gate: at most `maxParallel` exploration/analysis tasks (free consultation reservations plus node-bound explore/analyze work, one shared budget) may be in flight at once; excess dispatches are rejected with `READER_CAPACITY`, and an active `task_id` continuation never self-blocks. The orchestrator prompt asks for same-turn multi-dispatch of independent exploration aspects.
- The critic is never freely admitted: its verdict can only travel through a bound review node, so when the review node exists but is not yet admissible the dispatch is rejected up front with `NO_READY_NODE` and the waiting reasons (plus the artifact-naming hint when an input references a name nothing produces) instead of stranding a child session that could never submit. Explorer, planner and multimodal keep free consultation because their findings/plan submissions do not require a node binding.
- `task_id` may continue the same active RUNNING attempt and role in the same run without charging another attempt. It may also **resume any node the session last worked on** when that node is `INCOMPLETE`/`PENDING`/`STALE` with attempts left — including a REVISE'd planner, a critic re-reviewing after a re-plan, or an implementer in the repair loop — because `submitPlan` preserves node session ids across plan replacement. A new attempt is charged, the recorded side-effect ledger travels with the dispatch, and the old inactive binding is superseded (stale inactive bindings no longer block a fresh reservation from binding the same session, and a resumed session's pre-dispatch idle evidence is discarded so a continuation cannot be instantly marked incomplete). Read-only role sessions whose binding is gone entirely (a round-1 planner after its plan submission invalidated the binding) may still be continued by identity: the reservation carries the session id and host metadata plus the bounded parentage lookup re-verify the relationship before any work is trusted; write-role continuations always require state-verified identity. After a plugin restart the in-memory binding is rebuilt from run state the same way, so an interrupted implementer conversation can be picked back up instead of starting over. Sessions without a usable dispatch fail with an actionable `BINDING_UNAVAILABLE` that tells the child to stop and report instead of retrying.
- Revision and repair evidence is relayed mechanically: dispatching a plan node after a REVISE verdict injects the critic's findings into the task prompt, and dispatching an implement node after a FAILED verification (now recorded as a durable superseded `verification:<id>` artifact) injects the failure summary and failing commands — fresh sessions and task_id continuations both receive it, no coordinator relay required.
- Read-only tools (`read`, `glob`, `grep`, `list`, `graph_status`, `graph_inspect`, `graph_journal_search`, `graph_journal_read`) are never collaterally blocked by the dispatch-binding gate. Rejected or finished children resolve the owning run through the host-verified parent chain, so inspection and journal history stay available even after a run reaches a terminal state. Write paths keep failing closed.
- `graph_run_decide(action, reason)` delivers the user's decision for a run paused at `AWAITING_USER_DECISION` (or deliberately rotates/terminates a quiet run). A user-provided reason is required, and native permission `ask` means the host confirms with the human before the tool runs. **abort** irreversibly marks the run `ABORTED`: findings, plans, reviews, violations and dispatch history stay untouched, dispatch is closed (`RUN_TERMINATED`), and the terminal run projects a journal summary with the reason. **reset** archives the run in place — original status, `pendingDecision`, counters and evidence remain, plus a `decision` record and `successorRunId` — and creates a fresh successor run whose counters start at zero; it re-walks the explorer → planner → critic gates and never replays implementer work or recorded side effects. The successor run carries a bounded `carryOver` digest (predecessor id, reset reason, the archived run's final rejection findings, and a findings summary aggregating the last 3 retained versions: summaries joined and capped, learnings newest-first capped at 8 items) that is reported by `graph_inspect` and injected into the new explorer/planner dispatch prompts with a revalidation mandate, so prior lessons are consumed instead of re-derived — and re-rejected. Both actions require no `RUNNING` nodes and no outstanding dispatch reservations first.
- `graph_run_new` starts a successor run in the same orchestrator session once the current run is `SUCCEEDED`, `FAILED` or `ABORTED` (write journal insights first). The successor run id is `<session>:<n>`; the finished run records `successorRunId`, and a restart follows the chain (regardless of the archived predecessors' statuses) so the orchestrator rebinds to the newest run.
- A reservation awaiting host metadata blocks another dispatch of that node/role (`DISPATCH_PENDING`) without consuming an attempt. Failed unbound task calls release their reservation.
- Both foreground running metadata and completed **background** task metadata are supported. Pending continuations survive the preceding prompt's idle event. Host event IDs deduplicate repeated idle notifications; ID-less legacy notifications are consumed once per session and rely on terminal task events for additional completions.
- Before child work, delayed metadata can be resolved through bounded host reads (64 parent messages, at most 256 parts per message, a 2-second request deadline). An unresolved session cannot silently bypass enforcement; it fails with `BINDING_UNAVAILABLE` until its relationship is established.
- `graph_run_resume` clears reservations and revokes old bindings; late events cannot claim a fresh dispatch. Recorded attempts and side effects remain intact. This is recovery of interrupted work, not a general FAILED-node reset.
- Consumed call IDs are retained in bounded run history (4,096 calls/run; 128 outstanding reservations) so recovery cannot reuse a revoked call ID. A failed binding save can be retried with the same dispatch identity without incrementing the attempt twice; inspect reports `BINDING_PERSISTENCE_FAILED` while the save is unresolved.
- `graph_inspect` includes pending/bound dispatches, remaining attempts, binding status, last submission failure and a recovery hint. Review attempts and `maxPlanRevisions` are independent budgets. Plan replacement is refused while a review, implementation or verification node is still RUNNING.

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

Initialization is single-flight and limited to three attempts per plugin instance. After failure, a later query may retry after 30 seconds, then 60 seconds; there are no background retry timers. Exhausted initialization continues using text fallback. Status exposes safe stage codes, initialization attempt count and the next retry timestamp. Transformers.js controls its own cache (by default its package `.cache`), which is distinct from Python's Hugging Face Hub cache.

Diagnostics distinguish `JOURNAL_SCAN_FAILED`, `JOURNAL_BACKFILL_FAILED`, `EMBEDDING_INITIALIZATION_FAILED`, `EMBEDDING_INFERENCE_FAILED`, `JOURNAL_INDEX_READ_FAILED` and `JOURNAL_INDEX_WRITE_FAILED`. Raw provider errors and filesystem paths are not copied into these public errors. Storage scan failures remain errors, not successful empty search results. Directory cleanup supports both Node Promise-returning and Bun synchronous `close()` behavior.

By default, the first user request is retained in run state and terminal summaries, capped at 8,000 characters. Set `journal.includeUserRequest` to `false` before the first request to opt out, or adjust `journal.maxUserRequestChars` within its documented range. Requests, commands and insights receive best-effort redaction for common key, token, bearer, JWT, password and secret patterns, but this is not a guarantee: avoid placing secrets in requests and protect or remove the plaintext state directories according to local retention policy.

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

Use Node.js 22 or newer. From this package directory run `npm install --ignore-scripts`, `npm test`, then `npm pack --ignore-scripts`. This produces `opencode-loop-0.3.0-alpha.14.tgz`; these commands do not publish or install globally. After installing changed plugin code, quit and restart OpenCode; running instances retain the previously loaded plugin.

From the project where you want to use the plugin, install that local tarball:

```powershell
npm install --ignore-scripts --save-dev C:\path\to\opencode-loop-0.3.0-alpha.14.tgz
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

All graph agents may call `graph_status` and `graph_inspect`; every role also receives `skill: 'allow'` through the shared permission baseline, and `skill` is classified as a read-only tool (it stays available to child sessions whose dispatch binding is gone, while write tools keep failing closed). Unknown tools (including arbitrary MCP tools) default to deny, and `read` explicitly denies `*.env`/`*.env.*`. Native agent definitions and the default agent remain intact unless `setDefaultAgent` is true. Any existing definition with one of the seven reserved names causes an atomic collision error.

Classifying `skill` as side-effect-free is an assumption based on OpenCode host 1.18.x behavior (the pinned SDK is `@opencode-ai/plugin@1.18.25`). If a newer host ever makes the `skill` tool mutate run state or the workspace, revisit both its `READ_ONLY_TOOLS` membership and the blanket `allow`.

Journal access is intentionally narrower. Prefer native `ask` when a journal operation, especially global promotion, needs user approval.

| Journal tool | Allowed roles | Behavior |
| --- | --- | --- |
| `graph_journal_search` | orchestrator, explorer, planner, plan critic | Bounded project/global search; performs bounded backfill first |
| `graph_journal_read` | orchestrator, explorer, planner, plan critic | Read one entry by scope and stable journal ID |
| `graph_journal_write_insight` | root orchestrator only | Write a project insight linked to the current terminal run summary |
| `graph_journal_promote` | root orchestrator only, native `ask` | Write separately supplied project-neutral content to global scope |

Implementer, verifier and multimodal roles receive none of the journal tools.

## Options

The default plugin function accepts `(context, options)`. Supported options are plain data:

| Key | Default | Accepted values |
| --- | --- | --- |
| `enabled` | `true` | Boolean; false returns no hooks |
| `setDefaultAgent` | `false` | Boolean; true selects `graph-orchestrator` |
| `models` | `{}` | Map of seven full agent names to nonempty model strings, max 256 characters, no surrounding whitespace or control characters |
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

The unit suite covers the sanitizer, TaskSpec/graph validation, the run and journal stores, terminal projection and bounded backfill, injected semantic ranking and text fallback, journal permissions and trust rules, every runner transition table entry, the five consultant scenarios (FAIL-then-dispatch rejected; attempts surviving reload; stale evidence rejected; crash-window recovery; out-of-scope writes denied pre-execution), full hook simulation, prompt contracts and truthful status. A relocation test packs and unpacks the real tarball and imports it with the real SDK/tool dependency closure outside the workspace without loading or downloading the embedding model.

What remains explicitly **not** claimed:

- `RUNNER_REJECTED` is a soft block: the child session is created and consumes a small turn, because `tool.execute.before` cannot abort a call.
- Established graph bindings do not restrict read paths; read-only tools are exempt from the binding gate entirely. Unknown child bindings fail closed (except read-only tools) until host identity is resolved. Resource locks are not a shell sandbox — `allowShell` implementers and read-only specialists get a best-effort static write-target screen (redirections, common write commands, heredocs; tracked `cd`), which fails open on anything it cannot confidently resolve; commands with effects outside the workspace remain governed only by native permissions.
- Submit-tool caller binding relies on host-provided tool context, task progress metadata (`callID`, `parentSessionId`, `sessionId`) and child parentage. Event races and bounded lookup are covered by simulations; a host that changes these semantics needs re-verification on the pinned build.
- Verifier `bash` remains a native `ask`; the runner never answers prompts on the user's behalf except to DENY rule violations.
- Real-model workflow acceptance (does the graph reduce errors versus the advisory loop at fixed budget) is separate evidence; `graph_status` keeps `enforcementAttested: false` until a locked-host scripted integration passes.
- Journal redaction is best-effort, storage is plaintext, and historical entries can be stale; journal output is never current gate evidence.
- Lesson fingerprints are exact-normalized-text matches; differently phrased duplicates do not consolidate. Dispatch-time lesson ranking is mechanical (paths, keywords, tags, occurrences, recency) and never loads the embedding model; relevance quality beyond those signals is the caller's job via `graph_lesson_search`.
- The internal effect boundary (`effect-boundary.mjs`) remains a tested but unwired design sketch; its replay protection is still single-instance.

Parallel implementers are gated at **admission time** (dispatch capacity over reserved + RUNNING nodes), unlike creation-time worker pools in team-style plugins; the gate sees the run's live DAG state, and per-node side-effect ledgers, file claims and scope enforcement are already per-writer. Scope denials are hard blocks: the `tool.execute.before` hook throws `RUNNER_DENIED(...)` with actionable guidance (the host's permission flow may auto-allow, so the throw is the only unbypassable deny), and a denied call that executes anyway strictly fails the attempt (`EXECUTED_DESPITE_DENY`, same class as out-of-scope claims) — tainted work can never reach SUCCEEDED. A per-member git-worktree isolation option (stronger than scope globs, at the cost of merge-back) is a possible future TaskSpec field. Attempt ceilings are per-node structured-submission budgets — much coarser than conversation-turn budgets — and exhaustion now pauses for a user reset decision rather than terminating, which is the intended pressure valve instead of larger budgets. Mid-flight progress is likewise mechanical, not signalled: every child mutation already serializes through the per-run dispatch queue, `graph_inspect` surfaces per-node ledger activity and deliverable completion (with a read-only existence check so bash-created artifacts like venv binaries count honestly), and finer-grained reporting is expressed by decomposing work into smaller nodes with declared `deliverables`, not by a self-reported status channel.
