import { describe, it, expect } from 'vitest';
import {
  deriveStatus,
  canTransition,
  isQuoteStatus,
  isPortalActionable,
  QUOTE_STATUSES,
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

  it('honors a persisted lost', () => {
    expect(deriveStatus(ts({ status: 'lost' }))).toBe('lost');
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
    ['draft', 'lost'],
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
    ['lost', 'sent'],            // terminal
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

  it('blocks terminal states (declined/cancelled/lost)', () => {
    expect(isPortalActionable('declined')).toBe(false);
    expect(isPortalActionable('cancelled')).toBe(false);
    expect(isPortalActionable('lost')).toBe(false);
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
