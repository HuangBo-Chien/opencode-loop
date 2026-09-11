# opencode-loop

`0.3.0-alpha.1` is a seven-agent **runner-gated** graph workflow with local cross-run journal memory for the official OpenCode `1.18.25` plugin API. The coordinator still drives native `task` dispatch, but a mechanical runner owns run state: dispatch admission, write-scope confinement, attempt counters, verdict gates and version-bound evidence are enforced by plugin hooks, not by prompts alone. The package name is provisional; no public npm release is claimed.

## How the gate works

The model proposes; the runner decides. Every hook decision is persisted to a run document under `<worktree>/<stateDirectory>/runs/<runId>.json` (atomic writes, cross-instance lock file), where `runId` is the orchestrator session id — a restart reloads it and continues with counters intact.

| Gate | Mechanism |
| --- | --- |
| Implementer/verifier may only be dispatched when a plan passed review | `tool.execute.before` on `task` consults the runner; illegal dispatches are rewritten into an explicit `RUNNER_REJECTED` child turn (soft block — the child session still spawns, reports the rejection, and burns no work) |
| Critic `FAIL` terminates the run; nothing may be dispatched afterwards | Runner verdict table: PASS advances, REVISE returns to the planner (capped by `maxPlanRevisions`), FAIL fails the run, UNVERIFIED blocks it honestly |
| Writes stay inside the assigned `writeScope` | `permission.ask` denies out-of-scope `edit` (and implementer `bash` without `allowShell`) for bound graph sessions before execution; violations are recorded |
| `testsPassed`-style claims are not trusted | Verdicts travel only through `graph_submit_*` tools; `PASS` requires at least one cited command with `exitCode 0`, and change submissions are cross-checked against the runner's own edit ledger (undisclosed files fail the node) |
| Reviews and verifications bind to versions | A review targets `plan@v`; a resubmitted plan supersedes the old PASS. Verifications bind change versions plus file-hash snapshots; on resume, drifted hashes mark stale evidence and its node `STALE` |
| Crashes never blindly redo side effects | A restart moves in-flight nodes to `RECOVERY_REQUIRED`; `graph_run_resume` classifies them (attempt counters preserved) and re-dispatch injects the recorded side-effect ledger so the implementer reconciles reality first |

Read-only specialists (explorer, planner, critic, multimodal) dispatch freely on healthy runs; enforcement concentrates on the write path and the verdict gates.

## Structured handoff

Work packages are `TaskSpec` nodes (`id`, `kind`, `agent`, `dependsOn`, `inputs`/`outputs` artifact refs, `writeScope`, `acceptance`, optional `maxAttempts`/`allowShell`). `graph_submit_plan` validates the graph — unique ids, resolvable dependencies, no cycles, pairwise-disjoint write scopes, mandatory review-before-implement and implement-before-verify gates, and no write nodes for plan-only intents — before it ever reaches run state. Each role then delivers through its own tool: `graph_submit_review`, `graph_submit_change`, `graph_submit_verification`, `graph_submit_findings`; `graph_inspect` reports node states, attempts, blockers, artifact versions and a Mermaid diagram; `graph_run_resume` performs crash recovery.

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

By default, the first user request is retained in run state and terminal summaries, capped at 8,000 characters. Set `journal.includeUserRequest` to `false` before the first request to opt out, or adjust `journal.maxUserRequestChars` within its documented range. Requests, commands and insights receive best-effort redaction for common key, token, bearer, JWT, password and secret patterns, but this is not a guarantee: avoid placing secrets in requests and protect or remove the plaintext state directories according to local retention policy.

Global promotion never copies a project entry. It accepts only a project `insight` and requires separately supplied, project-neutral title/body/tags plus native permission `ask`. Run summaries, raw requests, project paths, run IDs and file lists are never written to the global journal.

## Project-local installation

Use Node.js 22 or newer. From this package directory run `npm install --ignore-scripts`, `npm test`, then `npm pack --ignore-scripts`. This produces `opencode-loop-0.3.0-alpha.1.tgz`; these commands do not publish or install globally.

From the project where you want to use the plugin, install that local tarball:

```powershell
npm install --ignore-scripts --save-dev C:\path\to\opencode-loop-0.3.0-alpha.1.tgz
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
| `graph-orchestrator` | primary | Route, dispatch, recover, summarize | `graph_run_resume` | `task` only to the six specialists; `question`, `todowrite` allowed |
| `graph-explorer` | subagent | Read source, gather versioned findings | `graph_submit_findings` | `webfetch`, `websearch` ask |
| `graph-planner` | subagent | Submit a validated task graph | `graph_submit_plan` | `webfetch`, `websearch` ask |
| `graph-plan-critic` | subagent | Verdict bound to a plan version | `graph_submit_review` | `webfetch`, `websearch` ask |
| `graph-implementer` | subagent | Write within `writeScope` only | `graph_submit_change` | `edit`, `bash` ask (bash denied unless `allowShell`) |
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
- Reads are unrestricted by the runner (read-only agents have no native write permissions anyway); resource locks are not a shell sandbox — an arbitrary command is only gated where native permissions ask.
- Submit-tool caller binding relies on the host-provided tool context (`sessionID`/`agent`) and child-session parentage events; a host that changes those semantics needs re-verification on the pinned build.
- Verifier `bash` remains a native `ask`; the runner never answers prompts on the user's behalf except to DENY rule violations.
- Real-model workflow acceptance (does the graph reduce errors versus the advisory loop at fixed budget) is separate evidence; `graph_status` keeps `enforcementAttested: false` until a locked-host scripted integration passes.
- Journal redaction is best-effort, storage is plaintext, and historical entries can be stale; journal output is never current gate evidence.
- The internal effect boundary (`effect-boundary.mjs`) remains a tested but unwired design sketch; its replay protection is still single-instance.

Multi-writer parallelism is future work: the runner enforces one RUNNING implement node at a time. `maxImplementerParallel` currently only shapes planner/critic recommendations.
