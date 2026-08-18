import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ingestTouch, planIngest } from './store';
import type { ExistingItem } from './store';
import type { NormalizedTouch, StoredContact } from './types';
import { quoteFollowUpDecision } from './quotetool';
import type { DashboardQuote } from '@/lib/dashboard/types';
import { buildInboxSummary } from './summary';

const T = new Date('2026-06-28T15:00:00Z');
const at = (ms: number) => new Date(T.getTime() + ms);
const HOUR = 3_600_000;

function touch(over: Partial<NormalizedTouch> = {}): NormalizedTouch {
  return {
    source: 'ghl',
    externalId: 'conv-1',
    direction: 'inbound',
    channel: 'sms',
    lastMessageAt: T,
    preview: 'hello',
    identity: { ghlContactId: 'g1', emails: ['jane@example.com'], phones: [], displayName: 'Jane' },
    ...over,
  };
}
function contact(over: Partial<StoredContact>): StoredContact {
  return { id: 'c1', ghlContactId: null, emails: [], phones: [], displayName: null, ...over };
}

describe('planIngest — new conversation, no existing item', () => {
  it('plans a fresh contact insert + an unresponded item when nobody matches', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(2 * HOUR) });
    expect(plan.contactOp.kind).toBe('insert');
    expect(plan.ambiguous).toBe(false);
    expect(plan.item.status).toBe('unresponded');
    expect(plan.item.source).toBe('ghl');
    expect(plan.item.external_id).toBe('conv-1');
    expect(plan.item.escalation_level).toBe(1); // display level for sorting/colour
    expect(plan.item.last_message_at).toBe(T.toISOString()); // serialized ISO
  });

  it('plans a contact UPDATE (append identifiers) when one candidate matches', () => {
    const candidate = contact({ id: 'A', emails: ['jane@example.com'] });
    const plan = planIngest({ candidates: [candidate], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.contactOp.kind).toBe('update');
    if (plan.contactOp.kind === 'update') {
      expect(plan.contactOp.contactId).toBe('A');
      expect(plan.contactOp.merged.ghlContactId).toBe('g1'); // appended from the touch
      expect(plan.contactOp.merged.emails).toContain('jane@example.com');
    }
  });

  it('inserts a FRESH contact (never auto-merges) and flags ambiguous when identifiers split across two contacts', () => {
    const candidates = [
      contact({ id: 'A', emails: ['jane@example.com'] }),
      contact({ id: 'B', phones: ['+16315551234'] }),
    ];
    const plan = planIngest({
      candidates,
      existing: null,
      touch: touch({ identity: { ghlContactId: null, emails: ['jane@example.com'], phones: ['631-555-1234'] } }),
      now: at(HOUR),
    });
    expect(plan.ambiguous).toBe(true);
    expect(plan.contactOp.kind).toBe('insert');
  });
});

describe('planIngest — existing item keeps its contact link', () => {
  it('keeps the linked contact and reopens a handled item on new inbound', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'handled', notifiedLevels: [1, 2], lastMessageAt: null };
    const plan = planIngest({ candidates: [], existing, touch: touch(), now: at(10 * 60_000) });
    expect(plan.contactOp.kind).toBe('keep');
    if (plan.contactOp.kind === 'keep') expect(plan.contactOp.contactId).toBe('A');
    expect(plan.reopened).toBe(true);
    expect(plan.item.status).toBe('unresponded');
    expect(plan.item.notified_levels).toEqual([]); // escalation clock reset
  });

  it('auto-resolves on an outbound touch', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [1], lastMessageAt: null };
    const plan = planIngest({ candidates: [], existing, touch: touch({ direction: 'outbound' }), now: at(6 * HOUR) });
    expect(plan.item.status).toBe('handled');
    expect(plan.autoResolved).toBe(true);
    expect(plan.skip).toBe(false); // existing item → must persist the auto-resolve
  });
});

describe('planIngest — skip outbound-with-no-existing (avoid noise)', () => {
  it('skips an outbound touch that has no existing item (we cold-contacted; nothing to track)', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch({ direction: 'outbound' }), now: at(HOUR) });
    expect(plan.skip).toBe(true);
  });
  it('still skips a gmail outbound touch that has no existing item', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch({ source: 'gmail', externalId: 'thread-1', direction: 'outbound' }), now: at(HOUR) });
    expect(plan.skip).toBe(true);
  });
  it('does NOT skip a quotetool outbound-first touch, and auto-resolves it handled', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ source: 'quotetool', externalId: 'quote-1', direction: 'outbound', channel: 'app' }),
      now: at(HOUR),
    });
    expect(plan.skip).toBe(false);
    expect(plan.item.status).toBe('handled');
    expect(plan.item.escalation_level).toBe(0);
    expect(plan.autoResolved).toBe(true);
  });
  // #252 slice F: GHL's 'call' channel gets the same outbound-first-observation
  // exception as quotetool above — a placed call (answered or no-answer, see
  // ghl.ts) is a deliberate reach-out worth a "we reached out" record, unlike a
  // cold outbound text/email blast. Channel-scoped, not source-scoped: the sms
  // test above (line 89, default channel 'sms') and the gmail test above prove
  // the narrow scope holds — only ghl+call is exempted, everything else on ghl
  // (and every other source) still skips as noise.
  it('does NOT skip a ghl outbound CALL touch with no existing item, and auto-resolves it handled (#252 slice F)', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ direction: 'outbound', channel: 'call' }),
      now: at(HOUR),
    });
    expect(plan.skip).toBe(false);
    expect(plan.skipReason).toBeNull();
    expect(plan.item.status).toBe('handled');
    expect(plan.item.channel).toBe('call');
    expect(plan.item.direction).toBe('outbound');
    expect(plan.autoResolved).toBe(true);
  });
  // #252 slice F fix round (MED, technical lens): reachable today via any
  // unmapped GHL lastMessageType (e.g. TYPE_CAMPAIGN_EMAIL) sent outbound —
  // ghl.ts's channelOf returns null for anything not in CHANNEL_BY_TYPE.
  // Pins tracksOutboundFirstObservation's channel check to EXACT equality
  // ('call'), not a truthy/startsWith match — nothing else pinned this before,
  // so a future widening of the check would have shipped silently.
  it('still skips a ghl outbound touch with channel:null (an unmapped GHL type) — the call-channel exception does not fire on null', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ direction: 'outbound', channel: null }),
      now: at(HOUR),
    });
    expect(plan.skip).toBe(true);
    expect(plan.skipReason).toBe('cold-outbound');
  });
  it('never skips an inbound touch', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.skip).toBe(false);
  });
});

// #252: the opposite-polarity twin of the block above. An activity-noise
// touch (isActivityNoise) must NEVER be skipped when there is no existing
// item (a conversation's first-ever touch must always be observable, even
// when GHL's rolled-up latest-event snapshot is pure CRM activity) — but MUST
// be skipped when an item already exists, so noise can't bump/reopen it.
describe('planIngest — GHL activity-noise touch skip (#252, opposite polarity)', () => {
  it('does NOT skip an activity-noise touch with no existing item (must never swallow a first touch)', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ isActivityNoise: true, direction: null, channel: null, preview: null }),
      now: at(HOUR),
    });
    expect(plan.skip).toBe(false);
    expect(plan.skipReason).toBeNull();
    expect(plan.contactOp.kind).toBe('insert'); // the conversation actually gets ingested
  });

  it('skips an activity-noise touch that HAS an existing item (never lets noise bump a real conversation), labeled skipReason "activity-noise-existing"', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ isActivityNoise: true, lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.skip).toBe(true);
    expect(plan.skipReason).toBe('activity-noise-existing');
  });

  // Only sound PAIRED with the test above (proves reason 2 exists at all) —
  // this one alone would also pass an implementation that omits reason 2
  // entirely, since it never exercises the noise+existing combination.
  it('does not skip a normal (non-noise) inbound touch on an existing item, even though existing is truthy', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ isActivityNoise: false, lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.skip).toBe(false);
    expect(plan.skipReason).toBeNull();
  });

  // #252 delta-verify MEDIUM: a touch can be BOTH activity-noise AND
  // cold-outbound-with-no-existing-item at once (live GHL data shows
  // direction varies independently of message type). That must resolve to
  // reason 1 (cold-outbound skip), never reason 2 — touch.isActivityNoise
  // being true is NOT sufficient on its own to imply the #252 reason fired.
  it('labels a cold-outbound activity-noise touch (no existing item) skipReason "cold-outbound", not "activity-noise-existing"', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ isActivityNoise: true, direction: 'outbound' }),
      now: at(HOUR),
    });
    expect(plan.skip).toBe(true); // reason 1 still applies
    expect(plan.skipReason).toBe('cold-outbound');
  });
});

// ─── planIngest — new fields flow through ────────────────────────────────────

describe('planIngest — leadKind + quoteValue thread through to item row', () => {
  it('defaults lead_kind to "lead" when the touch omits leadKind', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.item.lead_kind).toBe('lead');
    expect(plan.item.quote_value).toBeNull();
  });

  it('carries leadKind "automated" and quoteValue through to the item row', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ leadKind: 'automated', quoteValue: 2218.5 }),
      now: at(HOUR),
    });
    expect(plan.item.lead_kind).toBe('automated');
    expect(plan.item.quote_value).toBe(2218.5);
  });

  it('carries leadKind "lead" and a null quoteValue explicitly set', () => {
    const plan = planIngest({
      candidates: [],
      existing: null,
      touch: touch({ leadKind: 'lead', quoteValue: null }),
      now: at(HOUR),
    });
    expect(plan.item.lead_kind).toBe('lead');
    expect(plan.item.quote_value).toBeNull();
  });
});

// ─── planIngest — noopReingest (#110 W7-004 write-amplification) ──────────────

describe('planIngest — noopReingest short-circuits dead re-ingests', () => {
  const resolved = (status: 'handled' | 'completed' | 'dismissed'): ExistingItem => ({
    id: 'i1',
    contactId: 'A',
    status,
    notifiedLevels: [],
    lastMessageAt: T,
  });

  it('re-ingesting our own outbound on an already-handled item (same last_message_at) is a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('handled'),
      touch: touch({ direction: 'outbound', lastMessageAt: T }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(true);
    expect(plan.autoResolved).toBe(false);
  });

  it('re-ingesting a completed item with the same message is a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('completed'),
      touch: touch({ direction: 'outbound', lastMessageAt: T }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(true);
  });

  it('a genuinely-new inbound that REOPENS a handled item is NOT a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: resolved('handled'),
      touch: touch({ direction: 'inbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.reopened).toBe(true);
    expect(plan.noopReingest).toBe(false);
  });

  it('the FIRST outbound that auto-resolves an unresponded item is NOT a no-op', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'outbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.autoResolved).toBe(true);
    expect(plan.noopReingest).toBe(false);
  });

  it('an unresponded item re-ingested with the same message is NOT a no-op (escalation colour ages)', () => {
    const existing: ExistingItem = { id: 'i1', contactId: 'A', status: 'unresponded', notifiedLevels: [], lastMessageAt: T };
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'inbound', lastMessageAt: T }),
      now: at(5 * HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  it('a brand-new conversation (no existing item) is NOT a no-op', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.noopReingest).toBe(false);
  });
});

// ─── listOpenItems — I/O layer (mocked Supabase) ─────────────────────────────
//
// listOpenItems makes TWO sequential calls to sb.from('inbox_items'):
//   1. The main select (with .eq/.order/.limit)
//   2. The returning-proxy count (.in('contact_id', [...]).select('contact_id'))
//
// We mock @/lib/supabase so getSupabaseServiceClient() returns a controlled fake.
// Each call to .from('inbox_items') gets its own builder; we track call order with
// a counter so we can return different data per call.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => null,
}));

import {
  closeFollowUpsForResolvedItem,
  closeQuoteInboxNoise,
  dismissItem,
  ensureFollowUp,
  EXCLUDE_LEGACY_REBOOK_FROM_INBOX,
  excludeLegacyRebookItems,
  findOrphanedFollowUpItems,
  findViewOnlyFollowUpItems,
  getReopenCounts,
  isHiddenLegacyRebookQuote,
  listDueFollowUps,
  listInWorks,
  listOpenItems,
  listEscalatableItems,
  markFollowUpDone,
  markItemCompleted,
  markItemHandledLocal,
  quoteIdPrefix,
  recordSuppressedFollowUp,
  sweepOrphanedFollowUps,
  sweepResolvedItemFollowUps,
} from './store';

/** Build a Supabase chain stub where the terminal await returns `result`.
 *  All intermediate chaining methods (select, eq, order, limit, in, or, is) return
 *  `self` so callers can chain freely. The spy arrays let us assert on what was called. */
function makeBuilder(result: { data: unknown; error: null | { message: string }; count?: number | null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const self: Record<string, unknown> = {};
  // #185: 'not' and 'gte' added for getReopenCounts (dashboard_activity's
  // .not('inbox_item_id','is',null) + .gte('created_at', sinceIso)) and
  // listInWorks (.not('followed_up_at','is',null) / .not('status','in',...)).
  // #208: 'neq' added for markItemHandledLocal/dismissItem's double-apply guard
  // (.neq('status','handled'|'dismissed')).
  for (const m of ['select', 'eq', 'neq', 'order', 'limit', 'in', 'or', 'is', 'update', 'not', 'gte', 'insert']) {
    self[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return self;
    };
  }
  // Terminal await — vitest resolves a thenable.
  self.then = (resolve: (v: unknown) => void) => resolve(result);
  // #208: explicit terminal .maybeSingle() (markItemHandledLocal/dismissItem's
  // priorStateOf + update...select...maybeSingle chains call this directly
  // rather than awaiting the builder itself).
  self.maybeSingle = async () => result;
  return { builder: self, calls };
}

// ─── excludeLegacyRebookItems — #157 (pure) ──────────────────────────────────

describe('excludeLegacyRebookItems (#157 — YLL Neighbors inbox exclusion)', () => {
  it('the reversible seam defaults ON (excluding legacy-rebook items from the inbox)', () => {
    expect(EXCLUDE_LEGACY_REBOOK_FROM_INBOX).toBe(true);
  });

  it('drops a quotetool item whose external_id is a legacy_rebook quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-legacy' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toHaveLength(0);
  });

  it('keeps a quotetool item whose external_id is NOT a legacy_rebook quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-normal' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toEqual(items);
  });

  it('never touches a non-quotetool item, even if its external_id collides with a legacy quote id', () => {
    const items = [
      { source: 'ghl', external_id: 'quote-legacy' },
      { source: 'gmail', external_id: 'quote-legacy' },
      { source: 'homeworks', external_id: 'quote-legacy' },
    ];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toEqual(items);
  });

  it('passes every item through unchanged when legacyQuoteIds is empty', () => {
    const items = [
      { source: 'quotetool', external_id: 'q1' },
      { source: 'ghl', external_id: 'msg-1' },
    ];
    const result = excludeLegacyRebookItems(items, new Set());
    expect(result).toEqual(items);
  });

  it('filters a mixed batch: legacy quotetool dropped, normal quotetool + other sources kept', () => {
    const items = [
      { source: 'quotetool', external_id: 'quote-legacy' },
      { source: 'quotetool', external_id: 'quote-normal' },
      { source: 'ghl', external_id: 'ghl-msg-1' },
    ];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result.map((i) => i.external_id)).toEqual(['quote-normal', 'ghl-msg-1']);
  });

  // #183 BUG 1: a :color-request-suffixed item belonging to a legacy quote must
  // ALSO be excluded, not just its bare-id sibling.
  it('drops a :color-request-suffixed item whose PREFIX is a legacy_rebook quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-legacy:color-request' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toHaveLength(0);
  });

  it('keeps a :color-request-suffixed item whose prefix is NOT a legacy quote', () => {
    const items = [{ source: 'quotetool', external_id: 'quote-normal:color-request' }];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result).toEqual(items);
  });

  it('drops both the plain legacy row AND its suffixed sibling from the same batch', () => {
    const items = [
      { source: 'quotetool', external_id: 'quote-legacy' },
      { source: 'quotetool', external_id: 'quote-legacy:color-request' },
      { source: 'quotetool', external_id: 'quote-normal' },
    ];
    const result = excludeLegacyRebookItems(items, new Set(['quote-legacy']));
    expect(result.map((i) => i.external_id)).toEqual(['quote-normal']);
  });
});

// ─── isHiddenLegacyRebookQuote — #252 slice G (pure) ─────────────────────────

describe('isHiddenLegacyRebookQuote (#252 slice G — narrowed to genuine unsent drafts; #263 re-export of the shared isParkedLegacyRebookDraft predicate)', () => {
  it('hides an unsent, still-DRAFT legacy_rebook quote', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(true);
  });

  it('does NOT hide a SENT legacy_rebook quote', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'sent',
        quote_sent_at: '2026-07-01T00:00:00Z',
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(false);
  });

  it('does NOT hide an APPROVED legacy_rebook quote', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'approved',
        quote_sent_at: '2026-07-01T00:00:00Z',
        customer_approved_at: '2026-07-02T00:00:00Z',
        deposit_paid_at: null,
      }),
    ).toBe(false);
  });

  // #252 refinement: 3 prod rows are booked with quote_sent_at IS NULL — a
  // naive "unsent = hidden" predicate would wrongly hide these. #263: what
  // actually keeps a booked row visible now is deposit_paid_at (what
  // deriveStatus reads for 'booked'), not the persisted status string itself
  // — verified every real prod row with status='booked' also carries
  // deposit_paid_at (2026-08-13, all 14 rows), so this fixture now carries
  // the timestamp that genuinely backs a booked row rather than only the label.
  it('does NOT hide a BOOKED legacy_rebook quote even though quote_sent_at is null', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'booked',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: '2026-07-01T00:00:00Z',
      }),
    ).toBe(false);
  });

  // #263 BEHAVIOR CHANGE from the old raw-status check: deriveStatus does not
  // trust a persisted 'booked' status string over the timestamps (see its own
  // doc comment), so a status='booked' row with NOTHING backing it (no
  // deposit_paid_at/customer_approved_at/viewed_at/quote_sent_at) now derives
  // 'draft' and IS hidden. 0 real prod rows have this shape today (every
  // status='booked' legacy_rebook row carries deposit_paid_at) — this pins the
  // new, intentional behavior rather than leaving it undocumented.
  it('DOES hide a legacy_rebook quote whose persisted status says booked but nothing backs it (unreached in prod today)', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'booked',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(true);
  });

  it('does NOT hide a non-legacy_rebook draft, even if unsent', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: false,
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(false);
  });

  it('does NOT hide a legacy_rebook quote with a null legacy_rebook read (defensive)', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: null,
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(false);
  });

  // Null-status edge (#263): a legacy row with no persisted status at all
  // (0 rows today, but deriveStatus's own fallback path) still derives
  // 'draft' when nothing else is set, so it's correctly hidden.
  it('hides a legacy_rebook quote with a null persisted status and no timestamps (deriveStatus falls back to draft)', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: null,
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
      }),
    ).toBe(true);
  });

  // #267(b): a legacy_rebook row that's actually been PAID must never be
  // hidden, even if its persisted status column never advanced off 'draft' —
  // the exact live-money shape #267(b) named (0 prod rows today; structural
  // fix, not an active incident).
  it('does NOT hide a paid legacy_rebook quote even though its persisted status is still draft (#267b)', () => {
    expect(
      isHiddenLegacyRebookQuote({
        legacy_rebook: true,
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: '2026-08-01T00:00:00Z',
      }),
    ).toBe(false);
  });
});

describe('quoteIdPrefix (#183 BUG 1)', () => {
  it('returns the id unchanged when there is no colon suffix', () => {
    expect(quoteIdPrefix('quote-1')).toBe('quote-1');
  });

  it('strips a :color-request suffix', () => {
    expect(quoteIdPrefix('quote-1:color-request')).toBe('quote-1');
  });

  it('strips a real-uuid-shaped id the same way', () => {
    expect(quoteIdPrefix('123e4567-e89b-12d3-a456-426614174000:color-request')).toBe(
      '123e4567-e89b-12d3-a456-426614174000',
    );
  });
});

describe('listOpenItems — select string, sort order, and field mapping', () => {
  beforeEach(() => {
    // Reset between tests.
    sbRef.current = null;
  });

  it('includes lead_kind and quote_value in the select string and sorts ascending (oldest-first)', async () => {
    const { builder: mainBuilder, calls: mainCalls } = makeBuilder({ data: [], error: null });
    // Second query (returning proxy) returns empty when no contact_ids.
    // With empty data the second from() is never called; this branch is fine.
    sbRef.current = {
      from: (_table: string) => mainBuilder,
    };

    const result = await listOpenItems(50);
    expect(result.ok).toBe(true);

    const selectCall = mainCalls.find((c) => c.method === 'select');
    expect(selectCall).toBeDefined();
    const selectStr = selectCall!.args[0] as string;
    expect(selectStr).toContain('lead_kind');
    expect(selectStr).toContain('quote_value');

    const orderCall = mainCalls.find((c) => c.method === 'order');
    expect(orderCall).toBeDefined();
    expect(orderCall!.args[1]).toEqual({ ascending: true });
  });

  it('maps lead_kind "automated" and quote_value to OpenInboxItem fields', async () => {
    const row = {
      id: 'item-1',
      source: 'ghl',
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-06-28T15:00:00Z',
      preview: 'test preview',
      subject: null,
      escalation_level: 1,
      contact_id: 'c-42',
      lead_kind: 'automated',
      quote_value: 2218.5,
      dashboard_contacts: { display_name: 'Jane', primary_email: 'j@example.com', primary_phone: null, assigned_to: null },
    };

    // First call: main list — returns one row with contact_id 'c-42'.
    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });

    // Second call: returning proxy — returns two rows for 'c-42' (so it IS returning).
    const { builder: countBuilder } = makeBuilder({
      data: [{ contact_id: 'c-42' }, { contact_id: 'c-42' }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : countBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow type

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.leadKind).toBe('automated');
    expect(item.quoteValue).toBe(2218.5);
    expect(item.isReturning).toBe(true); // two rows for the same contact_id → returning
  });

  it('maps lead_kind null (or unknown) to "lead" and isReturning false for unlinked item', async () => {
    const row = {
      id: 'item-2',
      source: 'ghl',
      channel: 'email',
      direction: 'inbound',
      last_message_at: '2026-06-28T10:00:00Z',
      preview: null,
      subject: 'Inquiry',
      escalation_level: 0,
      contact_id: null, // unlinked
      lead_kind: null,
      quote_value: null,
      dashboard_contacts: null,
    };

    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });
    // No contact_ids → second query never fires.
    sbRef.current = { from: (_table: string) => mainBuilder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.items[0];
    expect(item.leadKind).toBe('lead'); // null → default 'lead'
    expect(item.quoteValue).toBeNull();
    expect(item.isReturning).toBe(false); // no contact_id
  });

  it('filters out followed items via .is("followed_up_at", null)', async () => {
    const { builder: mainBuilder, calls: mainCalls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: (_table: string) => mainBuilder };

    const result = await listOpenItems(50);
    expect(result.ok).toBe(true);

    const isCall = mainCalls.find((c) => c.method === 'is');
    expect(isCall).toBeDefined();
    expect(isCall!.args[0]).toBe('followed_up_at');
    expect(isCall!.args[1]).toBeNull();
  });

  // #185: the returning-customer contact-count query was UNBOUNDED (every
  // historical inbox_items row for the page's contacts, any status/time).
  // Assert the bound is actually wired, not just documented.
  it('bounds the returning-customer contact-count query with a limit (#185 — was unbounded)', async () => {
    const row = {
      id: 'item-1',
      source: 'ghl',
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-06-28T15:00:00Z',
      preview: 'test preview',
      subject: null,
      escalation_level: 1,
      contact_id: 'c-42',
      lead_kind: 'lead',
      quote_value: null,
      dashboard_contacts: null,
    };
    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });
    const { builder: countBuilder, calls: countCalls } = makeBuilder({ data: [{ contact_id: 'c-42' }], error: null });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : countBuilder;
      },
    };

    await listOpenItems(100);

    const limitCall = countCalls.find((c) => c.method === 'limit');
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBe(5000);
  });
});

// ─── getReopenCounts — window pairs run concurrently (#185) ─────────────────
//
// Was a strictly-sequential for-loop (3 windows x 2 actions = 6 round-trips,
// one at a time). Now all 6 distinct() calls fire via nested Promise.all.
// Call order stays deterministic (keys.map + the array-literal argument order
// to Promise.all both evaluate left-to-right): for [all, 90, 30], each window
// is [handled, reopened] — so a call-index-keyed dataset still lets us assert
// correctness without needing to inspect real concurrency timing.

describe('getReopenCounts — window pairs run concurrently (#185)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('returns Supabase-not-configured zeros for all three windows when unconfigured', async () => {
    const result = await getReopenCounts(new Date('2026-07-30T00:00:00Z'));
    expect(result).toEqual({
      all: { handled: 0, reopened: 0 },
      '90': { handled: 0, reopened: 0 },
      '30': { handled: 0, reopened: 0 },
    });
  });

  it('assembles correct DISTINCT handled/reopened counts per window from the 6 parallel calls', async () => {
    // Call order: all-handled, all-reopened, 90-handled, 90-reopened, 30-handled, 30-reopened.
    const datasets = [
      [{ inbox_item_id: 'a1' }, { inbox_item_id: 'a2' }], // all: handled -> 2 distinct
      [{ inbox_item_id: 'b1' }], // all: reopened -> 1 distinct
      [{ inbox_item_id: 'c1' }, { inbox_item_id: 'c1' }], // 90: handled -> 1 distinct (duplicate id)
      [], // 90: reopened -> 0
      [{ inbox_item_id: 'd1' }, { inbox_item_id: 'd2' }, { inbox_item_id: 'd3' }], // 30: handled -> 3
      [{ inbox_item_id: 'e1' }], // 30: reopened -> 1
    ];
    let callIndex = 0;
    const fromCalls: string[] = [];
    sbRef.current = {
      from: (table: string) => {
        fromCalls.push(table);
        const idx = callIndex;
        callIndex += 1;
        return makeBuilder({ data: datasets[idx] ?? [], error: null }).builder;
      },
    };

    const result = await getReopenCounts(new Date('2026-07-30T00:00:00Z'));

    expect(result.all).toEqual({ handled: 2, reopened: 1 });
    expect(result['90']).toEqual({ handled: 1, reopened: 0 });
    expect(result['30']).toEqual({ handled: 3, reopened: 1 });
    expect(callIndex).toBe(6);
    expect(fromCalls.every((t) => t === 'dashboard_activity')).toBe(true);
  });
});

// ─── listInWorks — parallel fetch (#185) ────────────────────────────────────
//
// Was two sequential `await`s (awaiting -> handled). Now both fire together
// via Promise.all; the array-literal argument order keeps [awaiting, handled]
// deterministic, so a call-index-keyed mock still lets us assert correctness.

describe('listInWorks — parallel fetch (#185)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('maps the awaiting + handled buckets from the two parallel queries', async () => {
    const awaitingRow = {
      id: 'i-aw',
      source: 'ghl',
      channel: 'sms',
      preview: 'following up',
      followed_up_at: '2026-07-20T10:00:00Z',
      handled_at: null,
      status: 'unresponded',
      dashboard_contacts: { display_name: 'Awaiting Amy' },
    };
    const handledRow = {
      id: 'i-hd',
      source: 'gmail',
      channel: 'email',
      preview: 'handled it',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      dashboard_contacts: { display_name: 'Handled Hank' },
    };
    let callIndex = 0;
    sbRef.current = {
      from: (_table: string) => {
        const idx = callIndex;
        callIndex += 1;
        const data = idx === 0 ? [awaitingRow] : [handledRow];
        return makeBuilder({ data, error: null }).builder;
      },
    };

    const result = await listInWorks(200);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.awaiting).toEqual([
      { id: 'i-aw', source: 'ghl', channel: 'sms', preview: 'following up', customerName: 'Awaiting Amy', lastActivityAt: '2026-07-20T10:00:00Z' },
    ]);
    expect(result.handled).toEqual([
      { id: 'i-hd', source: 'gmail', channel: 'email', preview: 'handled it', customerName: 'Handled Hank', lastActivityAt: '2026-07-21T09:00:00Z' },
    ]);
    expect(callIndex).toBe(2);
  });

  it('surfaces the AWAITING query error even though both queries were fired', async () => {
    let callIndex = 0;
    sbRef.current = {
      from: (_table: string) => {
        const idx = callIndex;
        callIndex += 1;
        return idx === 0
          ? makeBuilder({ data: null, error: { message: 'awaiting query failed' } }).builder
          : makeBuilder({ data: [], error: null }).builder;
      },
    };

    const result = await listInWorks(200);
    expect(result).toEqual({ ok: false, error: 'awaiting query failed' });
    // Both queries fired (parallel) even though the first one errored.
    expect(callIndex).toBe(2);
  });

  it('surfaces the HANDLED query error when only it fails', async () => {
    let callIndex = 0;
    sbRef.current = {
      from: (_table: string) => {
        const idx = callIndex;
        callIndex += 1;
        return idx === 0
          ? makeBuilder({ data: [], error: null }).builder
          : makeBuilder({ data: null, error: { message: 'handled query failed' } }).builder;
      },
    };

    const result = await listInWorks(200);
    expect(result).toEqual({ ok: false, error: 'handled query failed' });
  });
});

// ─── listOpenItems — truncation signal (WT-41) ───────────────────────────────
//
// Above the page cap, listOpenItems returns only the oldest `limit` items (by
// design — they're the longest-waiting), but the "Open leads" count must not
// silently under-report. `totalOpen` comes from Postgrest's exact count (via
// { count: 'exact' } on .select()), which is NOT affected by .limit().

describe('listOpenItems — truncation signal (WT-41)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('passes { count: "exact" } as select options so Postgrest returns the untruncated total', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null, count: 0 });
    sbRef.current = { from: (_table: string) => builder };

    await listOpenItems(50);

    const selectCall = calls.find((c) => c.method === 'select');
    expect(selectCall).toBeDefined();
    expect(selectCall!.args[1]).toEqual({ count: 'exact' });
  });

  it('reports truncated=true and the real total when the fetched page is smaller than the total open count', async () => {
    const row = (id: string) => ({
      id,
      source: 'ghl',
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-06-28T10:00:00Z',
      preview: null,
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: null,
      quote_value: null,
      dashboard_contacts: null,
    });
    const { builder } = makeBuilder({ data: [row('a'), row('b')], error: null, count: 150 });
    sbRef.current = { from: (_table: string) => builder };

    const result = await listOpenItems(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(2);
    expect(result.totalOpen).toBe(150);
    expect(result.truncated).toBe(true); // 148 more open items not shown
  });

  it('reports truncated=false when the fetched page covers every open item', async () => {
    const { builder } = makeBuilder({ data: [], error: null, count: 0 });
    sbRef.current = { from: (_table: string) => builder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totalOpen).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ─── listOpenItems — totalLeads excludes automated lead_kind (#265) ─────────
//
// listOpenItems' sibling listEscalatableItems filters lead_kind='automated'
// rows out at the QUERY level (.or('lead_kind.is.null,lead_kind.neq.automated')).
// listOpenItems deliberately does NOT — its `items`/`totalOpen` stay the raw,
// unfiltered population because InboxList.tsx's "Show N filtered" toggle needs
// automated rows to still be fetched so staff can view them on demand. Instead
// `totalLeads` is a SEPARATE number, excluding automated noise, for consumers
// (the morning digest) that want "how many actually need a reply" — matching
// what /inbox's own "Open leads" tile (buildInboxSummary) already shows.

describe('listOpenItems — totalLeads excludes automated lead_kind (#265)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const row = (id: string, leadKind: string | null, source = 'gmail', externalId = `ext-${id}`) => ({
    id,
    source,
    external_id: externalId,
    channel: 'email',
    direction: 'inbound',
    last_message_at: '2026-08-01T10:00:00Z',
    preview: null,
    subject: null,
    escalation_level: 0,
    contact_id: null,
    lead_kind: leadKind,
    quote_value: null,
    dashboard_contacts: null,
  });

  it('totalLeads excludes automated rows while items/totalOpen keep them (the "Show filtered" toggle still needs them fetched)', async () => {
    const rows = [row('a', 'lead'), row('b', 'automated'), row('c', 'automated'), row('d', null)];
    const { builder } = makeBuilder({ data: rows, error: null, count: 4 });
    sbRef.current = { from: () => builder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // items keeps ALL 4 rows (2 automated included) — the toggle depends on this.
    expect(result.items).toHaveLength(4);
    expect(result.items.map((i) => i.leadKind).sort()).toEqual(['automated', 'automated', 'lead', 'lead']);
    // totalOpen is the raw mixed count, unaffected by lead_kind (unchanged behavior).
    expect(result.totalOpen).toBe(4);
    // totalLeads excludes the 2 automated rows — null (row d) counts as a lead,
    // same as the sibling's .or('lead_kind.is.null,...') treats NULL.
    expect(result.totalLeads).toBe(2);
  });

  it('totalLeads equals totalOpen when there is no automated noise (no behavior change for the common case)', async () => {
    const rows = [row('a', 'lead'), row('b', null)];
    const { builder } = makeBuilder({ data: rows, error: null, count: 2 });
    sbRef.current = { from: () => builder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totalOpen).toBe(2);
    expect(result.totalLeads).toBe(2);
  });

  it("totalLeads reflects Postgrest's exact count beyond the fetched page, same as totalOpen does (WT-41 parity)", async () => {
    // Only 2 rows fetched (page cap), but the exact count says 10 rows exist
    // total; of the 2 actually fetched, 1 is automated noise.
    const rows = [row('a', 'lead'), row('b', 'automated')];
    const { builder } = makeBuilder({ data: rows, error: null, count: 10 });
    sbRef.current = { from: () => builder };

    const result = await listOpenItems(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.totalOpen).toBe(10);
    // totalOpen(10) - automatedInWindow(1, from the 2 fetched rows) = 9.
    expect(result.totalLeads).toBe(9);
  });

  it('matches buildInboxSummary(items).openLeads when the page is not truncated — the /inbox tile and the digest agree (#265)', async () => {
    const rows = [
      row('a', 'lead'),
      row('b', 'automated'),
      row('c', 'lead'),
      row('d', 'automated'),
      row('e', 'automated'),
    ];
    const { builder } = makeBuilder({ data: rows, error: null, count: 5 });
    sbRef.current = { from: () => builder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.truncated).toBe(false); // sanity: this equivalence only holds un-truncated
    const summary = buildInboxSummary(result.items, Date.now());
    expect(result.totalLeads).toBe(summary.openLeads);
    expect(result.totalLeads).toBe(2);
  });

  it('totalLeads is computed from the WINDOW (rows, pre-page-slice), not the page — automated rows beyond the page cap still get subtracted', async () => {
    // 6 rows come back inside the query window, but limit=2 caps the
    // returned PAGE to the oldest 2 (both leads). All 4 automated rows sit
    // at positions 3-6 — entirely beyond the page. If automatedInWindow were
    // computed from the page (trimmed/items) instead of the full window
    // (rows), it would see ZERO automated rows and totalLeads would wrongly
    // collapse to totalOpen (6) via the floor, instead of the true 2. This
    // is the scenario the digest actually depends on — the whole point of
    // totalLeads (like totalOpen before it) is to see past the page cap.
    const rows = [
      row('a', 'lead'),
      row('b', 'lead'),
      row('c', 'automated'),
      row('d', 'automated'),
      row('e', 'automated'),
      row('f', 'automated'),
    ];
    const { builder } = makeBuilder({ data: rows, error: null, count: 6 });
    sbRef.current = { from: () => builder };

    const result = await listOpenItems(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Sanity: the returned PAGE carries no automated-row signal at all —
    // confirms this is a genuine window-vs-page scenario, not accidentally
    // page-visible.
    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.leadKind === 'lead')).toBe(true);
    expect(result.truncated).toBe(true);

    expect(result.totalOpen).toBe(6);
    // All 4 automated rows (beyond the page) are subtracted — not 0.
    expect(result.totalLeads).toBe(2);
  });

  it('combines correctly with the #157 legacy-rebook exclusion — a hidden Neighbor draft (always lead_kind=lead) never interacts with the automated count', async () => {
    const LEGACY_ID = '11111111-1111-1111-1111-111111111111';
    const rows = [
      row('i-legacy', 'lead', 'quotetool', LEGACY_ID),
      row('i-ghl-auto', 'automated', 'ghl'),
      row('i-ghl-lead', 'lead', 'ghl'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 3 });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: LEGACY_ID, legacy_rebook: true, status: 'draft', quote_sent_at: null }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The legacy quotetool row is hidden entirely (not in items, not in either count).
    expect(result.items.map((i) => i.id)).toEqual(['i-ghl-auto', 'i-ghl-lead']);
    expect(result.totalOpen).toBe(2); // 3 raw − 1 legacy-hidden
    expect(result.totalLeads).toBe(1); // 2 open − 1 automated (i-ghl-auto)
  });
});

// ─── listOpenItems — legacy-rebook exclusion wiring (#157) ──────────────────
//
// listOpenItems makes a THIRD sb.from('quotes') call ONLY when the fetched page
// contains 'quotetool' items — proving the STORE (not just the pure function)
// actually excludes legacy-rebook drafts, and that every consumer (inbox page,
// nav badge via buildInboxSummary, /api/inbox) inherits it automatically since
// they all read through this one function.

describe('listOpenItems — legacy-rebook exclusion wiring (#157, #183)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  // Real uuid-shaped ids (#183 BUG 1's isUuid filter drops anything else from
  // the .in() lookup, so these fixtures must actually parse as uuids).
  const LEGACY_ID = '11111111-1111-1111-1111-111111111111';
  const NORMAL_ID = '22222222-2222-2222-2222-222222222222';

  const row = (id: string, source: string, externalId: string) => ({
    id,
    source,
    external_id: externalId,
    channel: 'app',
    direction: 'inbound',
    last_message_at: '2026-07-16T10:00:00Z',
    preview: null,
    subject: null,
    escalation_level: 0,
    contact_id: null,
    lead_kind: null,
    quote_value: null,
    dashboard_contacts: null,
  });

  it('excludes an unsent DRAFT legacy_rebook quotetool item, keeps normal quotetool + other sources', async () => {
    const rows = [
      row('i-legacy', 'quotetool', LEGACY_ID),
      row('i-normal', 'quotetool', NORMAL_ID),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 3 });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: LEGACY_ID, legacy_rebook: true, status: 'draft', quote_sent_at: null },
        { id: NORMAL_ID, legacy_rebook: false, status: 'draft', quote_sent_at: null },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((i) => i.id)).toEqual(['i-normal', 'i-ghl']);
    expect(result.totalOpen).toBe(2); // 3 total − 1 excluded legacy item
    expect(result.truncated).toBe(false);

    // The quotes lookup only queried the ids seen on THIS page (the quotetool
    // ones) — never the ghl item's external_id.
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall).toBeDefined();
    expect(inCall!.args[1]).toEqual(expect.arrayContaining([LEGACY_ID, NORMAL_ID]));
    expect(inCall!.args[1]).toHaveLength(2);
  });

  it('skips the quotes lookup entirely when the page has no quotetool items', async () => {
    const rows = [row('i-ghl', 'ghl', 'ghl-msg-1')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 1 });

    let fromCalls = 0;
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return mainBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(1);
    // No contact_id → no returning-proxy call; no quotetool ids → no quotes call.
    expect(fromCalls).toBe(1);
  });

  // #183 BUG 1: a :color-request-suffixed external_id used to poison the WHOLE
  // .in() lookup (not a valid uuid → Postgres 22P02 on the entire query),
  // silently emptying legacyQuoteIds so EVERY legacy row on the page — not
  // just the suffixed one — rendered on the open-items list.
  it('a :color-request-suffixed id alongside a plain one: BOTH resolve + exclude correctly, and the .in() call carries only the stripped prefix', async () => {
    const rows = [
      row('i-legacy', 'quotetool', LEGACY_ID),
      row('i-legacy-color', 'quotetool', `${LEGACY_ID}:color-request`),
      row('i-normal', 'quotetool', NORMAL_ID),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 4 });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: LEGACY_ID, legacy_rebook: true, status: 'draft', quote_sent_at: null },
        { id: NORMAL_ID, legacy_rebook: false, status: 'draft', quote_sent_at: null },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both the bare legacy row AND its suffixed sibling are excluded.
    expect(result.items.map((i) => i.id)).toEqual(['i-normal', 'i-ghl']);

    // The .in() call carries the DE-DUPED, STRIPPED prefix — never the raw
    // suffixed string (which would have poisoned the whole Postgres query).
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall!.args[1]).toEqual(expect.arrayContaining([LEGACY_ID, NORMAL_ID]));
    expect(inCall!.args[1]).toHaveLength(2);
  });

  it('drops a malformed (non-uuid) quotetool external_id from the lookup instead of poisoning the whole query', async () => {
    const rows = [row('i-bad', 'quotetool', 'not-a-uuid'), row('i-normal', 'quotetool', NORMAL_ID)];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 2 });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [{ id: NORMAL_ID, legacy_rebook: false }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Neither row is silently dropped from the RESULT (only the lookup input
    // is filtered) — the malformed one just can't be confirmed legacy, so it
    // stays (fail-open for that one row, same spirit as the error path below).
    expect(result.items.map((i) => i.id)).toEqual(['i-bad', 'i-normal']);

    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall!.args[1]).toEqual([NORMAL_ID]);
  });

  // #252 slice G: narrowed from "every legacy_rebook item" to "only a genuine
  // unsent DRAFT" — a SENT/APPROVED/BOOKED Neighbor quote's item now behaves
  // like a normal quotetool item on the open-items list (this is the row #252
  // set out to fix: quote #1129, BOOKED, sat invisible for 14 days under the
  // old blanket rule).
  it('does NOT exclude a SENT legacy_rebook quotetool item', async () => {
    const rows = [row('i-sent-legacy', 'quotetool', LEGACY_ID), row('i-ghl', 'ghl', 'ghl-msg-1')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 2 });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: LEGACY_ID, legacy_rebook: true, status: 'sent', quote_sent_at: '2026-07-20T10:00:00Z' }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(['i-sent-legacy', 'i-ghl']);
  });

  // #252 refinement: 3 prod rows are BOOKED with quote_sent_at IS NULL — a
  // naive "unsent = hidden" implementation would still wrongly hide this one,
  // since it never checks status. Pin it explicitly. #263: deposit_paid_at is
  // what actually backs a booked row post-deriveStatus-switch (every real
  // prod row with status='booked' also carries it, verified 2026-08-13).
  it('does NOT exclude a BOOKED legacy_rebook quotetool item even though quote_sent_at is null', async () => {
    const rows = [row('i-booked-legacy', 'quotetool', LEGACY_ID)];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 1 });
    const { builder: quotesBuilder } = makeBuilder({
      data: [
        {
          id: LEGACY_ID,
          legacy_rebook: true,
          status: 'booked',
          quote_sent_at: null,
          customer_approved_at: '2026-07-01T09:00:00Z',
          deposit_paid_at: '2026-07-01T10:00:00Z',
          viewed_at: null,
        },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(['i-booked-legacy']);
  });

  // #183 BUG 1 (c): the lookup error must be visible, and the fail-open must
  // proceed unexcluded rather than crash or silently no-op.
  it('logs and proceeds unexcluded when the quotes lookup itself errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [row('i-legacy', 'quotetool', LEGACY_ID), row('i-ghl', 'ghl', 'ghl-msg-1')];
      const { builder: mainBuilder } = makeBuilder({ data: rows, error: null, count: 2 });
      const { builder: quotesBuilder } = makeBuilder({ data: null, error: { message: 'connection reset' } });

      let callCount = 0;
      sbRef.current = {
        from: (_table: string) => {
          callCount += 1;
          return callCount === 1 ? mainBuilder : quotesBuilder;
        },
      };

      const result = await listOpenItems(100);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Fail-open: nothing excluded, both rows still present.
      expect(result.items.map((i) => i.id)).toEqual(['i-legacy', 'i-ghl']);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[inbox] legacy-rebook exclusion lookup failed:',
        'connection reset',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ─── listDueFollowUps — contact fallback + due-window (#229) ────────────────
//
// #229 FIX 3 (round 3): an earlier round added a legacy-rebook "anchoring"
// flag + a quotetool->quotes batch lookup here, mirroring listOpenItems. That
// state is IMPOSSIBLE by construction — isHiddenLegacyRebookQuote requires
// deriveStatus === 'draft' (quote_sent_at NULL), but a quote_sent_no_reply
// follow-up (quotetool.ts's quoteFollowUpDecision) only ever gets CREATED
// when quote_sent_at IS SET. Confirmed empirically against prod: 28 pending
// follow-ups, all with quote_sent_at set, zero parked drafts. Removed the
// flag, the inbox_items embed, and the batch lookup entirely — a
// legacy_rebook-anchored follow-up here is for a SENT Neighbor quote (a real
// customer genuinely owed a reply), so it is never filtered.

describe('listDueFollowUps — contact fallback + due-window (#229)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const NOW = new Date('2026-08-06T15:00:00Z'); // Aug 6, 2026, ET morning

  const dueRow = (over: Record<string, unknown>) => ({
    id: 'fu-1',
    reason: 'quote_sent_no_reply',
    due_at: '2026-08-05T10:00:00Z', // yesterday ET — overdue
    dashboard_contacts: { display_name: 'Jane Doe', primary_phone: '+16315551234', primary_email: 'jane@x.com' },
    ...over,
  });

  it('carries contact phone/email alongside the name (nameless-contact fallback support downstream)', async () => {
    const rows = [
      dueRow({
        id: 'fu-nameless',
        dashboard_contacts: { display_name: null, primary_phone: '+16315559999', primary_email: 'lead@x.com' },
      }),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    sbRef.current = { from: () => mainBuilder };

    const result = await listDueFollowUps(NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].contactName).toBeNull();
    expect(result.items[0].contactPhone).toBe('+16315559999');
    expect(result.items[0].contactEmail).toBe('lead@x.com');
  });

  it('excludes a follow-up due strictly in the future (not yet due today)', async () => {
    const rows = [dueRow({ due_at: '2026-08-08T10:00:00Z' })]; // 2 days ahead
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    sbRef.current = { from: () => mainBuilder };

    const result = await listDueFollowUps(NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(0);
  });

  // #229 FIX 3: locks in the corrected behavior — a follow-up anchored to a
  // SENT legacy_rebook quote is a real, owed reply and must NOT be filtered
  // (only ONE sb.from() call — no quotetool/quotes lookup exists anymore).
  it('never filters or special-cases a legacy_rebook-linked follow-up (no anchoring lookup exists)', async () => {
    const rows = [dueRow({ id: 'fu-neighbor', dashboard_contacts: { display_name: 'YLL Neighbor Lead', primary_phone: null, primary_email: null } })];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    let fromCalls = 0;
    sbRef.current = {
      from: () => {
        fromCalls += 1;
        return mainBuilder;
      },
    };

    const result = await listDueFollowUps(NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].contactName).toBe('YLL Neighbor Lead');
    expect(fromCalls).toBe(1); // no second (quotes) lookup — the anchoring machinery is gone
  });
});

// ─── ensureFollowUp — idempotency scoped to pending only (WT-43) ────────────
//
// A quotetool item's id is stable, so the OLD "any status" idempotency check
// meant clicking Done once permanently killed the "sent, no reply" nudge for
// that (item, reason) forever — the reconcile cron never recreated it, even
// weeks later while the quote was still unapproved. Scoping the check to
// status='pending' lets a fresh nudge fire after a prior one was closed.

describe('ensureFollowUp — idempotency scoped to pending (WT-43)', () => {
  type FollowUpRow = {
    id: string;
    inbox_item_id: string;
    reason: string;
    status: string;
    [key: string]: unknown;
  };

  /** Minimal stateful fake for the follow_ups table: supports the
   *  select().eq().eq().eq().limit() idempotency check, the plain insert()
   *  ensureFollowUp issues, the update().eq('id', ...) markFollowUpDone
   *  issues, and an update().eq(...).eq(...).select().maybeSingle()-shaped
   *  close chain — enough to exercise the real create → done → recreate
   *  lifecycle AND #252's closeFollowUpsForResolvedItem/sweepResolvedItemFollowUps.
   *
   *  #252 fix (salvaged from the closed #793 branch): the ORIGINAL version of
   *  this fake had two defects that made it lie about real supabase-js shape:
   *  (a) `.select()` unconditionally set mode='select', so a real
   *  `.update(...).eq(...).select(...)` chain lost the update entirely and
   *  silently took the read-only branch (data: rows as they were BEFORE the
   *  update, not the affected rows, and the update itself never applied); (b)
   *  there was no `.maybeSingle()` at all, so a chain ending in it would call
   *  a nonexistent method. Neither defect was ever hit by the two tests below
   *  (markFollowUpDone's `.update().eq('id', id)` never chains `.select()`,
   *  and ensureFollowUp never calls `.maybeSingle()`), so fixing this changes
   *  neither test's outcome — the bug was latent, not currently masking a
   *  false-passing assertion. */
  function makeFollowUpsFake(seed: FollowUpRow[]) {
    const rows: FollowUpRow[] = seed.map((r) => ({ ...r }));
    let nextId = rows.length + 1;
    function table() {
      const filters: Record<string, unknown> = {};
      let mode: 'select' | 'insert' | 'update' | 'upsert' | null = null;
      let selectRequested = false;
      let insertRow: Record<string, unknown> | undefined;
      let updateFields: Record<string, unknown> | undefined;
      let upsertConflict: string | undefined;
      const self: Record<string, unknown> = {};
      self.select = () => {
        // Real supabase-js: `.select()` after `.update()`/`.insert()`/`.upsert()`
        // requests the affected rows back WITHOUT changing which operation
        // runs — only a bare `.select()` (nothing else called first) is
        // itself the read.
        if (mode === null) mode = 'select';
        else selectRequested = true;
        return self;
      };
      self.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return self;
      };
      self.limit = () => self;
      self.insert = (row: Record<string, unknown>) => {
        mode = 'insert';
        insertRow = row;
        return self;
      };
      self.update = (fields: Record<string, unknown>) => {
        mode = 'update';
        updateFields = fields;
        return self;
      };
      // Models Postgres UPSERT against the real `unique (inbox_item_id, reason)`
      // constraint: a conflicting row is UPDATED in place, never duplicated.
      self.upsert = (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
        mode = 'upsert';
        insertRow = row;
        upsertConflict = opts?.onConflict;
        return self;
      };
      function resolveResult(): { data: unknown; error: null } {
        if (mode === 'insert') {
          const row = { id: String(nextId++), ...insertRow } as FollowUpRow;
          rows.push(row);
          return { data: [row], error: null };
        } else if (mode === 'update') {
          const matched = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          for (const r of matched) Object.assign(r, updateFields);
          // Only a chain that actually asked for rows back (.select()) gets them;
          // a bare update().eq(...) (e.g. markFollowUpDone) still resolves data: null.
          return { data: selectRequested ? matched.map((r) => ({ ...r })) : null, error: null };
        } else if (mode === 'upsert') {
          const cols = (upsertConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean);
          const existing = cols.length
            ? rows.find((r) => cols.every((c) => r[c] === (insertRow as Record<string, unknown>)[c]))
            : undefined;
          if (existing) {
            Object.assign(existing, insertRow); // re-arm: done -> pending, fresh due_at
            return { data: [existing], error: null };
          } else {
            const row = { id: String(nextId++), ...insertRow } as FollowUpRow;
            rows.push(row);
            return { data: [row], error: null };
          }
        } else {
          const matched = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
          return { data: matched, error: null };
        }
      }
      self.then = (resolve: (v: unknown) => void) => resolve(resolveResult());
      // Terminal single-row resolution (e.g. an update().eq(...).select().maybeSingle()
      // chain) — real supabase-js: null when zero rows matched, the bare row
      // (not an array) when exactly one did.
      self.maybeSingle = async () => {
        const result = resolveResult();
        const matchedRows = (result.data as FollowUpRow[] | null) ?? [];
        return { data: matchedRows[0] ?? null, error: result.error };
      };
      return self;
    }
    return { rows, table };
  }

  /** Swallows any non-follow_ups table (dashboard_activity) with a no-op stub. */
  function genericTable() {
    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.eq = () => self;
    self.insert = () => self;
    self.update = () => self;
    // #252 churn gate: ensureFollowUp now reads the anchored item's status via
    // inbox_items.select().eq().maybeSingle(). Null data here = "status unknown",
    // which the gate treats as NOT terminal, so these follow-up tests behave as
    // they did before the gate existed.
    self.maybeSingle = () => Promise.resolve({ data: null, error: null });
    self.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
    return self;
  }

  beforeEach(() => {
    sbRef.current = null;
  });

  it('does not duplicate while a PENDING follow-up for the same (item, reason) exists', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

    expect(fake.rows).toHaveLength(1); // no new insert — the pending row already covers it
  });

  it('re-arms the follow-up (done -> pending) after a prior one for the same (item, reason) was marked done', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    // Operator (or an auto-close) marks the existing follow-up done...
    const done = await markFollowUpDone('fu-1', 'operator-1');
    expect(done.ok).toBe(true);
    expect(fake.rows[0].status).toBe('done');

    // ...weeks later, a second "quote sent, no reply" cycle fires for the SAME
    // still-unapproved item. WT-43: the real `unique (inbox_item_id, reason)`
    // constraint means a plain insert would 23505 + silently no-op, so ensureFollowUp
    // must UPSERT the existing row back to pending (never a duplicate).
    await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

    // Still exactly ONE row (the unique constraint forbids a duplicate), flipped
    // back to pending so the nudge re-arms.
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0].status).toBe('pending');
    expect(fake.rows[0].inbox_item_id).toBe('item-1');
    expect(fake.rows[0].reason).toBe('quote_sent_no_reply');
  });

  // #252 salvage: markFollowUpDone's operatorId widened to `string | null` for
  // parity with markItemHandledLocal/dismissItem/markItemCompleted. The activity
  // row must still name an actor when no operator resolved — dashboard_activity
  // .actor is free text whose migration comment allows 'system'.
  it('records the activity actor as system when markFollowUpDone gets a null operator', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    const activityInserts: Record<string, unknown>[] = [];
    sbRef.current = {
      from: (table: string) => {
        if (table === 'follow_ups') return fake.table();
        if (table === 'dashboard_activity') {
          return {
            insert: (row: Record<string, unknown>) => {
              activityInserts.push(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        return genericTable();
      },
    };

    const done = await markFollowUpDone('fu-1', null);

    expect(done.ok).toBe(true);
    expect(fake.rows[0].status).toBe('done');
    expect(activityInserts).toHaveLength(1);
    expect(activityInserts[0]).toMatchObject({ actor: 'system', action: 'handled' });
  });

  // #252 follow-up-autoclose: closeFollowUpsForResolvedItem + its backlog
  // sweep, exercised against the REAL create/update/select shape via the
  // (now-fixed) stateful fake above rather than a fixed-response stub — this
  // is exactly the update().eq(...).select() chain the fake used to get wrong.
  describe('closeFollowUpsForResolvedItem — closes ALL pending follow-ups anchored to a resolved item (#252)', () => {
    it('closes a pending follow-up and returns count 1', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(1);
      expect(fake.rows[0].status).toBe('done');
    });

    it('leaves an already-done follow-up untouched and returns count 0 for it', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(0);
      expect(fake.rows[0].status).toBe('done'); // unchanged, not re-touched
    });

    it('closes a pending follow-up regardless of reason (no reason filter — the item being terminal invalidates any anchored nag)', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'some_future_reason', status: 'pending' },
      ]);
      sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(1);
      expect(fake.rows[0].status).toBe('done');
    });

    it('returns 0 without touching an unrelated item\'s pending follow-up', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-OTHER', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(0);
      expect(fake.rows[0].status).toBe('pending');
    });

    it('swallows a store-level failure and returns 0 (non-fatal — never throws)', async () => {
      sbRef.current = {
        from: (table: string) =>
          table === 'follow_ups'
            ? { update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }) }) }) }) }
            : genericTable(),
      };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(0);
    });

    // #252 review (admin lens): an auto-close used to leave NO human-visible
    // trace — the nag just vanished off the "due today" strip, and follow_ups
    // has no column recording who closed a row. Same reasoning as #230(a)'s
    // recordSuppressedFollowUp, which exists for exactly this failure shape.
    it('writes one followup_autoclosed activity row per closed follow-up, carrying the triggering status', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      const activityInserts: Record<string, unknown>[] = [];
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'dashboard_activity') {
            return {
              insert: (rows: Record<string, unknown>[]) => {
                activityInserts.push(...rows);
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          return genericTable();
        },
      };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'dismissed');

      expect(closed).toBe(1);
      expect(activityInserts).toHaveLength(1);
      expect(activityInserts[0]).toMatchObject({
        actor: 'system',
        action: 'followup_autoclosed',
        inbox_item_id: 'item-1',
        detail: { followUpId: 'fu-1', terminalStatus: 'dismissed' },
      });
    });

    it('writes no activity row when nothing was closed', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      const activityInserts: Record<string, unknown>[] = [];
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'dashboard_activity') {
            return {
              insert: (rows: Record<string, unknown>[]) => {
                activityInserts.push(...rows);
                return Promise.resolve({ data: null, error: null });
              },
            };
          }
          return genericTable();
        },
      };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(0);
      expect(activityInserts).toHaveLength(0);
    });

    it('still reports the close when the audit write throws — the audit is best-effort, the close is the real work', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'dashboard_activity') {
            return {
              insert: () => {
                throw new Error('activity table unavailable');
              },
            };
          }
          return genericTable();
        },
      };

      const closed = await closeFollowUpsForResolvedItem('item-1', 'completed');

      expect(closed).toBe(1); // the follow-up really was closed
      expect(fake.rows[0].status).toBe('done');
    });
  });

  // #252 churn gate. quoteFollowUpDecision derives kind:'create' from the
  // QUOTE's own fields alone, so the reconcile asks for a follow-up on every
  // tick for any sent-but-unapproved quote — including one whose inbox item an
  // operator has since resolved. Without this gate the upsert flipped the
  // auto-closed row back to pending every 5 minutes, and the sweep re-closed it
  // later in the same tick, so the end state looked correct while the row
  // churned forever.
  describe('ensureFollowUp — does not re-arm a nag whose anchored item is already resolved (#252)', () => {
    /** inbox_items stub for ensureFollowUp's `.select('status').eq('id').maybeSingle()`. */
    function makeItemStatusFake(status: string | null) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: status === null ? null : { status }, error: null }),
          }),
        }),
      };
    }

    function wire(fake: ReturnType<typeof makeFollowUpsFake>, status: string | null) {
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'inbox_items') return makeItemStatusFake(status);
          return genericTable();
        },
      };
    }

    it('returns false and leaves a done row done when the item is completed', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'completed');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe(false);
      expect(fake.rows[0].status).toBe('done');
    });

    it('returns false and leaves a done row done when the item is dismissed', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'dismissed');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe(false);
      expect(fake.rows[0].status).toBe('done');
    });

    // The regression that would hurt most: a still-open conversation must keep
    // getting its nag re-armed exactly as before this gate existed.
    it('re-arms a done row to pending when the item is only handled', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'handled');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe(true);
      expect(fake.rows[0].status).toBe('pending');
    });

    it('re-arms a done row to pending when the item is unresponded', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'unresponded');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe(true);
      expect(fake.rows[0].status).toBe('pending');
    });

    it('returns false without a second write when a pending row already exists (the pre-existing early return still wins)', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      wire(fake, 'handled');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe(false);
      expect(fake.rows).toHaveLength(1);
    });
  });

  describe('sweepResolvedItemFollowUps — backlog self-heal for items already terminal before the write-site fix (#252)', () => {
    /** Minimal fixed-response fake for inbox_items' single `.select().in()` lookup. */
    function makeItemsFake(items: { id: string; status: string }[]) {
      const self: Record<string, unknown> = {};
      self.select = () => self;
      self.in = () => self;
      self.then = (resolve: (v: unknown) => void) => resolve({ data: items, error: null });
      return self;
    }

    it('closes a pre-existing pending follow-up whose item is already completed, and returns count 1', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-done', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      const itemsFake = makeItemsFake([{ id: 'item-done', status: 'completed' }]);
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'inbox_items') return itemsFake;
          return genericTable();
        },
      };

      const closed = await sweepResolvedItemFollowUps();

      expect(closed).toBe(1);
      expect(fake.rows[0].status).toBe('done');
    });

    it('leaves a pending follow-up alone when its item is only handled (the normal quote-sent-awaiting-reply case)', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-handled', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      const itemsFake = makeItemsFake([{ id: 'item-handled', status: 'handled' }]);
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'inbox_items') return itemsFake;
          return genericTable();
        },
      };

      const closed = await sweepResolvedItemFollowUps();

      expect(closed).toBe(0);
      expect(fake.rows[0].status).toBe('pending');
    });

    it('returns 0 without querying inbox_items when there are no pending follow-ups', async () => {
      const fake = makeFollowUpsFake([]);
      let inboxItemsQueried = false;
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'inbox_items') {
            inboxItemsQueried = true;
            return makeItemsFake([]);
          }
          return genericTable();
        },
      };

      const closed = await sweepResolvedItemFollowUps();

      expect(closed).toBe(0);
      expect(inboxItemsQueried).toBe(false);
    });
  });
});

// ─── planIngest — clearFollowedUp ────────────────────────────────────────────

describe('quotetool fast-sent quote lifecycle (#222)', () => {
  type ContactRow = {
    id: string;
    ghl_contact_id: string | null;
    emails: string[];
    phones: string[];
    display_name: string | null;
    primary_email: string | null;
    primary_phone: string | null;
  };
  type InboxItemRow = Record<string, unknown> & {
    id: string;
    source: string;
    external_id: string;
  };
  type FollowUpRow = Record<string, unknown> & {
    id: string;
    inbox_item_id: string;
    reason: string;
    status: string;
  };

  function makeQuoteInboxFake() {
    const contacts: ContactRow[] = [];
    const inboxItems: InboxItemRow[] = [];
    const followUps: FollowUpRow[] = [];
    const activity: Record<string, unknown>[] = [];
    let nextContactId = 1;
    let nextItemId = 1;
    let nextFollowUpId = 1;

    function builderFor(table: string) {
      const filters: Record<string, unknown> = {};
      let mode: 'select' | 'insert' | 'update' | 'upsert' | null = null;
      let insertRow: Record<string, unknown> | undefined;
      let orClause: string | undefined;
      const self: Record<string, unknown> = {};
      self.select = () => {
        if (mode === null) mode = 'select';
        return self;
      };
      self.eq = (col: string, val: unknown) => {
        filters[col] = val;
        return self;
      };
      self.or = (clause: string) => {
        orClause = clause;
        return self;
      };
      self.limit = () => self;
      self.insert = (row: Record<string, unknown>) => {
        mode = 'insert';
        insertRow = row;
        return self;
      };
      self.update = () => self;
      self.upsert = (row: Record<string, unknown>) => {
        mode = 'upsert';
        insertRow = row;
        return self;
      };
      self.single = async () => {
        if (table === 'dashboard_contacts' && mode === 'insert') {
          const row: ContactRow = {
            id: `contact-${nextContactId++}`,
            ghl_contact_id: (insertRow?.ghl_contact_id as string | null) ?? null,
            emails: (insertRow?.emails as string[] | null) ?? [],
            phones: (insertRow?.phones as string[] | null) ?? [],
            display_name: (insertRow?.display_name as string | null) ?? null,
            primary_email: (insertRow?.primary_email as string | null) ?? null,
            primary_phone: (insertRow?.primary_phone as string | null) ?? null,
          };
          contacts.push(row);
          return { data: { id: row.id }, error: null };
        }
        if (table === 'inbox_items' && mode === 'upsert') {
          const keySource = String(insertRow?.source);
          const keyExternalId = String(insertRow?.external_id);
          let row = inboxItems.find((item) => item.source === keySource && item.external_id === keyExternalId);
          if (!row) {
            row = { id: `item-${nextItemId++}`, ...insertRow, source: keySource, external_id: keyExternalId } as InboxItemRow;
            inboxItems.push(row);
          } else {
            Object.assign(row, insertRow);
          }
          return { data: { id: row.id }, error: null };
        }
        return { data: null, error: { message: `unexpected single() on ${table}` } };
      };
      self.maybeSingle = async () => {
        if (table === 'inbox_items') {
          const row = inboxItems.find(
            (item) => item.source === filters.source && item.external_id === filters.external_id,
          );
          if (!row) return { data: null, error: null };
          return {
            data: {
              id: row.id,
              contact_id: row.contact_id ?? null,
              status: row.status,
              notified_levels: row.notified_levels ?? [],
              last_message_at: row.last_message_at ?? null,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      self.then = (resolve: (v: unknown) => void) => {
        if (table === 'dashboard_contacts' && mode === 'select' && orClause) {
          resolve({ data: [], error: null });
          return;
        }
        if (table === 'dashboard_activity' && mode === 'insert') {
          activity.push(insertRow ?? {});
          resolve({ data: null, error: null });
          return;
        }
        if (table === 'follow_ups' && mode === 'select') {
          const matched = followUps.filter((row) =>
            Object.entries(filters).every(([k, v]) => row[k] === v),
          );
          resolve({ data: matched.map((row) => ({ id: row.id })), error: null });
          return;
        }
        if (table === 'follow_ups' && mode === 'upsert') {
          const existing = followUps.find(
            (row) => row.inbox_item_id === insertRow?.inbox_item_id && row.reason === insertRow?.reason,
          );
          if (existing) {
            Object.assign(existing, insertRow);
            resolve({ data: [existing], error: null });
            return;
          }
          const row: FollowUpRow = {
            id: `fu-${nextFollowUpId++}`,
            inbox_item_id: String(insertRow?.inbox_item_id),
            reason: String(insertRow?.reason),
            status: String(insertRow?.status),
            ...insertRow,
          };
          followUps.push(row);
          resolve({ data: [row], error: null });
          return;
        }
        resolve({ data: [], error: null });
      };
      return self;
    }

    return {
      contacts,
      inboxItems,
      followUps,
      activity,
      from: (table: string) => builderFor(table),
    };
  }

  function fastSentQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
    return {
      id: 'quote-1263',
      customer_name: 'Fast Send',
      customer_email: 'fastsend@example.com',
      customer_phone: '(631) 555-0000',
      total: 1500,
      created_at: '2026-08-10T16:32:54.950Z',
      quote_sent_at: '2026-08-10T16:33:02.700Z',
      customer_approved_at: null,
      deposit_paid_at: null,
      homeworks_sent_at: null,
      homeworks_signed_at: null,
      highlevel_contact_id: null,
      service_type: null,
      ...over,
    };
  }

  beforeEach(() => {
    sbRef.current = null;
  });

  it('creates one handled inbox item and one quote_sent_no_reply follow-up across two reconcile-like passes', async () => {
    const fake = makeQuoteInboxFake();
    sbRef.current = fake;
    const quote = fastSentQuote({ legacy_rebook: true });
    const decision = quoteFollowUpDecision(quote);
    expect(decision.kind).toBe('create');
    if (decision.kind !== 'create') throw new Error('expected create decision');

    const touch: NormalizedTouch = {
      source: 'quotetool',
      externalId: quote.id,
      direction: 'outbound',
      channel: 'app',
      lastMessageAt: new Date(quote.quote_sent_at!),
      preview: `Quote — $${quote.total}`,
      subject: null,
      identity: {
        ghlContactId: null,
        emails: ['fastsend@example.com'],
        phones: ['+16315550000'],
        displayName: 'Fast Send',
      },
      raw: quote,
      leadKind: 'lead',
      quoteValue: quote.total,
    };

    for (const now of [new Date('2026-08-10T16:35:00Z'), new Date('2026-08-10T16:40:00Z')]) {
      const ingest = await ingestTouch(touch, now);
      expect(ingest.ok).toBe(true);
      if (!ingest.ok) throw new Error(ingest.error);
      expect(ingest.itemId).not.toBeNull();
      if (ingest.itemId) {
        await ensureFollowUp({
          inboxItemId: ingest.itemId,
          contactId: ingest.contactId,
          reason: decision.reason,
          sentAt: decision.sentAt,
        });
      }
    }

    expect(fake.inboxItems).toHaveLength(1);
    expect(fake.followUps).toHaveLength(1);
    expect(fake.inboxItems[0].status).toBe('handled');
    expect(fake.followUps[0].inbox_item_id).toBe(fake.inboxItems[0].id);
    expect(fake.followUps[0].reason).toBe('quote_sent_no_reply');
  });
});

describe('planIngest — clearFollowedUp', () => {
  it('sets clearFollowedUp=true when touch.lastMessageAt is genuinely newer than existing.lastMessageAt', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'unresponded',
      notifiedLevels: [],
      lastMessageAt: T, // base time
    };
    // touch arrives 1 hour after the existing message
    const plan = planIngest({ candidates: [], existing, touch: touch({ lastMessageAt: at(HOUR) }), now: at(2 * HOUR) });
    expect(plan.clearFollowedUp).toBe(true);
  });

  it('sets clearFollowedUp=false when touch.lastMessageAt equals existing.lastMessageAt (same-message re-ingest, preserves snooze)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'unresponded',
      notifiedLevels: [],
      lastMessageAt: T, // same timestamp as touch
    };
    const plan = planIngest({ candidates: [], existing, touch: touch({ lastMessageAt: T }), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(false);
  });

  it('sets clearFollowedUp=false when there is no existing item (new conversation)', () => {
    const plan = planIngest({ candidates: [], existing: null, touch: touch(), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(false);
  });

  it('sets clearFollowedUp=true when existing.lastMessageAt is null (mirrors handled-reopen guard)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'handled',
      notifiedLevels: [],
      lastMessageAt: null, // null → treat touch as newer
    };
    const plan = planIngest({ candidates: [], existing, touch: touch(), now: at(HOUR) });
    expect(plan.clearFollowedUp).toBe(true);
  });

  it('sets clearFollowedUp=false on our OWN newer OUTBOUND reply (a sent reply must NOT wipe the snooze)', () => {
    const existing: ExistingItem = {
      id: 'i1',
      contactId: 'A',
      status: 'handled', // a sent reply marked it handled + followed
      notifiedLevels: [],
      lastMessageAt: T, // the customer's inbound
    };
    // the reconcile cron re-ingests our outbound reply, newer than the inbound —
    // direction-agnostic clearing would null followed_up_at and the item would
    // vanish from BOTH lists. The inbound gate keeps it snoozed.
    const plan = planIngest({
      candidates: [],
      existing,
      touch: touch({ direction: 'outbound', lastMessageAt: at(HOUR) }),
      now: at(2 * HOUR),
    });
    expect(plan.clearFollowedUp).toBe(false);
  });
});

// ─── listEscalatableItems — escalation skips automated noise ─────────────────

describe('listEscalatableItems — .or filter excludes automated but keeps NULL', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('includes an .or call with the lead_kind filter so automated items are excluded but pre-migration NULL rows are not', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: () => builder };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);

    const orCall = calls.find((c) => c.method === 'or');
    expect(orCall).toBeDefined();
    expect(orCall!.args[0]).toBe('lead_kind.is.null,lead_kind.neq.automated');
  });

  it('excludes manually-Followed items via .is("followed_up_at", null) so a snoozed item stops escalating (#110 W7-005)', async () => {
    const { builder, calls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: () => builder };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);

    const isCall = calls.find((c) => c.method === 'is');
    expect(isCall).toBeDefined();
    expect(isCall!.args[0]).toBe('followed_up_at');
    expect(isCall!.args[1]).toBeNull();
  });
});

// ─── listEscalatableItems — legacy-rebook exclusion wiring (#181 / #157 / #252) ─
//
// Same #157 exclusion listOpenItems already applies to the /inbox display,
// extended (#181) to escalation: a YLL Neighbor item must never trip an
// amber/red alert or land in the EOD digest either. Mirrors the listOpenItems
// legacy-rebook wiring tests above, including the #252 slice-G narrowing.

describe('listEscalatableItems — legacy-rebook exclusion wiring (#181, #183, #252)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  // Real uuid-shaped ids (#183 BUG 1's isUuid filter drops anything else from
  // the .in() lookup, so these fixtures must actually parse as uuids).
  const LEGACY_ID = '33333333-3333-3333-3333-333333333333';
  const NORMAL_ID = '44444444-4444-4444-4444-444444444444';

  const row = (id: string, source: string, externalId: string) => ({
    id,
    source,
    external_id: externalId,
    last_message_at: '2026-07-16T10:00:00Z',
    notified_levels: [],
    escalation_level: 0,
    preview: null,
    dashboard_contacts: null,
  });

  it('excludes an unsent DRAFT legacy_rebook quotetool item, keeps normal quotetool + other sources', async () => {
    const rows = [
      row('i-legacy', 'quotetool', LEGACY_ID),
      row('i-normal', 'quotetool', NORMAL_ID),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: LEGACY_ID, legacy_rebook: true, status: 'draft', quote_sent_at: null },
        { id: NORMAL_ID, legacy_rebook: false, status: 'draft', quote_sent_at: null },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((i) => i.id)).toEqual(['i-normal', 'i-ghl']);

    // Same predicate call shape as listOpenItems: batch-fetch only the
    // quotetool ids seen on this read.
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall).toBeDefined();
    expect(inCall!.args[1]).toEqual(expect.arrayContaining([LEGACY_ID, NORMAL_ID]));
    expect(inCall!.args[1]).toHaveLength(2);
  });

  // #252 slice G: narrowed from "every legacy_rebook item, regardless of
  // quote_sent_at" (the old behavior this test used to pin) to "only a
  // genuine unsent DRAFT" — a SENT Neighbor quote now behaves like a normal
  // quote here too, matching quotetool.ts's ingest-time guard rather than
  // fighting it.
  it('does NOT exclude a SENT legacy_rebook quote here either', async () => {
    const rows = [row('i-sent-legacy', 'quotetool', LEGACY_ID)];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: LEGACY_ID, legacy_rebook: true, status: 'sent', quote_sent_at: '2026-07-20T10:00:00Z' }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(['i-sent-legacy']);
  });

  // #252 the row this fix ships for: quote #1129 is a BOOKED, legacy_rebook
  // quote whose colour-change-request item sat invisible in escalation (never
  // triggered an amber/red alert or the EOD digest) for 14 days under the old
  // blanket rule.
  it('does NOT exclude a BOOKED legacy_rebook quote', async () => {
    const rows = [row('i-booked-legacy', 'quotetool', LEGACY_ID)];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: LEGACY_ID, legacy_rebook: true, status: 'booked', quote_sent_at: '2026-07-01T10:00:00Z' }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(['i-booked-legacy']);
  });

  // #252 refinement: 3 prod rows are BOOKED with quote_sent_at IS NULL — pin
  // this explicitly since a naive "unsent = hidden" predicate would still
  // wrongly hide it (it never checks status). #263: deposit_paid_at is what
  // actually backs a booked row post-deriveStatus-switch (every real prod row
  // with status='booked' also carries it, verified 2026-08-13).
  it('does NOT exclude a BOOKED legacy_rebook quote even when quote_sent_at is null', async () => {
    const rows = [row('i-booked-unsent-legacy', 'quotetool', LEGACY_ID)];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder } = makeBuilder({
      data: [
        {
          id: LEGACY_ID,
          legacy_rebook: true,
          status: 'booked',
          quote_sent_at: null,
          customer_approved_at: '2026-06-30T09:00:00Z',
          deposit_paid_at: '2026-07-01T10:00:00Z',
          viewed_at: null,
        },
      ],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: () => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.id)).toEqual(['i-booked-unsent-legacy']);
  });

  it('skips the quotes lookup entirely when the page has no quotetool items', async () => {
    const rows = [row('i-ghl', 'ghl', 'ghl-msg-1')];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });

    let fromCalls = 0;
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return mainBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items).toHaveLength(1);
    expect(fromCalls).toBe(1);
  });

  // #183 BUG 1: a color-request item belonging to a legacy quote must also be
  // excluded from escalation (amber/red alerts + the EOD digest), not just the
  // bare-id sibling — and the poisoned .in() list must not empty the whole
  // lookup the way the raw suffixed string used to.
  it('excludes a :color-request-suffixed item whose prefix is a legacy_rebook quote too', async () => {
    const rows = [
      row('i-legacy', 'quotetool', LEGACY_ID),
      row('i-legacy-color', 'quotetool', `${LEGACY_ID}:color-request`),
      row('i-ghl', 'ghl', 'ghl-msg-1'),
    ];
    const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [{ id: LEGACY_ID, legacy_rebook: true, status: 'draft', quote_sent_at: null }],
      error: null,
    });

    let callCount = 0;
    sbRef.current = {
      from: (_table: string) => {
        callCount += 1;
        return callCount === 1 ? mainBuilder : quotesBuilder;
      },
    };

    const result = await listEscalatableItems();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.items.map((i) => i.id)).toEqual(['i-ghl']);
    const inCall = quotesCalls.find((c) => c.method === 'in');
    expect(inCall!.args[1]).toEqual([LEGACY_ID]); // stripped + de-duped, never the raw suffixed string
  });

  it('logs and proceeds unexcluded when the quotes lookup itself errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const rows = [row('i-legacy', 'quotetool', LEGACY_ID), row('i-ghl', 'ghl', 'ghl-msg-1')];
      const { builder: mainBuilder } = makeBuilder({ data: rows, error: null });
      const { builder: quotesBuilder } = makeBuilder({ data: null, error: { message: 'timeout' } });

      let callCount = 0;
      sbRef.current = {
        from: (_table: string) => {
          callCount += 1;
          return callCount === 1 ? mainBuilder : quotesBuilder;
        },
      };

      const result = await listEscalatableItems();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.items.map((i) => i.id)).toEqual(['i-legacy', 'i-ghl']);
      expect(consoleErrorSpy).toHaveBeenCalledWith('[inbox] legacy-rebook exclusion lookup failed:', 'timeout');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ─── findOrphanedFollowUpItems (#183 BUG 3, pure) ───────────────────────────
//
// runQuoteToolReconcile's main loop only ever visits quotes still returned by
// listQuotesForDashboard, so a pending quote_sent_no_reply follow-up anchored
// to a DELETED quote row can never be closed there — it sits overdue-pending
// forever. This pure predicate is the sweep's decision: given the pending
// follow-ups (mapped to their inbox item id), the inbox items' external_ids
// (batch-fetched), and the set of quote ids that DO still exist, which inbox
// item ids are orphaned (their quote is gone)?

describe('findOrphanedFollowUpItems (#183 BUG 3)', () => {
  const ALIVE_ID = '55555555-5555-5555-5555-555555555555';
  const DEAD_ID = '66666666-6666-6666-6666-666666666666';

  it('flags a follow-up whose quote id is absent from existingQuoteIds', () => {
    const result = findOrphanedFollowUpItems(
      [{ inboxItemId: 'item-dead' }],
      [{ id: 'item-dead', externalId: DEAD_ID }],
      new Set([ALIVE_ID]),
    );
    expect(result).toEqual(['item-dead']);
  });

  it('does not flag a follow-up whose quote id IS present in existingQuoteIds', () => {
    const result = findOrphanedFollowUpItems(
      [{ inboxItemId: 'item-alive' }],
      [{ id: 'item-alive', externalId: ALIVE_ID }],
      new Set([ALIVE_ID]),
    );
    expect(result).toEqual([]);
  });

  it('resolves a :color-request-suffixed external_id to the same quote id (shares BUG 1s derivation)', () => {
    const result = findOrphanedFollowUpItems(
      [{ inboxItemId: 'item-color' }],
      [{ id: 'item-color', externalId: `${ALIVE_ID}:color-request` }],
      new Set([ALIVE_ID]),
    );
    expect(result).toEqual([]); // the underlying quote exists, so NOT orphaned
  });

  it('skips a follow-up with a null inboxItemId', () => {
    const result = findOrphanedFollowUpItems([{ inboxItemId: null }], [], new Set());
    expect(result).toEqual([]);
  });

  it('skips a follow-up whose inbox item could not be resolved at all (nothing to confirm dead)', () => {
    const result = findOrphanedFollowUpItems([{ inboxItemId: 'item-unknown' }], [], new Set([ALIVE_ID]));
    expect(result).toEqual([]);
  });

  it('de-dupes when two follow-ups point at the same orphaned inbox item', () => {
    const result = findOrphanedFollowUpItems(
      [{ inboxItemId: 'item-dead' }, { inboxItemId: 'item-dead' }],
      [{ id: 'item-dead', externalId: DEAD_ID }],
      new Set([ALIVE_ID]),
    );
    expect(result).toEqual(['item-dead']);
  });

  it('mixed batch: only the orphaned one comes back', () => {
    const result = findOrphanedFollowUpItems(
      [{ inboxItemId: 'item-alive' }, { inboxItemId: 'item-dead' }],
      [
        { id: 'item-alive', externalId: ALIVE_ID },
        { id: 'item-dead', externalId: DEAD_ID },
      ],
      new Set([ALIVE_ID]),
    );
    expect(result).toEqual(['item-dead']);
  });
});

describe('findViewOnlyFollowUpItems (#187 review FIX 2, #660)', () => {
  const NORMAL_ID = '77777777-0000-0000-0000-000000000001';
  const VIEW_ONLY_ID = '77777777-0000-0000-0000-000000000002';

  it('flags a follow-up whose quote id IS in viewOnlyQuoteIds', () => {
    const result = findViewOnlyFollowUpItems(
      [{ inboxItemId: 'item-frozen' }],
      [{ id: 'item-frozen', externalId: VIEW_ONLY_ID }],
      new Set([VIEW_ONLY_ID]),
    );
    expect(result).toEqual(['item-frozen']);
  });

  it('does not flag a follow-up whose quote id is NOT in viewOnlyQuoteIds', () => {
    const result = findViewOnlyFollowUpItems(
      [{ inboxItemId: 'item-normal' }],
      [{ id: 'item-normal', externalId: NORMAL_ID }],
      new Set([VIEW_ONLY_ID]),
    );
    expect(result).toEqual([]);
  });

  it('skips a follow-up with a null inboxItemId', () => {
    const result = findViewOnlyFollowUpItems([{ inboxItemId: null }], [], new Set([VIEW_ONLY_ID]));
    expect(result).toEqual([]);
  });

  it('skips a follow-up whose inbox item could not be resolved at all', () => {
    const result = findViewOnlyFollowUpItems([{ inboxItemId: 'item-unknown' }], [], new Set([VIEW_ONLY_ID]));
    expect(result).toEqual([]);
  });

  it('mixed batch: only the view_only one comes back', () => {
    const result = findViewOnlyFollowUpItems(
      [{ inboxItemId: 'item-normal' }, { inboxItemId: 'item-frozen' }],
      [
        { id: 'item-normal', externalId: NORMAL_ID },
        { id: 'item-frozen', externalId: VIEW_ONLY_ID },
      ],
      new Set([VIEW_ONLY_ID]),
    );
    expect(result).toEqual(['item-frozen']);
  });
});

// ─── sweepOrphanedFollowUps — I/O wiring (#183 BUG 3) ───────────────────────
//
// Three sequential batched queries (follow_ups -> inbox_items -> quotes), then
// closeFollowUp per orphan (itself a follow_ups update+select). Dispatches by
// TABLE NAME since 'follow_ups' is hit twice (the pending select, then each
// close's update) with different shapes.

describe('sweepOrphanedFollowUps — I/O wiring (#183 BUG 3)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const ALIVE_ID = '77777777-7777-7777-7777-777777777777';
  const DEAD_ID = '88888888-8888-8888-8888-888888888888';
  const REASON = 'quote_sent_no_reply';

  it('closes only the follow-up whose quote no longer exists', async () => {
    const { builder: pendingBuilder } = makeBuilder({
      data: [
        { id: 'fu-alive', inbox_item_id: 'item-alive' },
        { id: 'fu-dead', inbox_item_id: 'item-dead' },
      ],
      error: null,
    });
    const { builder: itemsBuilder, calls: itemsCalls } = makeBuilder({
      data: [
        { id: 'item-alive', external_id: ALIVE_ID, source: 'quotetool' },
        { id: 'item-dead', external_id: DEAD_ID, source: 'quotetool' },
      ],
      error: null,
    });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [{ id: ALIVE_ID }], // only the alive quote still exists
      error: null,
    });
    const { builder: closeBuilder, calls: closeCalls } = makeBuilder({
      data: [{ id: 'fu-dead' }], // one row flipped to done
      error: null,
    });

    let followUpsCallCount = 0;
    sbRef.current = {
      from: (table: string) => {
        if (table === 'follow_ups') {
          followUpsCallCount += 1;
          return followUpsCallCount === 1 ? pendingBuilder : closeBuilder;
        }
        if (table === 'inbox_items') return itemsBuilder;
        if (table === 'quotes') return quotesBuilder;
        throw new Error(`unexpected table: ${table}`);
      },
    };

    const closed = await sweepOrphanedFollowUps(REASON);

    expect(closed).toBe(1);
    // Only the two referenced item ids were looked up.
    const itemsInCall = itemsCalls.find((c) => c.method === 'in');
    expect(itemsInCall!.args[1]).toEqual(expect.arrayContaining(['item-alive', 'item-dead']));
    const quotesInCall = quotesCalls.find((c) => c.method === 'in');
    expect(quotesInCall!.args[1]).toEqual(expect.arrayContaining([ALIVE_ID, DEAD_ID]));
    // closeFollowUp was called for the DEAD item only.
    const closeEqCalls = closeCalls.filter((c) => c.method === 'eq');
    expect(closeEqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === 'item-dead')).toBe(true);
    expect(closeEqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === 'item-alive')).toBe(false);
  });

  // #187 review FIX 2 (#660): the reconcile-race backstop — a pending
  // follow-up whose quote is now view_only=true gets closed too, even though
  // the quote row still exists (it's just excluded from future reconciles).
  it('closes a pending follow-up whose quote is now view_only=true; a non-view-only quote is left alone', async () => {
    const VIEW_ONLY_QUOTE_ID = '99999999-1111-1111-1111-111111111111';
    const { builder: pendingBuilder } = makeBuilder({
      data: [
        { id: 'fu-normal', inbox_item_id: 'item-normal' },
        { id: 'fu-frozen', inbox_item_id: 'item-frozen' },
      ],
      error: null,
    });
    const { builder: itemsBuilder } = makeBuilder({
      data: [
        { id: 'item-normal', external_id: ALIVE_ID, source: 'quotetool' },
        { id: 'item-frozen', external_id: VIEW_ONLY_QUOTE_ID, source: 'quotetool' },
      ],
      error: null,
    });
    const { builder: quotesBuilder, calls: quotesCalls } = makeBuilder({
      data: [
        { id: ALIVE_ID, view_only: false },
        { id: VIEW_ONLY_QUOTE_ID, view_only: true },
      ],
      error: null,
    });
    const { builder: closeBuilder, calls: closeCalls } = makeBuilder({
      data: [{ id: 'fu-frozen' }],
      error: null,
    });

    let followUpsCallCount = 0;
    sbRef.current = {
      from: (table: string) => {
        if (table === 'follow_ups') {
          followUpsCallCount += 1;
          return followUpsCallCount === 1 ? pendingBuilder : closeBuilder;
        }
        if (table === 'inbox_items') return itemsBuilder;
        if (table === 'quotes') return quotesBuilder;
        throw new Error(`unexpected table: ${table}`);
      },
    };

    const closed = await sweepOrphanedFollowUps(REASON);

    expect(closed).toBe(1);
    // The quotes lookup selected view_only alongside id.
    const selectCall = quotesCalls.find((c) => c.method === 'select');
    expect(selectCall!.args[0]).toContain('view_only');
    // closeFollowUp was called for the FROZEN (view_only) item only.
    const closeEqCalls = closeCalls.filter((c) => c.method === 'eq');
    expect(closeEqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === 'item-frozen')).toBe(true);
    expect(closeEqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === 'item-normal')).toBe(false);
  });

  it('returns 0 without querying further when there are no pending follow-ups', async () => {
    const { builder: pendingBuilder } = makeBuilder({ data: [], error: null });
    let fromCalls = 0;
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return pendingBuilder;
      },
    };

    const closed = await sweepOrphanedFollowUps(REASON);
    expect(closed).toBe(0);
    expect(fromCalls).toBe(1); // only the pending-follow_ups query fired
  });

  it('fails open (closes nothing) and logs when the pending-follow_ups lookup errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { builder: pendingBuilder } = makeBuilder({ data: null, error: { message: 'db down' } });
      sbRef.current = { from: (_table: string) => pendingBuilder };

      const closed = await sweepOrphanedFollowUps(REASON);
      expect(closed).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[inbox] orphan follow-up sweep: pending lookup failed:',
        'db down',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // Review hardening (#183): the other two lookup legs share the same
  // fail-open contract — a transient error must close NOTHING (the one
  // catastrophic failure mode here is a flaky read mass-closing live nudges).
  it('fails open (closes nothing) and logs when the inbox_items lookup errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { builder: pendingBuilder } = makeBuilder({
        data: [{ id: 'fu-dead', inbox_item_id: 'item-dead' }],
        error: null,
      });
      const { builder: itemsBuilder } = makeBuilder({ data: null, error: { message: 'items down' } });
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return pendingBuilder;
          if (table === 'inbox_items') return itemsBuilder;
          throw new Error(`unexpected table: ${table}`);
        },
      };

      const closed = await sweepOrphanedFollowUps(REASON);
      expect(closed).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[inbox] orphan follow-up sweep: inbox_items lookup failed:',
        'items down',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('fails open (closes nothing) and logs when the quotes lookup errors', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { builder: pendingBuilder } = makeBuilder({
        data: [{ id: 'fu-dead', inbox_item_id: 'item-dead' }],
        error: null,
      });
      const { builder: itemsBuilder } = makeBuilder({
        data: [{ id: 'item-dead', external_id: DEAD_ID, source: 'quotetool' }],
        error: null,
      });
      const { builder: quotesBuilder } = makeBuilder({ data: null, error: { message: 'quotes down' } });
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return pendingBuilder;
          if (table === 'inbox_items') return itemsBuilder;
          if (table === 'quotes') return quotesBuilder;
          throw new Error(`unexpected table: ${table}`);
        },
      };

      const closed = await sweepOrphanedFollowUps(REASON);
      expect(closed).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[inbox] orphan follow-up sweep: quotes lookup failed:',
        'quotes down',
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  // Review hardening (#183): a follow-up anchored on a NON-quotetool item is
  // never treated as an orphan candidate — the sweep can't derive a quote id
  // from another source's external_id shape.
  it('ignores follow-ups anchored on non-quotetool inbox items', async () => {
    const { builder: pendingBuilder } = makeBuilder({
      data: [{ id: 'fu-ghl', inbox_item_id: 'item-ghl' }],
      error: null,
    });
    const { builder: itemsBuilder } = makeBuilder({
      data: [{ id: 'item-ghl', external_id: 'conv-123', source: 'ghl' }],
      error: null,
    });
    let quotesQueried = false;
    const { builder: quotesBuilder } = makeBuilder({ data: [], error: null });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'follow_ups') return pendingBuilder;
        if (table === 'inbox_items') return itemsBuilder;
        if (table === 'quotes') {
          quotesQueried = true;
          return quotesBuilder;
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };

    const closed = await sweepOrphanedFollowUps(REASON);
    expect(closed).toBe(0);
    expect(quotesQueried).toBe(false); // no quotetool candidates → no quotes lookup at all
  });
});

describe('closeQuoteInboxNoise — I/O wiring (#187a)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const QUOTE_ID = '99999999-9999-9999-9999-999999999999';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';

  /** Dispatch `from()` by table, returning the SELECT builder on the first
   *  `inbox_items` call and the UPDATE builder on the second. */
  function makeSbForCleanup(opts: {
    itemsSelect: { data: unknown; error: null | { message: string } };
    followUpsUpdate?: { data: unknown; error: null | { message: string } };
    itemsUpdate?: { data: unknown; error: null | { message: string } };
    activityInsert?: { data: unknown; error: null | { message: string } };
  }) {
    const { builder: itemsSelectBuilder, calls: itemsSelectCalls } = makeBuilder(opts.itemsSelect);
    const { builder: fuBuilder, calls: fuCalls } = makeBuilder(opts.followUpsUpdate ?? { data: [], error: null });
    const { builder: itemsUpdateBuilder, calls: itemsUpdateCalls } = makeBuilder(
      opts.itemsUpdate ?? { data: [], error: null },
    );
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder(
      opts.activityInsert ?? { data: null, error: null },
    );
    let inboxItemsCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxItemsCallCount += 1;
        return inboxItemsCallCount === 1 ? itemsSelectBuilder : itemsUpdateBuilder;
      }
      if (table === 'follow_ups') return fuBuilder;
      if (table === 'dashboard_activity') return activityBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, itemsSelectCalls, fuCalls, itemsUpdateCalls, activityCalls };
  }

  // #187 review FIX 1 (#660): the lookup is scoped to the EXACT bare-uuid
  // external_id — never `.in([bare, suffixed])` — so a sibling
  // `${quoteId}:color-request` item (a still-live customer ask; the
  // colour-request flow is deliberately ungated on view_only) can never be
  // matched by this query, structurally, regardless of what other quotetool
  // items exist for the same quote.
  it('looks up ONLY the bare-uuid external_id — never the :color-request one', async () => {
    const { from, itemsSelectCalls } = makeSbForCleanup({ itemsSelect: { data: [], error: null } });
    sbRef.current = { from };

    await closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID);

    const sourceEqCall = itemsSelectCalls.find((c) => c.method === 'eq' && c.args[0] === 'source');
    expect(sourceEqCall!.args).toEqual(['source', 'quotetool']);
    const idEqCall = itemsSelectCalls.find((c) => c.method === 'eq' && c.args[0] === 'external_id');
    expect(idEqCall!.args).toEqual(['external_id', QUOTE_ID]);
    // No `.in()` on the select at all — the old both-shapes lookup is gone.
    expect(itemsSelectCalls.some((c) => c.method === 'in')).toBe(false);
  });

  it('closes the pending follow-up and resolves the open item for the bare-uuid external_id', async () => {
    const { from, fuCalls, itemsUpdateCalls, activityCalls } = makeSbForCleanup({
      itemsSelect: { data: [{ id: 'item-bare', status: 'unresponded', followed_up_at: null }], error: null },
    });
    sbRef.current = { from };

    await closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID);

    const fuInCall = fuCalls.find((c) => c.method === 'in');
    expect(fuInCall!.args).toEqual(['inbox_item_id', ['item-bare']]);
    const fuUpdateCall = fuCalls.find((c) => c.method === 'update');
    expect(fuUpdateCall!.args[0]).toEqual({ status: 'done' });
    const fuReasonEq = fuCalls.find((c) => c.method === 'eq' && c.args[0] === 'reason');
    expect(fuReasonEq!.args[1]).toBe('quote_sent_no_reply');

    const itemInCall = itemsUpdateCalls.find((c) => c.method === 'in');
    expect(itemInCall!.args).toEqual(['id', ['item-bare']]);
    const itemUpdateCall = itemsUpdateCalls.find((c) => c.method === 'update');
    expect(itemUpdateCall!.args[0]).toMatchObject({ status: 'completed', handled_by: OPERATOR_ID });

    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toEqual([
      expect.objectContaining({ actor: OPERATOR_ID, action: 'completed', inbox_item_id: 'item-bare' }),
    ]);
  });

  // #187 review FIX 4 (#660): detail.from must carry the item's PRIOR
  // status/follow state — inverseOf('completed', detail.from) (lifecycle.ts)
  // reads detail.from.status specifically and silently falls back to
  // 'handled' when it's missing or the wrong shape (e.g. a bare string).
  it('carries the item prior status + follow flag into detail.from (so Reverse restores the right bucket)', async () => {
    const { from, activityCalls } = makeSbForCleanup({
      itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: '2026-07-01T00:00:00Z' }], error: null },
    });
    sbRef.current = { from };

    await closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID);

    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toEqual([
      expect.objectContaining({
        detail: { note: 'Quote marked view-only', from: { status: 'handled', wasFollowed: true } },
      }),
    ]);
  });

  it('never re-stamps an already-completed/dismissed item, but still tries to close its follow-up', async () => {
    const { from, fuCalls, itemsUpdateCalls, activityCalls } = makeSbForCleanup({
      itemsSelect: {
        data: [{ id: 'item-done', status: 'completed', followed_up_at: null }],
        error: null,
      },
    });
    sbRef.current = { from };

    await closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID);

    // Follow-up close is still attempted (independent record).
    const fuInCall = fuCalls.find((c) => c.method === 'in');
    expect(fuInCall!.args).toEqual(['inbox_item_id', ['item-done']]);

    // But the already-resolved item is never re-stamped or logged.
    expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
    expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('does nothing further when no inbox item matches the bare-uuid external_id', async () => {
    let fromCalls = 0;
    const { builder } = makeBuilder({ data: [], error: null });
    sbRef.current = {
      from: (_table: string) => {
        fromCalls += 1;
        return builder;
      },
    };

    await closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID);
    expect(fromCalls).toBe(1); // only the inbox_items lookup fired
  });

  it('is non-fatal (fails open, warns) when the inbox_items lookup errors', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { builder } = makeBuilder({ data: null, error: { message: 'db down' } });
      sbRef.current = { from: (_table: string) => builder };

      await expect(closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID)).resolves.toBeUndefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[inbox] view-only cleanup: item lookup failed (non-fatal):',
        'db down',
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('is non-fatal (warns) when the inbox write fails — the toggle response is never blocked', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { from, fuCalls } = makeSbForCleanup({
        itemsSelect: { data: [{ id: 'item-open', status: 'unresponded' }], error: null },
        itemsUpdate: { data: null, error: { message: 'write failed' } },
      });
      sbRef.current = { from };

      await expect(closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID)).resolves.toBeUndefined();
      // The independent follow-up close was still attempted despite the item
      // write failing.
      expect(fuCalls.some((c) => c.method === 'update')).toBe(true);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[inbox] view-only cleanup: item resolve failed (non-fatal):',
        'write failed',
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('no-ops (no throw) when the service client is not configured', async () => {
    sbRef.current = null;
    await expect(closeQuoteInboxNoise(QUOTE_ID, OPERATOR_ID)).resolves.toBeUndefined();
  });
});

// #208: inbox_items.handled_by is a `uuid references auth.users(id)` column.
// The route callers used to fall back to the literal string 'system' when no
// operator resolved (operator?.id ?? 'system') — a non-uuid string a uuid
// column rejects outright. The fix widened operatorId to `string | null` and
// the callers now pass `?? null`. These functions' own write logic was
// already a straight passthrough (never the bug); these tests lock in that
// both a real uuid AND null now flow through to handled_by correctly.
describe('markItemHandledLocal / dismissItem / markItemCompleted — handled_by uuid-or-null (#208)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-07T12:00:00Z');

  /** Dispatch .from('inbox_items') by call order: 1st = priorStateOf's plain
   *  SELECT, 2nd = the function's own UPDATE (...) chain. .from('dashboard_activity')
   *  gets its own builder, mirroring makeSbForCleanup above. */
  function makeSbFor(itemUpdateResult: { data: unknown; error: null | { message: string } }) {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder, calls: updateCalls } = makeBuilder(itemUpdateResult);
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder({ data: null, error: null });
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        return inboxCallCount === 1 ? priorBuilder : updateBuilder;
      }
      if (table === 'dashboard_activity') return activityBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, updateCalls, activityCalls };
  }

  it('markItemHandledLocal writes the real operator uuid to handled_by on the normal path', async () => {
    const { from, updateCalls, activityCalls } = makeSbFor({
      data: { source: 'ghl', external_id: 'ext-1', source_message_id: null, dashboard_contacts: null },
      error: null,
    });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'handled', handled_by: OPERATOR_ID });
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({ actor: OPERATOR_ID, action: 'handled' });
  });

  it('markItemHandledLocal writes NULL (never a sentinel string) to handled_by when no operator resolved', async () => {
    const { from, updateCalls } = makeSbFor({
      data: { source: 'ghl', external_id: 'ext-1', source_message_id: null, dashboard_contacts: null },
      error: null,
    });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, null, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ handled_by: null });
    expect(updateCall!.args[0]).not.toMatchObject({ handled_by: 'system' });
  });

  it('markItemHandledLocal still surfaces a real DB error (never silently swallowed)', async () => {
    const { from } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('connection reset');
  });

  it('dismissItem writes the real operator uuid to handled_by on the normal path', async () => {
    const { from, updateCalls, activityCalls } = makeSbFor({
      data: { dashboard_contacts: null },
      error: null,
    });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'dismissed', handled_by: OPERATOR_ID });
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({ actor: OPERATOR_ID, action: 'dismissed' });
  });

  it('dismissItem writes NULL (never a sentinel string) to handled_by when no operator resolved', async () => {
    const { from, updateCalls } = makeSbFor({ data: { dashboard_contacts: null }, error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, null, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ handled_by: null });
  });

  it('markItemCompleted writes the real operator uuid to handled_by on the normal path', async () => {
    const { from, updateCalls, activityCalls } = makeSbFor({ data: [{ id: ITEM_ID }], error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'completed', handled_by: OPERATOR_ID });
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({ actor: OPERATOR_ID, action: 'completed' });
  });

  it('markItemCompleted writes NULL (never a sentinel string) to handled_by when no operator resolved', async () => {
    const { from, updateCalls } = makeSbFor({ data: [{ id: ITEM_ID }], error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, null, NOW);
    expect(res.ok).toBe(true);

    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ handled_by: null });
    expect(updateCall!.args[0]).not.toMatchObject({ handled_by: 'system' });
  });

  it('markItemCompleted still surfaces a real DB error (never silently swallowed)', async () => {
    const { from } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('connection reset');
  });
});

// #252 follow-up-autoclose: nothing closed a pending follow-up when its
// anchored item reached a TERMINAL state (completed/dismissed) — it kept
// nagging "due today" forever. markItemCompleted/dismissItem now close any
// pending follow-up anchored to the item, but ONLY on the path where their own
// guarded update actually matched a row, and NEVER for markItemHandledLocal
// ('handled' is not terminal — it's the normal quote-sent-awaiting-reply case
// the follow-up exists to chase, and must keep nagging until a reply or a
// terminal transition closes it).
describe('markItemCompleted / dismissItem — close anchored follow-ups on terminal transition (#252 follow-up-autoclose)', () => {
  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-18T12:00:00Z');

  beforeEach(() => {
    sbRef.current = null;
  });

  /** Dispatch by table: inbox_items (1st call = priorStateOf's SELECT, 2nd =
   *  the function's own guarded UPDATE), dashboard_activity, and follow_ups
   *  (the #252 close). Mirrors the #208 describe block's makeSbFor above,
   *  extended with a follow_ups builder. */
  function makeSbFor(
    itemUpdateResult: { data: unknown; error: null | { message: string } },
    followUpCloseResult: { data: unknown; error: null | { message: string } } = { data: [], error: null },
  ) {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder } = makeBuilder(itemUpdateResult);
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder({ data: null, error: null });
    const { builder: followUpBuilder, calls: followUpCalls } = makeBuilder(followUpCloseResult);
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        return inboxCallCount === 1 ? priorBuilder : updateBuilder;
      }
      if (table === 'dashboard_activity') return activityBuilder;
      if (table === 'follow_ups') return followUpBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, activityCalls, followUpCalls };
  }

  it('markItemCompleted closes a pending follow-up anchored to the item', async () => {
    const { from, followUpCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null }, { data: [{ id: 'fu-1' }], error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const updateCall = followUpCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'done' });
    const eqCalls = followUpCalls.filter((c) => c.method === 'eq');
    expect(eqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === ITEM_ID)).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === 'status' && c.args[1] === 'pending')).toBe(true);
  });

  it('dismissItem closes a pending follow-up anchored to the item', async () => {
    const { from, followUpCalls } = makeSbFor({ data: { dashboard_contacts: null }, error: null }, { data: [{ id: 'fu-1' }], error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const updateCall = followUpCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'done' });
    const eqCalls = followUpCalls.filter((c) => c.method === 'eq');
    expect(eqCalls.some((c) => c.args[0] === 'inbox_item_id' && c.args[1] === ITEM_ID)).toBe(true);
  });

  it('markItemCompleted no-op (guard matched nothing) never touches follow_ups', async () => {
    const { from, followUpCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    expect(followUpCalls.length).toBe(0);
  });

  it('dismissItem no-op (already dismissed) never touches follow_ups', async () => {
    const { from, followUpCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW);

    // Already-dismissed is a reported success no-op per dismissItem's own doc
    // (never re-logs a duplicate reversible row) — but it must still skip the
    // follow-up close, since nothing actually transitioned.
    expect(res.ok).toBe(true);
    expect(followUpCalls.length).toBe(0);
  });

  it('a store-level failure closing the follow-up is swallowed — the completion still reports ok', async () => {
    const { from } = makeSbFor({ data: { id: ITEM_ID }, error: null }, { data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
  });

  it("markItemHandledLocal ('handled') never touches follow_ups — the quote-sent-awaiting-reply nag must keep nagging", async () => {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder } = makeBuilder({
      data: { source: 'ghl', external_id: 'ext-1', source_message_id: null, dashboard_contacts: null },
      error: null,
    });
    const { builder: activityBuilder } = makeBuilder({ data: null, error: null });
    let inboxCallCount = 0;
    let followUpsQueried = false;
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          inboxCallCount += 1;
          return inboxCallCount === 1 ? priorBuilder : updateBuilder;
        }
        if (table === 'dashboard_activity') return activityBuilder;
        if (table === 'follow_ups') {
          followUpsQueried = true;
          throw new Error('markItemHandledLocal must never touch follow_ups');
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(followUpsQueried).toBe(false);
  });
});

// #224 (S35 wrap, staff MED): markItemCompleted had NO status guard at all — a
// bare .eq('id', itemId) — while its siblings markItemHandledLocal/dismissItem
// at least guard .neq('status','handled')/.neq('status','dismissed') against
// re-applying the SAME action. Fix: markItemCompleted now guards against
// overwriting either terminal state it should never clobber — 'dismissed'
// (sticky spam, per reducer.ts) and 'completed' (idempotent re-apply, sibling
// parity). 'unresponded' → completed and 'handled' → completed stay legal
// (InboxList.tsx's "Mark completed" button fires directly from the open queue,
// and InWorksSection.tsx's fires from the handled bucket — both real workflows).
describe('markItemCompleted — status guard (#224)', () => {
  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-14T12:00:00Z');

  beforeEach(() => {
    sbRef.current = null;
  });

  /** Mirrors the #208 describe block's makeSbFor: 1st .from('inbox_items') call
   *  is priorStateOf's SELECT, 2nd is the update chain under test. */
  function makeSbFor(itemUpdateResult: { data: unknown; error: null | { message: string } }) {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder, calls: updateCalls } = makeBuilder(itemUpdateResult);
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder({ data: null, error: null });
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        return inboxCallCount === 1 ? priorBuilder : updateBuilder;
      }
      if (table === 'dashboard_activity') return activityBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, updateCalls, activityCalls };
  }

  it('blocks re-completing an item the guard excluded (already dismissed or already completed), and does not log activity', async () => {
    // maybeSingle() returns null when the guarded UPDATE...WHERE matched zero
    // rows (status was 'dismissed' or 'completed') — no DB error, just nothing
    // to update.
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/dismissed|completed/i);
    // The logically-wrong-200 the ticket calls out: a blocked guard must not
    // ALSO write a false activity trail claiming the action happened.
    expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('the update chain is a POSITIVE match on the two legal source statuses (the actual guard, not just the observed outcome)', async () => {
    // Positive `.in(...)`, not a negative `.neq(...)` pair — see markItemCompleted's
    // doc comment for the fail-open-vs-fail-closed reasoning (positive-seam-gate
    // convention, AGENTS.md Pitfalls).
    const { from, updateCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    const inCalls = updateCalls.filter((c) => c.method === 'in').map((c) => c.args);
    expect(inCalls).toContainEqual(['status', ['unresponded', 'handled']]);
  });

  it('still allows the normal forward transitions (unresponded/handled → completed)', async () => {
    const { from, activityCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({ actor: OPERATOR_ID, action: 'completed' });
  });
});

// #230(a): the previously-console.warn-only #220 suppression trace now also
// lands in dashboard_activity, so it shows up on the /inbox/activity page.
describe('recordSuppressedFollowUp (#230a — suppression visibility)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('inserts a followup_suppressed activity row for the item, actor system', async () => {
    const { builder, calls } = makeBuilder({ data: null, error: null });
    sbRef.current = { from: () => builder };

    await recordSuppressedFollowUp('item-99', { quoteId: 'q1', quoteNumber: 1262 });

    const insertCall = calls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({
      actor: 'system',
      action: 'followup_suppressed',
      inbox_item_id: 'item-99',
      detail: { quoteId: 'q1', quoteNumber: 1262 },
    });
  });

  it('no-ops (no throw) when the service client is not configured', async () => {
    sbRef.current = null;
    await expect(recordSuppressedFollowUp('item-99', {})).resolves.toBeUndefined();
  });
});
