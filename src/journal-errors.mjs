// Public diagnostics use a fixed vocabulary, never raw provider/filesystem errors.
export const JOURNAL_STAGE_ERRORS = Object.freeze({
  JOURNAL_SCAN_FAILED: 'Journal entry scan failed',
  JOURNAL_BACKFILL_FAILED: 'Journal run backfill scan failed',
  EMBEDDING_INITIALIZATION_FAILED: 'Embedding initialization failed',
  EMBEDDING_INFERENCE_FAILED: 'Embedding inference failed',
  JOURNAL_INDEX_READ_FAILED: 'Journal embedding index read failed',
  JOURNAL_INDEX_WRITE_FAILED: 'Journal embedding index write failed',
  JOURNAL_SEMANTIC_FAILED: 'Semantic search unavailable; using text fallback',
});

export function journalStageError(code) {
  return Object.assign(new Error(JOURNAL_STAGE_ERRORS[code] ?? 'Journal operation failed'), { code });
}

export function safeJournalStage(code) {
  return typeof code === 'string' && Object.hasOwn(JOURNAL_STAGE_ERRORS, code) ? code : null;
}
