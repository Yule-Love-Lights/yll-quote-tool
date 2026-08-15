import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuoteListItem } from '@/lib/quotes';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the collect filtering + the pure formatter run for real.
const { listQuotes, listFulfillmentCards, listOpenItems, listDueFollowUps } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
  listOpenItems: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false })),
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

const emptyData: OpsDigestData = {
  dateLabel: 'Tue, Aug 5',
  installsToday: [],
  installsTomorrow: [],
  quotesToSendCount: 0,
  rebookDraftCount: 0,
  quotesAwaitingReplyCount: 0,
  awaitingReplyNamed: [],
  changesRequestedCount: 0,
  depositsPendingCount: 0,
  depositsPendingNamed: [],
  inboxOpenCount: 0,
  inboxFilteredCount: 0,
  inboxFollowUpsDueCount: 0,
  overdueFollowUps: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
  listOpenItems.mockResolvedValue({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false });
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

  it('reads inbox open + due-follow-up counts from the inbox surface (totalLeads, not the capped page)', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}, {}], totalOpen: 64, totalLeads: 40, truncated: true });
    listDueFollowUps.mockResolvedValue({ ok: true, items: [{}, {}, {}] });
    const data = await collectOpsDigest();
    expect(data.inboxOpenCount).toBe(40);
    expect(data.inboxFollowUpsDueCount).toBe(3);
  });

  // #265: pins the actual field the digest reads — totalOpen counts EVERY open
  // item (leads + lead_kind='automated' noise); totalLeads excludes the noise,
  // matching /inbox's own "Open leads" tile. Before the fix, the digest read
  // totalOpen and over-counted by exactly the automated total.
  it('reads totalLeads specifically, NOT totalOpen — the digest must not re-count automated noise as leads (#265)', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}], totalOpen: 167, totalLeads: 127, truncated: false });
    const data = await collectOpsDigest();
    expect(data.inboxOpenCount).toBe(127);
    expect(data.inboxOpenCount).not.toBe(167);
  });

  // #265: the filtered count is the residual signal — what got excluded
  // (totalOpen − totalLeads) — derived from the SAME listOpenItems() read
  // as inboxOpenCount, not a second round-trip.
  it('derives inboxFilteredCount as totalOpen minus totalLeads from a single inbox read', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}], totalOpen: 167, totalLeads: 127, truncated: false });
    const data = await collectOpsDigest();
    expect(data.inboxFilteredCount).toBe(40);
    expect(listOpenItems).toHaveBeenCalledTimes(1);
  });

  it('reports inboxFilteredCount 0 when there is no automated noise (no behavior change for the common case)', async () => {
    listOpenItems.mockResolvedValue({ ok: true, items: [{}], totalOpen: 12, totalLeads: 12, truncated: false });
    const data = await collectOpsDigest();
    expect(data.inboxFilteredCount).toBe(0);
  });

  it('falls back to null inbox counts (including inboxFilteredCount) when the inbox read fails — never breaks the digest', async () => {
    listOpenItems.mockResolvedValue({ ok: false, error: 'db down' });
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    const data = await collectOpsDigest();
    expect(data.inboxOpenCount).toBeNull();
    expect(data.inboxFilteredCount).toBeNull();
    expect(data.inboxFollowUpsDueCount).toBeNull();
  });

  it('stamps a shop-timezone date label', async () => {
    const data = await collectOpsDigest();
    // 2026-07-21T02:00Z is still Mon Jul 20 in New York.
    expect(data.dateLabel).toBe('Mon, Jul 20');
  });
});

// ─── #229: named detail — overdue follow-ups / awaiting reply / deposits ─────

describe('collectOpsDigest — #229 named details', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Overdue follow-ups (from listDueFollowUps) ─────────────────────────────

  it('lists overdue follow-ups by name, with whole days overdue', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z')); // Aug 6, ET morning
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-04T12:00:00Z', // 2d 3h ago -> 2 whole days
          contactName: 'Sam Overdue',
          contactPhone: null,
          contactEmail: null,
          isLegacyRebookAnchored: false,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Sam Overdue', daysOverdue: 2 }]);
  });

  // Ledger #229's headline bug: a legacy_rebook ("YLL Neighbor") quote can mint
  // a follow-up (#222's outbound-first allowlist) that must never appear by
  // name — but the STRIP's own count is unchanged (it has never excluded
  // rebook), so the header count here must still see both.
  it('filters a legacy-rebook-anchored follow-up from the named list; the count stays unchanged (existing strip behavior)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-05T12:00:00Z',
          contactName: 'YLL Neighbor Lead',
          contactPhone: null,
          contactEmail: null,
          isLegacyRebookAnchored: true,
        },
        {
          id: 'f2',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-05T12:00:00Z',
          contactName: 'Real Customer',
          contactPhone: null,
          contactEmail: null,
          isLegacyRebookAnchored: false,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBe(2); // unfiltered — matches the strip
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Real Customer', daysOverdue: 1 }]);
    expect(data.overdueFollowUps?.some((f) => f.displayName === 'YLL Neighbor Lead')).toBe(false);
  });

  it('falls back name -> phone -> email -> "(no name)" for a nameless follow-up contact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [
        { id: 'f1', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: '+16315551234', contactEmail: 'lead@x.com', isLegacyRebookAnchored: false },
        { id: 'f2', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: null, contactEmail: 'onlyemail@x.com', isLegacyRebookAnchored: false },
        { id: 'f3', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: null, contactEmail: null, isLegacyRebookAnchored: false },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps?.map((f) => f.displayName)).toEqual(['+16315551234', 'onlyemail@x.com', '(no name)']);
  });

  it('overdueFollowUps is null when the inbox read fails (mirrors inboxFollowUpsDueCount)', async () => {
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toBeNull();
    expect(data.inboxFollowUpsDueCount).toBeNull();
  });

  it('guards a malformed dueAt (invalid date) to 0 days rather than NaN', async () => {
    listDueFollowUps.mockResolvedValue({
      ok: true,
      items: [{ id: 'f1', reason: 'x', dueAt: 'not-a-date', contactName: 'Bad Date Bob', contactPhone: null, contactEmail: null, isLegacyRebookAnchored: false }],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Bad Date Bob', daysOverdue: 0 }]);
  });

  // ── Quotes awaiting reply (from listQuotes) ─────────────────────────────────

  it('lists quotes awaiting reply by name, with whole days since sent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'));
    listQuotes.mockResolvedValue([quote({ id: 'q1', customer_name: 'Pat Sent', quote_sent_at: '2026-08-03T12:00:00Z' })]); // exactly 3 days
    const data = await collectOpsDigest();
    expect(data.awaitingReplyNamed).toEqual([{ displayName: 'Pat Sent', daysSinceSent: 3 }]);
  });

  it('excludes a viewed quote with no quote_sent_at from the named list, but the header count still includes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'));
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'No Sent Date', viewed_at: '2026-08-03T12:00:00Z', quote_sent_at: null }),
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesAwaitingReplyCount).toBe(1);
    expect(data.awaitingReplyNamed).toEqual([]);
  });

  it('falls back to phone (then email) for a nameless awaiting-reply quote', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'));
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: null, customer_phone: '631-555-0000', customer_email: 'x@y.com', quote_sent_at: '2026-08-03T12:00:00Z' }),
    ]);
    const data = await collectOpsDigest();
    expect(data.awaitingReplyNamed).toEqual([{ displayName: '631-555-0000', daysSinceSent: 3 }]);
  });

  it('never lists a legacy_rebook/is_test/view_only quote in awaitingReplyNamed (inherits the `real` filter for free)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'));
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Rebook Neighbor', legacy_rebook: true, quote_sent_at: '2026-08-03T12:00:00Z' }),
      quote({ id: 'q2', customer_name: 'Test Quote', is_test: true, quote_sent_at: '2026-08-03T12:00:00Z' }),
      quote({ id: 'q3', customer_name: 'View Only', view_only: true, quote_sent_at: '2026-08-03T12:00:00Z' }),
    ]);
    const data = await collectOpsDigest();
    expect(data.quotesAwaitingReplyCount).toBe(0);
    expect(data.awaitingReplyNamed).toEqual([]);
  });

  // The core sort-correctness test (ledger #229 requirement 5 / "Done looks
  // like" #2). Input is deliberately NOT fed in freshness order — Array.sort
  // is STABLE, so a broken comparator that ties every same-day send at 0
  // whole days would just preserve this (wrong) input order after a cap,
  // which is exactly the bug this test exists to catch.
  it('sorts awaiting-reply by RAW timestamp (freshest-first under 24h) so the cap keeps the 2 freshest of 7 same-day sends and drops the 2 stalest', async () => {
    const NOW = new Date('2026-08-06T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    listQuotes.mockResolvedValue([
      quote({ id: 'q18', customer_name: 'Stale18h', quote_sent_at: hoursAgo(18) }),
      quote({ id: 'q5', customer_name: 'Fresh5h', quote_sent_at: hoursAgo(5) }),
      quote({ id: 'q23', customer_name: 'Stale23h', quote_sent_at: hoursAgo(23) }),
      quote({ id: 'q1', customer_name: 'Fresh1h', quote_sent_at: hoursAgo(1) }),
      quote({ id: 'q13', customer_name: 'Fresh13h', quote_sent_at: hoursAgo(13) }),
      quote({ id: 'q3', customer_name: 'Fresh3h', quote_sent_at: hoursAgo(3) }),
      quote({ id: 'q9', customer_name: 'Fresh9h', quote_sent_at: hoursAgo(9) }),
    ]);
    const data = await collectOpsDigest();
    // Fully sorted, uncapped: freshest (smallest age) first.
    expect(data.awaitingReplyNamed.map((q) => q.displayName)).toEqual([
      'Fresh1h', 'Fresh3h', 'Fresh5h', 'Fresh9h', 'Fresh13h', 'Stale18h', 'Stale23h',
    ]);
    const msg = opsDigestMessage(data, 'https://x');
    // The two FRESHEST of the seven survive a render cap of 5; the two
    // STALEST spill behind an exact "+2 more".
    expect(msg).toContain('Fresh1h');
    expect(msg).toContain('Fresh13h');
    expect(msg).not.toContain('Stale18h');
    expect(msg).not.toContain('Stale23h');
    expect(msg).toContain('+2 more');
  });

  // ── Deposits pending (from listQuotes) ──────────────────────────────────────

  it('lists deposits pending by name and dollar amount', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Approved Amy', customer_approved_at: '2026-07-10T00:00:00Z', total: 2500 }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Approved Amy', amountLabel: '$2,500' }]);
  });

  it('renders "amount unknown" — never "$0" — for a null total', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'No Total Nick', customer_approved_at: '2026-07-10T00:00:00Z', total: null }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'No Total Nick', amountLabel: 'amount unknown' }]);
  });

  it('renders an actual $0 total as "$0", distinct from a null/unknown total', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Zero Total', customer_approved_at: '2026-07-10T00:00:00Z', total: 0 }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Zero Total', amountLabel: '$0' }]);
  });

  it('sorts deposits pending oldest-approved-first (longest pending survives the cap)', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Newer', customer_approved_at: '2026-07-15T00:00:00Z', total: 1000 }),
      quote({ id: 'q2', customer_name: 'Older', customer_approved_at: '2026-07-01T00:00:00Z', total: 2000 }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed.map((d) => d.displayName)).toEqual(['Older', 'Newer']);
  });

  // ── Fail-soft isolation (requirement 7 / "Done looks like" #5) ─────────────

  it('a due-follow-ups read failure degrades ONLY that section — quote-derived named lists + the heartbeat still render', async () => {
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Still Here', customer_approved_at: '2026-07-10T00:00:00Z', total: 500 }),
    ]);
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toBeNull();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Still Here', amountLabel: '$500' }]);
    const msg = opsDigestMessage(data, 'https://x');
    expect(msg).toContain('Still Here');
    expect(msg).toContain('☀️ YLL morning digest'); // heartbeat unaffected
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
    // #265: a zero (noise-free) filtered count stays OMITTED — a quiet/clean
    // morning must not grow a "· 0 filtered" clause nobody needs to read.
    expect(msg).not.toContain('filtered');
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
        inboxFilteredCount: 10,
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
    expect(msg).toContain('📥 Inbox — 64 to respond · 10 filtered · 10 follow-ups due');
  });

  // #265: the residual signal — softens the count cliff on the first
  // post-merge send (57 → 16 becomes "16 to respond · 41 filtered", which
  // self-explains where the rest went) and mirrors /inbox's own
  // InboxSummaryStrip "· N filtered" texture.
  it('shows the filtered (excluded automated) count only when nonzero (#265)', () => {
    const msg = opsDigestMessage(
      { ...emptyData, inboxOpenCount: 16, inboxFilteredCount: 41, inboxFollowUpsDueCount: 3 },
      'https://quote.yulelovelights.com',
    );
    expect(msg).toContain('📥 Inbox — 16 to respond · 41 filtered · 3 follow-ups due');
  });

  it('keeps the inbox line + link but drops the numbers when the inbox read failed', () => {
    const msg = opsDigestMessage(
      { ...emptyData, inboxOpenCount: null, inboxFilteredCount: null, inboxFollowUpsDueCount: null },
      'https://x',
    );
    expect(msg).toContain('📥 Inbox\n→ https://x/inbox');
    expect(msg).not.toContain('to respond');
    expect(msg).not.toContain('filtered');
  });

  it('normalizes a trailing slash on the base url', () => {
    const msg = opsDigestMessage(emptyData, 'https://x/');
    expect(msg).toContain('→ https://x/inbox');
    expect(msg).toContain('Dashboard → https://x/');
    expect(msg).not.toContain('https://x//');
  });

  // ── #229: named-list capping (installs + all three new sections) ──────────

  it('caps every named list at 5 with an exact "+N more", while header counts stay the TRUE totals', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: Array.from({ length: 8 }, (_, i) => ({
          jobNumber: i,
          customerName: `Cust${i}`,
          stageLabel: 'Scheduled',
          isTest: false,
        })),
        overdueFollowUps: Array.from({ length: 7 }, (_, i) => ({ displayName: `Overdue${i + 1}`, daysOverdue: i })),
        awaitingReplyNamed: Array.from({ length: 9 }, (_, i) => ({ displayName: `Wait${i + 1}`, daysSinceSent: i })),
        depositsPendingNamed: Array.from({ length: 6 }, (_, i) => ({ displayName: `Dep${i + 1}`, amountLabel: `$${i + 1}` })),
      },
      'https://x',
    );
    // Installs: header stays the true total (8); only 5 named + an exact overflow.
    expect(msg).toContain('🔧 Installs — today: 8 · tomorrow: 0');
    expect(msg).toContain('Cust0');
    expect(msg).not.toContain('Cust5');
    expect(msg).toContain('+3 more');
    // Overdue follow-ups: 7 -> 5 shown + "+2 more".
    expect(msg).toContain('Overdue1');
    expect(msg).not.toContain('Overdue6');
    expect(msg).toContain('+2 more');
    // Awaiting reply: 9 -> 5 shown + "+4 more".
    expect(msg).toContain('Wait1');
    expect(msg).not.toContain('Wait6');
    expect(msg).toContain('+4 more');
    // Deposits pending: 6 -> 5 shown + "+1 more".
    expect(msg).toContain('Dep1');
    expect(msg).not.toContain('Dep6');
    expect(msg).toContain('+1 more');
  });

  it('shows no overflow marker when a named list exactly fills the cap (no off-by-one)', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ displayName: `D${i + 1}`, amountLabel: '$1' }));
    const msg = opsDigestMessage({ ...emptyData, depositsPendingNamed: five }, 'https://x');
    expect(msg).toContain('D5');
    expect(msg).not.toMatch(/\+\d+ more/);
  });

  it('renders "due today" (0 days) and "sent today" instead of "0 days ago/overdue"', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        overdueFollowUps: [{ displayName: 'Today Tim', daysOverdue: 0 }],
        awaitingReplyNamed: [{ displayName: 'Today Tara', daysSinceSent: 0 }],
      },
      'https://x',
    );
    expect(msg).toContain('• Today Tim — due today');
    expect(msg).toContain('• Today Tara — sent today');
    expect(msg).not.toContain('0 days');
  });

  it('never shows the follow-ups named block when the inbox read failed, even though the count line is also absent (null, not empty)', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        inboxOpenCount: null,
        inboxFilteredCount: null,
        inboxFollowUpsDueCount: null,
        overdueFollowUps: null,
      },
      'https://x',
    );
    // Exact match with the pre-existing "read failed" test above: the inbox
    // line is immediately followed by its link, nothing injected between.
    expect(msg).toContain('📥 Inbox\n→ https://x/inbox');
  });

  it('stays well under Telegram\'s 4096-char limit even on a heavy day (many installs + named entries across every section)', () => {
    const install = (i: number) => ({
      jobNumber: i,
      customerName: `Customer With A Fairly Long Name Number ${i}`,
      stageLabel: 'Ready For Install',
      isTest: false,
    });
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: Array.from({ length: 40 }, (_, i) => install(i)),
        installsTomorrow: Array.from({ length: 40 }, (_, i) => install(i)),
        overdueFollowUps: Array.from({ length: 60 }, (_, i) => ({
          displayName: `Overdue Customer With A Longer Name ${i}`,
          daysOverdue: i,
        })),
        awaitingReplyNamed: Array.from({ length: 60 }, (_, i) => ({
          displayName: `Awaiting Customer With A Longer Name ${i}`,
          daysSinceSent: i,
        })),
        depositsPendingNamed: Array.from({ length: 60 }, (_, i) => ({
          displayName: `Deposit Customer With A Longer Name ${i}`,
          amountLabel: '$12,345',
        })),
        quotesToSendCount: 40,
        rebookDraftCount: 124,
        quotesAwaitingReplyCount: 60,
        changesRequestedCount: 5,
        depositsPendingCount: 60,
        inboxOpenCount: 200,
        inboxFilteredCount: 40,
        inboxFollowUpsDueCount: 60,
      },
      'https://quote.yulelovelights.com',
    );
    expect(msg.length).toBeLessThan(4096);
  });
});
