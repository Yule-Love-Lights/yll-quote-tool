// Tests for the pure seams extracted out of the pay-balance page (PostHog
// Wave 4 — no component-render test infra exists in this repo; see
// StickyBottomBar.test.ts's buildApprovePayload for the same extraction
// pattern). Covers (a) the pay_balance_opened property contract, and (b) the
// pay_balance_error category mapping, reusing categorizeApproveError from
// Wave 1 (errorCategory.test.ts already covers the categorizer itself).

import { describe, it, expect } from 'vitest';
import { buildPayBalanceOpenedProperties, buildPayBalanceErrorProperties } from './page';

describe('buildPayBalanceOpenedProperties (PostHog Wave 4)', () => {
  it('carries quote_id only — this page never loads service_type', () => {
    expect(buildPayBalanceOpenedProperties('quote-123')).toEqual({ quote_id: 'quote-123' });
  });

  it('passes quoteId through undefined for the not-yet-hydrated params case', () => {
    expect(buildPayBalanceOpenedProperties(undefined)).toEqual({ quote_id: undefined });
  });
});

describe('buildPayBalanceErrorProperties (PostHog Wave 4)', () => {
  it('always stamps stage: "balance"', () => {
    expect(buildPayBalanceErrorProperties('quote-123', 500, new Error('boom')).stage).toBe('balance');
  });

  it('categorizes a 5xx response as http_5xx', () => {
    const props = buildPayBalanceErrorProperties('quote-123', 503, new Error('valor unavailable'));
    expect(props).toEqual({ quote_id: 'quote-123', stage: 'balance', category: 'http_5xx' });
  });

  it('categorizes a 4xx response as http_4xx', () => {
    const props = buildPayBalanceErrorProperties('quote-123', 409, new Error('conflict'));
    expect(props).toEqual({ quote_id: 'quote-123', stage: 'balance', category: 'http_4xx' });
  });

  it('categorizes a pre-response TypeError (blocked/offline fetch) as network', () => {
    const props = buildPayBalanceErrorProperties('quote-123', undefined, new TypeError('Failed to fetch'));
    expect(props).toEqual({ quote_id: 'quote-123', stage: 'balance', category: 'network' });
  });

  it('falls back to unknown for anything else', () => {
    const props = buildPayBalanceErrorProperties('quote-123', undefined, 'a thrown string');
    expect(props).toEqual({ quote_id: 'quote-123', stage: 'balance', category: 'unknown' });
  });
});
