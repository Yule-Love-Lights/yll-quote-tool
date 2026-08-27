// Fix round 3 (Finding MED, PR #926): the Kanban work-order modal's "Prepare"
// button — the PRIMARY staff surface for prepareJobMaterials — was silently
// discarding PrepareResult's `short` field (the SKUs the on-hand floor
// clamped), while the WhatsApp bot's reply for the same action already named
// them. This repo has no jsdom/testing-library setup, so component tests here
// cover a fetch-response shape via a pure extraction function (same pattern
// as ColorRequestPanel.test.tsx's applyOutcomeFromResponse) rather than
// rendering the modal.

import { describe, expect, it } from 'vitest';
import { shortSkusFromPrepareResponse, shouldShowStuckStockBadge } from './page';

describe('shortSkusFromPrepareResponse', () => {
  it('passes through the short SKU list from a real PrepareResult body', () => {
    expect(
      shortSkusFromPrepareResponse({
        ok: true,
        alreadyDone: false,
        deductions: [{ sku: 'SKU-A', before: 1, deducted: 1, after: 0 }],
        short: ['SKU-A'],
      }),
    ).toEqual(['SKU-A']);
  });

  it('is empty for a full prep (nothing short)', () => {
    expect(
      shortSkusFromPrepareResponse({ ok: true, alreadyDone: false, deductions: [], short: [] }),
    ).toEqual([]);
  });

  it('degrades to empty (never throws) for a missing/malformed body', () => {
    expect(shortSkusFromPrepareResponse(null)).toEqual([]);
    expect(shortSkusFromPrepareResponse(undefined)).toEqual([]);
    expect(shortSkusFromPrepareResponse({})).toEqual([]);
    expect(shortSkusFromPrepareResponse({ short: 'not-an-array' })).toEqual([]);
    // Drops non-string entries rather than passing them through raw.
    expect(shortSkusFromPrepareResponse({ short: ['SKU-A', 42, null] })).toEqual(['SKU-A']);
  });
});

// Staff-lens fix (row 382/MED): stockSnapshotPending was on FulfillmentCard
// but the board (the surface staff actually watch) never rendered it — only
// the daily digest did. JobCard's badge condition reads this pure function
// (see page.tsx), the same jsdom-free pattern as shortSkusFromPrepareResponse
// above, so the JSX wiring is provable without rendering the component.
describe('shouldShowStuckStockBadge', () => {
  it('is false for a card without the flag', () => {
    expect(shouldShowStuckStockBadge({ stockSnapshotPending: false })).toBe(false);
  });

  it('is true for a card with the flag set', () => {
    expect(shouldShowStuckStockBadge({ stockSnapshotPending: true })).toBe(true);
  });
});
