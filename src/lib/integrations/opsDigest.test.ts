import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuoteListItem } from '@/lib/quotes';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the collect filtering + the pure formatter run for real.
const { listQuotes, listFulfillmentCards, listOpenItems, listDueFollowUps } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
  listOpenItems: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [], totalOpen: 0, truncated: false })),
  listDueFollowUps: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [] })),
}));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ listOpenItems, listDueFollowUps }));

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
  dateLabel: 'Tue, Aug 5',
  installsToday: [],
  installsTomorrow: [],
  quotesToSendCount: 0,
  rebookDraftCount: 0,
  quotesAwaitingReplyCount: 0,
  depositsPendingCount: 0,
  inboxOpenCount: 0,
  inboxFollowUpsDueCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
  listOpenItems.mockResolvedValue({ ok: true, items: [], totalOpen: 0, truncated: false });
  listDueFollowUps.mockResolvedValue({ ok: true, items: [] });
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

  it('counts each quote bucket: draft to-send, sent/viewed awaiting reply, approved deposits, rebook drafts; excludes test + view-only', async () => {
    listQuotes.mockResolvedValue([
      quote({}), // q1 draft, real → to-send
      quote({ id: 'q2', quote_number: 102, is_test: true }), // excluded
      quote({ id: 'q3', quote_number: 103, legacy_rebook: true }), // rebook draft → own line
      quote({ id: 'q4', quote_number: 104, customer_approved_at: '2026-07-10T00:00:00Z' }), // approved → deposit pending
      quote({ id: 'q5', quote_number: 105, customer_approved_at: '2026-07-10T00:00:00Z', deposit_paid_at: '2026-07-11T00:00:00Z' }), // booked → none
      quote({ id: 'q6', quote_number: 106, status: 'declined' }), // terminal → none
      quote({ id: 'q7', quote_number: 107, view_only: true }), // excluded
      quote({ id: 'q8', quote_number: 108, quote_sent_at: '2026-07-05T00:00:00Z' }), // sent → awaiting reply
      quote({ id: 'q9', quote_number: 109, viewed_at: '2026-07-06T00:00:00Z' }), // viewed → awaiting reply
      quote({ id: 'q10', quote_number: 110, legacy_rebook: true, view_only: true }), // rebook BUT view-only → excluded from rebookDraftCount
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesToSendCount).toBe(1); // q1
    expect(data.rebookDraftCount).toBe(1); // q3 only; q10 is view-only so excluded (parity with the real bucket)
    expect(data.quotesAwaitingReplyCount).toBe(2); // q8 sent + q9 viewed
    expect(data.depositsPendingCount).toBe(1); // q4 approved+unpaid; q5 booked
  });

  it('reads inbox open + due-follow-up counts from the inbox surface (totalOpen, not the capped page)', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}, {}], totalOpen: 64, truncated: true });
    listDueFollowUps.mockResolvedValue({ ok: true, items: [{}, {}, {}] });
    const data = await collectOpsDigest();
    expect(data.inboxOpenCount).toBe(64);
    expect(data.inboxFollowUpsDueCount).toBe(3);
  });

  it('falls back to null inbox counts when the inbox read fails — never breaks the digest', async () => {
    listOpenItems.mockResolvedValue({ ok: false, error: 'db down' });
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    const data = await collectOpsDigest();
    expect(data.inboxOpenCount).toBeNull();
    expect(data.inboxFollowUpsDueCount).toBeNull();
  });

  it('stamps a shop-timezone date label', async () => {
    const data = await collectOpsDigest();
    // 2026-07-21T02:00Z is still Mon Jul 20 in New York.
    expect(data.dateLabel).toBe('Mon, Jul 20');
  });
});

describe('opsDigestMessage (pure formatter — heartbeat)', () => {
  it('ALWAYS returns a message: an all-quiet day still sends, with zeroed counts', () => {
    const msg = opsDigestMessage(emptyData, 'https://quote.yulelovelights.com');
    expect(msg).toContain('☀️ YLL morning digest — Tue, Aug 5');
    expect(msg).toContain('🔧 Installs — today: 0 · tomorrow: 0');
    expect(msg).toContain('📝 Quotes to send: 0');
    expect(msg).toContain('🏘️ Neighbor (rebook) drafts: 0');
    expect(msg).toContain('⏳ Quotes awaiting reply: 0');
    expect(msg).toContain('💰 Deposits pending: 0');
    expect(msg).toContain('📥 Inbox — 0 to respond · 0 follow-ups due');
    expect(msg).toContain('→ https://quote.yulelovelights.com/inbox');
    expect(msg).toContain('Dashboard → https://quote.yulelovelights.com/');
    expect(msg).not.toContain('/admin/quotes');
  });

  it('lists installs by name but shows counts for the pipeline stats', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: [{ jobNumber: 142, customerName: 'Maria', stageLabel: 'Ready For Install', isTest: true }],
        installsTomorrow: [{ jobNumber: 143, customerName: 'Tom', stageLabel: 'Scheduled', isTest: false }],
        quotesToSendCount: 3,
        rebookDraftCount: 124,
        quotesAwaitingReplyCount: 8,
        depositsPendingCount: 2,
        inboxOpenCount: 64,
        inboxFollowUpsDueCount: 10,
      },
      'https://quote.yulelovelights.com',
    );
    expect(msg).toContain('🔧 Installs — today: 1 · tomorrow: 1');
    expect(msg).toContain('Today:');
    expect(msg).toContain('• Job #142 Maria (Ready For Install) [TEST]');
    expect(msg).toContain('Tomorrow:');
    expect(msg).toContain('• Job #143 Tom (Scheduled)');
    expect(msg).toContain('📝 Quotes to send: 3');
    expect(msg).toContain('🏘️ Neighbor (rebook) drafts: 124');
    expect(msg).toContain('⏳ Quotes awaiting reply: 8');
    expect(msg).toContain('💰 Deposits pending: 2');
    expect(msg).toContain('📥 Inbox — 64 to respond · 10 follow-ups due');
  });

  it('keeps the inbox line + link but drops the numbers when the inbox read failed', () => {
    const msg = opsDigestMessage({ ...emptyData, inboxOpenCount: null, inboxFollowUpsDueCount: null }, 'https://x');
    expect(msg).toContain('📥 Inbox\n→ https://x/inbox');
    expect(msg).not.toContain('to respond');
  });

  it('normalizes a trailing slash on the base url', () => {
    const msg = opsDigestMessage(emptyData, 'https://x/');
    expect(msg).toContain('→ https://x/inbox');
    expect(msg).toContain('Dashboard → https://x/');
    expect(msg).not.toContain('https://x//');
  });
});
