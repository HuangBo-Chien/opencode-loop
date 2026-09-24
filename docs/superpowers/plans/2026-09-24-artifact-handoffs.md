# Version-pinned artifact handoffs implementation plan

> Execute inline in this session, with regression tests before implementation. User approved approach A. No commits or deployment are part of this task.

**Goal:** Deliver authoritative upstream artifacts without orchestrator transcription, preserve verbatim node contracts, and make each dispatch's evidence inspectable.

**Architecture:** Capture a content-addressed, immutable handoff during dispatch reservation under the existing run lock. Store payload JSON strings once per digest in the run JSON; reservations and retained settled dispatches reference them. Inject a bounded artifact manifest with small complete payloads; expose paginated exact-snapshot reads for larger payloads. Keep workspace evidence files as references, not copied file contents. Handoffs are context, never new approval authority.

**Tech stack:** Node.js ESM, existing run store and dispatch ownership, OpenCode plugin tools, node:test.

## Contract

- Planner gets the current complete findings payload (summary, all evidence, learnings); existing bounded historical learnings remain supplementary.
- Critic gets the complete submitted plan. Implementer/verifier get the complete plan and their consumed input/dependency artifacts, including change payloads for verification.
- Capture exact refs, digest, byte count, delivery mode, node contract and consumed refs at admission. Fresh attempts receive fresh snapshots; continuing a running attempt preserves its consumed versions.
- Compare consumed refs before binding; refuse a changed dependency rather than silently consuming a different version from the dispatched evidence.
- `graph_artifact_read(handoffId, ref, offset, limit)` reads only the caller's retained handoff (root can inspect its run). Explicitly fail for unavailable versions, missing snapshots, wrong ownership or bad pagination. Return JSON text pages, digest and nextOffset; never silently truncate or substitute latest.
- Persist snapshots with reservations atomically. Prune only payloads no longer referenced by active or retained settled dispatches. Existing run/settlement caps remain enforced; capacity failure rejects admission rather than dropping evidence.
- Incoming dispatch text is supplementary. Demote reserved RUNNER labels in that text; preserve the actual text for audit and do not guess where legacy acceptance blocks end. Only the newly generated runner prefix is authoritative. Identical repeated hook invocation is idempotent within the plugin instance.
- Expose bounded handoff summaries in graph_inspect (handoffOffset/handoffLimit, handoffPage.nextOffset), including retained settled calls. Read full manifest entries through graph_artifact_read with ref omitted. Legacy runs without handoffs remain readable but do not fabricate snapshots.

## Task 1 — regression coverage

Files: `test/artifact-handoffs.test.mjs`, `test/plugin.test.mjs`.

- [x] Add real-store/runner/hook harness tests for full findings, full critic plan, implementer and verifier artifacts, exact acceptance, oversized pagination, snapshot version advance, unauthorized reads, reservation failure, dependency race, continuation and duplicate legacy RUNNER text.
- [x] Run `node --test test/artifact-handoffs.test.mjs` and confirm missing handoff behavior fails.

## Task 2 — snapshot and read path

Files: new `src/artifact-handoffs.mjs`; modify `src/dispatch-bindings.mjs`, `src/submit.mjs`, `src/agents.mjs`, `src/enforcement.mjs`.

- [x] Implement pure capture/render/page helpers, using stable JSON and SHA-256. Payloads are complete artifacts, keyed by content digest; manifest refs stay exact.
- [x] Capture during reservation persistence, publish in-memory only after save, prune unreferenced payloads, and check dependency pins before beginNode.
- [x] Add authenticated paginated tool and role permission. Root reads only its run; specialists read only their own authenticated handoff; nested consultations have none.
- [x] Add current and retained handoff metadata to inspection without changing readiness or approval gates.

## Task 3 — single authoritative dispatch context

Files: `src/enforcement.mjs`, `src/prompts.mjs`, `README.md`.

- [x] Render node contract from captured context and artifact manifest before supplementary dispatch notes. Inline only whole small payloads within a total budget; otherwise provide exact read instructions.
- [x] Demote incoming reserved labels and remove old task correlation markers before adding the fresh one. Preserve normal node hint parsing and user evidence text.
- [x] Cache identical completed hook formatting by call identity and argument fingerprint to prevent duplicate formatting on host re-entry.
- [x] Explain that orchestrator supplies goals/locations, not rewritten contracts; agents must read paginated formal artifacts through completion and report unavailable inputs.

## Task 4 — verification

- [x] Run targeted tests, including existing strict dispatch, artifact lineage and recovery tests.
- [x] Run `npm test` once targeted checks pass; investigate regressions and rerun affected checks after fixes.
- [x] Run `git diff --check`, review final diff and report actual checks, limits and restart requirement. Real-model LF2 acceptance requires a new dispatch after plugin restart, not a claim based on unit tests.

## Verification record

- Added 19 handoff regression scenarios, including disk reload, Unicode-safe lossless pages, exact input versions, snapshot ownership, persistence rollback, capacity refusal, reserved-label demotion and hook idempotence.
- Independent review reproduced a 52,453-byte inspection response after 128 settled planner calls. Added a failing regression, bounded/paginated inspection and manifest reads, then verified every receipt and artifact remains discoverable. Follow-up review approved the fix.
- Final `npm test`: 1,022 tests, 1,020 passed, 0 failed, 2 platform-specific skips on Windows; exit 0.
- `git diff --check`: exit 0.
- Deployment and real-model LF2 session acceptance are not part of these test results. The installed plugin must be updated and OpenCode restarted before a new dispatch uses this implementation.
