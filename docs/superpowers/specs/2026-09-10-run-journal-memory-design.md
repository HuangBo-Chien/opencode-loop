# Run Journal Memory Design

## Goal

Add persistent cross-run memory to `opencode-loop` without weakening the runner's authority. Terminal run state is projected into an append-only, searchable project journal. Reusable insights can be explicitly promoted to a global journal.

## Boundaries

- Run state remains the only authority for dispatch, attempts, write scope, artifacts, recovery and verdict gates.
- Journal entries are historical evidence and never satisfy a current run gate.
- Insights are explicitly non-authoritative interpretations linked to terminal run summaries.
- Generic persona, human and project memory blocks are out of scope. `opencode-agent-memory` may coexist for that use case.

## Components

### Run Request Capture

The root `chat.message` hook captures the first user text parts for a graph run. The text is redacted, capped at 8,000 characters and stored in run state with truncation and redaction metadata. A durable capture-completed flag ensures an attachment-only or blank first message cannot cause a later message to be mistaken for the initial request. Run-state schema v2 migrates v1 documents by setting `request` to `null` and the capture flag conservatively.

### Journal Store

Project entries live under `<worktree>/<stateDirectory>/journal/entries/`. Global entries live under `~/.config/opencode/opencode-loop/journal/entries/`. Embedding sidecars live in an `index/` sibling directory.

Files are Markdown with JSON-compatible YAML frontmatter. Entry IDs are stable hashes, filenames never contain model-supplied paths, and writes use temporary files plus atomic rename.

Entry kinds:

- `run-summary`: deterministic projection of a terminal project run.
- `insight`: orchestrator-authored project lesson linked to at least one run summary.
- `promoted-insight`: explicitly approved, project-neutral copy of an insight in global scope.

Only insights may be promoted. Run summaries, raw requests, project paths, run IDs and file lists never enter the global journal.

### Projector

After run state is successfully persisted, the projector writes a summary only for `SUCCEEDED` and `FAILED`. The entry ID is derived from project identity and run ID, making repeated and concurrent projection idempotent. Projection failures do not change run state and are retried by bounded backfill before journal searches.

A run summary contains:

- original user request, capped at 8,000 characters;
- intent, terminal status and timestamps;
- node states and attempts;
- versioned artifact references;
- changed files and unresolved items;
- verification commands and exit codes;
- failure reasons and recorded violations.

It excludes source code, diffs, transcripts, environment values and full tool output.

### Embedding Index

`Xenova/all-MiniLM-L6-v2` with q8 inference is lazy-loaded through `@huggingface/transformers`. Markdown remains authoritative; each sidecar records model ID, source digest, vector dimensions and vector data. Missing or stale sidecars are rebuilt lazily.

Model download or inference failure degrades search to metadata and lexical matching. It never blocks plugin startup, journal writes or the runner workflow. Tests inject a fake embedding provider and never download a model.

### Tools And Permissions

- `graph_journal_search`: orchestrator, explorer, planner and critic; searches project, global or both.
- `graph_journal_read`: orchestrator, explorer, planner and critic; reads one entry by scope and ID.
- `graph_journal_write_insight`: orchestrator only; writes a project insight linked to the current terminal run summary.
- `graph_journal_promote`: orchestrator only with native `ask`; writes a separately supplied, validated project-neutral global version.

Implementer, verifier and multimodal roles do not receive journal tools. Verifier PASS still requires current command evidence. Explorer must re-check historical claims against current source before submitting findings.

### Search

Search first filters by scope, kind, status, tags and files. Text queries use semantic similarity with exact-text and project-scope boosts. Results return compact metadata, score, snippet and the actual mode (`semantic`, `hybrid` or `text-fallback`). Full content requires `graph_journal_read`.

## Configuration

Journal features are enabled by default as requested:

```json
{
  "journal": {
    "enabled": true,
    "includeUserRequest": true,
    "semanticSearch": true,
    "maxUserRequestChars": 8000
  }
}
```

Nested options are strictly validated and frozen. The embedding model is fixed in the first release. Global writes always require explicit promotion even when journaling is enabled.

## Security And Failure Policy

- Common API key, bearer token, JWT, password and secret assignment patterns are redacted from stored requests, commands and insights. Redaction is best-effort and documented as such.
- Journal data is local plaintext. Status reports whether raw requests are retained and where project/global data is stored without exposing those paths to unrelated callers.
- Entry IDs and paths are generated internally; tools cannot read or write arbitrary filesystem paths.
- Corrupt entries are skipped and counted as degraded rather than crashing search.
- Embedding failures fall back to lexical search and are visible through journal status.
- A journal failure cannot change a run verdict or block dispatch/recovery.

## Validation

Tests cover strict configuration, v1-to-v2 migration, request capture/redaction/truncation, terminal-only projection, idempotent atomic writes, project/global isolation, promotion restrictions, semantic ranking with injected embeddings, lexical fallback, hook integration, role permissions, prompt trust rules, status reporting and packed relocation. A separate manual acceptance exercises the real local model on Node 22/Windows.
