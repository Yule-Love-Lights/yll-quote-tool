import { describe, it, expect } from 'vitest';
import {
  deriveStatus,
  canTransition,
  canRevive,
  isQuoteStatus,
  isPortalActionable,
  QUOTE_STATUSES,
  APPROVED_STAGE_DISPLAY_LABEL,
  type QuoteStatus,
  type QuoteStatusRow,
} from './quoteStatus';

function ts(overrides: Partial<QuoteStatusRow> = {}): QuoteStatusRow {
  return {
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    ...overrides,
  };
}

describe('deriveStatus — from timestamps', () => {
  it('is draft when no lifecycle timestamps are set', () => {
    expect(deriveStatus(ts())).toBe('draft');
  });

  it('is sent when sent but not viewed/approved/paid', () => {
    expect(deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z' }))).toBe('sent');
  });

  it('is viewed when the customer opened it (wins over sent)', () => {
    expect(
      deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z', viewed_at: '2026-06-02T01:00:00Z' })),
    ).toBe('viewed');
  });

  it('is approved when approved but the deposit is not yet paid', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-06-02T00:00:00Z',
          viewed_at: '2026-06-02T01:00:00Z',
          customer_approved_at: '2026-06-03T00:00:00Z',
        }),
      ),
    ).toBe('approved');
  });

  it('is booked once the deposit is paid (wins over approved + viewed + sent)', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-06-02T00:00:00Z',
          viewed_at: '2026-06-02T01:00:00Z',
          customer_approved_at: '2026-06-03T00:00:00Z',
          deposit_paid_at: '2026-06-04T00:00:00Z',
        }),
      ),
    ).toBe('booked');
  });

  it('is approved when approved without a send timestamp (offline close)', () => {
    expect(deriveStatus(ts({ customer_approved_at: '2026-06-03T00:00:00Z' }))).toBe('approved');
  });

  it('ignores viewed_at when it is absent (Workflow board DashboardQuote shape)', () => {
    // No viewed_at key at all — must still derive sent, not throw.
    expect(deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z' }))).toBe('sent');
  });
});

describe('deriveStatus — persisted status fallback', () => {
  it('honors a persisted declined even when sent/viewed timestamps exist', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-06-02T00:00:00Z',
          viewed_at: '2026-06-02T01:00:00Z',
          status: 'declined',
        }),
      ),
    ).toBe('declined');
  });

  it('honors a persisted changes_requested over the sent timestamp', () => {
    expect(
      deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z', status: 'changes_requested' })),
    ).toBe('changes_requested');
  });

  it('honors a persisted cancelled even on a booked row', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-06-02T00:00:00Z',
          customer_approved_at: '2026-06-03T00:00:00Z',
          deposit_paid_at: '2026-06-04T00:00:00Z',
          status: 'cancelled',
        }),
      ),
    ).toBe('cancelled');
  });

  it('honors a persisted abandoned', () => {
    expect(deriveStatus(ts({ status: 'abandoned' }))).toBe('abandoned');
  });

  it('does NOT trust a persisted forward status over timestamps (timestamps win)', () => {
    // A stale 'draft' status on a row whose deposit is paid must still read booked.
    expect(
      deriveStatus(ts({ deposit_paid_at: '2026-06-04T00:00:00Z', status: 'draft' }))
    ).toBe('booked');
    // A persisted 'booked' on a draft row is not trusted — no booking timestamp.
    expect(deriveStatus(ts({ status: 'booked' }))).toBe('draft');
  });
});

describe('canTransition — legal transitions', () => {
  const legal: ReadonlyArray<[QuoteStatus, QuoteStatus]> = [
    ['draft', 'sent'],
    ['draft', 'approved'],     // deliberate offline/in-person close (approvedWhileUnsent)
    ['draft', 'cancelled'],
    ['draft', 'abandoned'],
    ['draft', 'declined'],     // #124 — a draft the customer declined before it was ever sent
    ['sent', 'viewed'],
    ['sent', 'approved'],
    ['sent', 'changes_requested'],
    ['sent', 'declined'],
    ['viewed', 'approved'],
    ['viewed', 'declined'],
    ['viewed', 'changes_requested'],
    ['approved', 'booked'],
    ['approved', 'cancelled'],
    ['approved', 'declined'],  // #124 — customer approved then backed out BEFORE paying the deposit (approved ⇒ no deposit)
    ['booked', 'cancelled'],
    ['changes_requested', 'sent'],
    ['changes_requested', 'declined'],
  ];

  it.each(legal)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  const illegal: ReadonlyArray<[QuoteStatus, QuoteStatus]> = [
    ['draft', 'booked'],
    ['sent', 'booked'],          // must approve first
    ['booked', 'declined'],      // #124 — a PAID deal is never "declined" (only cancelled, refund manual); money-safety
    ['booked', 'approved'],      // no going backward
    ['declined', 'sent'],        // terminal
    ['cancelled', 'draft'],      // terminal
    ['abandoned', 'sent'],       // terminal
    ['draft', 'draft'],          // same-state is not a transition
  ];

  it.each(illegal)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe('isQuoteStatus / QUOTE_STATUSES', () => {
  it('accepts every known status', () => {
    for (const s of QUOTE_STATUSES) expect(isQuoteStatus(s)).toBe(true);
  });
  it('rejects unknown / non-string values', () => {
    expect(isQuoteStatus('won')).toBe(false);
    expect(isQuoteStatus('')).toBe(false);
    expect(isQuoteStatus(null)).toBe(false);
    expect(isQuoteStatus(42)).toBe(false);
  });
  it('covers all union members (no orphans)', () => {
    expect(QUOTE_STATUSES.length).toBe(9);
  });
});

describe('isPortalActionable — customer approve+pay UI gate (Bug 3)', () => {
  it('allows the live pre-booked/booked states', () => {
    for (const s of ['draft', 'sent', 'viewed', 'approved', 'booked'] as const) {
      expect(isPortalActionable(s)).toBe(true);
    }
  });

  it('blocks terminal states (declined/cancelled/abandoned)', () => {
    expect(isPortalActionable('declined')).toBe(false);
    expect(isPortalActionable('cancelled')).toBe(false);
    expect(isPortalActionable('abandoned')).toBe(false);
  });

  it('blocks changes_requested (being revised)', () => {
    expect(isPortalActionable('changes_requested')).toBe(false);
  });

  it('fails open for unknown / null / undefined (server is the real gate)', () => {
    expect(isPortalActionable(null)).toBe(true);
    expect(isPortalActionable(undefined)).toBe(true);
    expect(isPortalActionable('some-future-status')).toBe(true);
  });
});

describe('APPROVED_STAGE_DISPLAY_LABEL — row 242 (remove the Approved stage from display)', () => {
  it('is not the bare word "Approved" — no surface should badge it as a standalone stage', () => {
    expect(APPROVED_STAGE_DISPLAY_LABEL).not.toBe('Approved');
    expect(APPROVED_STAGE_DISPLAY_LABEL.toLowerCase()).not.toBe('approved');
  });

  it('names what a sent-but-unpaid approval is actually waiting on', () => {
    expect(APPROVED_STAGE_DISPLAY_LABEL).toBe('Awaiting Deposit');
  });

  it('a sent-then-approved-but-unpaid quote still derives the approved CODE, which every quote-lane surface then renders under this display label — the mechanism (deriveStatus) and the presentation (the label) are independently verifiable and stay in sync', () => {
    const approvedUnpaid = ts({
      quote_sent_at: '2026-06-02T00:00:00Z',
      viewed_at: '2026-06-02T01:00:00Z',
      customer_approved_at: '2026-06-03T00:00:00Z',
      // deposit_paid_at stays null — approved, not yet booked.
    });
    const code = deriveStatus(approvedUnpaid);
    expect(code).toBe('approved'); // the real status code — untouched by this row
    // The 3 quote-lane display surfaces (admin list, admin detail, quote
    // builder header pill) all map STATUS_LABELS/STATUS_BADGE[code] through
    // this same constant for the 'approved' key — asserting the constant's
    // value here is the shared assertion point for all three, since none of
    // them export their local maps for direct import (see the PR body for
    // why: importing a route's page.tsx / a huge client component into a
    // unit test to grab one constant would drag in their whole module graph
    // for no real safety gain over testing the single shared source).
    const displayLabelForCode: Record<QuoteStatus, string> = {
      draft: 'Draft',
      sent: 'Sent',
      viewed: 'Viewed',
      approved: APPROVED_STAGE_DISPLAY_LABEL,
      booked: 'Booked',
      changes_requested: 'Changes',
      declined: 'Declined',
      cancelled: 'Cancelled',
      abandoned: 'Abandoned',
    };
    expect(displayLabelForCode[code]).toBe('Awaiting Deposit');
  });

  it('canTransition still treats approved as a full, real status (the mechanism is untouched by the label change)', () => {
    expect(canTransition('approved', 'booked')).toBe(true);
    expect(canTransition('approved', 'declined')).toBe(true);
    expect(canTransition('approved', 'cancelled')).toBe(true);
  });
});

describe('canRevive — #116 re-send half (revive a dead quote in place)', () => {
  it('is true only for declined and abandoned', () => {
    expect(canRevive('declined')).toBe(true);
    expect(canRevive('abandoned')).toBe(true);
  });

  it('is false for cancelled (post-booking — refunds are manual, rebook-only)', () => {
    expect(canRevive('cancelled')).toBe(false);
  });

  it('is false for every non-terminal status', () => {
    for (const s of ['draft', 'sent', 'viewed', 'approved', 'booked', 'changes_requested'] as const) {
      expect(canRevive(s)).toBe(false);
    }
  });
});

describe('deriveStatus — after a #116 revive write (the resurrection proof)', () => {
  // The revive write does: quote_sent_at = now, status = 'sent',
  // customer_approved_at = null, viewed_at = null. `sent` is NOT in
  // deriveStatus's TERMINAL_OR_BRANCH set, so the persisted status column is
  // NOT trusted on its own — the timestamp fallback still runs underneath it.
  // These tests prove that fallback lands on 'sent', not a resurrected
  // 'approved'/'viewed'/'declined', for every shape a revived row can carry.

  it('a revived declined quote (that was NEVER approved) derives to sent', () => {
    // Declined straight from sent/viewed — customer_approved_at was never set.
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z', // re-stamped by the revive
          status: 'sent',
        }),
      ),
    ).toBe('sent');
  });

  it('a revived declined quote that WAS approved-then-declined (#124) does not resurrect to approved', () => {
    // #124 lets 'declined' fire from 'approved', so a declined row can carry a
    // stale customer_approved_at. If the revive write didn't clear it, the
    // un-guarded timestamp fallback would read 'approved', not 'sent'.
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z',
          customer_approved_at: null, // revive write clears this
          status: 'sent',
        }),
      ),
    ).toBe('sent');
    // Prove the negative: WITHOUT clearing it, the same row resurrects to approved.
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z',
          customer_approved_at: '2026-06-01T00:00:00Z', // stale, not cleared
          status: 'sent',
        }),
      ),
    ).toBe('approved');
  });

  it('a revived quote that was VIEWED before it was declined does not resurrect to viewed', () => {
    // viewed_at also outranks quote_sent_at in the fallback cascade, so it must
    // be cleared too, independent of customer_approved_at.
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z',
          viewed_at: null, // revive write clears this
          status: 'sent',
        }),
      ),
    ).toBe('sent');
    // Prove the negative: a stale viewed_at alone resurrects to viewed.
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z',
          viewed_at: '2026-06-01T00:00:01Z', // stale, not cleared
          status: 'sent',
        }),
      ),
    ).toBe('viewed');
  });

  it('a revived abandoned quote derives to sent the same way (abandoned and declined share the fix)', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-07-11T12:00:00Z',
          customer_approved_at: null,
          viewed_at: null,
          status: 'sent',
        }),
      ),
    ).toBe('sent');
  });
});
