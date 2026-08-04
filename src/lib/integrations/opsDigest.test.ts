import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuoteListItem } from '@/lib/quotes';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the collect filtering + the pure formatter run for real.
const { listQuotes, listFulfillmentCards } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));

import { collectOpsDigest, opsDigestMessage, type OpsDigestData } from './opsDigest';

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
  view_only: false,
  highlevel_contact_id: null,
  customer_id: null,
  ...over,
});

const card = (over: Partial<FulfillmentCard>): FulfillmentCard => ({
  id: 'j1',
  jobNumber: 142,
  quoteId: 'q1',
  designId: null,
  stage: 'ready_for_install',
  status: 'scheduled',
  customerName: 'Maria Alvarez',
  customerAddress: null,
  itemCount: 3,
  installDate: null,
  isTest: false,
  highlevelContactId: null,
  customerId: null,
  ...over,
});

const emptyData: OpsDigestData = {
  installsToday: [],
  installsTomorrow: [],
  quotesToSend: [],
  quotesToSendCount: 0,
  depositsPending: [],
  depositsPendingCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
});

describe('collectOpsDigest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-07-21T02:00Z is still July 20 in New York — install bucketing must
    // follow the shop's calendar, not the server's UTC date.
    vi.setSystemTime(new Date('2026-07-21T02:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buckets installs by the NY date and splits today vs tomorrow', async () => {
    listFulfillmentCards.mockResolvedValue([
      card({ installDate: '2026-07-20' }),
      card({ id: 'j2', jobNumber: 143, customerName: 'Tomorrow Tom', installDate: '2026-07-21' }),
      card({ id: 'j3', jobNumber: 144, installDate: '2026-07-25' }),
    ]);
    const data = await collectOpsDigest();
    expect(data.installsToday).toEqual([
      { jobNumber: 142, customerName: 'Maria Alvarez', stageLabel: 'Ready For Install', isTest: false },
    ]);
    expect(data.installsTomorrow.map((i) => i.jobNumber)).toEqual([143]);
  });

  it('counts draft quotes as to-send and approved-unpaid as deposits pending, excluding test + legacy + view-only', async () => {
    listQuotes.mockResolvedValue([
      quote({}),
      quote({ id: 'q2', quote_number: 102, is_test: true }),
      quote({ id: 'q3', quote_number: 103, legacy_rebook: true }),
      quote({ id: 'q4', quote_number: 104, customer_approved_at: '2026-07-10T00:00:00Z' }),
      quote({ id: 'q5', quote_number: 105, customer_approved_at: '2026-07-10T00:00:00Z', deposit_paid_at: '2026-07-11T00:00:00Z' }),
      quote({ id: 'q6', quote_number: 106, status: 'declined' }),
      quote({ id: 'q7', quote_number: 107, view_only: true }),
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesToSendCount).toBe(1); // only q1: test/legacy/approved/booked/declined/view-only all excluded
    expect(data.quotesToSend[0].quoteNumber).toBe(101);
    expect(data.depositsPendingCount).toBe(1); // q4 approved + unpaid; q5 is booked
    expect(data.depositsPending[0].quoteNumber).toBe(104);
  });

  it('caps the line lists at 5 but keeps the full counts', async () => {
    listQuotes.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => quote({ id: `q${i}`, quote_number: 200 + i })),
    );
    const data = await collectOpsDigest();
    expect(data.quotesToSend).toHaveLength(5);
    expect(data.quotesToSendCount).toBe(8);
  });
});

describe('opsDigestMessage (pure formatter)', () => {
  it('returns null on an all-quiet day — no noise ping', () => {
    expect(opsDigestMessage(emptyData, 'https://x')).toBeNull();
  });

  it('renders only the non-empty sections, with the overflow marker and TEST tag', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: [{ jobNumber: 142, customerName: 'Maria', stageLabel: 'Ready For Install', isTest: true }],
        quotesToSend: [{ quoteNumber: 101, customerName: 'Ann', total: 1500 }],
        quotesToSendCount: 7,
      },
      'https://quote.yulelovelights.com',
    );
    expect(msg).toContain('☀️ YLL morning digest');
    expect(msg).toContain('Installs today:');
    expect(msg).toContain('• Job #142 Maria (Ready For Install) [TEST]');
    expect(msg).not.toContain('Installs tomorrow:');
    expect(msg).toContain('Quotes to send: 7');
    expect(msg).toContain('• #101 Ann — $1,500');
    expect(msg).toContain('…+6 more');
    expect(msg).not.toContain('Deposits pending');
    expect(msg).toContain('Admin → https://quote.yulelovelights.com/admin/quotes');
  });
});
