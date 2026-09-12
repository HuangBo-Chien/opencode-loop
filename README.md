# opencode-loop

`0.3.0-alpha.3` is a seven-agent **runner-gated** graph workflow with local cross-run journal memory for the official OpenCode `1.18.25` plugin API. The coordinator still drives native `task` dispatch, but a mechanical runner owns run state: dispatch admission, write-scope confinement, attempt counters, verdict gates and version-bound evidence are enforced by plugin hooks, not by prompts alone. The package name is provisional; no public npm release is claimed.

## How the gate works

The model proposes; the runner decides. Every hook decision is persisted to a run document under `<worktree>/<stateDirectory>/runs/<runId>.json` (atomic writes, cross-instance lock file), where `runId` is the orchestrator session id — a restart reloads it and continues with counters intact.

| Gate | Mechanism |
| --- | --- |
| Implementer/verifier may only be dispatched when a plan passed review | `tool.execute.before` on `task` consults the runner; illegal dispatches are rewritten into an explicit `RUNNER_REJECTED` child turn (soft block — the child session still spawns, reports the rejection, and burns no work) |
| Critic `FAIL` terminates the run; nothing may be dispatched afterwards | Runner verdict table: PASS advances, REVISE returns to the planner (capped by `maxPlanRevisions`), FAIL fails the run, UNVERIFIED blocks it honestly |
| Writes stay inside the assigned `writeScope` | `permission.ask` denies out-of-scope `edit` **and `write`** (and implementer `bash` without `allowShell`) for bound graph sessions before execution; violations are recorded. For `allowShell` implementers and read-only specialists, a best-effort static screen also rejects shell commands whose write targets (redirections, `tee`/`cp`/`mv`/`rm`/`dd of=`/`sed -i`/`truncate`/heredocs) resolve inside the workspace but outside the allowed scope |
| `testsPassed`-style claims are not trusted | Verdicts travel only through `graph_submit_*` tools; `PASS` requires at least one cited command with `exitCode 0`, and change submissions are cross-checked against the runner's own edit ledger (undisclosed files fail the node) |
| Reviews and verifications bind to versions | A review targets `plan@v`; a resubmitted plan supersedes the old PASS. Verifications bind change versions plus file-hash snapshots; on resume, drifted hashes mark stale evidence and its node `STALE` |
| Crashes never blindly redo side effects | A restart moves in-flight nodes to `RECOVERY_REQUIRED`; `graph_run_resume` revokes old dispatch bindings and reservations, classifies nodes (attempt counters preserved), and re-dispatch injects the recorded side-effect ledger so the implementer reconciles reality first |
| Child sessions cannot consume another task's queue entry | Reservations are keyed by root session and native task `callID`; host task metadata supplies `sessionId`, checked against child parentage. Attempts start only after binding. Session creation order is not used |

Read-only specialists (explorer, planner, critic, multimodal) dispatch freely on healthy runs; enforcement concentrates on the write path and the verdict gates.

## Structured handoff

Work packages are `TaskSpec` nodes (`id`, `kind`, `agent`, `dependsOn`, `inputs`/`outputs` artifact refs, `writeScope`, `acceptance`, optional `maxAttempts`/`allowShell`). `graph_submit_plan` validates the graph — unique ids, resolvable dependencies, no cycles, pairwise-disjoint write scopes, mandatory review-before-implement and implement-before-verify gates, no write nodes for plan-only intents, and the **artifact naming contract** (declared `outputs` must equal the runner-assigned name for the kind — `findings`, `plan`, `review`, `change:<id>`, `verification:<id>` — or be omitted, and `inputs` may only reference names some runner-managed artifact can satisfy, so a node can never wait on a name nothing produces) — before it ever reaches run state; an `INVALID_GRAPH` rejection carries a compact TaskSpec schema summary (kind↔agent mapping, bare artifact `outputs`, naming rules, gate rules) so the planner can fix the submission without guessing. Each role then delivers through its own tool: `graph_submit_review`, `graph_submit_change`, `graph_submit_verification`, `graph_submit_findings`; `graph_inspect` reports node states, attempts, blockers, artifact versions and a Mermaid diagram; `graph_run_resume` performs crash recovery; `graph_run_new` starts a successor run after a terminal one.

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

### Dispatch and recovery

- The coordinator can steer dispatch: an explicit `nodeId` task argument, or a single `[nodeId: implement-setup]` marker on the first prompt line, targets a specific node. The runner validates exactly that node (existence, role match, admissibility, attempts, single-writer) and either binds it or rejects the dispatch with the precise reason (`NODE_NOT_FOUND`, `NODE_NOT_ADMISSIBLE`, `ATTEMPTS_EXHAUSTED`, `SINGLE_WRITER`); it never silently reassigns the request to a different node. Unmarked dispatches keep the runner's own ordering, and every bound dispatch confirms the assignment with a `[RUNNER] Assigned nodeId` prompt line.
- The critic is never freely admitted: its verdict can only travel through a bound review node, so when the review node exists but is not yet admissible the dispatch is rejected up front with `NO_READY_NODE` and the waiting reasons (plus the artifact-naming hint when an input references a name nothing produces) instead of stranding a child session that could never submit. Explorer, planner and multimodal keep free consultation because their findings/plan submissions do not require a node binding.
- `task_id` may continue the same active RUNNING attempt and role in the same run without charging another attempt. It may also **resume the unfinished node the session last worked on** when that node is `INCOMPLETE`/`PENDING`/`STALE` with attempts left: a new attempt is charged, the recorded side-effect ledger travels with the dispatch, and the old inactive binding is superseded. Completed nodes, foreign sessions and exhausted attempts still require a fresh session (`FRESH_SESSION_REQUIRED`, and rejection messages name the bound node).
- Read-only tools (`read`, `glob`, `grep`, `list`, `graph_status`, `graph_inspect`, `graph_journal_search`, `graph_journal_read`) are never collaterally blocked by the dispatch-binding gate. Rejected or finished children resolve the owning run through the host-verified parent chain, so inspection and journal history stay available even after a run reaches a terminal state. Write paths keep failing closed.
- `graph_run_new` starts a successor run in the same orchestrator session once the current run is `SUCCEEDED` or `FAILED` (write journal insights first). The successor run id is `<session>:<n>`; the finished run records `successorRunId`, and a restart follows the chain so the orchestrator rebinds to the newest run instead of the terminal one.
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

## Project-local installation

Use Node.js 22 or newer. From this package directory run `npm install --ignore-scripts`, `npm test`, then `npm pack --ignore-scripts`. This produces `opencode-loop-0.3.0-alpha.3.tgz`; these commands do not publish or install globally. After installing changed plugin code, quit and restart OpenCode; running instances retain the previously loaded plugin.

From the project where you want to use the plugin, install that local tarball:

```powershell
npm install --ignore-scripts --save-dev C:\path\to\opencode-loop-0.3.0-alpha.3.tgz
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
| `graph-orchestrator` | primary | Route, dispatch, recover, summarize | `graph_run_resume`, `graph_run_new` | `task` only to the six specialists; `question`, `todowrite` allowed |
| `graph-explorer` | subagent | Read source, gather versioned findings | `graph_submit_findings` | `bash` ask for non-mutating checks (workspace writes denied by the screen); `webfetch`, `websearch` ask |
| `graph-planner` | subagent | Submit a validated task graph | `graph_submit_plan` | `webfetch`, `websearch` ask |
| `graph-plan-critic` | subagent | Verdict bound to a plan version | `graph_submit_review` | `webfetch`, `websearch` ask |
| `graph-implementer` | subagent | Write within `writeScope` only | `graph_submit_change` | `edit`, `write`, `bash` ask (bash denied unless `allowShell`; screened write targets must stay in scope) |
| `graph-verifier` | subagent | Evidence-bound verification | `graph_submit_verification` | `bash` ask; no edit |
| `graph-multimodal` | subagent | Analyze supported visual inputs honestly | `graph_submit_findings` | `webfetch`, `websearch` ask |

All graph agents may call `graph_status` and `graph_inspect`; unknown tools (including arbitrary MCP tools) default to deny, and `read` explicitly denies `*.env`/`*.env.*`. Native agent definitions and the default agent remain intact unless `setDefaultAgent` is true. Any existing definition with one of the seven reserved names causes an atomic collision error.

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
| `maxAttempts` | `3` | Integer 1–10; enforced per-node attempt budget (including the first attempt) and the verification repair loop cap |
| `maxParallel` | `4` | Integer 1–16; maximum independent read-only tasks (prompt-guided; writes are mechanically single-writer) |
| `maxImplementerParallel` | `1` | Integer 1–4; planner/critic parallelism ceiling (advisory for scheduling; the runner still serializes write nodes in this version) |
| `maxPlanRevisions` | = `maxAttempts` | Integer 1–10; enforced cap on REVISE loops before the run fails |
| `stateDirectory` | `.opencode-loop` | 1–4 forward-slash separated segments (`[A-Za-z0-9.][A-Za-z0-9._-]`), no `.`/`..`/backslashes |
| `enforcement` | `hooks` | The literal `'hooks'` (only supported mode) |
| `journal.enabled` | `true` | Boolean; disables projection/backfill/search/writes when false; registered journal tools reject with `JOURNAL_DISABLED` |
| `journal.includeUserRequest` | `true` | Boolean; retain the first user request when true, or opt out before capture when false |
| `journal.semanticSearch` | `true` | Boolean; local hybrid semantic/text search when true, text fallback when false |
| `journal.maxUserRequestChars` | `8000` | Integer 1–32000; maximum retained first-request characters |

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
- The internal effect boundary (`effect-boundary.mjs`) remains a tested but unwired design sketch; its replay protection is still single-instance.

Multi-writer parallelism is future work: the runner enforces one RUNNING implement node at a time. `maxImplementerParallel` currently only shapes planner/critic recommendations.
