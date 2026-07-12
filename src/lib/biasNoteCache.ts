// Shared 5-minute memoization for the corpus-wide bias note (#8 Stage C /
// #109 Phase 2 fold-in). Split into its own tiny module so BOTH
// trainingExamples.ts (training_examples writes: capture/update/correct/
// delete) and training.ts (training_houses ground-truth writes,
// saveTrainingHouse) can invalidate the SAME cache without a
// training.ts ⇄ trainingExamples.ts import cycle — trainingExamples.ts
// already needs to import training.ts for the ground-truth fold-in read.

export const BIAS_NOTE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let biasNoteCache: { note: string | null; expiresAt: number } | null = null;

// Returns the cached note when still fresh, or null (cache miss / stale).
// Distinguishes "no cache" from "cached null note" via a nullable wrapper.
export function readBiasNoteCache(now: number): { note: string | null } | null {
  if (biasNoteCache && biasNoteCache.expiresAt > now) return { note: biasNoteCache.note };
  return null;
}

export function writeBiasNoteCache(note: string | null, now: number): void {
  biasNoteCache = { note, expiresAt: now + BIAS_NOTE_TTL_MS };
}

// Drop the memoized note so the next getCorpusBiasNote() call recomputes from
// fresh rows. Called after every write that can change the bias corpus
// (training_examples capture/update/correct/delete, training_houses
// ground-truth save) so the note never lags a real corpus change by more
// than one write; the TTL above is just the belt-and-suspenders fallback.
// Also exported test-only (mirrors rateLimit.ts's __bucketSize) so each test
// can start from a clean cache instead of leaking state across test files.
export function invalidateBiasNoteCache(): void {
  biasNoteCache = null;
}
