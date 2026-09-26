# Structured dispatch native host probe

## Recorded verification

On 2026-09-24, the opt-in probe passed on the installed **OpenCode 1.18.31**
native Windows executable, using a deterministic local OpenAI-compatible provider
fixture (not a real LLM). Both ordinary and background-enabled task **schema**
modes passed. Task calls themselves remained foreground (`background: false` in
the background-enabled case); asynchronous background lifecycle acceptance is not
claimed by this probe. Native 1.18.25 source was checked, but its executable was
not run. The plugin SDK and Effect projection dependency remain pinned.

The probe uses a disposable project and isolated HOME/XDG config/data/cache/state,
loads this checkout's plugin, disables default plugins and external skills, and
uses only the local fixture provider. It does not use provider credentials or run
LF2, edit source files in the probe project, or claim product behavior verified.
The verifier deliberately submits UNVERIFIED; the resulting pause is expected.

## Run

Use Node with `node:sqlite` support (Node 22.13+; recorded run: Node 25.9.0).
Set the **native executable** path, not the PowerShell/.cmd launcher:

```powershell
$env:OPENCODE_NATIVE_BINARY = 'C:\path\to\opencode.exe'
node --test test/native-dispatch.probe.mjs
```

The ordinary `npm test` suite does not launch this probe. It runs SDK-shaped
tests for schema exposure, native Effect decoding, graph gates and recovery.
The opt-in probe is a separate host integration check, and skips when no executable
is supplied. Scratch directories are removed when it finishes.

## Actual path exercised

1. Orchestrator calls task with `nodeId: absent`: direct NODE_NOT_FOUND error.
2. A real planner child submits a light plan with implement and verify nodes.
3. Orchestrator supplies conflicting structural/leading targets: direct
   CONFLICTING_NODE_ID error.
4. `nodeId: impl` with no prompt marker creates the implementation child. Its
   first turn ends without submission, leaving INCOMPLETE.
5. `task_id` alone resumes that exact child and node. The second attempt submits
   a no-op change with `filesTouched: []`.
6. `nodeId: verify` with no marker creates a verifier child, which submits
   UNVERIFIED to distinguish transport coverage from behavioral verification.
7. Orchestrator inspects the run and finishes its report.

## Assertions

- Actual provider requests expose optional nodeId, preserving task's required
  fields and background field visibility in each mode.
- Run receipts show four admitted calls and `targetSource: task-id` for the
  continuation, `argument` for explicitly targeted calls.
- Implementation has two attempts, verification one; rejected calls add none.
- The isolated **host database**, independently of runner receipts, contains
  exactly three direct children (planner, implementation, verification), six
  root task parts and two native tool errors. No rejection-only child exists.
- Rejected native input still contains the original `nodeId` and prompt.
- Native tool errors reach the root provider request, rather than being relayed
  through an error-only child response.
- Run status ends AWAITING_USER_DECISION from the deliberate UNVERIFIED verdict.

Source references checked for the hook/decoder ordering:

- `anomalyco/opencode` v1.18.25 `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/tool.ts`, `task.ts`, `json-schema.ts`
- `packages/opencode/src/session/tools.ts`
- The v1.18.25..v1.18.31 diff in these paths only changed preservation of the
  existing native tool start time in `session/tools.ts`.

This test establishes native argument transport, rejection-before-child behavior
and session reuse on the recorded host. It does not establish real-model routing
accuracy, reduce-retry statistics in LF2, or globally attest every enforcement
boundary; `graph_status.enforcementAttested` remains false.
