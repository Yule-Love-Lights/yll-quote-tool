// Coverage for buildCommitmentRows -- the DEDUPE KEY's extraction_index
// assignment and that promised_at resolution runs off calledAt, not the
// extractor's own clock. Ported from the yll-call-copilot repo's
// src/lib/commitments/build.test.ts (master fb1bf326) -- unchanged logic.

import { describe, it, expect } from 'vitest';
import { buildCommitmentRows } from './build';
import type { RawCommitment } from './types';

const noTime = { promised_time_local: null, promised_day_offset: null };

describe('buildCommitmentRows', () => {
  it('assigns extraction_index 0 for a single commitment', () => {
    const raw: RawCommitment[] = [{ kind: 'send_quote', detail: 'send the roofline quote', ...noTime }];
    const rows = buildCommitmentRows(raw, null);
    expect(rows).toEqual([{ kind: 'send_quote', detail: 'send the roofline quote', promised_at: null, extraction_index: 0 }]);
  });

  it('gives two distinct same-kind commitments separate rows (index 0 and 1), never collapsed into one', () => {
    const raw: RawCommitment[] = [
      { kind: 'send_photos', detail: 'send photos of the front roofline', ...noTime },
      { kind: 'send_photos', detail: 'send photos of the shed too', ...noTime },
    ];
    const rows = buildCommitmentRows(raw, null);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'send_photos', extraction_index: 0, detail: 'send photos of the front roofline' });
    expect(rows[1]).toMatchObject({ kind: 'send_photos', extraction_index: 1, detail: 'send photos of the shed too' });
  });

  it('indexes each kind independently -- a send_quote and a callback each start at 0', () => {
    const raw: RawCommitment[] = [
      { kind: 'send_quote', detail: 'send quote', ...noTime },
      { kind: 'callback', detail: 'call back tomorrow', ...noTime },
    ];
    const rows = buildCommitmentRows(raw, null);

    expect(rows[0]).toMatchObject({ kind: 'send_quote', extraction_index: 0 });
    expect(rows[1]).toMatchObject({ kind: 'callback', extraction_index: 0 });
  });

  it('is stable across a reorder of the same commitments -- extraction_index tracks position WITHIN a kind, not overall array position', () => {
    const forward: RawCommitment[] = [
      { kind: 'send_photos', detail: 'roofline photos', ...noTime },
      { kind: 'send_photos', detail: 'shed photos', ...noTime },
    ];
    const reordered: RawCommitment[] = [forward[1]!, forward[0]!];

    const forwardRows = buildCommitmentRows(forward, null);
    const reorderedRows = buildCommitmentRows(reordered, null);

    // Same two (kind, extraction_index) pairs exist in both runs -- the
    // DEDUPE KEY set is stable even though which detail sits at which index
    // flips (this is exactly the reorder hazard persist.ts's finalize
    // function refuses to allow once a row has resolved -- see that file's
    // header).
    const keyOf = (r: { kind: string; extraction_index: number }) => `${r.kind}:${r.extraction_index}`;
    expect(new Set(forwardRows.map(keyOf))).toEqual(new Set(reorderedRows.map(keyOf)));
    expect(reorderedRows[0]).toMatchObject({ detail: 'shed photos', extraction_index: 0 });
    expect(reorderedRows[1]).toMatchObject({ detail: 'roofline photos', extraction_index: 1 });
  });

  it('returns an empty array for a transcript with no commitments (no error)', () => {
    expect(buildCommitmentRows([], '2026-01-15T18:30:00Z')).toEqual([]);
  });

  it('resolves promised_at off the CALL date passed in, not the current clock', () => {
    const raw: RawCommitment[] = [{ kind: 'callback', detail: 'call back at 3', promised_time_local: '15:00', promised_day_offset: 0 }];
    // A call date far from "now" -- if this were resolved off Date.now()
    // instead of calledAt, the assertion below would fail.
    const rows = buildCommitmentRows(raw, '2026-01-15T18:30:00Z');
    expect(rows[0]!.promised_at).toBe('2026-01-15T20:00:00.000Z');
  });
});
