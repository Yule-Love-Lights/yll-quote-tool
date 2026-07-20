import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuoteListItem } from '@/lib/quotes';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the search/format/timezone logic runs for real.
const { listQuotes, listFulfillmentCards } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));

import { runStatusTool, runScheduleTool } from './botTools';

const quote = (over: Partial<QuoteListItem>): QuoteListItem => ({
  id: 'q1',
  customer_name: 'Maria Alvarez',
  customer_address: null,
  customer_phone: null,
  customer_email: null,
  total: 2500,
  created_at: '2026-07-01T00:00:00Z',
  quote_sent_at: null,
  customer_approved_at: null,
  deposit_paid_at: null,
  viewed_at: null,
  last_viewed_at: null,
  view_count: null,
  status: null,
  decline_reason: null,
  quote_number: 101,
  is_test: false,
  service_type: null,
  legacy_rebook: false,
  ...over,
});

const card = (over: Partial<FulfillmentCard>): FulfillmentCard => ({
  id: 'j1',
  jobNumber: 142,
  quoteId: 'q1',
  designId: null,
  stage: 'to_be_prepared',
  status: 'to_schedule',
  customerName: 'Maria Alvarez',
  customerAddress: null,
  itemCount: 3,
  installDate: null,
  isTest: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
});

describe('runStatusTool', () => {
  it('finds quotes by case-insensitive name substring with the derived lifecycle', async () => {
    listQuotes.mockResolvedValue([
      quote({ quote_sent_at: '2026-07-10T00:00:00Z', viewed_at: '2026-07-11T00:00:00Z' }),
    ]);
    const out = await runStatusTool('alvarez');
    expect(out).toContain('#101 Maria Alvarez — Sent + viewed');
    expect(out).toContain('$2,500');
  });

  it('derives booked / approved / draft correctly', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'a', quote_number: 1, customer_name: 'Booked Bob', deposit_paid_at: '2026-07-01T00:00:00Z' }),
      quote({ id: 'b', quote_number: 2, customer_name: 'Approved Ann', customer_approved_at: '2026-07-01T00:00:00Z' }),
      quote({ id: 'c', quote_number: 3, customer_name: 'Draft Dan' }),
    ]);
    expect(await runStatusTool('booked bob')).toContain('Booked (deposit paid)');
    expect(await runStatusTool('approved ann')).toContain('Approved, deposit pending');
    expect(await runStatusTool('draft dan')).toContain('Draft, not sent');
  });

  it('matches an exact quote number or job number for a numeric query', async () => {
    listQuotes.mockResolvedValue([quote({}), quote({ id: 'q2', quote_number: 555, customer_name: 'Other' })]);
    listFulfillmentCards.mockResolvedValue([card({ installDate: '2026-12-01' })]);
    const byQuoteNum = await runStatusTool('101');
    expect(byQuoteNum).toContain('#101 Maria Alvarez');
    expect(byQuoteNum).not.toContain('#555');
    const byJobNum = await runStatusTool('142');
    expect(byJobNum).toContain('Job #142 Maria Alvarez — To Be Prepared, install 2026-12-01');
    expect(byJobNum).not.toContain('#101 Maria');
  });

  it('excludes legacy rebook drafts from name searches', async () => {
    listQuotes.mockResolvedValue([quote({ legacy_rebook: true })]);
    expect(await runStatusTool('alvarez')).toBe('No quote or job matching "alvarez".');
  });

  it('tags test rows and caps long hit lists', async () => {
    listQuotes.mockResolvedValue([
      quote({ is_test: true }),
      ...Array.from({ length: 7 }, (_, i) =>
        quote({ id: `x${i}`, quote_number: 200 + i, customer_name: `Alvarez ${i}` }),
      ),
    ]);
    const out = await runStatusTool('alvarez');
    expect(out).toContain('[TEST]');
    expect(out).toContain('…+3 more quotes');
  });
});

describe('runScheduleTool (America/New_York bucketing)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-07-21T02:00Z is still July 20 in New York — proves the NY calendar
    // is what buckets installs, not the server's UTC date.
    vi.setSystemTime(new Date('2026-07-21T02:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buckets today by the NY date, not the UTC date', async () => {
    listFulfillmentCards.mockResolvedValue([
      card({ installDate: '2026-07-20' }),
      card({ id: 'j2', jobNumber: 143, customerName: 'UTC Tomorrow', installDate: '2026-07-21' }),
    ]);
    const out = await runScheduleTool('today');
    expect(out).toContain('2026-07-20 — Job #142 Maria Alvarez (To Be Prepared)');
    expect(out).not.toContain('#143');
  });

  it('handles tomorrow and the 7-day week window (inclusive), sorted by date', async () => {
    listFulfillmentCards.mockResolvedValue([
      card({ id: 'j2', jobNumber: 143, installDate: '2026-07-21' }),
      card({ id: 'j3', jobNumber: 144, installDate: '2026-07-26', isTest: true }),
      card({ id: 'j4', jobNumber: 145, installDate: '2026-07-27' }),
      card({ id: 'j5', jobNumber: 146, installDate: null }),
    ]);
    expect(await runScheduleTool('tomorrow')).toContain('Job #143');
    const week = await runScheduleTool('week');
    expect(week).toContain('Job #143');
    expect(week).toContain('Job #144');
    expect(week).toContain('[TEST]');
    expect(week).not.toContain('Job #145'); // day 7 is outside today..+6
    expect(week.indexOf('#143')).toBeLessThan(week.indexOf('#144'));
  });

  it('says so when nothing is scheduled', async () => {
    expect(await runScheduleTool('today')).toBe('No installs scheduled today.');
    expect(await runScheduleTool('week')).toBe('No installs scheduled in the next 7 days.');
  });
});
