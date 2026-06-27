import { describe, it, expect } from 'vitest';
import { deriveStatus, type QuoteLifecycleTimestamps } from './quoteStatus';

function ts(overrides: Partial<QuoteLifecycleTimestamps> = {}): QuoteLifecycleTimestamps {
  return {
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    ...overrides,
  };
}

describe('deriveStatus', () => {
  it('is draft when no lifecycle timestamps are set', () => {
    expect(deriveStatus(ts())).toBe('draft');
  });

  it('is sent when sent but not approved or paid', () => {
    expect(deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z' }))).toBe('sent');
  });

  it('is approved when approved but the deposit is not yet paid', () => {
    expect(
      deriveStatus(ts({ quote_sent_at: '2026-06-02T00:00:00Z', customer_approved_at: '2026-06-03T00:00:00Z' })),
    ).toBe('approved');
  });

  it('is booked once the deposit is paid (wins over approved + sent)', () => {
    expect(
      deriveStatus(
        ts({
          quote_sent_at: '2026-06-02T00:00:00Z',
          customer_approved_at: '2026-06-03T00:00:00Z',
          deposit_paid_at: '2026-06-04T00:00:00Z',
        }),
      ),
    ).toBe('booked');
  });

  it('is approved when approved without a send timestamp (offline close)', () => {
    expect(deriveStatus(ts({ customer_approved_at: '2026-06-03T00:00:00Z' }))).toBe('approved');
  });
});
