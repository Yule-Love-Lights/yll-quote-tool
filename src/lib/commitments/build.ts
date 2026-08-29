// Turns the extractor's raw per-commitment output into rows ready for
// persistCommitments -- assigns each commitment's DEDUPE KEY ordinal and
// resolves its promised_at instant. Kept separate from extract.ts so this
// logic is testable without mocking Claude (calls_merge_plan_2026-08.md
// slice S6). Faithful port of the yll-call-copilot repo's
// src/lib/commitments/build.ts (master fb1bf326) -- no adaptation needed,
// this is pure logic with no table/schema dependency.

import { resolvePromisedAt } from './time';
import type { CommitmentRow, RawCommitment } from './types';

// extraction_index is the position of a commitment within its own kind
// group, in the order the model returned them -- see
// migrations/2026-08-29-call-commitments.sql's DEDUPE KEY note for why
// this (not the freeform `detail` text) is the third column of the unique
// key: it stays stable across a re-extraction of the same transcript even
// though Claude is not byte-deterministic about wording. A re-extraction
// that happens to reorder same-kind commitments updates existing rows'
// detail text in place rather than creating a duplicate or a third row.
// That reorder is only safe while every existing row for the transcript is
// still 'open' -- persistCommitments refuses the whole write outright once
// any row has moved off 'open', because relabeling a RESOLVED row this way
// would mislabel a real employee's accountability record (see the #217
// review finding documented in persist.ts).
export function buildCommitmentRows(raw: RawCommitment[], calledAt: string | null): CommitmentRow[] {
  const seenPerKind = new Map<string, number>();
  return raw.map(r => {
    const extraction_index = seenPerKind.get(r.kind) ?? 0;
    seenPerKind.set(r.kind, extraction_index + 1);
    return {
      kind: r.kind,
      detail: r.detail,
      promised_at: resolvePromisedAt(calledAt, r.promised_time_local, r.promised_day_offset),
      extraction_index,
    };
  });
}
