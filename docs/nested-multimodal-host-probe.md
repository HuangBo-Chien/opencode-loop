# Native nested multimodal host probe

## Verification status

**UNVERIFIED on the pinned OpenCode 1.18.25 host.** The implementation environment
reports `opencode --version` = `1.18.31`; no pinned 1.18.25 host/model-driven
session was run. Unit tests use SDK-shaped host fixtures and do not prove that
the native host exposes nested task or that an image-capable model reads PNGs.
`test/runtime-smoke.test.mjs` exercises stores/embeddings, not this flow.

Source prerequisites were independently checked:

- [Authoritative configuration schema](https://opencode.ai/config.json):
  `Config.properties.subagent_depth` is a top-level integer, minimum 0;
  its documented native default is 1.
- [Pinned v1.18.25 native task source](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.25/packages/opencode/src/tool/task.ts):
  `TaskTool.execute` counts caller ancestors, then rejects
  `depth >= (cfg.subagent_depth ?? 1)` **before** child creation and metadata.
  An orchestrator's child has depth 1, so nesting requires at least 2.

The plugin config hook now defaults an unspecified `subagent_depth` to 2. It
preserves explicit values, including 0/1, and admission checks the effective
setting before creating reservations. Source inspection is not native smoke
verification; arbitrary native errors remain fail-closed lifetime blockers.

## Reproduction setup

1. Use a disposable Git worktree/project and an actual OpenCode **1.18.25**
   executable. Record `opencode --version`, this plugin's Git revision/diff and
   the selected provider/model. Use a configured image-capable model for
   `graph-multimodal` and valid native provider credentials. Do not record secrets.
2. Configure the project to load this checkout's `src/index.mjs` plugin (use the
   absolute `file:///D:/opencode-loop/src/index.mjs` URL on this Windows checkout;
   adjust the path elsewhere). Follow the README installation configuration;
   set `maxParallel: 1`. Leave top-level `subagent_depth` unspecified to exercise
   the plugin default, or explicitly set `"subagent_depth": 2` (outside plugin
   options). Confirm the effective host config is at least 2; an explicit 0/1
   is intentionally preserved and rejects admission. Quit and restart OpenCode after changing configuration
   so the new hooks, permissions and prompts are loaded. Do not use `--pure`.
3. In a paint application, create `probe.png` containing a blue circle on the
   left, a red square on the right and the text `NESTED 42`; save it in the
   disposable project. This is the independent expected visual answer.
4. Start the actual host in that project with `graph-orchestrator`. For example,
   in PowerShell, with the correct pinned executable path:

   ```powershell
   & "C:\path\to\opencode-1.18.25.exe" --version
   & "C:\path\to\opencode-1.18.25.exe" "D:\scratch\nested-probe" --agent graph-orchestrator
   ```

## User request to paste

> Implement an image-description note in `result.md`. Use the full graph workflow:
> explorer findings, planner plan, independent plan-critic approval, implementer,
> verifier. The implementer must ask graph-multimodal via native task to actually
> read `probe.png`; do not relay an earlier image description or infer from its
> filename. Its nested task must omit nodeId. Ask the analyst for observations,
> source path and uncertainty through its task response, without findings submit.
> The implementer must write the returned observations to result.md and formally
> submit its change; the verifier checks the result. Keep the implementer write
> scope limited to result.md. Report actual tool evidence and limitations.

## Evidence to capture and acceptance

Use native session export/host API and the plugin run document, not model prose,
to record these observations. Export the root, implementer and analyst sessions
with `opencode export <sessionID>` after the run (check that executable's help).
During execution, copy the run document/inspect output before settlement; after
execution use `settledDispatches` for the same call identities.

- The implementer's native `task` call targets `graph-multimodal`; native
  permissions expose that target and reject other delegation targets.
- Analyst session `parentID` is the **implementer session**, not the root.
  Task part `sessionID` is the implementer; metadata `parentSessionId` is the
  implementer and `sessionId` is the analyst. Preserve its actual `callID`.
- Reservation has `nested: true`, `nodeId: null`, the run's `rootSessionId`,
  implementer `callerSessionId` and the exact implementer `callerDispatchId`.
- Analyst prompt contains the injected delivery instruction and unique
  `[RUNNER_TASK_CALL:...]`. Its original user message is recorded as
  `userMessageId` with `userAnchorSource: "chat.message"`.
- The analyst's actual `read` tool reads the PNG, and the returned observations
  correctly describe the two shapes/colors/positions and text. A filename-only
  guess, unsupported attachment or absent read is **not a pass**.
- Native task response reaches the implementer, which writes `result.md` and
  successfully uses `graph_submit_change`. The analyst never writes findings
  or a closeout. No analyze-node attempt is consumed.
- Foreground task completion or an anchored terminal assistant response plus
  idle corroboration retires the nested lifetime. For background work preserve
  assistant `parentID`, terminal finish/time and settled tool parts. Empty
  status, metadata acknowledgment or an idle event alone must not retire it.
- Verify the final reservation list is empty and normal verifier delivery
  succeeds. Retain exports and pre/post run snapshots as host evidence.

## Boundary probes in separate runs

- Set top-level `subagent_depth: 1`, restart, and request the nested consultation:
  expect `SUBAGENT_DEPTH_LIMIT` with no new reservation/admission-history entry.
  With `0`, root dispatch must also leave no reservation. Restore 2 or omit the
  setting and restart for the successful probe. A later arbitrary host error
  must not silently delete an already-admitted lifetime.
- While an explorer occupies the single reader slot, have it request one image
  consultation. It must succeed. A second outstanding nested request anywhere
  in the run must fail with capacity guidance; do not repeatedly retry it.
- Keep a ready analyze node in the graph while a specialist consults: the node's
  state/attempt must stay unchanged.
- Attempt reuse of the analyst task_id from a different caller or a new owning
  attempt. It must reject without changing reservations. The original caller
  may continue it after settlement while its own generation is still active.
- After completing a run, start a successor under the same root and attempt
  root reuse of the old nested analyst task_id. It must reject before reservation,
  including after restart/history eviction. A legitimate same-run free root
  continuation with verified native parentage and admitted call metadata still
  works when its in-memory binding is gone.
- Pause or revoke the parent while the nested host call remains outstanding;
  restart the plugin. Inspect retained caller provenance and capacity. Confirm
  late trustworthy native completion settles it without granting execution or
  permitting nested findings closeout. Never edit run JSON to fake completion.
- Trigger selective verification FAIL for an implementer with an outstanding
  nested consultation, then let only the parent host finish. Replacement of that
  implement node must remain `REPAIR_SETTLEMENT_PENDING` until the analyst's own
  lifetime settles, including across restart. An unrelated sibling remains
  outside that selective repair fence.

Record each probe as PASS, FAIL, or UNVERIFIED with actual evidence. Stop on
unsupported nested task, missing credentials or missing pinned host; those are
unverified integration requirements, not successful mocked host tests.
