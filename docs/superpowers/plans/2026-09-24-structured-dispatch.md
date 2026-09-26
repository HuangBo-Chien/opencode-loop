# Structured task targets and direct rejection implementation plan

**Goal:** Remove prompt-layout failures from graph dispatch and reject invalid calls before native task execution or child creation.

**Architecture:** Extend the native task's model-facing JSON Schema with optional `nodeId`, leaving its runtime decoder intact. Graph admission consumes the field under existing binding/ownership gates, records the target source, and removes the extension before native execution. Retain unambiguous leading legacy markers and infer only authenticated same-node continuations. Reject through a bounded actionable tool error instead of dispatching a rejection-only child.

**Baseline:** Current feature branch includes the preceding uncommitted artifact-handoff work. Its 1,022 tests passed before this change. Preserve those edits. No commit, deployment, or LF2 workload is requested.

## Host compatibility

- SDK is 1.18.25; installed host reports 1.18.31. Native `session/tools.ts` invokes `tool.execute.before` before the runtime decoder and task execution.
- Native tool registry passes `description`, Effect `parameters`, and optional `jsonSchema` to `tool.definition`. Foreground task has explicit JSON Schema; background-capable task can require projection from Effect Schema.
- Preserve the existing JSON Schema when available. Otherwise project the actual Effect schema using an explicitly declared, pinned `effect` dependency matching the installed SDK (4.0.0-beta.83); do not hand-author a replacement native task schema or assume parameters are Zod.
- Preserve required native fields and background visibility; do not require nodeId globally. Capability failures leave original definitions unchanged and are reported as unsupported, not silently claimed as supported.

## Tasks

- [x] Add failing schema/host-shaped execution tests for optional nodeId, original schema preservation, background projection, idempotence, collision/unsupported fallback, native decoding and hook rejection before execution.
- [x] Implement `src/task-definition.mjs`, register the hook in `src/index.mjs`, declare the Effect dependency, update package closure tests and expose schema capability status.
- [x] Add tests for structural target authority, first-line inline legacy markers, contradictory/ambiguous markers, body quotations and active/incomplete/restarted continuation ownership.
- [x] Update `src/dispatch-target.mjs` and `src/dispatch-bindings.mjs`. A structured target may ignore malformed prose but must reject recognizable contradictory leading markers. Legacy-only targeting accepts exactly one leading marker, including same-line task text. No scanning arbitrary later prose. Restore a missing continuation target only from authenticated current-run ownership and never retarget a session to another node.
- [x] Add failing direct-rejection tests. Preserve incoming args on rejection; record bounded code/target source/nextAction diagnostics, with candidate IDs supplied by the actual admission decision where available. Storage failure still prevents native execution.
- [x] Update `src/enforcement.mjs` to throw `RUNNER_REJECTED(code)` for root and nested calls, remove rejection-child rewriting, and strip nodeId only after successful admission. Existing attempt, pause, capacity, repair and handoff gates remain enforced.
- [x] Update tests expecting rejection prompts to assert tool errors without weakening their state/ownership assertions. Update prompts, status, README and a reproducible host probe.
- [x] Run targeted suites, full suite, package smoke, independent review and diff checks. Exercise an isolated native host probe when possible; distinguish real host evidence from SDK-shaped tests and report any unverified host mode/version.

## Acceptance

- Valid nodeId routes an implementer/verifier without a prompt marker, through native schema exposure and decoding.
- Clearly conflicting targets reject without a reservation, attempt charge or child launch; unrelated prose examples never steer dispatch.
- A single valid first-line legacy marker followed by same-line prose is accepted; multiple leading markers, invalid IDs and ambiguous missing targets fail explicitly.
- Authenticated continuations preserve node identity and all version/repair/host-lifetime fences, including across restart. Unknown, foreign or nested sessions cannot use inference to gain authority.
- Format/capacity/dependency rejections reach the orchestrator directly with correction/wait/inspect/replan guidance; no error-only child session is created.
- Native non-graph use and nested image consults retain their existing behavior. Foreground/background fields and native permissions are preserved.
- The preceding artifact handoff still carries the admitted exact contract and inputs; retries do not append duplicate runner context.

## Verification record

- `npm test`: 1,038 tests; 1,036 pass, 0 fail, 2 existing platform skips. Includes isolated packed-package imports and actual Effect schema projection outside the workspace.
- `node --test test/native-dispatch.probe.mjs` with OPENCODE_NATIVE_BINARY set: 2 pass on OpenCode 1.18.31. Real host, isolated project/config/data and deterministic local provider; both foreground/background-enabled schema modes, task executions foreground. Host SQLite independently confirms exactly 3 children, 6 task calls, 2 direct errors, and a same-session inferred continuation. Native 1.18.25 binary and actual asynchronous background execution were not exercised.
- Independent review identified same-line prose examples being scanned as extra targets. Added a failing regression, restricted parsing to adjacent leading markers, and passed follow-up review.
- `git diff --check`: pass. Work remains uncommitted on the existing feature branch; no LF2 deployment or workload was run.
