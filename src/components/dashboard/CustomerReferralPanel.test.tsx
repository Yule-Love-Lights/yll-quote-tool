// Thin coverage for the customer profile referral panel (ledger #41 PR 2).
// Renders with react-dom/server (same approach as ReferralSection.test.tsx)
// — lib/referrals + appBaseUrl are mocked so this only exercises the panel's
// own state-selection + rendering, not the DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { ensureReferralCodeMock, listReferralsForMock, getReferralPhotoOptoutMock } = vi.hoisted(() => ({
  ensureReferralCodeMock: vi.fn(async (): Promise<string | null> => 'ABCD1234'),
  listReferralsForMock: vi.fn(async () => ({
    items: [] as Array<{
      id: string;
      displayName: string;
      source: 'link' | 'mention';
      status: 'pending' | 'booked' | 'credited';
      amountUsd: number;
      createdAt: string;
      bookedAt: string | null;
      creditedAt: string | null;
      creditedQuoteId: string | null;
    }>,
    summary: { pendingCount: 0, bookedCount: 0, creditedCount: 0, spendableUsd: 0, lifetimeEarnedUsd: 0 },
  })),
  getReferralPhotoOptoutMock: vi.fn(async () => false),
}));

vi.mock('@/lib/referrals', () => ({
  ensureReferralCode: ensureReferralCodeMock,
  listReferralsFor: listReferralsForMock,
  getReferralPhotoOptout: getReferralPhotoOptoutMock,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));

import { CustomerReferralPanel } from './CustomerReferralPanel';

beforeEach(() => {
  vi.clearAllMocks();
  ensureReferralCodeMock.mockResolvedValue('ABCD1234');
  listReferralsForMock.mockResolvedValue({
    items: [],
    summary: { pendingCount: 0, bookedCount: 0, creditedCount: 0, spendableUsd: 0, lifetimeEarnedUsd: 0 },
  });
  getReferralPhotoOptoutMock.mockResolvedValue(false);
});

describe('CustomerReferralPanel', () => {
  it('renders a graceful empty state and never fetches when no customer_id resolves', async () => {
    const html = renderToStaticMarkup(await CustomerReferralPanel({ customerId: null }));
    expect(html).toContain('No referral activity yet.');
    expect(ensureReferralCodeMock).not.toHaveBeenCalled();
    expect(listReferralsForMock).not.toHaveBeenCalled();
  });

  it('shows the referral link + zero counts + "no referrals yet" for a code with no history', async () => {
    const html = renderToStaticMarkup(await CustomerReferralPanel({ customerId: 'c1' }));
    expect(html).toContain('https://quote.yulelovelights.com/refer/ABCD1234');
    expect(html).toContain('No referrals yet.');
    expect(html).toContain('0 pending');
    expect(html).toContain('$0.00');
  });

  it('falls back to "no referral link yet" when the customer row cannot mint a code', async () => {
    ensureReferralCodeMock.mockResolvedValueOnce(null);
    const html = renderToStaticMarkup(await CustomerReferralPanel({ customerId: 'c1' }));
    expect(html).toContain('No referral link yet.');
  });

  it('renders the full history table + summary for an active referrer', async () => {
    listReferralsForMock.mockResolvedValueOnce({
      items: [
        {
          id: 'r1',
          displayName: 'Jordan Lee',
          source: 'mention' as const,
          status: 'booked' as const,
          amountUsd: 125,
          createdAt: '2026-02-01T00:00:00Z',
          bookedAt: '2026-02-15T00:00:00Z',
          creditedAt: null,
          creditedQuoteId: null,
        },
        {
          id: 'r2',
          displayName: 'Alex Chen',
          source: 'mention' as const,
          status: 'credited' as const,
          amountUsd: 125,
          createdAt: '2026-01-05T00:00:00Z',
          bookedAt: '2026-01-15T00:00:00Z',
          creditedAt: '2026-03-01T00:00:00Z',
          creditedQuoteId: 'q-spend-1',
        },
      ],
      summary: { pendingCount: 0, bookedCount: 1, creditedCount: 1, spendableUsd: 125, lifetimeEarnedUsd: 250 },
    });

    const html = renderToStaticMarkup(await CustomerReferralPanel({ customerId: 'c1' }));
    expect(html).toContain('Jordan Lee');
    expect(html).toContain('Alex Chen');
    expect(html).toContain('$125.00'); // spendable credit
    expect(html).toContain('$250.00'); // lifetime earned
    expect(html).toContain('/quote/q-spend-1');
    expect(html).toContain('Spent on quote');
    expect(html).not.toContain('No referrals yet.');
  });

  it('never uses an em dash in the staff-facing copy (voice rules)', async () => {
    const html = renderToStaticMarkup(await CustomerReferralPanel({ customerId: null }));
    expect(html).not.toContain('—');
  });
});
