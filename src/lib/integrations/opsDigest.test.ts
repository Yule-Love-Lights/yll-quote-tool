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
  is_nce: false,
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

const dueFollowUp = (over: Partial<Record<string, unknown>>) => ({
  id: 'f1',
  reason: 'call back',
  dueAt: '2026-07-18T12:00:00Z',
  contactName: 'Overdue Olive',
  contactPhone: null,
  contactEmail: null,
  isLegacyRebook: false,
  ...over,
});

const emptyData: OpsDigestData = {
  dateLabel: 'Tue, Aug 5',
  installsToday: [],
  installsTomorrow: [],
  quotesToSendCount: 0,
  rebookDraftCount: 0,
  quotesAwaitingReplyCount: 0,
  changesRequestedCount: 0,
  depositsPendingCount: 0,
  inboxOpenCount: 0,
  inboxFollowUpsDueCount: 0,
  followUpsOverdueCount: 0,
  overdueFollowUps: [],
  quotesAwaitingReplyNamed: [],
  depositsPendingNamed: [],
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
      quote({ id: 'q11', quote_number: 111, status: 'changes_requested' }), // customer asked for edits → changes requested
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesToSendCount).toBe(1); // q1
    expect(data.rebookDraftCount).toBe(1); // q3 only; q10 is view-only so excluded (parity with the real bucket)
    expect(data.quotesAwaitingReplyCount).toBe(2); // q8 sent + q9 viewed
    expect(data.changesRequestedCount).toBe(1); // q11
    expect(data.depositsPendingCount).toBe(1); // q4 approved+unpaid; q5 booked
    // Counts must be exhaustive — scan well above listQuotes()'s default 500 cap
    // so an older open quote can't silently drop out of the totals.
    expect(listQuotes).toHaveBeenCalledWith(10_000);
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

  // #223: named detail underneath the counts.
  it('lists quotes awaiting reply by name + days since sent, sorted oldest-first, excluding test/view-only/rebook', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'a', quote_number: 201, customer_name: 'Ana', quote_sent_at: '2026-07-01T00:00:00Z' }), // ~19d
      quote({ id: 'b', quote_number: 202, customer_name: 'Ben', viewed_at: '2026-07-15T00:00:00Z' }), // ~5d
      quote({ id: 'c', quote_number: 203, customer_name: 'Cara', is_test: true, quote_sent_at: '2026-01-01T00:00:00Z' }),
      quote({ id: 'd', quote_number: 204, customer_name: 'Dan', view_only: true, quote_sent_at: '2026-01-01T00:00:00Z' }),
      quote({ id: 'e', quote_number: 205, customer_name: 'Eve', legacy_rebook: true, quote_sent_at: '2026-01-01T00:00:00Z' }),
    ]);
    const data = await collectOpsDigest();
    // legacy_rebook (Eve) is excluded from `real` entirely, same as the count.
    expect(data.quotesAwaitingReplyCount).toBe(2); // a, b
    expect(data.quotesAwaitingReplyNamed).toEqual([
      { customerName: 'Ana', quoteNumber: 201, daysSinceSent: expect.any(Number) },
      { customerName: 'Ben', quoteNumber: 202, daysSinceSent: expect.any(Number) },
    ]);
    expect(data.quotesAwaitingReplyNamed[0].daysSinceSent).toBeGreaterThan(data.quotesAwaitingReplyNamed[1].daysSinceSent);
  });

  it('lists deposits pending by name + dollar total, sorted highest-first', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'a', quote_number: 301, customer_name: 'Ana', total: 5000, customer_approved_at: '2026-07-01T00:00:00Z' }),
      quote({ id: 'b', quote_number: 302, customer_name: 'Ben', total: 1200, customer_approved_at: '2026-07-01T00:00:00Z' }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([
      { customerName: 'Ana', quoteNumber: 301, total: 5000 },
      { customerName: 'Ben', quoteNumber: 302, total: 1200 },
    ]);
  });

  it('caps named lists at 5 with the overflow left to the count (formatter shows "+N more")', async () => {
    listQuotes.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        quote({ id: `q${i}`, quote_number: 400 + i, customer_name: `Cust${i}`, quote_sent_at: '2026-07-01T00:00:00Z' }),
      ),
    );
    const data = await collectOpsDigest();
    expect(data.quotesAwaitingReplyCount).toBe(8);
    expect(data.quotesAwaitingReplyNamed).toHaveLength(5);
  });

  it('lists overdue follow-ups by contact name + days overdue, excluding due-today (0 days)', async () => {
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        dueFollowUp({ id: 'f1', dueAt: '2026-07-18T12:00:00Z', contactName: 'Overdue Olive' }), // ~2d overdue
        dueFollowUp({ id: 'f2', dueAt: '2026-07-15T12:00:00Z', contactName: 'Way Overdue Wes' }), // ~5d overdue
        dueFollowUp({ id: 'f3', dueAt: '2026-07-21T01:00:00Z', contactName: 'Due Today Dave' }), // due today, not overdue
      ],
    });
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBe(3); // matches the inbox strip (due today + overdue)
    expect(data.followUpsOverdueCount).toBe(2);
    expect(data.overdueFollowUps).toEqual([
      { contactName: 'Way Overdue Wes', contactPhone: null, contactEmail: null, daysOverdue: expect.any(Number) },
      { contactName: 'Overdue Olive', contactPhone: null, contactEmail: null, daysOverdue: expect.any(Number) },
    ]);
  });

  // #223 review HIGH1: a legacy_rebook quotetool follow-up is REACHABLE (the
  // reconcile chokepoint doesn't filter legacy_rebook, only is_test/view_only
  // — see quotetool.ts) and must never be NAMED, even though the /inbox
  // strip's own due-count keeps including it (documented, unchanged).
  it('excludes an isLegacyRebook follow-up from the named list and its count, but NOT from inboxFollowUpsDueCount', async () => {
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        dueFollowUp({ id: 'f1', dueAt: '2026-07-15T12:00:00Z', contactName: 'Real Customer Rae' }), // ~5d overdue
        dueFollowUp({ id: 'f2', dueAt: '2026-07-15T12:00:00Z', contactName: 'Rebook Randy', isLegacyRebook: true }), // ~5d overdue but rebook
      ],
    });
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBe(2); // unfiltered, matches /inbox
    expect(data.followUpsOverdueCount).toBe(1); // named-list count excludes rebook
    expect(data.overdueFollowUps).toHaveLength(1);
    expect(data.overdueFollowUps[0].contactName).toBe('Real Customer Rae');
  });

  // #223 review HIGH2: no display_name, but a phone/email exists — must still
  // render as SOMETHING actionable (the real Aug-6 dropped-lead shape).
  it('carries contactPhone/contactEmail through for a nameless overdue contact', async () => {
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        dueFollowUp({ id: 'f1', dueAt: '2026-07-15T12:00:00Z', contactName: null, contactPhone: '555-0100', contactEmail: null }),
      ],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps[0]).toMatchObject({ contactName: null, contactPhone: '555-0100' });
  });

  // #223 review MEDIUM4: a quote sent 12h ago must survive the cap even when
  // 5 older quotes would otherwise fill every slot — the exact Aug-6 shape.
  it('keeps a <24h-old awaiting-reply quote visible even when 5 older ones would fill the cap', async () => {
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z')); // noon UTC = 8am NY
    listQuotes.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) =>
        quote({ id: `old${i}`, quote_number: 500 + i, customer_name: `Old${i}`, quote_sent_at: '2026-07-01T00:00:00Z' }),
      ),
      quote({ id: 'fresh', quote_number: 600, customer_name: 'Just Texted Jane', quote_sent_at: '2026-07-21T00:00:00Z' }), // 12h ago
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesAwaitingReplyCount).toBe(6);
    expect(data.quotesAwaitingReplyNamed).toHaveLength(5); // still capped
    expect(data.quotesAwaitingReplyNamed.map((r) => r.customerName)).toContain('Just Texted Jane');
  });

  it('degrades only the overdue-follow-ups section on a read failure — quote-derived lists are unaffected', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'a', quote_number: 201, customer_name: 'Ana', quote_sent_at: '2026-07-01T00:00:00Z' }),
    ]);
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBeNull();
    expect(data.followUpsOverdueCount).toBeNull();
    expect(data.overdueFollowUps).toEqual([]);
    expect(data.quotesAwaitingReplyNamed).toEqual([{ customerName: 'Ana', quoteNumber: 201, daysSinceSent: expect.any(Number) }]);
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
    expect(msg).toContain('✏️ Changes requested: 0');
    expect(msg).toContain('💰 Deposits pending: 0');
    expect(msg).toContain('→ https://quote.yulelovelights.com/admin/quotes');
    expect(msg).toContain('📥 Inbox — 0 to respond · 0 follow-ups due');
    expect(msg).toContain('→ https://quote.yulelovelights.com/inbox');
    expect(msg).toContain('Dashboard → https://quote.yulelovelights.com/');
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
        changesRequestedCount: 1,
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
    expect(msg).toContain('✏️ Changes requested: 1');
    expect(msg).toContain('💰 Deposits pending: 2');
    expect(msg).toContain('→ https://quote.yulelovelights.com/admin/quotes');
    expect(msg).toContain('📥 Inbox — 64 to respond · 10 follow-ups due');
  });

  it('keeps the inbox line + link but drops the numbers when the inbox read failed', () => {
    const msg = opsDigestMessage({ ...emptyData, inboxOpenCount: null, inboxFollowUpsDueCount: null }, 'https://x');
    expect(msg).toContain('📥 Inbox\n→ https://x/inbox');
    expect(msg).not.toContain('to respond');
  });

  it('#223: renders named awaiting-reply, deposits-pending, and overdue-follow-up lists with an overflow marker', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        quotesAwaitingReplyCount: 8,
        quotesAwaitingReplyNamed: [
          { customerName: 'Eve', quoteNumber: 205, daysSinceSent: 21 },
          { customerName: 'Ana', quoteNumber: 201, daysSinceSent: 19 },
        ],
        depositsPendingCount: 2,
        depositsPendingNamed: [
          { customerName: 'Ana', quoteNumber: 301, total: 5000 },
          { customerName: null, quoteNumber: 302, total: 1200 },
        ],
        followUpsOverdueCount: 7,
        overdueFollowUps: [
          { contactName: 'Way Overdue Wes', contactPhone: null, contactEmail: null, daysOverdue: 5 },
          { contactName: null, contactPhone: null, contactEmail: null, daysOverdue: 3 },
        ],
      },
      'https://x',
    );
    expect(msg).toContain('• Eve — 21d');
    expect(msg).toContain('• Ana — 19d');
    expect(msg).toContain('+6 more'); // 8 awaiting - 2 shown
    expect(msg).toContain('• Ana — $5,000');
    expect(msg).toContain('• (no name) — $1,200');
    expect(msg).toContain('Overdue follow-ups:');
    expect(msg).toContain('• Way Overdue Wes — 5d overdue');
    expect(msg).toContain('• (no name) — 3d overdue');
    expect(msg).toContain('+5 more'); // 7 overdue - 2 shown
  });

  // #223 review HIGH2
  it('falls back to phone, then email, when a follow-up contact has no name', () => {
    const withPhone = opsDigestMessage(
      {
        ...emptyData,
        followUpsOverdueCount: 1,
        overdueFollowUps: [{ contactName: null, contactPhone: '555-0100', contactEmail: null, daysOverdue: 2 }],
      },
      'https://x',
    );
    expect(withPhone).toContain('• 555-0100 — 2d overdue');

    const withEmail = opsDigestMessage(
      {
        ...emptyData,
        followUpsOverdueCount: 1,
        overdueFollowUps: [{ contactName: null, contactPhone: null, contactEmail: 'jane@example.com', daysOverdue: 2 }],
      },
      'https://x',
    );
    expect(withEmail).toContain('• jane@example.com — 2d overdue');

    const withNeither = opsDigestMessage(
      {
        ...emptyData,
        followUpsOverdueCount: 1,
        overdueFollowUps: [{ contactName: null, contactPhone: null, contactEmail: null, daysOverdue: 2 }],
      },
      'https://x',
    );
    expect(withNeither).toContain('• (no name) — 2d overdue');
  });

  // #223 review MEDIUM3
  it('renders a null deposit total as "amount unknown", never "$0"', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        depositsPendingCount: 1,
        depositsPendingNamed: [{ customerName: 'Ana', quoteNumber: 301, total: null }],
      },
      'https://x',
    );
    expect(msg).toContain('• Ana — amount unknown');
    expect(msg).not.toContain('$0');
  });

  // #223 review (lower priority): installs cap
  it('caps the installs list with an overflow marker, but keeps the header count real', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: Array.from({ length: 8 }, (_, i) => ({
          jobNumber: 100 + i,
          customerName: `Cust${i}`,
          stageLabel: 'Scheduled',
          isTest: false,
        })),
      },
      'https://x',
    );
    expect(msg).toContain('🔧 Installs — today: 8 · tomorrow: 0');
    expect(msg).toContain('• Job #100 Cust0 (Scheduled)');
    expect(msg).toContain('• Job #104 Cust4 (Scheduled)');
    expect(msg).not.toContain('Cust5');
    expect(msg).toContain('+3 more');
  });

  it('#223: omits the overdue-follow-ups block entirely when nothing is overdue (heartbeat stays clean)', () => {
    const msg = opsDigestMessage(emptyData, 'https://x');
    expect(msg).not.toContain('Overdue follow-ups:');
  });

  it('#223: a null followUpsOverdueCount (read failure) also omits the overdue block, not a crash', () => {
    const msg = opsDigestMessage(
      { ...emptyData, inboxOpenCount: null, inboxFollowUpsDueCount: null, followUpsOverdueCount: null },
      'https://x',
    );
    expect(msg).not.toContain('Overdue follow-ups:');
    expect(msg).toContain('📥 Inbox\n→ https://x/inbox');
  });

  it('normalizes a trailing slash on the base url', () => {
    const msg = opsDigestMessage(emptyData, 'https://x/');
    expect(msg).toContain('→ https://x/inbox');
    expect(msg).toContain('Dashboard → https://x/');
    expect(msg).not.toContain('https://x//');
  });
});
