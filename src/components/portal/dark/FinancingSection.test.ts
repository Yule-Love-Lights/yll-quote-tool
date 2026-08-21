// Tests for financingSectionEligible, the pure gate FinancingSection uses to
// decide whether it renders at all. No render infra exists for client
// components in this repo (FinancingSection is 'use client' and reads
// useSelection()), so this covers the gate the same way StickyBottomBar's own
// pure seams are covered — as a plain function, mock-free.
//
// Ledger row 236, fix round (four-lens MED): before that row, a
// declined/abandoned quote's portal hard-blocked before this section could
// ever mount, so quoteStatus never needed to be in this gate. Once
// StickyBottomBar's terminalBrowse strip kept those two statuses' portals
// open, this section would otherwise show "Book like normal. Your deposit
// holds your install date..." on a quote where approve/pay/decline are all
// 409-closed server-side — these tests prove the new quoteStatus leg closes
// that gap the same way the pre-existing viewOnly leg already closes its own.

import { describe, it, expect } from 'vitest';
import { financingSectionEligible } from './FinancingSection';

// An otherwise fully-eligible holiday quote: real prequal URL, $2,000 total,
// $1,000 deposit → $1,000 balance (inside Wisetack's $500–$25,000 range),
// $2,000 total clears the $1,500 YLL floor.
function baseInput(overrides: Partial<Parameters<typeof financingSectionEligible>[0]> = {}) {
  return {
    viewOnly: false,
    quoteStatus: 'sent' as string | null | undefined,
    prequalUrl: 'https://wisetack.example.com/prequal/abc',
    serviceType: 'holiday' as const,
    totalUsd: 2000,
    depositUsd: 1000,
    ...overrides,
  };
}

describe('financingSectionEligible (row 236 fix round)', () => {
  it('is eligible on an otherwise-qualifying live (sent) quote', () => {
    expect(financingSectionEligible(baseInput())).toBe(true);
  });

  it('is INELIGIBLE on a declined quote, even though every other leg qualifies', () => {
    expect(financingSectionEligible(baseInput({ quoteStatus: 'declined' }))).toBe(false);
  });

  it('is INELIGIBLE on an abandoned quote, even though every other leg qualifies', () => {
    expect(financingSectionEligible(baseInput({ quoteStatus: 'abandoned' }))).toBe(false);
  });

  it('stays eligible on cancelled/changes_requested (unaffected — those two never reach this component; page.tsx still hard-blocks them)', () => {
    // financingSectionEligible itself only excludes declined/abandoned
    // (isTerminalBrowseStatus's exact set) — proving this doesn't widen the
    // gate to the other two non-actionable statuses by accident.
    expect(financingSectionEligible(baseInput({ quoteStatus: 'cancelled' }))).toBe(true);
    expect(financingSectionEligible(baseInput({ quoteStatus: 'changes_requested' }))).toBe(true);
  });

  it('is false when viewOnly, independent of quoteStatus (the pre-existing #176 gate still holds)', () => {
    expect(financingSectionEligible(baseInput({ viewOnly: true, quoteStatus: 'sent' }))).toBe(false);
    expect(financingSectionEligible(baseInput({ viewOnly: true, quoteStatus: 'declined' }))).toBe(false);
  });

  it('is false with no prequalUrl (feature off), independent of quoteStatus', () => {
    expect(financingSectionEligible(baseInput({ prequalUrl: undefined }))).toBe(false);
  });

  it('is false for an ineligible service type (event), independent of quoteStatus', () => {
    expect(financingSectionEligible(baseInput({ serviceType: 'event' }))).toBe(false);
  });

  it('null/undefined quoteStatus is treated as actionable (fail-open, matches isTerminalBrowseStatus)', () => {
    expect(financingSectionEligible(baseInput({ quoteStatus: null }))).toBe(true);
    expect(financingSectionEligible(baseInput({ quoteStatus: undefined }))).toBe(true);
  });
});
