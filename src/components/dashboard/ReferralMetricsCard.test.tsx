// Ledger #41 growth feature 3 — the dashboard's referral measurement tile.
// Pure/presentational, rendered with react-dom/server (same style as the
// other dashboard/portal component tests in this repo).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralMetricsCard } from './ReferralMetricsCard';
import type { ReferralMetrics } from '@/lib/dashboard/referralMetrics';

describe('ReferralMetricsCard', () => {
  it('shows an empty state when no referrals have been generated', () => {
    const data: ReferralMetrics = {
      totalReferrals: 0,
      bookedConversionRate: null,
      revenueInfluenced: { kind: 'count', count: 0 },
      topReferrers: [],
    };
    const html = renderToStaticMarkup(<ReferralMetricsCard data={data} />);
    expect(html).toContain('No referrals generated yet');
  });

  it('shows the generated count, conversion percent, and $ revenue influenced', () => {
    const data: ReferralMetrics = {
      totalReferrals: 10,
      bookedConversionRate: 0.4,
      revenueInfluenced: { kind: 'usd', amountUsd: 12500 },
      topReferrers: [{ customerId: 'c1', name: 'Jordan Smith', convertedCount: 3 }],
    };
    const html = renderToStaticMarkup(<ReferralMetricsCard data={data} />);
    expect(html).toContain('10');
    expect(html).toContain('40%');
    expect(html).toContain((12500).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
    expect(html).toContain('Jordan Smith');
    expect(html).toContain('3 booked');
  });

  it('falls back to a plain count when revenue could not be resolved to a $ figure', () => {
    const data: ReferralMetrics = {
      totalReferrals: 2,
      bookedConversionRate: 1,
      revenueInfluenced: { kind: 'count', count: 2 },
      topReferrers: [],
    };
    const html = renderToStaticMarkup(<ReferralMetricsCard data={data} />);
    expect(html).toContain('2 booked');
    expect(html).not.toContain('$');
  });

  it('omits the top-referrers list entirely when nobody has converted yet', () => {
    const data: ReferralMetrics = {
      totalReferrals: 5,
      bookedConversionRate: 0,
      revenueInfluenced: { kind: 'count', count: 0 },
      topReferrers: [],
    };
    const html = renderToStaticMarkup(<ReferralMetricsCard data={data} />);
    expect(html).not.toContain('Top referrers');
  });
});
