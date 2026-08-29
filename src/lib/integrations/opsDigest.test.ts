import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuoteListItem } from '@/lib/quotes';
import { BUSINESS_RULES } from '@/lib/pricing/pricingEngine';
import type { FulfillmentCard } from '@/lib/inventory/jobs';

// IO seams mocked; the collect filtering + the pure formatter run for real.
const { listQuotes, listFulfillmentCards, listOpenItems, listDueFollowUps, sbRef } = vi.hoisted(() => ({
  listQuotes: vi.fn(async (): Promise<unknown[]> => []),
  listFulfillmentCards: vi.fn(async (): Promise<unknown[]> => []),
  listOpenItems: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false })),
  listDueFollowUps: vi.fn(async (): Promise<unknown> => ({ ok: true, items: [], totalDue: 0, truncated: false })),
  sbRef: { current: null as unknown },
}));
vi.mock('@/lib/quotes', () => ({ listQuotes }));
vi.mock('@/lib/inventory/jobs', () => ({ listFulfillmentCards }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ listOpenItems, listDueFollowUps }));
// #229 FIX 1: fetchDepositAmounts' scoped quotes lookup — sbRef.current stays
// null by default (every deposit renders "amount unknown"); tests that need a
// real figure set sbRef.current to a fake client (see makeDepositClient).
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { collectOpsDigest, opsDigestMessage, timeExceptionsCountFromScan, type OpsDigestData } from './opsDigest';

/** Fake Supabase client for fetchDepositAmounts' `.from('quotes').select(...).in(...)`
 *  chain — the only shape opsDigest.ts's deposit lookup ever calls. */
function makeDepositClient(rows: { id: string; approval_snapshot: unknown }[] | null, error: { message: string } | null = null) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        in: (_col: string, _ids: string[]) => Promise.resolve({ data: rows, error }),
      }),
    }),
  };
}

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
  // Row 409: listQuotes now resolves every row's deposit rate; these fixtures
  // are not about deposits, so they take the business default.
  deposit_rate: BUSINESS_RULES.depositPercentage,
  deposit_rate_frozen: false,
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
  stockSnapshotPending: false,
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
  timeExceptionsCount: 0,
};

describe('timeExceptionsCountFromScan — the collector-side null-vs-zero decision', () => {
  it('a clean scan returns the count, including a real zero', () => {
    expect(timeExceptionsCountFromScan({ exceptions: [], errors: [] })).toBe(0);
    expect(timeExceptionsCountFromScan({ exceptions: [{}, {}], errors: [] })).toBe(2);
  });

  it('ANY scan error returns null, never a low count (an undercount reads as handled)', () => {
    expect(timeExceptionsCountFromScan({ exceptions: [{}, {}], errors: ['shifts query failed'] })).toBeNull();
    expect(timeExceptionsCountFromScan({ exceptions: [], errors: ['x'] })).toBeNull();
  });
});

describe('opsDigestMessage — stuck time records line (ops suggestions round)', () => {
  it('renders the line with the count and the time-tracking link when there are exceptions', () => {
    const msg = opsDigestMessage({ ...emptyData, timeExceptionsCount: 2 }, 'https://x.test');
    expect(msg).toContain('Stuck time records: 2');
    expect(msg).toContain('https://x.test/admin/time-tracking');
  });

  it('stays silent at zero (a clean morning stays clean)', () => {
    const msg = opsDigestMessage({ ...emptyData, timeExceptionsCount: 0 }, 'https://x.test');
    expect(msg).not.toContain('Stuck time records');
    expect(msg).not.toContain('/admin/time-tracking');
  });

  it('stays silent when the read failed (null must never render as a lying zero)', () => {
    const msg = opsDigestMessage({ ...emptyData, timeExceptionsCount: null }, 'https://x.test');
    expect(msg).not.toContain('Stuck time records');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  listQuotes.mockResolvedValue([]);
  listFulfillmentCards.mockResolvedValue([]);
  listOpenItems.mockResolvedValue({ ok: true, items: [], totalOpen: 0, totalLeads: 0, truncated: false });
  listDueFollowUps.mockResolvedValue({ ok: true, items: [], totalDue: 0, truncated: false });
  sbRef.current = null;
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
    listDueFollowUps.mockResolvedValue({ ok: true, items: [{}, {}, {}], totalDue: 3, truncated: false });
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
      totalDue: 1,
      truncated: false,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-04T12:00:00Z', // 2 ET calendar days before Aug 6
          contactName: 'Sam Overdue',
          contactPhone: null,
          contactEmail: null,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Sam Overdue', daysOverdue: 2 }]);
  });

  // #229 FIX 3: an earlier round filtered a "legacy-rebook-anchored" follow-up
  // out of the named list — that state is structurally IMPOSSIBLE (a
  // quote_sent_no_reply follow-up only ever exists when quote_sent_at IS SET,
  // which is mutually exclusive with the "parked draft" predicate the filter
  // required; confirmed empirically against prod). A follow-up linked to a
  // legacy_rebook quote is for a SENT Neighbor quote — a real customer
  // genuinely owed a reply — so it now appears by name like any other, and
  // the named list always matches the count exactly (same rows, no filter).
  it('never filters a legacy_rebook-linked follow-up out of the named list — the list matches the count exactly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      totalDue: 2,
      truncated: false,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-05T12:00:00Z',
          contactName: 'YLL Neighbor Lead',
          contactPhone: null,
          contactEmail: null,
        },
        {
          id: 'f2',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-05T12:00:00Z',
          contactName: 'Real Customer',
          contactPhone: null,
          contactEmail: null,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBe(2);
    expect(data.overdueFollowUps).toEqual([
      { displayName: 'YLL Neighbor Lead', daysOverdue: 1 },
      { displayName: 'Real Customer', daysOverdue: 1 },
    ]);
  });

  // Row 391 fix round (admin lens MED): the named list's own "+N more" trailer
  // was computed from the page array, so a digest could read "137 follow-ups
  // due" above five names and "+95 more" — accounting for 100 and silently
  // dropping 37. It now counts against the real total printed on the line above.
  it('the named list overflow counts against the REAL total, not the capped page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T11:30:00Z'));
    const item = (i: number) => ({
      id: `f${i}`,
      reason: 'quote_sent_no_reply',
      dueAt: '2026-08-05T12:00:00Z',
      contactName: `Person ${i}`,
      contactPhone: null,
      contactEmail: null,
    });
    listDueFollowUps.mockResolvedValue({
      ok: true,
      totalDue: 137,
      truncated: true,
      items: Array.from({ length: 8 }, (_, i) => item(i)),
    });
    const data = await collectOpsDigest();
    const msg = opsDigestMessage(data, 'https://x');
    expect(msg).toContain('137 follow-ups due');
    // 137 due, NAMED_LIST_CAP names printed — the trailer covers the rest.
    const shown = (msg.match(/• Person \d+ —/g) ?? []).length;
    expect(msg).toContain(`+${137 - shown} more`);
    expect(msg).not.toContain(`+${8 - shown} more`);
  });

  // Row 391: the named list is capped at listDueFollowUps' page size, but the
  // COUNT must be the real total. Before this, the digest read the count off
  // items.length, so a backlog past the cap reported a flat "100 due" forever
  // and disagreed with the inbox strip's own "N more not shown".
  it('reports the REAL due count even when the named list is capped below it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T11:30:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      totalDue: 137,
      truncated: true,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          dueAt: '2026-08-05T12:00:00Z',
          contactName: 'Sam Overdue',
          contactPhone: null,
          contactEmail: null,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.inboxFollowUpsDueCount).toBe(137);
    expect(data.overdueFollowUps).toHaveLength(1); // the NAMED list stays the page
  });

  it('falls back name -> phone -> email -> "(no name)" for a nameless follow-up contact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T15:00:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      totalDue: 3,
      truncated: false,
      items: [
        { id: 'f1', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: '+16315551234', contactEmail: 'lead@x.com' },
        { id: 'f2', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: null, contactEmail: 'onlyemail@x.com' },
        { id: 'f3', reason: 'x', dueAt: '2026-08-05T12:00:00Z', contactName: null, contactPhone: null, contactEmail: null },
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
      totalDue: 1,
      truncated: false,
      items: [{ id: 'f1', reason: 'x', dueAt: 'not-a-date', contactName: 'Bad Date Bob', contactPhone: null, contactEmail: null }],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Bad Date Bob', daysOverdue: 0 }]);
  });

  // #229 FIX 2: the 7:30am ET cron boundary. A follow-up due 8pm ET the
  // PRIOR calendar day is only ~11.5 elapsed hours before 7:30am ET today —
  // an elapsed-ms/24h-block count (the old daysBetween) floors that to 0
  // ("due today"), but it already crossed an ET midnight, so the calendar-day
  // rule that put the row in the list (isDueToday) already calls it a day
  // overdue. The displayed number must agree with the rule that selected it.
  it('reads "1 day overdue" (not "due today") for a follow-up due yesterday evening ET, at the 7:30am ET cron boundary', async () => {
    vi.useFakeTimers();
    // 7:30am EDT (UTC-4) on Aug 6.
    vi.setSystemTime(new Date('2026-08-06T11:30:00Z'));
    listDueFollowUps.mockResolvedValue({
      ok: true,
      totalDue: 1,
      truncated: false,
      items: [
        {
          id: 'f1',
          reason: 'quote_sent_no_reply',
          // 8:00pm EDT on Aug 5 == 2026-08-06T00:00:00Z — only 11.5 elapsed
          // hours before 7:30am ET today, but a DIFFERENT ET calendar day.
          dueAt: '2026-08-06T00:00:00Z',
          contactName: 'Boundary Bea',
          contactPhone: null,
          contactEmail: null,
        },
      ],
    });
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toEqual([{ displayName: 'Boundary Bea', daysOverdue: 1 }]);
    const msg = opsDigestMessage(data, 'https://x');
    expect(msg).toContain('• Boundary Bea — 1 day overdue');
    expect(msg).not.toContain('Boundary Bea — due today');
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

  // ── Deposits pending (from listQuotes + fetchDepositAmounts) ────────────────
  //
  // #229 FIX 1: the rendered amount is the DEPOSIT owed
  // (approval_snapshot.customerSelection.currentDepositUsd, via a scoped
  // fetchDepositAmounts lookup), NOT `q.total` (the full quote — roughly
  // double the real figure). sbRef.current supplies the scoped lookup's fake
  // Supabase client.

  it('lists deposits pending by name and the DEPOSIT amount (not the full quote total)', async () => {
    listQuotes.mockResolvedValue([
      // total is $5,000 — if this rendered `total` it would show "$5,000",
      // roughly double the real $2,500 deposit.
      quote({ id: 'q1', customer_name: 'Approved Amy', customer_approved_at: '2026-07-10T00:00:00Z', total: 5000 }),
    ]);
    sbRef.current = makeDepositClient([
      { id: 'q1', approval_snapshot: { customerSelection: { currentDepositUsd: 2500 } } },
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Approved Amy', amountLabel: '$2,500' }]);
  });

  it('renders "amount unknown" — never "$0" — when the deposit lookup has no snapshot for the quote', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'No Snapshot Nick', customer_approved_at: '2026-07-10T00:00:00Z', total: 2500 }),
    ]);
    sbRef.current = makeDepositClient([{ id: 'q1', approval_snapshot: null }]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'No Snapshot Nick', amountLabel: 'amount unknown' }]);
  });

  it('renders "amount unknown" (never $0, never `total`) when the deposit lookup itself fails or is unconfigured', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Lookup Failed Fred', customer_approved_at: '2026-07-10T00:00:00Z', total: 3000 }),
    ]);
    // sbRef.current stays null (the beforeEach default) — Supabase unconfigured.
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Lookup Failed Fred', amountLabel: 'amount unknown' }]);
  });

  it('renders an actual $0 deposit as "$0", distinct from a missing/unknown one', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Zero Deposit', customer_approved_at: '2026-07-10T00:00:00Z', total: 500 }),
    ]);
    sbRef.current = makeDepositClient([
      { id: 'q1', approval_snapshot: { customerSelection: { currentDepositUsd: 0 } } },
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Zero Deposit', amountLabel: '$0' }]);
  });

  it('sorts deposits pending oldest-approved-first (longest pending survives the cap) — the count line is unaffected by the deposit lookup', async () => {
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Newer', customer_approved_at: '2026-07-15T00:00:00Z', total: 1000 }),
      quote({ id: 'q2', customer_name: 'Older', customer_approved_at: '2026-07-01T00:00:00Z', total: 2000 }),
    ]);
    const data = await collectOpsDigest();
    expect(data.depositsPendingNamed.map((d) => d.displayName)).toEqual(['Older', 'Newer']);
    // FIX 1's own re-check: the deposit-amount change must never alter the
    // COUNT line — it's computed independently of the deposit lookup.
    expect(data.depositsPendingCount).toBe(2);
  });

  // ── Fail-soft isolation (requirement 7 / "Done looks like" #5) ─────────────

  it('a due-follow-ups read failure degrades ONLY that section — quote-derived named lists + the heartbeat still render', async () => {
    listDueFollowUps.mockRejectedValue(new Error('boom'));
    listQuotes.mockResolvedValue([
      quote({ id: 'q1', customer_name: 'Still Here', customer_approved_at: '2026-07-10T00:00:00Z', total: 500 }),
    ]);
    sbRef.current = makeDepositClient([
      { id: 'q1', approval_snapshot: { customerSelection: { currentDepositUsd: 250 } } },
    ]);
    const data = await collectOpsDigest();
    expect(data.overdueFollowUps).toBeNull();
    expect(data.depositsPendingNamed).toEqual([{ displayName: 'Still Here', amountLabel: '$250' }]);
    const msg = opsDigestMessage(data, 'https://x');
    expect(msg).toContain('Still Here');
    expect(msg).toContain('☀️ YLL morning digest'); // heartbeat unaffected
  });

  // #229 FIX 1's own fail-soft leg: the deposit-amount lookup erroring must
  // degrade to "amount unknown" per row, never throw and never block the
  // rest of the section/message.
  it('a deposit-amount lookup error degrades to "amount unknown" — never throws, never blocks the send', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      listQuotes.mockResolvedValue([
        quote({ id: 'q1', customer_name: 'Lookup Error Liz', customer_approved_at: '2026-07-10T00:00:00Z', total: 1000 }),
      ]);
      sbRef.current = makeDepositClient(null, { message: 'connection reset' });
      const data = await collectOpsDigest();
      expect(data.depositsPendingNamed).toEqual([{ displayName: 'Lookup Error Liz', amountLabel: 'amount unknown' }]);
      const msg = opsDigestMessage(data, 'https://x');
      expect(msg).toContain('☀️ YLL morning digest');
    } finally {
      consoleErrorSpy.mockRestore();
    }
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

  // ── #229: named-list capping (the pipeline sections only, #229 FIX 4) ──────

  it('caps every PIPELINE named list at 5 with an exact "+N more", while header counts stay the TRUE totals', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        overdueFollowUps: Array.from({ length: 7 }, (_, i) => ({ displayName: `Overdue${i + 1}`, daysOverdue: i })),
        awaitingReplyNamed: Array.from({ length: 9 }, (_, i) => ({ displayName: `Wait${i + 1}`, daysSinceSent: i })),
        depositsPendingNamed: Array.from({ length: 6 }, (_, i) => ({ displayName: `Dep${i + 1}`, amountLabel: `$${i + 1}` })),
      },
      'https://x',
    );
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

  // #229 FIX 4: installs were wrongly capped in round 2 — the length pressure
  // that justified it didn't exist, and they're the day's real, bounded crew
  // work, not an open-ended pipeline. Locks in the revert: ALL of them render,
  // no overflow marker, even well past the pipeline lists' cap of 5.
  it('never caps installs — every job for the day renders by name, no overflow marker', () => {
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: Array.from({ length: 8 }, (_, i) => ({
          jobNumber: i,
          customerName: `Cust${i}`,
          stageLabel: 'Scheduled',
          isTest: false,
        })),
      },
      'https://x',
    );
    expect(msg).toContain('🔧 Installs — today: 8 · tomorrow: 0');
    for (let i = 0; i < 8; i++) expect(msg).toContain(`Cust${i}`);
    expect(msg).not.toMatch(/\+\d+ more/);
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

  // #229 FIX 4: installs are UNCAPPED, so a heavy-day stress test must use a
  // realistic (still generous) crew-capacity number for them — a lighting
  // installer genuinely bounded by trucks/crews, not an open-ended pipeline
  // like the follow-up/reply/deposit backlogs, which this test still stresses
  // at 60 rows each (well past anything realistic) to prove the CAP, not the
  // install count, is what keeps the message bounded.
  it('stays well under Telegram\'s 4096-char limit even on a heavy day (a realistic-but-busy install day + a stress-tested pipeline backlog)', () => {
    const install = (i: number) => ({
      jobNumber: i,
      customerName: `Customer With A Fairly Long Name Number ${i}`,
      stageLabel: 'Ready For Install',
      isTest: false,
    });
    const msg = opsDigestMessage(
      {
        ...emptyData,
        installsToday: Array.from({ length: 15 }, (_, i) => install(i)),
        installsTomorrow: Array.from({ length: 10 }, (_, i) => install(i)),
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
