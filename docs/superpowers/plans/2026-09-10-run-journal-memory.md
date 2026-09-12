# Run Journal Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-enabled, local semantic run journaling with project summaries, optional insights and explicitly promoted global lessons while preserving runner-state authority.

**Architecture:** A journal service decorates successful run-store persistence and projects terminal states into deterministic Markdown entries. A lazy embedding provider indexes those entries, and graph-specific tools expose bounded search/read/write/promote operations without participating in runner gates.

**Tech Stack:** Node.js 22 ESM, OpenCode plugin SDK 1.18.25, `@huggingface/transformers` 3.8.1, `node:test`.

---

### Task 1: Strict Journal Configuration And Request State

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/run-state.mjs`
- Modify: `src/runner.mjs`
- Test: `test/plugin.test.mjs`
- Test: `test/runner-and-state.test.mjs`

- [ ] **Step 1: Write failing tests for journal defaults and validation**

Assert the parsed/status-visible defaults are `{ enabled: true, includeUserRequest: true, semanticSearch: true, maxUserRequestChars: 8000 }`; reject unknown journal keys, non-boolean flags and limits outside `1..32000`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/plugin.test.mjs`
Expected: FAIL because `journal` is unknown.

- [ ] **Step 3: Implement strict nested option parsing**

Add a frozen `journal` object to `parseOptions`, preserving getter/proxy protections used by top-level options.

- [ ] **Step 4: Write failing migration and request-capture tests**

Cover loading schema v1 as v2 with `request: null`; new runs contain `request: null`; `runner.captureRequest` stores `{ text, truncated, redactions, capturedAt }` once and later calls do not overwrite it.

- [ ] **Step 5: Implement schema v2 and runner capture transition**

Add `runner.captureRequest(state, request)` and migrate v1 documents before validation.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/plugin.test.mjs test/runner-and-state.test.mjs`
Expected: PASS.

### Task 2: Journal Text Safety And Append-Only Store

**Files:**
- Create: `src/journal-text.mjs`
- Create: `src/journal-store.mjs`
- Modify: `src/enforcement.mjs`
- Modify: `src/index.mjs`
- Create: `test/journal-store.test.mjs`
- Test: `test/enforcement.test.mjs`

- [ ] **Step 1: Write failing redaction and extraction tests**

Cover text-part joining, whitespace normalization, 8,000-character truncation, truncation metadata and redaction of bearer tokens, JWTs, common token prefixes and secret/password assignments.

- [ ] **Step 2: Implement bounded journal text sanitation**

Expose `captureRequest(parts, options)` and `sanitizeJournalText(text, limit)` returning text, truncation and redaction count. Preserve readable newlines and never inspect attachment bytes.

- [ ] **Step 3: Wire first-message capture**

Update `onChatMessage(input, output)` to sanitize only the first graph-orchestrator user message and call `runner.captureRequest`; later messages and subagent messages cannot overwrite it.

- [ ] **Step 4: Write failing store tests**

Cover generated safe IDs, Markdown plus JSON frontmatter round trips, atomic idempotent writes, project/global namespace isolation, corruption skipping and path traversal rejection.

- [ ] **Step 5: Implement journal storage**

Expose `createJournalStore({ worktree, stateDirectory, globalDirectory })` with `write`, `read`, `list`, `exists` and `status`. Use stable content hashes, temp-file rename and mode `0o600` where supported.

- [ ] **Step 6: Run focused tests**

Run: `node --test test/journal-store.test.mjs test/enforcement.test.mjs`
Expected: PASS.

### Task 3: Lazy Embeddings And Hybrid Search

**Files:**
- Create: `src/embeddings.mjs`
- Create: `src/journal-search.mjs`
- Modify: `src/journal-store.mjs`
- Create: `test/journal-search.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing embedding/search tests**

Inject a deterministic fake provider and assert semantic ordering, lexical boost, metadata filters, project-scope preference, stale digest rebuild and `text-fallback` when embedding throws.

- [ ] **Step 2: Implement embedding provider**

Lazy dynamic-import `@huggingface/transformers`, create one cached q8 feature-extraction pipeline for `Xenova/all-MiniLM-L6-v2`, mean-pool and normalize output, and expose cosine similarity.

- [ ] **Step 3: Implement digest-bound sidecars and hybrid search**

Write `{ schemaVersion, model, digest, dimensions, vector }` sidecars atomically. Filter entries before embedding, combine cosine similarity with exact-text and project-scope boosts, and return compact hits plus actual search mode.

- [ ] **Step 4: Pin the dependency and run focused tests**

Add exact dependency `"@huggingface/transformers": "3.8.1"`.

Run: `node --test test/journal-search.test.mjs test/package.test.mjs`
Expected: PASS without downloading a model.

### Task 4: Terminal Projection, Backfill And Run-Store Decoration

**Files:**
- Create: `src/journal.mjs`
- Modify: `src/run-state.mjs`
- Modify: `src/index.mjs`
- Test: `test/journal.test.mjs`
- Test: `test/enforcement.test.mjs`

- [ ] **Step 1: Write failing projection tests**

Assert only `SUCCEEDED` and `FAILED` project runs project; summaries include request, nodes, artifacts, files, commands, failure/violations and unresolved items; repeated projection yields one entry; global contains none.

- [ ] **Step 2: Implement deterministic projector**

Create a `run-summary` entry with ID derived from project identity and run ID. Render bounded Markdown sections and sanitized evidence. Projection catches and records its own errors.

- [ ] **Step 3: Add run listing and bounded backfill**

Extend `createRunStore` with `listRunIds()`. Before search, scan a bounded set of terminal run documents and project missing summaries through the same idempotent path.

- [ ] **Step 4: Decorate successful persistence**

Wrap `saveRun` so projection happens only after authoritative persistence succeeds. Pass the decorated store to enforcement and submit tools; backfill uses the undecorated base store to avoid recursion.

- [ ] **Step 5: Run focused tests**

Run: `node --test test/journal.test.mjs test/runner-and-state.test.mjs test/enforcement.test.mjs`
Expected: PASS.

### Task 5: Journal Tools, Role Permissions And Trust Prompts

**Files:**
- Create: `src/journal-tools.mjs`
- Modify: `src/agents.mjs`
- Modify: `src/prompts.mjs`
- Modify: `src/index.mjs`
- Test: `test/journal-tools.test.mjs`
- Test: `test/workflow.test.mjs`

- [ ] **Step 1: Write failing tool and permission tests**

Search/read accept only orchestrator, explorer, planner and critic. Insight creation requires the root orchestrator and a terminal current run. Promotion accepts only project insights, requires separately supplied global-safe content and is configured as native `ask`.

- [ ] **Step 2: Implement bounded tools**

Register `graph_journal_search`, `graph_journal_read`, `graph_journal_write_insight` and `graph_journal_promote`. Validate role/session binding, limits, tags, entry kind and known project metadata leakage before writing.

- [ ] **Step 3: Update native permissions and prompts**

Allow search/read only to the approved read roles, insight write only to orchestrator and promotion as ask. Instruct explorer to revalidate memories, planner/critic to cite IDs, and verifier to ignore memory as PASS evidence.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/journal-tools.test.mjs test/workflow.test.mjs test/plugin.test.mjs`
Expected: PASS.

### Task 6: Status, Documentation, Packaging And Release Validation

**Files:**
- Modify: `src/status.mjs`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `test/plugin.test.mjs`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Write failing dynamic status tests**

Assert journal status reports enabled flags, fixed model, current mode, pending backfill count and last error without leaking user request text or absolute project paths.

- [ ] **Step 2: Wire dynamic status**

Pass the journal service to `createStatusTool`; report safe capability/degradation fields while preserving runner status output.

- [ ] **Step 3: Document operation and privacy**

Document storage, defaults, tools, role access, semantic fallback, first-use model download, best-effort redaction, plaintext retention, global promotion and the state/journal trust boundary.

- [ ] **Step 4: Bump the alpha version**

Change package version and matching assertions/install examples to `0.3.0-alpha.1`.

- [ ] **Step 5: Run the complete suite**

Run: `npm test`
Expected: all tests pass with no model download.

- [ ] **Step 6: Pack and inspect**

Run: `npm pack --ignore-scripts`
Expected: `opencode-loop-0.3.0-alpha.1.tgz`; package contains runtime source and README, and isolated import succeeds without loading the embedding model.

- [ ] **Step 7: Manual semantic acceptance**

Run one opt-in script that writes two temporary entries and searches with the real model on Node 22/Windows. Expected: model loads locally, semantic result ranks correctly, and no journal content leaves the machine. This check is reported separately from unit tests.
