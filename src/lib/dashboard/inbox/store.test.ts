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

// ─── planIngest — noopReingest (#110 W7-004 + #316 write-amplification) ───────

describe('planIngest — noopReingest short-circuits dead re-ingests', () => {
  const resolved = (status: 'handled' | 'completed' | 'dismissed'): ExistingItem => ({
    id: 'i1',
    contactId: 'A',
    status,
    notifiedLevels: [],
    lastMessageAt: T,
  });

  // #316: an ExistingItem whose touch-derived fields exactly mirror what
  // touch()'s defaults produce on the ItemRow (direction 'inbound', channel
  // 'sms', preview 'hello', no subject/sourceMessageId, leadKind 'lead', no
  // quoteValue, no raw so no raw.highlevel_contact_id/raw.customer_name) —
  // i.e. the stored row from a PRIOR identical ingest of touch(). Absent
  // touch fields normalize to `null` on the item (`?? null` / `?? 'lead'`),
  // so the matching existing fixture must spell those out as `null`, not
  // leave them `undefined` — see the "missing fields" test below for why
  // that distinction matters.
  const unrespondedMatchingTouch = (over: Partial<ExistingItem> = {}): ExistingItem => ({
    id: 'i1',
    contactId: 'A',
    status: 'unresponded',
    notifiedLevels: [],
    lastMessageAt: T,
    direction: 'inbound',
    channel: 'sms',
    preview: 'hello',
    subject: null,
    sourceMessageId: null,
    leadKind: 'lead',
    quoteValue: null,
    rawHighlevelContactId: null,
    rawCustomerName: null,
    ...over,
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

  // #316: this used to assert `false` ("escalation colour ages") — flipped to
  // `true`. escalation_level is deliberately NOT part of the content-change
  // check (see IngestPlan.noopReingest's doc): it's a pure function of
  // (last_message_at, now) that changes on nearly every tick for an aging
  // open item, and the separately-scheduled escalate cron (every 10 min,
  // sync.ts's runEscalation) — not ingest — is what keeps the stored column
  // caught up. A genuinely identical re-observation of the same open
  // conversation now stops writing a dead 'ingested' row every reconcile tick.
  it('an unresponded item re-ingested with the identical message AND identical content is a no-op (#316)', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch(),
      touch: touch({ direction: 'inbound', lastMessageAt: T }),
      now: at(5 * HOUR),
    });
    expect(plan.noopReingest).toBe(true);
    expect(plan.item.escalation_level).toBe(2); // still computed fresh in the plan...
    // ...but ingestTouch never persists it on a noop — the escalate cron owns
    // catching the stored column up (see the doc above).
  });

  it('a genuinely newer last_message_at on an unresponded item is NOT a no-op, even with identical content otherwise', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch(),
      touch: touch({ direction: 'inbound', lastMessageAt: at(HOUR), preview: 'hello' }),
      now: at(2 * HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  // #316 concrete real-world case: a still-DRAFT quotetool lead pins
  // lastMessageAt to created_at (quotetool.ts's normalizeQuoteTouch), so
  // staff editing the draft's total changes preview + quote_value with the
  // timestamp completely frozen. Decided MATERIAL — a changed price is
  // exactly the kind of content staff need to see, so it must still write
  // and log, not disappear into the noop.
  it('a changed preview + quote_value with the SAME last_message_at is NOT a no-op (a still-draft quote total was edited)', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch({ channel: 'app', preview: 'Quote — $2500', quoteValue: 2500 }),
      touch: touch({
        source: 'quotetool',
        externalId: 'quote-1',
        channel: 'app',
        direction: 'inbound',
        lastMessageAt: T,
        preview: 'Quote — $2800', // total was edited from $2500 to $2800
        leadKind: 'lead',
        quoteValue: 2800,
      }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(false);
    expect(plan.item.quote_value).toBe(2800); // the new total DOES get persisted
  });

  // A subject-only change (same preview, same timestamp) — subject is a real
  // touch-derived field the upsert writes, so it's held to the same bar.
  it('a changed subject with the SAME last_message_at is NOT a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch({ subject: 'Old subject' }),
      touch: touch({ direction: 'inbound', lastMessageAt: T, subject: 'New subject' }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  // #316 follow-up (review FIX 2) — concrete traced case: a still-open draft
  // quote gets linked to a GHL contact via /api/integrations/highlevel/attach
  // (writes quotes.highlevel_contact_id only, never inbox_items or
  // dashboard_contacts) between two reconcile ticks. The stored item's
  // frozen raw still shows no contact; the next tick's touch carries the
  // newly-attached one, content otherwise identical. MUST NOT no-op, or
  // inbox_items.raw stays frozen pre-attach and getItemForReply's fallback
  // keeps showing "no GHL contact linked" on an item that IS linked.
  it('a draft quote attached to a GHL contact between two ticks (raw.highlevel_contact_id changed, nothing else did) is NOT a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch({ rawHighlevelContactId: null, rawCustomerName: 'Jane Doe' }),
      touch: touch({
        source: 'quotetool',
        direction: 'inbound',
        lastMessageAt: T,
        raw: { highlevel_contact_id: 'ghl-contact-99', customer_name: 'Jane Doe' },
      }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  // #316 follow-up: both sides null is the ORDINARY shape (every non-quotetool
  // source's raw lacks these keys entirely, and so does an un-attached
  // quotetool draft) — still a no-op. Guards against the new pair breaking
  // the noop for sources that never carry it.
  it('raw.highlevel_contact_id/customer_name null on BOTH sides is still a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch(), // rawHighlevelContactId/rawCustomerName both null
      touch: touch({ direction: 'inbound', lastMessageAt: T }), // no raw on the touch -> both null
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(true);
  });

  // #316 follow-up: raw.customer_name changing alone (contact id unchanged)
  // is held to the same bar as the contact-id case above.
  it('a changed raw.customer_name with everything else identical is NOT a no-op', () => {
    const plan = planIngest({
      candidates: [],
      existing: unrespondedMatchingTouch({ rawHighlevelContactId: 'ghl-contact-1', rawCustomerName: 'Old Name' }),
      touch: touch({
        source: 'quotetool',
        direction: 'inbound',
        lastMessageAt: T,
        raw: { highlevel_contact_id: 'ghl-contact-1', customer_name: 'New Name' },
      }),
      now: at(HOUR),
    });
    expect(plan.noopReingest).toBe(false);
  });

  // Fail-safe design check: an ExistingItem fixture that never populated the
  // new #316 fields (undefined, as every OTHER test in this file predates
  // #316) never qualifies for the content-match path, even when the touch's
  // content would otherwise line up — undefined never `===` a real value.
  // findExistingItem always populates them in production; this only protects
  // against a future caller that forgets to.
  it('an unresponded item with UNPOPULATED existing content fields is NOT a no-op (fails safe, never over-skips)', () => {
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
  ANCHORED_ITEM_RESOLVABLE_STATUS,
  closeFollowUp,
  closeFollowUpsForResolvedItem,
  closeQuoteInboxNoise,
  completeTerminalQuoteItems,
  dismissItem,
  ensureFollowUp,
  EXCLUDE_LEGACY_REBOOK_FROM_INBOX,
  excludeLegacyRebookItems,
  findOrphanedFollowUpItems,
  findViewOnlyFollowUpItems,
  getItemStatus,
  getGmailWritebackRetryTarget,
  getReopenCounts,
  isColorRequestExternalId,
  isHiddenLegacyRebookQuote,
  isReversibleActivity,
  listActivity,
  listDueFollowUps,
  listGmailWritebackFailures,
  listInWorks,
  listOpenItems,
  listEscalatableItems,
  listPendingColorRequests,
  markFollowUpDone,
  markItemCompleted,
  markItemFollowed,
  markItemHandledLocal,
  shouldResolveAnchoredItem,
  needsLookReason,
  quoteIdPrefix,
  recordSuppressedFollowUp,
  recordWriteback,
  reverseItemState,
  sweepOrphanedFollowUps,
  sweepResolvedItemFollowUps,
} from './store';
import { QUOTE_STATUSES, type QuoteStatus } from '@/lib/quoteStatus';

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

// ─── isColorRequestExternalId — row 321 (pure) ───────────────────────────────

describe('isColorRequestExternalId (row 321)', () => {
  it('true for a :color-request-suffixed external_id', () => {
    expect(isColorRequestExternalId('quote-1:color-request')).toBe(true);
  });

  it('false for a bare quote id', () => {
    expect(isColorRequestExternalId('quote-1')).toBe(false);
  });

  it('false for a non-quotetool-shaped external_id', () => {
    expect(isColorRequestExternalId('conv-abc123')).toBe(false);
  });
});

// ─── needsLookReason — #307 "Needs a look" (pure) ────────────────────────────

describe('needsLookReason (#307 — pure "Needs a look" evidence rule)', () => {
  const settled = { direction: 'outbound' as string | null, quoteStatus: null as QuoteStatus | null, followUpPending: false };

  // Rule (a), proved over the FULL QuoteStatus enum rather than a few
  // hand-picked cases — 'sent'/'viewed'/'changes_requested' flag, every other
  // status (including the three dead ones and 'draft') does not.
  it.each(QUOTE_STATUSES)('rule (a) alone — quoteStatus=%s (direction outbound, no pending follow-up)', (status) => {
    const result = needsLookReason({ ...settled, quoteStatus: status });
    const expectFlagged = status === 'sent' || status === 'viewed' || status === 'changes_requested';
    expect(result).toBe(expectFlagged ? 'Quote unanswered' : null);
  });

  it('rule (a): no linked quote (quoteStatus null) does not flag on its own', () => {
    expect(needsLookReason({ ...settled, quoteStatus: null })).toBeNull();
  });

  it('rule (b) alone: direction "inbound" flags "They wrote last"', () => {
    expect(needsLookReason({ direction: 'inbound', quoteStatus: null, followUpPending: false })).toBe(
      'They wrote last',
    );
  });

  it('rule (b): direction "outbound" does not flag on its own', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: null, followUpPending: false })).toBeNull();
  });

  it('rule (b): direction null (no message direction recorded) does not flag on its own', () => {
    expect(needsLookReason({ direction: null, quoteStatus: null, followUpPending: false })).toBeNull();
  });

  it('rule (c) alone: a pending follow-up flags "Follow-up due"', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: null, followUpPending: true })).toBe(
      'Follow-up due',
    );
  });

  it('rule (c): no pending follow-up does not flag on its own', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: null, followUpPending: false })).toBeNull();
  });

  it('the negative case: a genuinely finished row (booked quote, staff spoke last, no pending follow-up) is NOT flagged', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: 'booked', followUpPending: false })).toBeNull();
  });

  it('the negative case, no linked quote at all: staff spoke last, no pending follow-up is NOT flagged', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: null, followUpPending: false })).toBeNull();
  });

  it('combination a+b: "Quote unanswered" wins over "They wrote last" when both fire', () => {
    expect(needsLookReason({ direction: 'inbound', quoteStatus: 'sent', followUpPending: false })).toBe(
      'Quote unanswered',
    );
  });

  it('combination a+c: "Quote unanswered" wins over "Follow-up due" when both fire', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: 'viewed', followUpPending: true })).toBe(
      'Quote unanswered',
    );
  });

  it('combination b+c: "They wrote last" wins over "Follow-up due" when rule (a) does not fire', () => {
    expect(needsLookReason({ direction: 'inbound', quoteStatus: null, followUpPending: true })).toBe(
      'They wrote last',
    );
  });

  it('combination a+b+c: "Quote unanswered" still wins when all three fire together', () => {
    expect(
      needsLookReason({ direction: 'inbound', quoteStatus: 'changes_requested', followUpPending: true }),
    ).toBe('Quote unanswered');
  });

  it('an approved quote does not itself satisfy rule (a), but does not suppress rule (b) either', () => {
    expect(needsLookReason({ direction: 'inbound', quoteStatus: 'approved', followUpPending: false })).toBe(
      'They wrote last',
    );
  });

  it('a declined (dead) quote does not itself satisfy rule (a), but does not suppress rule (c) either', () => {
    expect(needsLookReason({ direction: 'outbound', quoteStatus: 'declined', followUpPending: true })).toBe(
      'Follow-up due',
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

  // Row 321 fix-round FIX 1: isColorRequest is now shape AND liveness (a
  // batched quotes lookup), not shape alone — see isLiveColorRequestItem's
  // own doc in store.ts.
  it('sets isColorRequest true for a quotetool item whose external_id is :color-request-suffixed AND whose quote still has a live pendingColorRequest, false for the bare sibling regardless', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const colorRequestRow = {
      id: 'item-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      direction: 'inbound',
      last_message_at: '2026-08-17T17:37:48.337Z',
      preview: 'Champagne',
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: 'lead',
      quote_value: null,
      dashboard_contacts: null,
    };
    const bareQuoteRow = {
      ...colorRequestRow,
      id: 'item-bare',
      external_id: QUOTE_UUID,
    };
    const { builder: mainBuilder } = makeBuilder({ data: [colorRequestRow, bareQuoteRow], error: null });
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: QUOTE_UUID, approval_snapshot: { pendingColorRequest: { label: 'Champagne' } } }],
      error: null,
    });
    sbRef.current = { from: (table: string) => (table === 'quotes' ? quotesBuilder : mainBuilder) };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bare item is NEVER flagged regardless of its quote's liveness — the
    // badge stays scoped to the item that actually represents the ask.
    expect(result.items.find((i) => i.id === 'item-cr')!.isColorRequest).toBe(true);
    expect(result.items.find((i) => i.id === 'item-bare')!.isColorRequest).toBe(false);
  });

  // Row 321 fix-round FIX 1 (staff MED half): the ORIGINAL shape-only bug —
  // once staff applies/dismisses the colour via ColorRequestPanel,
  // approval_snapshot.pendingColorRequest is cleared, so the badge must turn
  // OFF even though the item's external_id still carries the suffix forever.
  it('reads isColorRequest false once pendingColorRequest has been applied/dismissed, even though the external_id suffix never changes', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const colorRequestRow = {
      id: 'item-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      direction: 'outbound',
      last_message_at: '2026-08-17T17:37:48.337Z',
      preview: 'Champagne',
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: 'lead',
      quote_value: null,
      dashboard_contacts: null,
    };
    const { builder: mainBuilder } = makeBuilder({ data: [colorRequestRow], error: null });
    // No pendingColorRequest key at all — the normal post-apply/dismiss shape.
    const { builder: quotesBuilder } = makeBuilder({
      data: [{ id: QUOTE_UUID, approval_snapshot: { customerSelection: { colorSchemeId: 'as-applied' } } }],
      error: null,
    });
    sbRef.current = { from: (table: string) => (table === 'quotes' ? quotesBuilder : mainBuilder) };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].isColorRequest).toBe(false);
  });

  // Row 321 fix-round FIX 1: fail-safe direction on a liveness-lookup error —
  // OPPOSITE of the legacy-rebook exclusion's own fail-open (hide nothing);
  // here a query error must make the caller show MORE badges, never fewer.
  it('fails SAFE (badges shown) when the color-request liveness lookup itself errors', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const colorRequestRow = {
      id: 'item-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      direction: 'inbound',
      last_message_at: '2026-08-17T17:37:48.337Z',
      preview: 'Champagne',
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: 'lead',
      quote_value: null,
      dashboard_contacts: null,
    };
    const { builder: mainBuilder } = makeBuilder({ data: [colorRequestRow], error: null });
    const { builder: quotesBuilder } = makeBuilder({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from: (table: string) => (table === 'quotes' ? quotesBuilder : mainBuilder) };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].isColorRequest).toBe(true);
  });

  it('never flags isColorRequest for a non-quotetool source, even with a colon in external_id', async () => {
    const row = {
      id: 'item-ghl',
      source: 'ghl',
      external_id: 'conv-1:color-request', // pathological — a real ghl id never looks like this
      channel: 'sms',
      direction: 'inbound',
      last_message_at: '2026-08-17T17:37:48.337Z',
      preview: 'hi',
      subject: null,
      escalation_level: 0,
      contact_id: null,
      lead_kind: 'lead',
      quote_value: null,
      dashboard_contacts: null,
    };
    const { builder: mainBuilder } = makeBuilder({ data: [row], error: null });
    sbRef.current = { from: (_table: string) => mainBuilder };

    const result = await listOpenItems(100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].isColorRequest).toBe(false);
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

// ─── listGmailWritebackFailures / getGmailWritebackRetryTarget — Gmail
// write-back failure visibility + retry (#342, fix round) ───────────────────
//
// recordWriteback (untested I/O glue, per this file's own convention) has
// always persisted runHandledWriteback's per-channel outcome into
// handled_channel_sync; nothing ever read it back. listGmailWritebackFailures
// is the read side (drives the /inbox banner); getGmailWritebackRetryTarget
// is the write-back RETRY side (drives the retry-gmail-sync route). Round 1
// shipped a bare count via `count:'exact', head:true` with no drill-down and
// no exit — a staff-lens BLOCK caught both, plus a MED where a query FAILURE
// (not just "nothing failed") silently rendered as a confident 0/all-clear.
// This round fixes all three.

// Fix round MED 3: recordWriteback used to discard its own update() error —
// the same silent-failure shape one hop upstream of the { count } bug. Now
// logged (still fire-and-forget/best-effort, so it stays void) rather than
// silent.
describe('recordWriteback (#342 fix round MED 3 — a failed persist is no longer silent)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('logs an error when the update() call itself fails', async () => {
    const { builder } = makeBuilder({ data: null, error: { message: 'update rejected' } });
    sbRef.current = { from: () => builder };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await recordWriteback('item-1', { gmailLabel: 'failed' });

    expect(spy).toHaveBeenCalledWith(
      '[inbox] recordWriteback failed to persist handled_channel_sync:',
      'update rejected',
    );
    spy.mockRestore();
  });

  it('does NOT log anything when the update() succeeds', async () => {
    const { builder } = makeBuilder({ data: null, error: null });
    sbRef.current = { from: () => builder };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await recordWriteback('item-1', { gmailLabel: 'ok' });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('listGmailWritebackFailures (#342 fix round — drill-down + honest error state)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  // listGmailWritebackFailures now fires 3 PARALLEL .from('inbox_items')
  // calls (the page query, then the failedCount and unconfiguredCount
  // head:true queries) via Promise.all — call order is still deterministic
  // (the array literal is built synchronously before any await), so this
  // routes by call index, same pattern as getReopenCounts' own test above.
  // `results[i]` may be omitted for a test that only cares about an earlier
  // call (e.g. the page-query-fails case never reaches the other two).
  function makeRouter(results: Array<{ data: unknown; error: null | { message: string }; count?: number | null }>) {
    const builders = results.map((r) => makeBuilder(r));
    let i = 0;
    return {
      sb: {
        from: () => {
          const b = builders[i] ?? builders[builders.length - 1];
          i += 1;
          return b.builder;
        },
      },
      builders,
    };
  }

  it('returns the all-clear shape (not an error) when Supabase is unconfigured', async () => {
    const res = await listGmailWritebackFailures();
    expect(res).toEqual({ ok: true, items: [], total: 0, failedCount: 0, unconfiguredCount: 0, truncated: false });
  });

  it('ok:false with the page query\'s error message on a real query failure — NOT a silent 0 (the round-1 MED)', async () => {
    const { sb } = makeRouter([{ data: null, error: { message: 'connection reset' }, count: null }]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures();

    expect(res).toEqual({ ok: false, error: 'connection reset' });
  });

  it('ok:false when the failedCount query fails, even though the page query itself succeeded', async () => {
    const { sb } = makeRouter([
      { data: [], error: null, count: 0 },
      { data: null, error: { message: 'failedCount query down' }, count: null },
      { data: null, error: null, count: 0 },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures();

    expect(res).toEqual({ ok: false, error: 'failedCount query down' });
  });

  it('ok:false when the unconfiguredCount query fails, even though the other two succeeded', async () => {
    const { sb } = makeRouter([
      { data: [], error: null, count: 0 },
      { data: null, error: null, count: 0 },
      { data: null, error: { message: 'unconfiguredCount query down' }, count: null },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures();

    expect(res).toEqual({ ok: false, error: 'unconfiguredCount query down' });
  });

  it('returns the all-clear shape when nothing has failed', async () => {
    const { sb } = makeRouter([
      { data: [], error: null, count: 0 },
      { data: null, error: null, count: 0 },
      { data: null, error: null, count: 0 },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures();

    expect(res).toEqual({ ok: true, items: [], total: 0, failedCount: 0, unconfiguredCount: 0, truncated: false });
  });

  it('maps failing rows to id/label/error/status, filters status=handled + gmailLabel in [failed,unconfigured], and flags truncation when total exceeds the page', async () => {
    const rows = [
      {
        id: 'i1',
        handled_channel_sync: { gmailLabel: 'failed', gmailLabelError: 'invalid_grant: token expired' },
        dashboard_contacts: { display_name: 'Jane Doe', primary_email: 'jane@example.com' },
      },
      {
        id: 'i2',
        handled_channel_sync: { gmailLabel: 'failed', gmailLabelError: 'rate limited' },
        dashboard_contacts: { display_name: null, primary_email: 'bob@example.com' },
      },
      {
        id: 'i3',
        handled_channel_sync: { gmailLabel: 'failed' }, // no gmailLabelError stored
        dashboard_contacts: null, // no linked contact at all
      },
    ];
    // Page: 5 total (failed+unconfigured combined), only 3 returned (limit 3).
    const { sb, builders } = makeRouter([
      { data: rows, error: null, count: 5 },
      { data: null, error: null, count: 5 },
      { data: null, error: null, count: 0 },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures(3);

    expect(res).toEqual({
      ok: true,
      items: [
        { id: 'i1', label: 'Jane Doe', error: 'invalid_grant: token expired', status: 'failed' },
        { id: 'i2', label: 'bob@example.com', error: 'rate limited', status: 'failed' }, // falls back to email
        { id: 'i3', label: 'Unknown contact', error: null, status: 'failed' }, // falls back to placeholder
      ],
      total: 5,
      failedCount: 5,
      unconfiguredCount: 0,
      truncated: true, // 5 total > 3 returned
    });
    const pageCalls = builders[0].calls;
    expect(pageCalls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'handled')).toBe(true);
    expect(
      pageCalls.some(
        (c) =>
          c.method === 'in' &&
          c.args[0] === 'handled_channel_sync->>gmailLabel' &&
          Array.isArray(c.args[1]) &&
          (c.args[1] as string[]).sort().join(',') === 'failed,unconfigured',
      ),
    ).toBe(true);
    expect(pageCalls.some((c) => c.method === 'limit' && c.args[0] === 3)).toBe(true);
  });

  it('truncated is false when every failing row fits in the page', async () => {
    const rows = [{ id: 'i1', handled_channel_sync: { gmailLabel: 'failed' }, dashboard_contacts: null }];
    const { sb } = makeRouter([
      { data: rows, error: null, count: 1 },
      { data: null, error: null, count: 1 },
      { data: null, error: null, count: 0 },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures(25);

    expect(res.ok && res.truncated).toBe(false);
  });

  // Fix round MED 1: a total Gmail outage sets gmailLabel:'unconfigured'
  // (sync.ts) instead of leaving the field unset — this must be counted, not
  // read as an all-clear.
  it('includes rows whose write-back never even attempted (gmailLabel="unconfigured"), tagged with status "unconfigured" and a null error', async () => {
    const rows = [
      {
        id: 'i1',
        handled_channel_sync: { gmailLabel: 'unconfigured' },
        dashboard_contacts: { display_name: 'Jane Doe', primary_email: null },
      },
    ];
    const { sb } = makeRouter([
      { data: rows, error: null, count: 1 },
      { data: null, error: null, count: 0 },
      { data: null, error: null, count: 1 },
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures();

    expect(res).toEqual({
      ok: true,
      items: [{ id: 'i1', label: 'Jane Doe', error: null, status: 'unconfigured' }],
      total: 1,
      failedCount: 0,
      unconfiguredCount: 1,
      truncated: false,
    });
  });

  // Second fix round (delta-verify MED): the gap that let the mixed-headline
  // bug through — no fixture ever exercised a mixed failed+unconfigured
  // population. Deliberately makes the TRUE per-status counts differ from
  // BOTH the combined `total` (12) AND from what a naive count of the
  // 3-row page would suggest, so this can only pass if failedCount/
  // unconfiguredCount genuinely come from their own queries.
  it('mixed population: failedCount and unconfiguredCount are independent TRUE counts, neither equal to combined `total` nor to the page size', async () => {
    const rows = [
      {
        id: 'i1',
        handled_channel_sync: { gmailLabel: 'failed', gmailLabelError: 'boom' },
        dashboard_contacts: { display_name: 'Jane Doe', primary_email: null },
      },
      {
        id: 'i2',
        handled_channel_sync: { gmailLabel: 'unconfigured' },
        dashboard_contacts: { display_name: 'Bob Baker', primary_email: null },
      },
    ];
    const { sb } = makeRouter([
      { data: rows, error: null, count: 12 }, // combined total (page capped at 2)
      { data: null, error: null, count: 9 }, // TRUE failed count
      { data: null, error: null, count: 3 }, // TRUE unconfigured count
    ]);
    sbRef.current = sb;

    const res = await listGmailWritebackFailures(2);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.total).toBe(12);
    expect(res.failedCount).toBe(9);
    expect(res.unconfiguredCount).toBe(3);
    // Sanity: neither count equals the 2-row page size — proves they came
    // from their own queries, not from counting `items`.
    expect(res.items.length).toBe(2);
    expect(res.failedCount).not.toBe(res.items.length);
    expect(res.unconfiguredCount).not.toBe(res.items.length);
  });
});

describe('getGmailWritebackRetryTarget (#342 fix round — safe replay of a failed write-back)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('refuses when Supabase is unconfigured', async () => {
    const res = await getGmailWritebackRetryTarget('item-1');
    expect(res).toEqual({ ok: false, error: 'Supabase service role not configured' });
  });

  it('refuses on a query error', async () => {
    const { builder } = makeBuilder({ data: null, error: { message: 'db down' } });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res).toEqual({ ok: false, error: 'db down' });
  });

  it('refuses when the item does not exist', async () => {
    const { builder } = makeBuilder({ data: null, error: null });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res).toEqual({ ok: false, error: 'Item not found' });
  });

  it('refuses an item whose stored sync is NOT a recorded Gmail failure — cannot be aimed at an unrelated item', async () => {
    const { builder } = makeBuilder({
      data: {
        source: 'gmail',
        external_id: 'thr-1:msg-1',
        source_message_id: 'msg-1',
        status: 'handled',
        handled_channel_sync: { gmailLabel: 'ok' },
        dashboard_contacts: { ghl_contact_id: null, display_name: 'Jane Doe' },
      },
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res).toEqual({ ok: false, error: 'This item has no recorded Gmail write-back failure to retry' });
  });

  // Fix round MED 2: reopen resets status to 'unresponded' but leaves the
  // STALE handled_channel_sync in place (store.ts's upsert omits it, so it's
  // preserved verbatim) — this must be refused, not replayed.
  it('refuses a row that is no longer Handled (reopened), even though its stale sync still says failed', async () => {
    const { builder } = makeBuilder({
      data: {
        source: 'gmail',
        external_id: 'thr-1:msg-1',
        source_message_id: 'msg-1',
        status: 'unresponded', // reopened — reducer.ts resets this on a newer inbound
        handled_channel_sync: { gmailLabel: 'failed', gmailLabelError: 'invalid_grant' }, // stale, never cleared
        dashboard_contacts: { ghl_contact_id: 'ghl-1', display_name: 'Jane Doe' },
      },
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res).toEqual({ ok: false, error: 'This item is no longer Handled — its Gmail write-back state is stale' });
  });

  it('builds a HandledTarget from a genuinely-failed row', async () => {
    const { builder } = makeBuilder({
      data: {
        source: 'gmail',
        external_id: 'thr-1:msg-1',
        source_message_id: 'msg-1',
        status: 'handled',
        handled_channel_sync: { gmailLabel: 'failed', gmailLabelError: 'invalid_grant' },
        dashboard_contacts: { ghl_contact_id: 'ghl-1', display_name: 'Jane Doe' },
      },
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res).toEqual({
      ok: true,
      target: {
        source: 'gmail',
        externalId: 'thr-1:msg-1',
        sourceMessageId: 'msg-1',
        ghlContactId: 'ghl-1',
        displayName: 'Jane Doe',
      },
    });
  });

  // Fix round MED 1: once a token is restored, a row that failed only
  // because Gmail was entirely unconfigured is just as retryable as one that
  // threw a real error.
  it('accepts an "unconfigured" row for retry, not just "failed"', async () => {
    const { builder } = makeBuilder({
      data: {
        source: 'gmail',
        external_id: 'thr-1:msg-1',
        source_message_id: 'msg-1',
        status: 'handled',
        handled_channel_sync: { gmailLabel: 'unconfigured' },
        dashboard_contacts: { ghl_contact_id: 'ghl-1', display_name: 'Jane Doe' },
      },
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await getGmailWritebackRetryTarget('item-1');

    expect(res.ok).toBe(true);
  });
});

// ─── listInWorks — parallel fetch (#185) + Needs a look (#307) ──────────────
//
// Was two sequential `await`s (awaiting -> handled). Now both fire together
// via Promise.all; the array-literal argument order keeps [awaiting, handled]
// deterministic, so a call-index-keyed mock still lets us assert correctness
// for the two inbox_items queries. #307 added two MORE batched queries
// (quotes, follow_ups) that fire only after the handled bucket is known, so
// this mock routes by table name instead so each table's builder/call-count
// is asserted independently — the wiring this section pins is "batched, not
// per-row": exactly one quotes call and one follow_ups call, regardless of
// how many handled rows there are.

function makeTableRouter(byTable: Record<string, { data: unknown; error: null | { message: string } }>) {
  const calls: Record<string, number> = {};
  const from = (table: string) => {
    calls[table] = (calls[table] ?? 0) + 1;
    const spec = byTable[table];
    if (!spec) throw new Error(`unexpected table in test: ${table}`);
    return makeBuilder(spec).builder;
  };
  return { from, calls };
}

describe('listInWorks — parallel fetch (#185)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('maps the awaiting + handled buckets from the two parallel queries; needsLookReason is null when no evidence contradicts "finished"', async () => {
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
      direction: 'outbound',
      external_id: 'msg-1',
      dashboard_contacts: { display_name: 'Handled Hank' },
    };
    // inbox_items is queried twice (awaiting, then handled); route by call order.
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      // Never reached: the handled row is source='gmail', so quotetoolQuoteIds
      // is empty and fetchQuoteStatusesById short-circuits before any 'quotes'
      // query — asserted below via router.calls.quotes being undefined.
      quotes: { data: [], error: null },
      follow_ups: { data: [], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [awaitingRow] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.awaiting).toEqual([
      {
        id: 'i-aw',
        source: 'ghl',
        channel: 'sms',
        preview: 'following up',
        customerName: 'Awaiting Amy',
        lastActivityAt: '2026-07-20T10:00:00Z',
        needsLookReason: null,
        isColorRequest: false,
      },
    ]);
    expect(result.handled).toEqual([
      {
        id: 'i-hd',
        source: 'gmail',
        channel: 'email',
        preview: 'handled it',
        customerName: 'Handled Hank',
        lastActivityAt: '2026-07-21T09:00:00Z',
        needsLookReason: null,
        isColorRequest: false,
      },
    ]);
    expect(inboxCallIndex).toBe(2);
    // Batched-not-per-row: follow_ups queried exactly once for the whole
    // handled page; quotes never queried at all (no quotetool rows present).
    expect(router.calls.follow_ups).toBe(1);
    expect(router.calls.quotes).toBeUndefined();
  });

  // Row 321 fix-round FIX 1 (technical HIGH — the core regression test): the
  // AWAITING bucket used to read isColorRequest:false UNCONDITIONALLY because
  // IN_WORKS_SELECT never selected external_id for that bucket at all. An
  // ordinary Handled -> Followed (snooze) -> Mark completed sequence could
  // bury a still-pending colour request with no confirm and no server check.
  // This pins that a `:color-request`-shaped row sitting in AWAITING (the
  // snoozed/followed-up state) now correctly badges when its quote's
  // pendingColorRequest is still live.
  it('badges a :color-request-shaped item in the AWAITING bucket (the row-321 HIGH: this bucket never carried isColorRequest at all before this fix)', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const awaitingColorRequestRow = {
      id: 'i-aw-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      preview: 'Champagne please',
      followed_up_at: '2026-08-01T10:00:00Z',
      handled_at: null,
      status: 'unresponded',
      dashboard_contacts: { display_name: 'Kristie' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      quotes: {
        data: [{ id: QUOTE_UUID, approval_snapshot: { pendingColorRequest: { label: "Staff's pick" } } }],
        error: null,
      },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [awaitingColorRequestRow] : [], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.awaiting).toHaveLength(1);
    expect(result.awaiting[0].isColorRequest).toBe(true);
    // ONE batched quotes query covers the awaiting-bucket lookup too — never
    // per-row, and never skipped just because the row is in the awaiting
    // (not handled) bucket.
    expect(router.calls.quotes).toBe(1);
  });

  // Row 321 fix-round FIX 1 (staff MED half, awaiting bucket): once the
  // request is resolved, an awaiting-bucket row with the same suffix must
  // stop badging too — not just the handled bucket.
  it("does NOT badge a :color-request-shaped item in the AWAITING bucket once its quote's pendingColorRequest has been cleared", async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const awaitingColorRequestRow = {
      id: 'i-aw-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      preview: 'Champagne please',
      followed_up_at: '2026-08-01T10:00:00Z',
      handled_at: null,
      status: 'unresponded',
      dashboard_contacts: { display_name: 'Kristie' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      quotes: { data: [{ id: QUOTE_UUID, approval_snapshot: {} }], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [awaitingColorRequestRow] : [], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.awaiting[0].isColorRequest).toBe(false);
  });

  // Row 321 fix-round FIX 1: fail-safe direction on the color-request
  // liveness lookup — OPPOSITE of fetchQuoteStatusesById/
  // fetchPendingFollowUpItemIds' own fail-open-but-report, which is UNSAFE by
  // design there (an empty result under-populates "Needs a look"). Here a
  // lookup error must make the caller show MORE badges, never fewer.
  it('fails SAFE (badges every shape-matching row) when the color-request liveness lookup itself errors, in EITHER bucket', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const awaitingRow = {
      id: 'i-aw-cr',
      source: 'quotetool',
      external_id: `${QUOTE_UUID}:color-request`,
      channel: null,
      preview: 'Champagne please',
      followed_up_at: '2026-08-01T10:00:00Z',
      handled_at: null,
      status: 'unresponded',
      dashboard_contacts: { display_name: 'Kristie' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      quotes: { data: null, error: { message: 'connection reset' } },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [awaitingRow] : [], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.awaiting[0].isColorRequest).toBe(true);
  });

  // #307 review fix 3 (admin lens): nothing previously tied the awaiting/
  // handled Promise.all array positions to the correct QueryBucket literal —
  // a future swap of 'awaiting_reply'/'handled' between the two applyBucketFilter
  // calls in store.ts would pass tsc, the applyBucketFilter<->bucketOf drift
  // test in lifecycle.test.ts, and every other existing test here, while
  // silently swapping the two In-the-works sections' contents system-wide.
  // Pins the exact recorded filter-chain args per query, mirroring the
  // listOpenItems .is("followed_up_at", null) assertion (line ~798 above) and
  // the listEscalatableItems .or(...) assertion (line ~2730 below).
  it("wires the awaiting query to applyBucketFilter(..., 'awaiting_reply') and the handled query to applyBucketFilter(..., 'handled') -- not swapped", async () => {
    let inboxCallIndex = 0;
    const inboxCalls: { method: string; args: unknown[] }[][] = [];
    const router = makeTableRouter({
      quotes: { data: [], error: null },
      follow_ups: { data: [], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          const { builder, calls } = makeBuilder({ data: [], error: null });
          inboxCalls[idx] = calls;
          return builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    // Call index 0 = awaiting, index 1 = handled — attribution follows the
    // CONST-DECLARATION order of the two base queries in listInWorks (each
    // `sb.from('inbox_items')` fires when its const line evaluates, before the
    // Promise.all array is even built), NOT the Promise.all array positions.
    // A cosmetic reorder of those two const lines would flip these indexes and
    // fail this test spuriously — if that happens, swap the indexes here; the
    // per-bucket predicate assertions below are what this test is really for.
    expect(inboxCallIndex).toBe(2);

    const awaitingCalls = inboxCalls[0];
    expect(
      awaitingCalls.some(
        (c) => c.method === 'not' && c.args[0] === 'followed_up_at' && c.args[1] === 'is' && c.args[2] === null,
      ),
    ).toBe(true);
    expect(
      awaitingCalls.some(
        (c) => c.method === 'not' && c.args[0] === 'status' && c.args[1] === 'in' && c.args[2] === '(completed,dismissed)',
      ),
    ).toBe(true);
    // Not the 'handled' bucket's predicate.
    expect(awaitingCalls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'handled')).toBe(
      false,
    );

    const handledCalls = inboxCalls[1];
    expect(handledCalls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'handled')).toBe(
      true,
    );
    expect(
      handledCalls.some((c) => c.method === 'is' && c.args[0] === 'followed_up_at' && c.args[1] === null),
    ).toBe(true);
    // Not the 'awaiting_reply' bucket's predicate.
    expect(handledCalls.some((c) => c.method === 'not' && c.args[0] === 'followed_up_at')).toBe(false);
  });

  it('flags a handled quotetool row whose quote is sent-but-unanswered as "Quote unanswered", batching the quote lookup in ONE query', async () => {
    // #183 BUG 1: quoteIdPrefix/isUuid means the id must be genuinely
    // UUID-shaped once the :color-request suffix is stripped, or the batch
    // lookup's isUuid filter drops it before the query ever fires (mirrors
    // listOpenItems' own tests, e.g. line ~601 above).
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const handledRow = {
      id: 'i-hd',
      source: 'quotetool',
      channel: null,
      preview: 'quote sent',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: `${QUOTE_UUID}:color-request`,
      dashboard_contacts: { display_name: 'Quoted Customer' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      quotes: {
        data: [
          {
            id: QUOTE_UUID,
            status: null,
            quote_sent_at: '2026-07-20T00:00:00Z',
            customer_approved_at: null,
            deposit_paid_at: null,
            viewed_at: null,
            // Row 321 fix-round FIX 1: this row is now ALSO the fixture for
            // the color-request liveness lookup (a separate, independent
            // batched query — see the `router.calls.quotes` assertion below)
            // — isColorRequest now needs a live pendingColorRequest, not just
            // the external_id's shape.
            approval_snapshot: { pendingColorRequest: { label: "Staff's pick" } },
          },
        ],
        error: null,
      },
      follow_ups: { data: [], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handled).toHaveLength(1);
    expect(result.handled[0].needsLookReason).toBe('Quote unanswered');
    // Row 321: this row's external_id IS the :color-request suffix, and its
    // quote's pendingColorRequest is still live.
    expect(result.handled[0].isColorRequest).toBe(true);
    // Row 321 fix-round FIX 1: TWO independent batched quotes queries now
    // fire for this page — fetchQuoteStatusesById (needsLookReason) and
    // fetchLiveColorRequestQuoteIds (isColorRequest) — each still batched
    // ONCE for the whole page (never one per handled row), not folded into a
    // single query (deliberately independent of each other — see
    // fetchLiveColorRequestQuoteIds's own doc for why).
    expect(router.calls.quotes).toBe(2);
  });

  it('flags a handled row whose direction is inbound as "They wrote last"', async () => {
    const handledRow = {
      id: 'i-hd',
      source: 'ghl',
      channel: 'sms',
      preview: 'customer replied',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'inbound',
      external_id: 'conv-1',
      dashboard_contacts: { display_name: 'Talked Last' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({ follow_ups: { data: [], error: null } });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handled[0].needsLookReason).toBe('They wrote last');
    // No quotetool rows on this page — the quotes query is skipped entirely.
    expect(router.calls.quotes).toBeUndefined();
  });

  it('flags a handled row with a still-pending follow_ups row as "Follow-up due", batching the lookup in ONE query for the whole page', async () => {
    const handledRow1 = {
      id: 'i-hd-1',
      source: 'ghl',
      channel: 'sms',
      preview: 'a',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: 'conv-1',
      dashboard_contacts: { display_name: 'Row One' },
    };
    const handledRow2 = {
      id: 'i-hd-2',
      source: 'ghl',
      channel: 'sms',
      preview: 'b',
      followed_up_at: null,
      handled_at: '2026-07-21T09:05:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: 'conv-2',
      dashboard_contacts: { display_name: 'Row Two' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      follow_ups: { data: [{ inbox_item_id: 'i-hd-2' }], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow1, handledRow2], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.handled.map((i) => [i.id, i.needsLookReason]));
    expect(byId.get('i-hd-1')).toBeNull();
    expect(byId.get('i-hd-2')).toBe('Follow-up due');
    // ONE follow_ups query covers BOTH handled rows — not one per row.
    expect(router.calls.follow_ups).toBe(1);
  });

  it('the handled bucket is empty: neither the quotes nor the follow_ups query fires at all', async () => {
    let inboxCallIndex = 0;
    const router = makeTableRouter({});
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          inboxCallIndex += 1;
          return makeBuilder({ data: [], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handled).toEqual([]);
    expect(inboxCallIndex).toBe(2); // awaiting + handled inbox_items queries still both fire
    expect(router.calls.quotes).toBeUndefined();
    expect(router.calls.follow_ups).toBeUndefined();
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
    // Both queries fired (parallel) even though the first one errored — and
    // the function returns before ever reaching the #307 quotes/follow_ups
    // lookups, so no third table is queried.
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

  // #307 review fix 2: fetchQuoteStatusesById/fetchPendingFollowUpItemIds
  // still fail OPEN on a lookup error (an empty map/set, never a thrown
  // error) — but now also report it via evidenceIncomplete instead of only
  // console.error, since an empty result here silently UNDER-populates
  // "Needs a look" (the unsafe direction — see the two functions' own doc
  // comments for the contrast with fetchHiddenLegacyRebookQuoteIds's safe
  // fail-open).
  it('evidenceIncomplete is false when both evidence lookups succeed', async () => {
    const handledRow = {
      id: 'i-hd',
      source: 'ghl',
      channel: 'sms',
      preview: 'handled it',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: 'conv-1',
      dashboard_contacts: { display_name: 'Settled Sam' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({ follow_ups: { data: [], error: null } });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidenceIncomplete).toBe(false);
  });

  it('evidenceIncomplete is true when the quotes evidence lookup errors, without failing the whole request', async () => {
    const QUOTE_UUID = '123e4567-e89b-12d3-a456-426614174000';
    const handledRow = {
      id: 'i-hd',
      source: 'quotetool',
      channel: null,
      preview: 'quote sent',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: `${QUOTE_UUID}:color-request`,
      dashboard_contacts: { display_name: 'Quoted Customer' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      quotes: { data: null, error: { message: 'quotes lookup failed' } },
      follow_ups: { data: [], error: null },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The request still succeeds and the row still renders — it just can't
    // be trusted as "settled" from this signal, which is what the flag is for.
    expect(result.evidenceIncomplete).toBe(true);
    expect(result.handled[0].needsLookReason).toBeNull();
  });

  it('evidenceIncomplete is true when the follow-ups evidence lookup errors, even for a non-quotetool row that never queries "quotes"', async () => {
    const handledRow = {
      id: 'i-hd',
      source: 'ghl',
      channel: 'sms',
      preview: 'handled it',
      followed_up_at: null,
      handled_at: '2026-07-21T09:00:00Z',
      status: 'handled',
      direction: 'outbound',
      external_id: 'conv-1',
      dashboard_contacts: { display_name: 'Settled Sam' },
    };
    let inboxCallIndex = 0;
    const router = makeTableRouter({
      follow_ups: { data: null, error: { message: 'follow_ups lookup failed' } },
    });
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          const idx = inboxCallIndex;
          inboxCallIndex += 1;
          return makeBuilder({ data: idx === 0 ? [] : [handledRow], error: null }).builder;
        }
        return router.from(table);
      },
    };

    const result = await listInWorks(200);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidenceIncomplete).toBe(true);
    expect(router.calls.quotes).toBeUndefined();
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

// ─── listPendingColorRequests — row 321 (I/O wiring) ────────────────────────

describe('listPendingColorRequests (row 321 — the unsuppressible surface)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('maps a quote row with a live pendingColorRequest, independent of any inbox_items status', async () => {
    const row = {
      id: 'quote-kristie',
      customer_name: 'Kristie Tibbetts',
      quote_number: 1129,
      approval_snapshot: {
        customerSelection: { colorSchemeId: 'as-designed' },
        pendingColorRequest: { label: "Staff's pick", requestedAt: '2026-07-29T15:15:41.787Z' },
      },
    };
    const { builder, calls } = makeBuilder({ data: [row], error: null });
    sbRef.current = { from: () => builder };

    const result = await listPendingColorRequests();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([
      {
        quoteId: 'quote-kristie',
        quoteNumber: 1129,
        customerName: 'Kristie Tibbetts',
        label: "Staff's pick",
        requestedAt: '2026-07-29T15:15:41.787Z',
      },
    ]);
    // The query filters DIRECTLY on the quote's own jsonb column — never joins
    // or reads inbox_items at all, so a completed/dismissed/hidden inbox row
    // cannot suppress this. Also asserts the is_test/view_only chokepoint
    // filters (queries.ts's DASHBOARD_QUOTES_SELECT convention) are wired.
    const notCall = calls.find((c) => c.method === 'not');
    expect(notCall!.args).toEqual(['approval_snapshot->pendingColorRequest', 'is', null]);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'is_test' && c.args[1] === false)).toBe(true);
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'view_only' && c.args[1] === false)).toBe(true);
    // Row 321 fix-round FIX 5: `.order()` paired with `.limit()` (the #185
    // convention) so the capped subset is deterministic.
    const orderCall = calls.find((c) => c.method === 'order');
    expect(orderCall!.args).toEqual(['id', { ascending: true }]);
    const limitCall = calls.find((c) => c.method === 'limit');
    expect(limitCall).toBeDefined();
    // .order() must be chained BEFORE .limit() — the ORDER a Postgrest query
    // is built in is the order it executes server-side.
    expect(calls.indexOf(orderCall!)).toBeLessThan(calls.indexOf(limitCall!));
  });

  it('sorts oldest request first', async () => {
    const rows = [
      { id: 'q-new', customer_name: 'New', quote_number: 2, approval_snapshot: { pendingColorRequest: { label: 'A', requestedAt: '2026-08-17T17:37:48.337Z' } } },
      { id: 'q-old', customer_name: 'Old', quote_number: 1, approval_snapshot: { pendingColorRequest: { label: 'B', requestedAt: '2026-07-29T15:15:41.787Z' } } },
    ];
    const { builder } = makeBuilder({ data: rows, error: null });
    sbRef.current = { from: () => builder };

    const result = await listPendingColorRequests();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((i) => i.quoteId)).toEqual(['q-old', 'q-new']);
  });

  it('falls back to a generic label when the stored request has none', async () => {
    const row = { id: 'q-1', customer_name: 'No Label', quote_number: null, approval_snapshot: { pendingColorRequest: {} } };
    const { builder } = makeBuilder({ data: [row], error: null });
    sbRef.current = { from: () => builder };

    const result = await listPendingColorRequests();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items[0].label).toBe('Colour change');
  });

  it('surfaces a query error', async () => {
    const { builder } = makeBuilder({ data: null, error: { message: 'db down' } });
    sbRef.current = { from: () => builder };

    const result = await listPendingColorRequests();
    expect(result).toEqual({ ok: false, error: 'db down' });
  });

  it('no-ops (ok:false, no throw) when the service client is not configured', async () => {
    sbRef.current = null;
    const result = await listPendingColorRequests();
    expect(result).toEqual({ ok: false, error: 'Supabase service role not configured' });
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
   *  a nonexistent method. Neither defect was ever hit by the tests below at
   *  the time (markFollowUpDone's row-323 CAS now DOES chain
   *  `.update().eq().eq().select()`, and the fake models it; ensureFollowUp
   *  still never calls `.maybeSingle()`), so fixing this changed
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
      // #310: sweepResolvedItemFollowUps' pending-follow_ups select now chains
      // .order() before .limit() — a no-op here, this fake doesn't model sort
      // order, but it must exist on the chain or the real call throws.
      self.order = () => self;
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

  // #252 slice E revival: markFollowUpDone now hands back the follow-up's
  // anchored inbox_item_id so a caller (the /api/dashboard/followup route)
  // can decide whether to also resolve that item — see route.test.ts's
  // coupling tests.
  it('returns the anchored inbox_item_id on success', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    const done = await markFollowUpDone('fu-1', 'operator-1');
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.inboxItemId).toBe('item-1');
    expect(fake.rows[0].status).toBe('done');
  });

  it("returns a null inboxItemId for a manual follow-up with no anchor (today's behavior preserved)", async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: null as unknown as string, reason: 'manual', status: 'pending' },
    ]);
    sbRef.current = { from: (table: string) => (table === 'follow_ups' ? fake.table() : genericTable()) };

    const done = await markFollowUpDone('fu-1', 'operator-1');
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.inboxItemId).toBeNull();
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

  // #323: two tabs / two operators racing to click Done on the same follow-up
  // must not both log an activity row. The row is already 'done' (a prior
  // caller won the race) — markFollowUpDone's .eq('status','pending') CAS
  // matches zero rows, and that's an honest no-op: still ok:true (the row IS
  // in the caller's desired end state), but zero dashboard_activity inserts.
  // #252 slice E revival: the SAME CAS also protects the anchor-resolution
  // coupling — a lost race returns inboxItemId: null, so the losing caller's
  // route never attempts to resolve the anchored item a second time either.
  it('is a no-op (ok:true, inboxItemId: null, no activity insert) when the follow-up is already done — lost race', async () => {
    const fake = makeFollowUpsFake([
      { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
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

    const done = await markFollowUpDone('fu-1', 'operator-1');

    expect(done.ok).toBe(true);
    if (done.ok) expect(done.inboxItemId).toBeNull();
    expect(fake.rows[0].status).toBe('done'); // unchanged, not re-touched
    expect(activityInserts).toHaveLength(0);
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

    it('returns skipped and leaves a done row done when the item is completed', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'completed');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe('skipped');
      expect(fake.rows[0].status).toBe('done');
    });

    it('returns skipped and leaves a done row done when the item is dismissed', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'dismissed');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe('skipped');
      expect(fake.rows[0].status).toBe('done');
    });

    // Row 287(b) (Jason's ruling — supersedes this test's OLD assertion): this
    // used to assert the OPPOSITE — 'created' / flipped to 'pending' — on the
    // theory that a merely-'handled' item is still a "still-open conversation"
    // that must keep getting nagged. That read of 'handled' was wrong: per
    // "HANDLED MEANS DONE" (the same principle row 252's
    // shouldResolveAnchoredItem already applies the other direction), an
    // operator explicitly marking the follow-up Done on a 'handled' item is a
    // real assertion the task is dealt with, and re-arming it on the very next
    // tick just undid their click. A genuinely new customer message reopens
    // the item to 'unresponded' (outside this skip set) and resumes normal
    // re-arming — see ensureFollowUp's own doc comment.
    it('leaves a done row done when the item is only handled (does not re-arm)', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'handled');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe('skipped');
      expect(fake.rows[0].status).toBe('done');
    });

    it('re-arms a done row to pending when the item is unresponded', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'done' },
      ]);
      wire(fake, 'unresponded');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe('created');
      expect(fake.rows[0].status).toBe('pending');
    });

    it('returns skipped without a second write when a pending row already exists (the pre-existing early return still wins)', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-1', inbox_item_id: 'item-1', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      wire(fake, 'handled');

      const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

      expect(created).toBe('skipped');
      expect(fake.rows).toHaveLength(1);
    });
  });

  // #310: both reads used to destructure only `data` — an {error} response or a
  // genuine throw (network blip) propagated straight out of ensureFollowUp into
  // runQuoteToolReconcile's single top-level catch, aborting the WHOLE reconcile
  // tick (zeroing every counter, skipping both tail sweeps) over one bad read on
  // one quote. Guarded to fail open: skip just this item, log, return 'failed'
  // (distinct from a legitimate 'skipped' no-op — see the fix-round doc on
  // ensureFollowUp and QuoteReconcileSummary.followUpErrors).
  describe('ensureFollowUp — guards its reads so one failure skips the item, not the whole tick (#310)', () => {
    /** follow_ups fake whose pending-lookup chain resolves to a fixed {data, error}. */
    function makePendingLookupFake(result: { data: unknown; error: { message: string } | null }) {
      const self: Record<string, unknown> = {};
      self.select = () => self;
      self.eq = () => self;
      self.limit = () => self;
      self.upsert = () => {
        throw new Error('upsert must not be called when a read fails open');
      };
      self.then = (resolve: (v: unknown) => void) => resolve(result);
      return self;
    }

    /** inbox_items fake for the churn-gate `.select('status').eq('id').maybeSingle()` read. */
    function makeItemStatusLookupFake(result: { data: unknown; error: { message: string } | null }) {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve(result),
          }),
        }),
      };
    }

    it('returns failed and never reaches the write when the pending lookup errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        sbRef.current = {
          from: (table: string) =>
            table === 'follow_ups'
              ? makePendingLookupFake({ data: null, error: { message: 'connection reset' } })
              : genericTable(),
        };

        const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

        expect(created).toBe('failed');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[inbox] ensureFollowUp: pending lookup failed (skipping item):',
          'connection reset',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('returns failed and never reaches the write when the item-status (churn-gate) lookup errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        sbRef.current = {
          from: (table: string) => {
            if (table === 'follow_ups') return makePendingLookupFake({ data: [], error: null });
            if (table === 'inbox_items') return makeItemStatusLookupFake({ data: null, error: { message: 'timeout' } });
            return genericTable();
          },
        };

        const created = await ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() });

        expect(created).toBe('failed');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[inbox] ensureFollowUp: item status lookup failed (skipping item):',
          'timeout',
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('catches a thrown exception from a read and returns failed instead of propagating (would otherwise abort the whole reconcile tick)', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        sbRef.current = {
          from: (table: string) => {
            if (table === 'follow_ups') {
              return {
                select: () => ({
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        limit: () => {
                          throw new Error('socket hang up');
                        },
                      }),
                    }),
                  }),
                }),
              };
            }
            return genericTable();
          },
        };

        await expect(
          ensureFollowUp({ inboxItemId: 'item-1', contactId: 'c1', reason: 'quote_sent_no_reply', sentAt: new Date() }),
        ).resolves.toBe('failed');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[inbox] ensureFollowUp failed (skipping item):',
          expect.any(Error),
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
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

    // #310: the only tests above ever seed a SINGLE terminal status per run.
    // sweepResolvedItemFollowUps derives each item's OWN status via a
    // type-narrowing filter (`r.status === 'completed' || r.status === 'dismissed'`)
    // then loops `closeFollowUpsForResolvedItem(item.id, item.status)` per item —
    // correct today, but nothing pinned that a MIX of completed + dismissed items
    // in one run each get closed under their OWN status rather than, say, every
    // audit row silently inheriting the first item's status. A non-terminal
    // 'handled' item is mixed in too, to prove it stays untouched alongside the
    // two that close.
    it('closes a MIX of completed and dismissed items in one run, each audit row carrying its OWN terminalStatus', async () => {
      const fake = makeFollowUpsFake([
        { id: 'fu-completed', inbox_item_id: 'item-completed', reason: 'quote_sent_no_reply', status: 'pending' },
        { id: 'fu-dismissed', inbox_item_id: 'item-dismissed', reason: 'quote_sent_no_reply', status: 'pending' },
        { id: 'fu-handled', inbox_item_id: 'item-handled', reason: 'quote_sent_no_reply', status: 'pending' },
      ]);
      const itemsFake = makeItemsFake([
        { id: 'item-completed', status: 'completed' },
        { id: 'item-dismissed', status: 'dismissed' },
        { id: 'item-handled', status: 'handled' },
      ]);
      const activityInserts: Record<string, unknown>[] = [];
      sbRef.current = {
        from: (table: string) => {
          if (table === 'follow_ups') return fake.table();
          if (table === 'inbox_items') return itemsFake;
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

      const closed = await sweepResolvedItemFollowUps();

      expect(closed).toBe(2); // completed + dismissed close; handled stays untouched
      expect(fake.rows.find((r) => r.id === 'fu-completed')!.status).toBe('done');
      expect(fake.rows.find((r) => r.id === 'fu-dismissed')!.status).toBe('done');
      expect(fake.rows.find((r) => r.id === 'fu-handled')!.status).toBe('pending');

      expect(activityInserts).toHaveLength(2); // one per closed item; the untouched 'handled' item gets none
      const completedActivity = activityInserts.find((r) => r.inbox_item_id === 'item-completed');
      const dismissedActivity = activityInserts.find((r) => r.inbox_item_id === 'item-dismissed');
      expect(completedActivity).toMatchObject({ detail: { followUpId: 'fu-completed', terminalStatus: 'completed' } });
      expect(dismissedActivity).toMatchObject({ detail: { followUpId: 'fu-dismissed', terminalStatus: 'dismissed' } });
      // The failure mode this test guards: neither row inherits the OTHER item's status.
      expect((completedActivity!.detail as { terminalStatus: string }).terminalStatus).not.toBe('dismissed');
      expect((dismissedActivity!.detail as { terminalStatus: string }).terminalStatus).not.toBe('completed');
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

    // #310: sibling-parity fix to the sweepOrphanedFollowUps bound above — same
    // unbounded pending-follow_ups select, same silent-truncation risk, and the
    // same #185-precedent determinism concern (an .order() so the capped
    // subset can't nondeterministically flip which rows this sweep covers).
    it('bounds the pending-follow_ups lookup with an explicit .limit() and orders it deterministically (#310)', async () => {
      const { builder: pendingBuilder, calls } = makeBuilder({ data: [], error: null });
      sbRef.current = { from: (_table: string) => pendingBuilder };

      await sweepResolvedItemFollowUps();

      const limitCall = calls.find((c) => c.method === 'limit');
      expect(limitCall).toBeDefined();
      expect(limitCall!.args[0]).toBeGreaterThanOrEqual(1000);
      const orderCall = calls.find((c) => c.method === 'order');
      expect(orderCall).toBeDefined();
      expect(orderCall!.args[0]).toBe('id');
      expect(orderCall!.args[1]).toEqual({ ascending: true });
    });
  });
});

// ─── #252 slice E — anchored-item resolution gate ───────────────────────────
//
// "Clicking Done on a follow-up currently does NOT touch the inbox item, so
// the strip clears while the conversation stays open elsewhere" (ledger row
// 252). shouldResolveAnchoredItem is the single decision point the
// /api/dashboard/followup route consults before reusing the Handled route's
// machinery (markItemHandledLocal + runHandledWriteback + recordWriteback) —
// see route.test.ts for the full wiring. Tested as a pure function here so
// every input combination (including a 'dismissed' follow-up, which has no
// live UI caller today but IS a real value under follow_ups' own
// `status in ('pending','done','dismissed')` CHECK constraint) is covered
// directly, without needing a live dismiss code path to exist.
describe('shouldResolveAnchoredItem (#252 slice E)', () => {
  it('true: a done follow-up anchored to a still-unresponded item', () => {
    expect(shouldResolveAnchoredItem('done', 'unresponded')).toBe(true);
  });

  it('false: an already-handled item is left untouched (no double-stamp)', () => {
    expect(shouldResolveAnchoredItem('done', 'handled')).toBe(false);
  });

  it('false: an already-completed item is left untouched', () => {
    expect(shouldResolveAnchoredItem('done', 'completed')).toBe(false);
  });

  it('false: an already-dismissed item is left untouched', () => {
    expect(shouldResolveAnchoredItem('done', 'dismissed')).toBe(false);
  });

  it('false: no anchored item (null status — e.g. item not found)', () => {
    expect(shouldResolveAnchoredItem('done', null)).toBe(false);
  });

  it('false: a DISMISSED follow-up never resolves the item, regardless of item status', () => {
    expect(shouldResolveAnchoredItem('dismissed', 'unresponded')).toBe(false);
    expect(shouldResolveAnchoredItem('dismissed', 'handled')).toBe(false);
  });

  it('false: a PENDING follow-up (not yet acted on) never resolves the item', () => {
    expect(shouldResolveAnchoredItem('pending', 'unresponded')).toBe(false);
  });
});

describe('getItemStatus (#252 slice E)', () => {
  /** Minimal single-table stub: select('status').eq('id', itemId).maybeSingle(). */
  function makeInboxItemsFake(row: { id: string; status: string } | null) {
    return {
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => ({ data: row && row.id === val ? { status: row.status } : null, error: null }),
        }),
      }),
    };
  }

  it("returns the item's current status", async () => {
    // getItemStatus only ever queries inbox_items — no generic-table fallback needed.
    sbRef.current = { from: () => makeInboxItemsFake({ id: 'item-1', status: 'unresponded' }) };
    expect(await getItemStatus('item-1')).toBe('unresponded');
  });

  it('returns null when the item does not exist', async () => {
    sbRef.current = { from: () => makeInboxItemsFake(null) };
    expect(await getItemStatus('missing-item')).toBeNull();
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

// ─── closeFollowUp — error logging parity with its sibling sweeps (row 320b) ─

describe('closeFollowUp — a genuine DB error is logged, not silently read as 0-to-close', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('returns the closed count on a normal write, no error logged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { builder } = makeBuilder({ data: [{ id: 'fu-1' }], error: null });
    sbRef.current = { from: () => builder };

    const closed = await closeFollowUp('item-1', 'quote_sent_no_reply');
    expect(closed).toBe(1);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a genuine DB error is logged and the function fails open (returns 0), not thrown', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { builder } = makeBuilder({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from: () => builder };

    const closed = await closeFollowUp('item-1', 'quote_sent_no_reply');
    expect(closed).toBe(0);
    expect(errSpy).toHaveBeenCalledWith('[inbox] closeFollowUp failed:', 'connection reset');
    errSpy.mockRestore();
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

  // #310: was unbounded — PostgREST silently truncates at its 1000-row default,
  // so past that this sweep would stop covering rows with no error and no
  // signal. Pins that the pending-follow_ups lookup carries an explicit bound
  // with real headroom over the current ~57-row table, AND that the capped
  // subset is deterministic (an .order() — same #185 precedent as
  // listOpenItems' returning-contact tally, without which a page past the cap
  // could nondeterministically flip which rows this sweep covers).
  it('bounds the pending-follow_ups lookup with an explicit .limit() and orders it deterministically (#310)', async () => {
    const { builder: pendingBuilder, calls } = makeBuilder({ data: [], error: null });
    sbRef.current = { from: (_table: string) => pendingBuilder };

    await sweepOrphanedFollowUps(REASON);

    const limitCall = calls.find((c) => c.method === 'limit');
    expect(limitCall).toBeDefined();
    expect(limitCall!.args[0]).toBeGreaterThanOrEqual(1000);
    const orderCall = calls.find((c) => c.method === 'order');
    expect(orderCall).toBeDefined();
    expect(orderCall!.args[0]).toBe('id');
    expect(orderCall!.args[1]).toEqual({ ascending: true });
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

// ─── completeTerminalQuoteItems — I/O wiring (#317) ─────────────────────────
describe('completeTerminalQuoteItems (#317 — terminal-quote auto-complete)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const QUOTE_ID = '99999999-9999-9999-9999-999999999999';
  const NOW = new Date('2026-08-20T12:00:00Z');

  /** Dispatch `from()` by table: 1st `inbox_items` call = the SELECT lookup,
   *  2nd = the UPDATE; `follow_ups` gets its own builder (shared across
   *  closeFollowUpsForResolvedItem's own calls, which this function invokes
   *  once per completed row). `dashboard_activity` is dispatched by call count
   *  too (row 317 fix-round FIX 2 added a SELECT ahead of the pre-existing
   *  INSERT(s)): 1st call = the FIX-2 reversed-row lookup, 2nd+ = the
   *  completion insert + any followup_autoclosed insert(s) from
   *  closeFollowUpsForResolvedItem, sharing one builder same as before. */
  function makeSbForComplete(opts: {
    itemsSelect: { data: unknown; error: null | { message: string } };
    itemsUpdate?: { data: unknown; error: null | { message: string } };
    followUpsUpdate?: { data: unknown; error: null | { message: string } };
    reversedLookup?: { data: unknown; error: null | { message: string } };
    activityInsert?: { data: unknown; error: null | { message: string } };
    // Row 321: the pending-color-request quote lookup — only ever dispatched
    // when the select above returned a `:color-request`-shaped candidate (see
    // the guard's own doc). Omitted in every pre-row-321 test above, which
    // never trip that branch (their fixtures carry no external_id at all).
    quoteSelect?: { data: unknown; error: null | { message: string } };
  }) {
    const { builder: itemsSelectBuilder, calls: itemsSelectCalls } = makeBuilder(opts.itemsSelect);
    const { builder: itemsUpdateBuilder, calls: itemsUpdateCalls } = makeBuilder(
      opts.itemsUpdate ?? { data: [], error: null },
    );
    const { builder: fuBuilder, calls: fuCalls } = makeBuilder(opts.followUpsUpdate ?? { data: [], error: null });
    // Default: nobody reversed anything — the safe default for every test that
    // isn't specifically exercising FIX 2.
    const { builder: reversedLookupBuilder, calls: reversedLookupCalls } = makeBuilder(
      opts.reversedLookup ?? { data: [], error: null },
    );
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder(
      opts.activityInsert ?? { data: null, error: null },
    );
    const { builder: quoteBuilder, calls: quoteCalls } = makeBuilder(
      opts.quoteSelect ?? { data: null, error: null },
    );
    let inboxItemsCallCount = 0;
    let activityCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxItemsCallCount += 1;
        return inboxItemsCallCount === 1 ? itemsSelectBuilder : itemsUpdateBuilder;
      }
      if (table === 'follow_ups') return fuBuilder;
      if (table === 'quotes') return quoteBuilder;
      if (table === 'dashboard_activity') {
        activityCallCount += 1;
        return activityCallCount === 1 ? reversedLookupBuilder : activityBuilder;
      }
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, itemsSelectCalls, itemsUpdateCalls, fuCalls, reversedLookupCalls, activityCalls, quoteCalls };
  }

  it('looks up BOTH the bare quote id and its :color-request sibling', async () => {
    const { from, itemsSelectCalls } = makeSbForComplete({ itemsSelect: { data: [], error: null } });
    sbRef.current = { from };

    await completeTerminalQuoteItems(QUOTE_ID, NOW);

    const sourceEqCall = itemsSelectCalls.find((c) => c.method === 'eq' && c.args[0] === 'source');
    expect(sourceEqCall!.args).toEqual(['source', 'quotetool']);
    const inCall = itemsSelectCalls.find((c) => c.method === 'in' && c.args[0] === 'external_id');
    expect(inCall!.args).toEqual(['external_id', [QUOTE_ID, `${QUOTE_ID}:color-request`]]);
  });

  it('completes an awaiting-reply bare item (followed_up_at set) — the live "2 declined" self-heal shape', async () => {
    const { from, itemsUpdateCalls, activityCalls } = makeSbForComplete({
      itemsSelect: {
        data: [{ id: 'item-bare', status: 'handled', followed_up_at: '2026-08-10T00:00:00Z' }],
        error: null,
      },
      itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
    });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

    expect(n).toBe(1);
    const updateCall = itemsUpdateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toEqual({
      status: 'completed',
      followed_up_at: null,
      handled_by: null,
      handled_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const idInCall = itemsUpdateCalls.find((c) => c.method === 'in' && c.args[0] === 'id');
    expect(idInCall!.args).toEqual(['id', ['item-bare']]);
    // FIX 1 (row 317 fix-round): CAS narrowed from a two-value .in(['unresponded',
    // 'handled']) to a single-value .eq('status','handled') — see the doc on
    // completeTerminalQuoteItems.
    const statusEqCall = itemsUpdateCalls.find((c) => c.method === 'eq' && c.args[0] === 'status');
    expect(statusEqCall!.args).toEqual(['status', 'handled']);

    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toEqual([
      {
        actor: 'system',
        action: 'completed',
        inbox_item_id: 'item-bare',
        detail: { auto: true, reason: 'quote_terminal', from: { status: 'handled', wasFollowed: true } },
      },
    ]);
  });

  it('completes a plain handled item (no follow-up flag)', async () => {
    const { from, itemsUpdateCalls } = makeSbForComplete({
      itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
      itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
    });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

    expect(n).toBe(1);
    const updateCall = itemsUpdateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ status: 'completed' });
  });

  // THE HARD CONSTRAINT (#317, a lens HIGH) — Susan Pace-Burke's live shape:
  // an UNRESPONDED :color-request item with NO follow flag on a BOOKED quote.
  // Must be left alone, completely untouched — no update, no activity row.
  it('NEVER completes a needs_reply item (unresponded, no follow-up flag) — the hard constraint', async () => {
    const { from, itemsUpdateCalls, activityCalls } = makeSbForComplete({
      itemsSelect: {
        data: [
          { id: 'item-bare', status: 'handled', followed_up_at: null },
          { id: 'item-color-request', status: 'unresponded', followed_up_at: null },
        ],
        error: null,
      },
      itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
    });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

    expect(n).toBe(1); // only the bare item
    const idInCall = itemsUpdateCalls.find((c) => c.method === 'in' && c.args[0] === 'id');
    expect(idInCall!.args).toEqual(['id', ['item-bare']]); // color-request excluded from the write entirely
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect((insertCall!.args[0] as unknown[]).map((r) => (r as { inbox_item_id: string }).inbox_item_id)).toEqual([
      'item-bare',
    ]);
  });

  // row 317 fix-round FIX 1 (customer MED + technical HIGH): renamed from "a
  // color-request item DOES complete once it is no longer needs_reply
  // (awaiting_reply — staff replied, never applied/dismissed)" — that name was
  // WRONG. The fixture (status: 'unresponded', followed_up_at SET) is not "staff
  // replied": it's the SNOOZE shape — staff clicked Followed on an inbound
  // without ever replying to it. bucketOf reads that as 'awaiting_reply' too,
  // which is exactly why the OLD bucketOf-based eligibility wrongly admitted
  // it. Jason's ruling's own literal exception ("they sent us a message and we
  // didn't reply") means this must NOT auto-complete. Flipped to assert the
  // correct (non-)outcome under FIX 1's status==='handled' gate.
  it('does NOT complete a merely-snoozed item (unresponded + followed_up_at set, staff never replied) — Jason\'s literal exception', async () => {
    const { from, itemsUpdateCalls, activityCalls } = makeSbForComplete({
      itemsSelect: {
        data: [{ id: 'item-color-request', status: 'unresponded', followed_up_at: '2026-08-18T00:00:00Z' }],
        error: null,
      },
    });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

    expect(n).toBe(0);
    expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
    expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('never touches an already-completed or dismissed item, and writes nothing', async () => {
    const { from, itemsUpdateCalls, activityCalls } = makeSbForComplete({
      itemsSelect: {
        data: [
          { id: 'item-done', status: 'completed', followed_up_at: null },
          { id: 'item-spam', status: 'dismissed', followed_up_at: null },
        ],
        error: null,
      },
    });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

    expect(n).toBe(0);
    expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
    expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('does nothing when neither the bare nor the color-request id has an inbox item', async () => {
    const { from } = makeSbForComplete({ itemsSelect: { data: [], error: null } });
    sbRef.current = { from };

    const { completed: n } = await completeTerminalQuoteItems(QUOTE_ID, NOW);
    expect(n).toBe(0);
  });

  it('closes any pending follow-up anchored to a completed item (#252 follow-up-autoclose, extended here)', async () => {
    const { from, fuCalls } = makeSbForComplete({
      itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
      itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
      followUpsUpdate: { data: [{ id: 'fu-1' }], error: null },
    });
    sbRef.current = { from };

    await completeTerminalQuoteItems(QUOTE_ID, NOW);

    const fuUpdateCall = fuCalls.find((c) => c.method === 'update');
    expect(fuUpdateCall!.args[0]).toEqual({ status: 'done' });
    const fuInboxItemEq = fuCalls.find((c) => c.method === 'eq' && c.args[0] === 'inbox_item_id');
    expect(fuInboxItemEq!.args).toEqual(['inbox_item_id', 'item-bare']);
  });

  it('is non-fatal (warns) when the lookup fails — never throws, never blocks the reconcile tick', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { from } = makeSbForComplete({ itemsSelect: { data: null, error: { message: 'db down' } } });
      sbRef.current = { from };

      await expect(completeTerminalQuoteItems(QUOTE_ID, NOW)).resolves.toEqual({ completed: 0, failed: true });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[inbox] terminal-quote auto-complete: item lookup failed (non-fatal):',
        'db down',
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('is non-fatal (warns) when the item write fails', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { from } = makeSbForComplete({
        itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
        itemsUpdate: { data: null, error: { message: 'write failed' } },
      });
      sbRef.current = { from };

      await expect(completeTerminalQuoteItems(QUOTE_ID, NOW)).resolves.toEqual({ completed: 0, failed: true });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[inbox] terminal-quote auto-complete: item resolve failed (non-fatal):',
        'write failed',
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('no-ops (no throw) when the service client is not configured', async () => {
    sbRef.current = null;
    await expect(completeTerminalQuoteItems(QUOTE_ID, NOW)).resolves.toEqual({ completed: 0, failed: false });
  });

  // ─── FIX 2 (row 317 fix-round, staff HIGH + admin MED converged) ───────────
  // The reversed-row skip: an item an operator explicitly Reversed must not
  // re-complete on the next tick.
  describe('reversed-row skip (FIX 2)', () => {
    it('does NOT re-complete an item whose most recent state-changing activity row is "reversed"', async () => {
      const { from, itemsUpdateCalls, activityCalls, reversedLookupCalls } = makeSbForComplete({
        itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
        reversedLookup: { data: [{ inbox_item_id: 'item-bare', action: 'reversed' }], error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(0);
      expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
      expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
      // Batched: one lookup query covering every candidate id, never a per-row
      // query (mirrors the #307/#814 batched-lookup pattern above).
      const inItemIdsCall = reversedLookupCalls.find((c) => c.method === 'in' && c.args[0] === 'inbox_item_id');
      expect(inItemIdsCall!.args).toEqual(['inbox_item_id', ['item-bare']]);
    });

    it('a fresh item with no activity history still completes (empty reversed lookup does not block it)', async () => {
      const { from, itemsUpdateCalls } = makeSbForComplete({
        itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
        itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
        reversedLookup: { data: [], error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(1);
      expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(true);
    });

    it('excludes only the specific reversed item, not a sibling on the same quote', async () => {
      const { from, itemsUpdateCalls } = makeSbForComplete({
        itemsSelect: {
          data: [
            { id: 'item-bare', status: 'handled', followed_up_at: null },
            { id: 'item-color-request', status: 'handled', followed_up_at: null },
          ],
          error: null,
        },
        itemsUpdate: { data: [{ id: 'item-color-request' }], error: null },
        reversedLookup: { data: [{ inbox_item_id: 'item-bare', action: 'reversed' }], error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(1);
      const idInCall = itemsUpdateCalls.find((c) => c.method === 'in' && c.args[0] === 'id');
      expect(idInCall!.args).toEqual(['id', ['item-color-request']]);
    });

    it('the MOST RECENT row wins — an older "reversed" row followed by a newer "handled" row does not block completion', async () => {
      const { from, itemsUpdateCalls } = makeSbForComplete({
        itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
        itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
        // Rows arrive newest-first (per the query's own ORDER) — the first
        // occurrence of an id is its latest action.
        reversedLookup: {
          data: [
            { inbox_item_id: 'item-bare', action: 'handled' },
            { inbox_item_id: 'item-bare', action: 'reversed' },
          ],
          error: null,
        },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(1);
      expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(true);
    });

    it('uses the SAME state-changing action set as reverseItemState\'s wrong-occurrence guard', async () => {
      const { from, reversedLookupCalls } = makeSbForComplete({
        itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
        itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
      });
      sbRef.current = { from };

      await completeTerminalQuoteItems(QUOTE_ID, NOW);

      const actionInCall = reversedLookupCalls.find((c) => c.method === 'in' && c.args[0] === 'action');
      expect(actionInCall!.args).toEqual([
        'action',
        ['handled', 'followed', 'completed', 'dismissed', 'reclassified', 'reversed', 'reopened'],
      ]);
    });

    // row 317 fix-round FIX 3: failed:true now meaningful (was always false
    // before FIX 3 landed) — asserts the full { completed, failed } shape.
    it('fails CLOSED (never completes) and reports failed:true when the reversed-row lookup errors', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { from, itemsUpdateCalls } = makeSbForComplete({
          itemsSelect: { data: [{ id: 'item-bare', status: 'handled', followed_up_at: null }], error: null },
          reversedLookup: { data: null, error: { message: 'db down' } },
        });
        sbRef.current = { from };

        const result = await completeTerminalQuoteItems(QUOTE_ID, NOW);

        expect(result).toEqual({ completed: 0, failed: true });
        expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[inbox] terminal-quote auto-complete: reversed-row lookup failed (non-fatal):',
          'db down',
        );
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });
  });

  // ─── FIX (row 321, S43 wrap CUSTOMER lens HIGH) ────────────────────────────
  // Never auto-complete a `:color-request` item while its quote's
  // approval_snapshot.pendingColorRequest is still live — see the guard's own
  // doc comment on completeTerminalQuoteItems.
  describe('pending-color-request guard (row 321)', () => {
    it('does NOT complete a handled :color-request item whose quote still has a live pendingColorRequest', async () => {
      const { from, itemsUpdateCalls, activityCalls, quoteCalls } = makeSbForComplete({
        itemsSelect: {
          data: [{ id: 'item-color-request', external_id: `${QUOTE_ID}:color-request`, status: 'handled', followed_up_at: null }],
          error: null,
        },
        quoteSelect: { data: { approval_snapshot: { pendingColorRequest: { label: "Staff's pick" } } }, error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(0);
      expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
      expect(activityCalls.some((c) => c.method === 'insert')).toBe(false);
      const eqCall = quoteCalls.find((c) => c.method === 'eq' && c.args[0] === 'id');
      expect(eqCall!.args).toEqual(['id', QUOTE_ID]);
    });

    it('DOES complete a handled :color-request item once pendingColorRequest has been applied/dismissed (cleared)', async () => {
      const { from, itemsUpdateCalls } = makeSbForComplete({
        itemsSelect: {
          data: [{ id: 'item-color-request', external_id: `${QUOTE_ID}:color-request`, status: 'handled', followed_up_at: null }],
          error: null,
        },
        itemsUpdate: { data: [{ id: 'item-color-request' }], error: null },
        // No pendingColorRequest key at all — the normal post-apply/dismiss shape.
        quoteSelect: { data: { approval_snapshot: { customerSelection: {} } }, error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);
      expect(completed).toBe(1);
      expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(true);
    });

    it('the bare item still completes even when its :color-request sibling is excluded', async () => {
      const { from, itemsUpdateCalls } = makeSbForComplete({
        itemsSelect: {
          data: [
            { id: 'item-bare', external_id: QUOTE_ID, status: 'handled', followed_up_at: null },
            { id: 'item-color-request', external_id: `${QUOTE_ID}:color-request`, status: 'handled', followed_up_at: null },
          ],
          error: null,
        },
        itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
        quoteSelect: { data: { approval_snapshot: { pendingColorRequest: { label: 'Champagne' } } }, error: null },
      });
      sbRef.current = { from };

      const { completed } = await completeTerminalQuoteItems(QUOTE_ID, NOW);

      expect(completed).toBe(1);
      const idInCall = itemsUpdateCalls.find((c) => c.method === 'in' && c.args[0] === 'id');
      expect(idInCall!.args).toEqual(['id', ['item-bare']]); // color-request excluded, bare still writes
    });

    it('never queries the quotes table when no eligible row is color-request-shaped (no external_id match)', async () => {
      const { from, quoteCalls } = makeSbForComplete({
        itemsSelect: {
          data: [{ id: 'item-bare', external_id: QUOTE_ID, status: 'handled', followed_up_at: null }],
          error: null,
        },
        itemsUpdate: { data: [{ id: 'item-bare' }], error: null },
      });
      sbRef.current = { from };

      await completeTerminalQuoteItems(QUOTE_ID, NOW);
      expect(quoteCalls.length).toBe(0);
    });

    it('fails CLOSED (never completes) and reports failed:true when the pending-color-request lookup errors', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { from, itemsUpdateCalls } = makeSbForComplete({
          itemsSelect: {
            data: [{ id: 'item-color-request', external_id: `${QUOTE_ID}:color-request`, status: 'handled', followed_up_at: null }],
            error: null,
          },
          quoteSelect: { data: null, error: { message: 'db down' } },
        });
        sbRef.current = { from };

        const result = await completeTerminalQuoteItems(QUOTE_ID, NOW);

        expect(result).toEqual({ completed: 0, failed: true });
        expect(itemsUpdateCalls.some((c) => c.method === 'update')).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[inbox] terminal-quote auto-complete: pending-color-request lookup failed (non-fatal):',
          'db down',
        );
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });
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
    // Fix round 2 (MED): a genuine DB error is NOT a CAS refusal — refused
    // must read false so a caller (reply/route.ts) never treats an unknown
    // failure as "the item was resolved elsewhere."
    if (!res.ok) expect(res.refused).toBe(false);
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

  // ── Row 387: dismiss gets the POSITIVE CAS its sibling got in row 366 ──────
  //
  // Why this one mattered more than parity tidiness: the negative
  // `.neq('status','dismissed')` default passes on a row that has meanwhile
  // become 'handled', so a stale click flips a GENUINELY ANSWERED lead to
  // dismissed — and dismiss also calls addSuppressedSenders, so that customer's
  // future messages get auto-filtered out of the default view.

  it('dismissItem uses a POSITIVE status CAS when the caller supplies expectedStatus', async () => {
    const { from, updateCalls } = makeSbFor({ data: { dashboard_contacts: null }, error: null });
    sbRef.current = { from };

    await dismissItem(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });

    // The positive guard carries the caller's real legal-status set into the
    // write's own WHERE clause...
    const inCall = updateCalls.find((c) => c.method === 'in');
    expect(inCall).toBeDefined();
    expect(inCall!.args).toEqual(['status', ['unresponded', 'handled']]);
    // ...and the negative default is gone, not merely added to.
    expect(updateCalls.find((c) => c.method === 'neq')).toBeUndefined();
  });

  it('dismissItem REFUSES (never suppresses the sender) when the row moved out of a dismissable status', async () => {
    // data:null = the CAS matched zero rows, i.e. the item is no longer
    // 'unresponded'/'handled' — someone resolved it in the read→write gap.
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });

    expect(res.ok).toBe(false);
    // `refused` distinguishes a lost race from a backend failure, so the route
    // can answer 409 rather than 503.
    expect(res.refused).toBe(true);
    expect(res.error).toMatch(/no longer unresponded\/handled/);
    // THE POINT: no 'dismissed' activity row, and execution never reaches
    // addSuppressedSenders — a refused dismiss must not silently suppress a
    // real customer's future messages. An 'action_failed' audit row IS written
    // (mirroring markItemHandledLocal's refusal path), so assert on the ACTION
    // rather than on the absence of any insert at all.
    const inserted = activityCalls.filter((c) => c.method === 'insert').map((c) => c.args[0]);
    expect(inserted.some((a) => (a as { action?: string }).action === 'dismissed')).toBe(false);
    expect(inserted.some((a) => (a as { action?: string }).action === 'action_failed')).toBe(true);
  });

  it('dismissItem keeps its legacy benign no-op when no expectedStatus is supplied', async () => {
    const { from } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW);

    // Under the `.neq('status','dismissed')` default a zero-row match can only
    // mean "already dismissed", which is genuinely benign — unchanged.
    expect(res.ok).toBe(true);
    expect(res.refused).toBeUndefined();
  });

  it('dismissItem still reports a real DB error as a failure, not a refusal', async () => {
    const { from } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('connection reset');
    // Not a lost race — the route must answer 503, not 409.
    expect(res.refused).toBeUndefined();
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

  it('blocks re-completing an item the guard excluded (already dismissed or already completed), and never logs a false "completed" row', async () => {
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
    const insertCalls = activityCalls.filter((c) => c.method === 'insert');
    expect(insertCalls.some((c) => (c.args[0] as { action?: string }).action === 'completed')).toBe(false);
    // Row 308: the guard refusal itself now DOES get a durable trace — an
    // 'action_failed' row (never the literal 'completed' verb), so a
    // systemic write-failure pattern is no longer invisible.
    expect(insertCalls).toContainEqual(
      expect.objectContaining({
        args: [expect.objectContaining({ action: 'action_failed', inbox_item_id: ITEM_ID, detail: { action: 'completed', error: 'Item not found, already completed, or dismissed' } })],
      }),
    );
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

// Row 321 fix-round FIX 1(b): a client window.confirm() is not a guard — it
// can be stale, bypassed, or raced. markItemCompleted now refuses (before the
// status-guarded UPDATE even runs) to complete a `:color-request`-shaped item
// whose quote still has a live approval_snapshot.pendingColorRequest, closing
// the awaiting-bucket path that used to be silently unguarded server-side.
describe('markItemCompleted — server-side pending-color-request backstop (row 321 fix-round FIX 1(b))', () => {
  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const QUOTE_ID = '123e4567-e89b-12d3-a456-426614174000';
  const NOW = new Date('2026-08-20T12:00:00Z');

  beforeEach(() => {
    sbRef.current = null;
  });

  /** 1st .from('inbox_items') = priorStateOf's SELECT, 2nd = this fix's own
   *  targeted external_id lookup, 3rd = the real guarded UPDATE. `quotes` and
   *  `dashboard_activity` each get their own dedicated builder. */
  function makeSbFor(opts: {
    targetSelect: { data: unknown; error: null | { message: string } };
    quoteSelect?: { data: unknown; error: null | { message: string } };
    itemUpdateResult?: { data: unknown; error: null | { message: string } };
  }) {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: targetBuilder } = makeBuilder(opts.targetSelect);
    const { builder: updateBuilder, calls: updateCalls } = makeBuilder(
      opts.itemUpdateResult ?? { data: null, error: null },
    );
    const { builder: quotesBuilder, calls: quoteCalls } = makeBuilder(opts.quoteSelect ?? { data: null, error: null });
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder({ data: null, error: null });
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        if (inboxCallCount === 1) return priorBuilder;
        if (inboxCallCount === 2) return targetBuilder;
        return updateBuilder;
      }
      if (table === 'quotes') return quotesBuilder;
      if (table === 'dashboard_activity') return activityBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, updateCalls, quoteCalls, activityCalls };
  }

  it('refuses a :color-request item whose quote still has a live pendingColorRequest, and never reaches the update', async () => {
    const { from, updateCalls, activityCalls } = makeSbFor({
      targetSelect: { data: { external_id: `${QUOTE_ID}:color-request` }, error: null },
      quoteSelect: { data: { approval_snapshot: { pendingColorRequest: { label: "Staff's pick" } } }, error: null },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/pending colour change request/i);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(false);
    // The refusal itself gets a durable trace (row 308 convention), never a
    // false 'completed' row.
    const insertCalls = activityCalls.filter((c) => c.method === 'insert');
    expect(insertCalls.some((c) => (c.args[0] as { action?: string }).action === 'completed')).toBe(false);
    expect(insertCalls).toContainEqual(
      expect.objectContaining({
        args: [expect.objectContaining({ action: 'action_failed', inbox_item_id: ITEM_ID })],
      }),
    );
  });

  it('allows completing a :color-request item once pendingColorRequest has been applied/dismissed (cleared)', async () => {
    const { from, updateCalls } = makeSbFor({
      targetSelect: { data: { external_id: `${QUOTE_ID}:color-request` }, error: null },
      // No pendingColorRequest key at all — the normal post-apply/dismiss shape.
      quoteSelect: { data: { approval_snapshot: { customerSelection: {} } }, error: null },
      itemUpdateResult: { data: { id: ITEM_ID }, error: null },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(true);
  });

  it('never queries the quotes table for a bare (non-:color-request) item, and still completes it normally', async () => {
    const { from, quoteCalls, updateCalls } = makeSbFor({
      targetSelect: { data: { external_id: QUOTE_ID }, error: null },
      itemUpdateResult: { data: { id: ITEM_ID }, error: null },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(quoteCalls.length).toBe(0);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(true);
  });

  it('fails CLOSED (refuses, never completes) when the pending-color-request lookup itself errors', async () => {
    const { from, updateCalls } = makeSbFor({
      targetSelect: { data: { external_id: `${QUOTE_ID}:color-request` }, error: null },
      quoteSelect: { data: null, error: { message: 'connection reset' } },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/could not confirm/i);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(false);
  });

  // Distinct from the error case above: `.maybeSingle()` on a genuinely
  // DELETED quote row returns {data:null, error:null} — not an error at all.
  // No live quote means no live pendingColorRequest left to protect, so the
  // guard must fall through and allow completion. A real prod row is in
  // exactly this state (a `:color-request` item whose quote no longer
  // exists), and nothing previously pinned this path.
  it('completes normally when the quote row itself has been deleted (.maybeSingle() -> {data:null,error:null}, not a lookup error)', async () => {
    const { from, updateCalls } = makeSbFor({
      targetSelect: { data: { external_id: `${QUOTE_ID}:color-request` }, error: null },
      quoteSelect: { data: null, error: null },
      itemUpdateResult: { data: { id: ITEM_ID }, error: null },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(true);
  });

  it('proceeds to the normal guard (never blocks) when the preliminary external_id lookup itself finds nothing', async () => {
    const { from, quoteCalls, updateCalls } = makeSbFor({
      targetSelect: { data: null, error: null }, // item not found by this preliminary lookup
      itemUpdateResult: { data: { id: ITEM_ID }, error: null },
    });
    sbRef.current = { from };

    const res = await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(quoteCalls.length).toBe(0);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(true);
  });
});

// Row 306 (10th sibling-parity instance): markItemFollowed used to be a bare
// `.update({followed_up_at}).eq('id', itemId)` with NO status guard at all —
// unlike ALL three siblings. Guarded the same positive-match way as
// markItemCompleted's own describe block above (mirrors its makeSbFor).
describe('markItemFollowed — status guard (row 306)', () => {
  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-20T12:00:00Z');

  beforeEach(() => {
    sbRef.current = null;
  });

  /** Mirrors markItemCompleted's own makeSbFor: 1st .from('inbox_items') call is
   *  priorStateOf's SELECT, 2nd is the update chain under test. */
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

  it('blocks stamping followed_up_at on a row the guard excluded (already completed or dismissed) — the row-311 harm path', async () => {
    // maybeSingle() returns null when the guarded UPDATE...WHERE matched zero
    // rows (status was 'completed' or 'dismissed') — no DB error, just nothing
    // to update.
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/completed|dismissed/i);
    // A blocked guard must not ALSO write a false 'followed' activity trail.
    const insertCalls = activityCalls.filter((c) => c.method === 'insert');
    expect(insertCalls.some((c) => (c.args[0] as { action?: string }).action === 'followed')).toBe(false);
    // Row 308: the guard refusal itself now DOES get a durable trace — an
    // 'action_failed' row (never the literal 'followed' verb).
    expect(insertCalls).toContainEqual(
      expect.objectContaining({
        args: [expect.objectContaining({ action: 'action_failed', inbox_item_id: ITEM_ID, detail: { action: 'followed', error: 'Item is completed or dismissed; cannot mark followed' } })],
      }),
    );
  });

  it('the update chain is a POSITIVE match on the two legal source statuses (AGENTS.md positive-seam-gate convention, mirroring markItemCompleted)', async () => {
    const { from, updateCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    const inCalls = updateCalls.filter((c) => c.method === 'in').map((c) => c.args);
    expect(inCalls).toContainEqual(['status', ['unresponded', 'handled']]);
  });

  it('still allows a Follow on a legal source status (unresponded/handled), and logs activity', async () => {
    const { from, activityCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({ actor: OPERATOR_ID, action: 'followed' });
  });

  // Row 311 fix-round FIX 1 correction: this test used to assert the guard
  // predicate NEVER touches followed_up_at — true before FIX 1, and no longer
  // true for the default (allowRestamp:false) path, on purpose: that's exactly
  // what closes row 306's headline harm (a retry could previously re-stamp
  // followed_up_at silently, resetting the customer's waiting clock — see the
  // dedicated "Already marked followed" tests below for the refusal case). A
  // genuine re-Follow on a row where followed_up_at is already null (a fresh
  // inbound cleared it, or it was never set) still passes the new guard and
  // gets stamped, exactly as before.
  it('still stamps followed_up_at on a genuine re-Follow (followed_up_at null), now via an explicit IS NULL guard alongside the status guard', async () => {
    const { from, updateCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ followed_up_at: NOW.toISOString() });
    const isCalls = updateCalls.filter((c) => c.method === 'is').map((c) => c.args);
    expect(isCalls).toContainEqual(['followed_up_at', null]);
  });

  it('still surfaces a real DB error (never silently swallowed)', async () => {
    const { from } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('connection reset');
  });

  // Row 311 fix-round FIX 1: the status guard above blocks the row-311 harm
  // (stamping a terminal row) but NOT the row-306 headline harm — a RETRY can
  // still re-stamp followed_up_at on a row that's already followed, resetting
  // the customer's waiting clock, because this function never changes status.
  // opts.allowRestamp differentiates the reply route's real-send re-stamp
  // (correct) from the standalone Followed button's duplicate-click re-stamp
  // (wrong) — see markItemFollowed's own doc comment for the full design.

  /** Like makeSbFor above, but with a configurable prior-state row (makeSbFor
   *  always hard-codes `{data: null, error: null}`, i.e. priorStateOf finds
   *  nothing) — these tests need priorStateOf to see a real followed_up_at so
   *  the "already followed" vs "guard blocked for another reason" distinction
   *  is actually exercised, not vacuously true.
   *
   *  Row 311 fix-round 2: the code now issues a THIRD `.from('inbox_items')`
   *  call — a re-read via priorStateOf — whenever the UPDATE matches 0 rows,
   *  to derive the refusal cause from CURRENT state rather than the stale
   *  pre-update snapshot. `rereadResult` mocks that call; when omitted it
   *  defaults to `priorResult` (nothing changed between snapshot and
   *  re-read), which keeps every pre-existing call site here correct without
   *  edits. Pass an explicit `rereadResult` to exercise the race — a snapshot
   *  that no longer matches what the re-read finds. */
  function makeSbForWithPrior(
    priorResult: { data: unknown; error: null | { message: string } },
    itemUpdateResult: { data: unknown; error: null | { message: string } },
    rereadResult?: { data: unknown; error: null | { message: string } },
  ) {
    const { builder: priorBuilder } = makeBuilder(priorResult);
    const { builder: updateBuilder, calls: updateCalls } = makeBuilder(itemUpdateResult);
    const { builder: rereadBuilder } = makeBuilder(rereadResult ?? priorResult);
    const { builder: activityBuilder, calls: activityCalls } = makeBuilder({ data: null, error: null });
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        if (inboxCallCount === 1) return priorBuilder;
        if (inboxCallCount === 2) return updateBuilder;
        return rereadBuilder;
      }
      if (table === 'dashboard_activity') return activityBuilder;
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, updateCalls, activityCalls };
  }

  it('allowRestamp:true (the reply-route caller) skips the followed_up_at guard entirely', async () => {
    const { from, updateCalls } = makeSbFor({ data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW, { allowRestamp: true });

    expect(res.ok).toBe(true);
    expect(updateCalls.some((c) => c.method === 'is')).toBe(false);
  });

  it('refuses a restamp of an already-followed row with "Already marked followed" (alreadyFollowed:true)', async () => {
    const priorRow = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const { from, activityCalls } = makeSbForWithPrior({ data: priorRow, error: null }, { data: null, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Already marked followed');
      expect(res.alreadyFollowed).toBe(true);
    }
    const insertCalls = activityCalls.filter((c) => c.method === 'insert');
    expect(insertCalls).toContainEqual(
      expect.objectContaining({
        args: [expect.objectContaining({ action: 'action_failed', inbox_item_id: ITEM_ID, detail: { action: 'followed', error: 'Already marked followed' } })],
      }),
    );
  });

  // Row 311 fix-round 2 (delta-verify MED — the TOCTOU the "already followed"
  // path above was itself exposed to): the SNAPSHOT (priorStateOf, taken
  // before the UPDATE) can go stale between the snapshot and the guarded
  // UPDATE. A row that looked already-followed at snapshot time can be marked
  // completed/dismissed by another operator before the UPDATE runs — the
  // UPDATE then fails on the STATUS guard, not the followed_up_at guard, and
  // the OLD code (trusting only the snapshot) mislabeled that terminal
  // refusal as alreadyFollowed:true, which followed/route.ts turns into a 200
  // that InWorksSection.tsx's act() uses to moveGroup a phantom row into
  // "awaiting" — the row is really terminal server-side. The fix re-reads
  // CURRENT state after a failed UPDATE and derives the cause from that.
  it('a stale wasFollowed=true snapshot does NOT win when the re-read shows the row went terminal in the meantime (the TOCTOU race)', async () => {
    const staleSnapshot = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const currentAfterRace = { status: 'completed', followed_up_at: '2026-08-19T00:00:00Z' };
    const { from, activityCalls } = makeSbForWithPrior(
      { data: staleSnapshot, error: null },
      { data: null, error: null },
      { data: currentAfterRace, error: null },
    );
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Item is completed or dismissed; cannot mark followed');
      expect(res.alreadyFollowed).toBeUndefined();
    }
    const insertCalls = activityCalls.filter((c) => c.method === 'insert');
    expect(insertCalls.some((c) => (c.args[0] as { action?: string }).action === 'followed')).toBe(false);
  });

  it('the re-read confirms a GENUINE duplicate (row still legal status, still followed) and keeps alreadyFollowed:true', async () => {
    const staleSnapshot = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const currentStillFollowed = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const { from } = makeSbForWithPrior(
      { data: staleSnapshot, error: null },
      { data: null, error: null },
      { data: currentStillFollowed, error: null },
    );
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Already marked followed');
      expect(res.alreadyFollowed).toBe(true);
    }
  });

  it('a re-read that errors fails SAFE — plain refusal, never alreadyFollowed', async () => {
    const staleSnapshot = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const { from } = makeSbForWithPrior(
      { data: staleSnapshot, error: null },
      { data: null, error: null },
      // priorStateOf only inspects `data`, never `error` — this mirrors what
      // a real Supabase error response looks like (data null, error set).
      { data: null, error: { message: 'read timeout' } },
    );
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Item is completed or dismissed; cannot mark followed');
      expect(res.alreadyFollowed).toBeUndefined();
    }
  });

  it('a guard block NOT explained by wasFollowed (e.g. status changed concurrently) keeps the generic message and never sets alreadyFollowed', async () => {
    const priorRow = { status: 'unresponded', followed_up_at: null };
    const { from } = makeSbForWithPrior({ data: priorRow, error: null }, { data: null, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Item is completed or dismissed; cannot mark followed');
      expect(res.alreadyFollowed).toBeUndefined();
    }
  });

  it('allowRestamp:true succeeds and restamps even when the row is already followed', async () => {
    const priorRow = { status: 'handled', followed_up_at: '2026-08-19T00:00:00Z' };
    const { from, updateCalls } = makeSbForWithPrior({ data: priorRow, error: null }, { data: { id: ITEM_ID }, error: null });
    sbRef.current = { from };

    const res = await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW, { allowRestamp: true });

    expect(res.ok).toBe(true);
    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ followed_up_at: NOW.toISOString() });
  });
});

// Row 308: before this, dashboard_activity only ever got a row on the SUCCESS
// path of markItemHandledLocal/dismissItem/markItemFollowed/markItemCompleted
// — prod confirmed zero failure-type actions in ~1.13M rows. recordActionFailed
// (private, exercised only through these four callers — mirrors
// recordAutoClosedFollowUps' own untested-in-isolation convention in this same
// file) now writes a best-effort 'action_failed' row on each function's real
// FAILURE branch, never on a reported-success no-op (dismissItem's
// already-dismissed !data path still returns {ok:true} and logs nothing).
describe('recordActionFailed — row 308 (failure-branch activity trace)', () => {
  const ITEM_ID = 'item-42';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-20T12:00:00Z');

  beforeEach(() => {
    sbRef.current = null;
  });

  /** Mirrors the sibling describe blocks' own makeSbFor above. */
  function makeSbFor(itemUpdateResult: { data: unknown; error: null | { message: string } }) {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder } = makeBuilder(itemUpdateResult);
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
    return { from, activityCalls };
  }

  function actionFailedRow(activityCalls: { method: string; args: unknown[] }[]) {
    return activityCalls
      .filter((c) => c.method === 'insert')
      .map((c) => c.args[0] as { actor?: unknown; action?: string; inbox_item_id?: string; detail?: unknown })
      .find((row) => row.action === 'action_failed');
  }

  it('markItemHandledLocal: a real DB error logs action_failed with detail {action, error}, actor = the operator', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);

    expect(actionFailedRow(activityCalls)).toMatchObject({
      actor: OPERATOR_ID,
      inbox_item_id: ITEM_ID,
      detail: { action: 'handled', error: 'connection reset' },
    });
  });

  it('markItemHandledLocal: the guard refusal (already handled) also logs action_failed', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);

    expect(actionFailedRow(activityCalls)).toMatchObject({
      detail: { action: 'handled', error: 'Item not found or already handled' },
    });
  });

  it('dismissItem: a real DB error logs action_failed with detail {action, error}', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    await dismissItem(ITEM_ID, OPERATOR_ID, NOW);

    expect(actionFailedRow(activityCalls)).toMatchObject({
      actor: OPERATOR_ID,
      inbox_item_id: ITEM_ID,
      detail: { action: 'dismissed', error: 'connection reset' },
    });
  });

  it('dismissItem: the already-dismissed no-op (!data, reported ok:true) logs NO action_failed row — it is not a failure', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await dismissItem(ITEM_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(actionFailedRow(activityCalls)).toBeUndefined();
  });

  it('markItemCompleted: a real DB error logs action_failed with detail {action, error}', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    await markItemCompleted(ITEM_ID, OPERATOR_ID, NOW);

    expect(actionFailedRow(activityCalls)).toMatchObject({
      actor: OPERATOR_ID,
      inbox_item_id: ITEM_ID,
      detail: { action: 'completed', error: 'connection reset' },
    });
  });

  it('markItemFollowed: a real DB error logs action_failed with detail {action, error}', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: { message: 'connection reset' } });
    sbRef.current = { from };

    await markItemFollowed(ITEM_ID, OPERATOR_ID, NOW);

    expect(actionFailedRow(activityCalls)).toMatchObject({
      actor: OPERATOR_ID,
      inbox_item_id: ITEM_ID,
      detail: { action: 'followed', error: 'connection reset' },
    });
  });

  it('an audit-write failure while logging action_failed never turns the caller\'s own response into a throw (fire-and-forget, mirrors recordSuppressedFollowUp)', async () => {
    const { builder: priorBuilder } = makeBuilder({ data: null, error: null });
    const { builder: updateBuilder } = makeBuilder({ data: null, error: { message: 'connection reset' } });
    const throwingActivityBuilder = {
      insert: () => {
        throw new Error('activity table unreachable');
      },
    };
    let inboxCallCount = 0;
    sbRef.current = {
      from: (table: string) => {
        if (table === 'inbox_items') {
          inboxCallCount += 1;
          return inboxCallCount === 1 ? priorBuilder : updateBuilder;
        }
        if (table === 'dashboard_activity') return throwingActivityBuilder;
        throw new Error(`unexpected table: ${table}`);
      },
    };

    // markItemCompleted's own {ok:false, error} return must still resolve normally.
    await expect(markItemCompleted(ITEM_ID, OPERATOR_ID, NOW)).resolves.toEqual({
      ok: false,
      error: 'connection reset',
    });
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

// row 312a: /inbox/activity's Reverse button is driven by listActivity's
// `reversible` flag (REVERSIBLE_ACTIONS, store.ts) — a 'reclassified' row must
// flip it true, or the button never renders regardless of what reverseItemState
// itself accepts.
//
// row 312 fix-round FIX 3: the bare action string 'reclassified' now ISN'T
// enough on its own — confirmed against prod (2026-08-20, execute_sql) that 34
// 'reclassified' rows split into two real populations: 26 `actor: 'system'`
// S41 rows all carrying `detail.followedUpAtSetTo`, and 8 `actor:
// 'assistant-backfill-268'` rows where NONE carry it (their detail is
// `reason`/`customer`/`from_contact` — a lead_kind/contact repoint that never
// touched followed_up_at). isReversibleActivity gates on that key's presence.
describe('listActivity — reversible flag (row 312a / row 312 fix-round FIX 3)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  it('marks an S41-shaped reclassified row (detail carries followedUpAtSetTo) reversible: true', async () => {
    const { builder } = makeBuilder({
      data: [
        {
          id: 'a1',
          action: 'reclassified',
          actor: 'system',
          inbox_item_id: 'i1',
          created_at: '2026-08-19T00:00:00Z',
          detail: { op: 're-file', to: 'awaiting_reply', from: 'handled', followedUpAtSetTo: '2026-08-06T16:33:02.701Z' },
          inbox_items: null,
        },
      ],
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await listActivity(10);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ action: 'reclassified', reversible: true });
    }
  });

  it('marks a #268-backfill-shaped reclassified row (no followedUpAtSetTo) reversible: false', async () => {
    const { builder } = makeBuilder({
      data: [
        {
          id: 'a2',
          action: 'reclassified',
          actor: 'assistant-backfill-268',
          inbox_item_id: 'i2',
          created_at: '2026-08-14T00:00:00Z',
          detail: { reason: 'row 268 backfill', customer: 'Chris Hughes', lead_kind: 'automated -> lead', from_contact: 'c1' },
          inbox_items: null,
        },
      ],
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await listActivity(10);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ action: 'reclassified', reversible: false });
    }
  });

  it('a non-reclassified reversible action (e.g. dismissed) stays reversible: true regardless of detail shape', async () => {
    const { builder } = makeBuilder({
      data: [
        { id: 'a3', action: 'dismissed', actor: 'op-1', inbox_item_id: 'i3', created_at: '2026-08-19T00:00:00Z', detail: null, inbox_items: null },
      ],
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await listActivity(10);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0]).toMatchObject({ action: 'dismissed', reversible: true });
  });

  // row 317 fix-round FIX 4 (staff LOW): autoReason threads detail.reason
  // through only when detail.auto is true — the shape completeTerminalQuoteItems
  // writes (store.ts).
  it('surfaces detail.reason as autoReason when detail.auto is true', async () => {
    const { builder } = makeBuilder({
      data: [
        {
          id: 'a4',
          action: 'completed',
          actor: 'system',
          inbox_item_id: 'i4',
          created_at: '2026-08-20T12:00:00Z',
          detail: { auto: true, reason: 'quote_terminal', from: { status: 'handled', wasFollowed: false } },
          inbox_items: null,
        },
      ],
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await listActivity(10);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0]).toMatchObject({ action: 'completed', autoReason: 'quote_terminal' });
  });

  it('autoReason is null for an operator-driven row (detail.auto absent)', async () => {
    const { builder } = makeBuilder({
      data: [
        {
          id: 'a5',
          action: 'completed',
          actor: 'op-1',
          inbox_item_id: 'i5',
          created_at: '2026-08-20T12:00:00Z',
          detail: { from: { status: 'handled', wasFollowed: false } },
          inbox_items: null,
        },
      ],
      error: null,
    });
    sbRef.current = { from: () => builder };

    const res = await listActivity(10);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rows[0]).toMatchObject({ action: 'completed', autoReason: null });
  });
});

// row 312 fix-round FIX 3: isReversibleActivity is the pure predicate driving
// both listActivity's flag and reverseItemState's guard — direct tests here
// pin the exact boundary against the real prod payload shapes queried above.
describe('isReversibleActivity (pure, row 312 fix-round FIX 3)', () => {
  it('rejects an action outside REVERSIBLE_ACTIONS regardless of detail', () => {
    expect(isReversibleActivity('ingested', { followedUpAtSetTo: 'x' })).toBe(false);
  });
  it('accepts every non-reclassified reversible action with any detail (incl. null)', () => {
    for (const action of ['handled', 'followed', 'completed', 'dismissed']) {
      expect(isReversibleActivity(action, null)).toBe(true);
    }
  });
  it("accepts 'reclassified' only when detail carries followedUpAtSetTo", () => {
    expect(isReversibleActivity('reclassified', { followedUpAtSetTo: '2026-08-06T16:33:02.701Z' })).toBe(true);
    expect(isReversibleActivity('reclassified', { reason: 'row 268 backfill', from_contact: 'c1' })).toBe(false);
    expect(isReversibleActivity('reclassified', null)).toBe(false);
    expect(isReversibleActivity('reclassified', undefined)).toBe(false);
  });
});

// row 312: reverseItemState — 'reclassified' reversibility + the wrong-occurrence
// guard (312c). Sequence of sb.from() calls: dashboard_activity (act lookup) ->
// dashboard_activity (latest-row guard) -> inbox_items (current state) ->
// inbox_items (update) -> [inbox_items (unsuppress lookup), dismissed only] ->
// dashboard_activity (insert the 'reversed' row).
describe('reverseItemState (row 312 — reclassified + wrong-occurrence guard)', () => {
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-20T12:00:00Z');
  const ITEM_ID = 'item-1';
  const ACTIVITY_ID = 'act-1';

  beforeEach(() => {
    sbRef.current = null;
  });

  function makeSbForReverse(opts: {
    activityRow: { data: unknown; error?: null | { message: string } };
    latestRow: { data: unknown; error?: null | { message: string } };
    curItem?: { data: unknown; error?: null | { message: string } };
    updateResult?: { data: unknown; error: null | { message: string } };
    unsuppressRow?: { data: unknown; error?: null | { message: string } };
  }) {
    const { builder: activityLookupBuilder } = makeBuilder({
      data: opts.activityRow.data,
      error: opts.activityRow.error ?? null,
    });
    const { builder: latestBuilder, calls: latestCalls } = makeBuilder({
      data: opts.latestRow.data,
      error: opts.latestRow.error ?? null,
    });
    const { builder: curBuilder } = makeBuilder({
      data: opts.curItem?.data ?? null,
      error: opts.curItem?.error ?? null,
    });
    const { builder: updateBuilder, calls: updateCalls } = makeBuilder(opts.updateResult ?? { data: null, error: null });
    const { builder: unsuppressBuilder } = makeBuilder({
      data: opts.unsuppressRow?.data ?? null,
      error: opts.unsuppressRow?.error ?? null,
    });
    const { builder: insertBuilder, calls: insertCalls } = makeBuilder({ data: null, error: null });

    let activityCallCount = 0;
    let inboxCallCount = 0;
    const from = (table: string) => {
      if (table === 'dashboard_activity') {
        activityCallCount += 1;
        if (activityCallCount === 1) return activityLookupBuilder;
        if (activityCallCount === 2) return latestBuilder;
        return insertBuilder;
      }
      if (table === 'inbox_items') {
        inboxCallCount += 1;
        if (inboxCallCount === 1) return curBuilder;
        if (inboxCallCount === 2) return updateBuilder;
        return unsuppressBuilder;
      }
      throw new Error(`unexpected table: ${table}`);
    };
    return { from, latestCalls, updateCalls, insertCalls };
  }

  // row 312 fix-round FIX 3: an S41-shaped 'reclassified' row must carry
  // detail.followedUpAtSetTo to pass the payload-shape gate before any of these
  // tests can reach the wrong-occurrence guard / stillMatches logic below — a
  // bare `detail: null` (the pre-fix-round fixture shape) is now refused
  // immediately as a #268-backfill-shaped row would be. See the dedicated FIX 3
  // refusal test further down for that path itself.
  const RECLASSIFIED_DETAIL = { op: 're-file', to: 'awaiting_reply', from: 'handled', followedUpAtSetTo: '2026-08-06T16:33:02.701Z' };

  it("reverses a 'reclassified' row: clears followed_up_at only, status untouched, CASing on followed_up_at IS NOT NULL (FIX 1)", async () => {
    const { from, updateCalls, insertCalls } = makeSbForReverse({
      activityRow: { data: { action: 'reclassified', inbox_item_id: ITEM_ID, detail: RECLASSIFIED_DETAIL } },
      latestRow: { data: { id: ACTIVITY_ID } }, // this row IS the latest — passes 312c
      curItem: { data: { status: 'handled', followed_up_at: '2026-08-01T00:00:00Z' } },
      updateResult: { data: { id: ITEM_ID }, error: null }, // FIX 1: CAS matched a row
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    const updateCall = updateCalls.find((c) => c.method === 'update');
    expect(updateCall!.args[0]).toMatchObject({ followed_up_at: null });
    expect(updateCall!.args[0]).not.toHaveProperty('status'); // inverseOf('reclassified') never sets status
    // FIX 1: 'reclassified' CASes on followed_up_at IS NOT NULL, not on status.
    const casNotCall = updateCalls.find((c) => c.method === 'not');
    expect(casNotCall!.args).toEqual(['followed_up_at', 'is', null]);
    expect(updateCalls.some((c) => c.method === 'eq' && c.args[0] === 'status')).toBe(false);
    // FIX 4: the 'reversed' audit row now carries the reversed activity's own
    // id + the prior values it cleared/restored.
    const insertCall = insertCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({
      action: 'reversed',
      detail: {
        reversed_action: 'reclassified',
        reversedActivityId: ACTIVITY_ID,
        from: { status: 'handled', followedUpAt: '2026-08-01T00:00:00Z' },
      },
    });
  });

  // row 312 fix-round FIX 1 (HIGH): the CAS on the update — not the earlier
  // read — is what actually closes the race/double-click window. Simulated
  // here by having the pre-check (curItem) pass stillMatches while the update
  // itself matches zero rows (updateResult.data: null) — exactly what a
  // concurrent write landing between the read and the write would produce.
  it('FIX 1: refuses (lost race) when the CAS update matches no row even though the pre-check read passed', async () => {
    const { from, insertCalls } = makeSbForReverse({
      activityRow: { data: { action: 'handled', inbox_item_id: ITEM_ID, detail: null } },
      latestRow: { data: { id: ACTIVITY_ID } },
      curItem: { data: { status: 'handled', followed_up_at: null } }, // stillMatches passes
      updateResult: { data: null, error: null }, // but the CAS itself matches nothing (lost race)
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/state has changed/i);
    // No 'reversed' audit row gets written for a lost-race refusal.
    expect(insertCalls.some((c) => c.method === 'insert')).toBe(false);
  });

  it("refuses a 'reclassified' row whose item is no longer awaiting reply (followed_up_at already cleared)", async () => {
    const { from, updateCalls } = makeSbForReverse({
      activityRow: { data: { action: 'reclassified', inbox_item_id: ITEM_ID, detail: RECLASSIFIED_DETAIL } },
      latestRow: { data: { id: ACTIVITY_ID } },
      curItem: { data: { status: 'handled', followed_up_at: null } },
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/state has changed/i);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(false);
  });

  // row 312 fix-round FIX 3: the payload-shape gate applies to a direct POST
  // too, not just listActivity's rendered button — a #268-backfill-shaped row
  // (no followedUpAtSetTo) is refused before ever running the wrong-occurrence
  // query, exactly like a genuinely-unreversible action string.
  it("FIX 3: refuses a 'reclassified' row shaped like the #268 backfill (no followedUpAtSetTo in detail)", async () => {
    const backfillDetail = { reason: 'row 268 backfill', customer: 'Chris Hughes', lead_kind: 'automated -> lead', from_contact: 'c1' };
    const { from, latestCalls, updateCalls } = makeSbForReverse({
      activityRow: { data: { action: 'reclassified', inbox_item_id: ITEM_ID, detail: backfillDetail } },
      latestRow: { data: { id: ACTIVITY_ID } },
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('This entry cannot be reversed');
    // Short-circuits before the wrong-occurrence query or any write.
    expect(latestCalls.length).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('312c: refuses when a LATER state-changing row exists for the same item (wrong-occurrence guard)', async () => {
    const { from, updateCalls } = makeSbForReverse({
      activityRow: { data: { action: 'handled', inbox_item_id: ITEM_ID, detail: null } },
      latestRow: { data: { id: 'act-later-999' } }, // some other, more recent row
      curItem: { data: { status: 'handled', followed_up_at: null } }, // would otherwise "stillMatch"
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/later action/i);
    // Short-circuits before ever reading current state or writing anything.
    expect(updateCalls.length).toBe(0);
  });

  // row 312 fix-round FIX 2: a query ERROR on the wrong-occurrence guard must
  // fail CLOSED (refuse), not read as "no later row exists" and proceed.
  it('FIX 2: fails closed when the wrong-occurrence guard query itself errors', async () => {
    const { from, updateCalls } = makeSbForReverse({
      activityRow: { data: { action: 'handled', inbox_item_id: ITEM_ID, detail: null } },
      latestRow: { data: null, error: { message: 'connection reset' } },
      curItem: { data: { status: 'handled', followed_up_at: null } },
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/try again/i);
    // Never reaches the write on a failed guard read.
    expect(updateCalls.length).toBe(0);
  });

  it('312c: proceeds normally when no later row exists at all (this IS the only row for the item)', async () => {
    const { from, updateCalls } = makeSbForReverse({
      activityRow: { data: { action: 'handled', inbox_item_id: ITEM_ID, detail: null } },
      latestRow: { data: null }, // no row found (maybeSingle null) — nothing later
      curItem: { data: { status: 'handled', followed_up_at: null } },
      updateResult: { data: { id: ITEM_ID }, error: null }, // FIX 1: CAS matched a row
    });
    sbRef.current = { from };

    const res = await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    expect(res.ok).toBe(true);
    expect(updateCalls.some((c) => c.method === 'update')).toBe(true);
    // FIX 1: non-followed/reclassified actions CAS on status, not followed_up_at.
    expect(updateCalls.some((c) => c.method === 'eq' && c.args[0] === 'status' && c.args[1] === 'handled')).toBe(true);
  });

  it("312c: the latest-row query's action set covers every reversible action plus 'reversed'/'reopened', ordered with an id tiebreaker (FIX 5a/5b)", async () => {
    const { from, latestCalls } = makeSbForReverse({
      activityRow: { data: { action: 'dismissed', inbox_item_id: ITEM_ID, detail: { from: { status: 'unresponded' } } } },
      latestRow: { data: { id: ACTIVITY_ID } },
      curItem: { data: { status: 'dismissed', followed_up_at: null } },
      unsuppressRow: { data: null },
    });
    sbRef.current = { from };

    await reverseItemState(ACTIVITY_ID, OPERATOR_ID, NOW);

    const inCall = latestCalls.find((c) => c.method === 'in');
    const [, actionSet] = inCall!.args as [string, string[]];
    expect(actionSet).toEqual(
      expect.arrayContaining(['handled', 'followed', 'completed', 'dismissed', 'reclassified', 'reversed', 'reopened']),
    );
    // FIX 5(a): secondary deterministic tiebreaker on id, after the created_at order.
    const orderCalls = latestCalls.filter((c) => c.method === 'order');
    expect(orderCalls).toEqual([
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
    ]);
  });
});

// ─── Row 366: markItemHandledLocal's expectedStatus CAS ─────────────────────
// The followup route reads an item's status, gates POSITIVELY on 'unresponded',
// then writes. The default write guard is a NEGATIVE .neq('status','handled'),
// which refuses an already-handled row but happily overwrites one that moved to
// 'completed'/'dismissed' in the gap — silently RESURRECTING it to 'handled'.
// expectedStatus carries the caller's positive check into the UPDATE itself.
describe('markItemHandledLocal — expectedStatus positive CAS (row 366)', () => {
  beforeEach(() => {
    sbRef.current = null;
  });

  const ITEM_ID = 'item-366';
  const OPERATOR_ID = '11111111-2222-3333-4444-555555555555';
  const NOW = new Date('2026-08-24T12:00:00Z');

  /** 1st .from('inbox_items') = priorStateOf's SELECT, 2nd = the UPDATE chain. */
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

  const OK_ROW = { source: 'ghl', external_id: 'ext-1', source_message_id: null, dashboard_contacts: null };

  it('with expectedStatus, the UPDATE guards on .eq(status, expected) and NEVER on the negative .neq', async () => {
    const { from, updateCalls } = makeSbFor({ data: OK_ROW, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: 'unresponded' });
    expect(res.ok).toBe(true);

    expect(updateCalls.filter((c) => c.method === 'eq')).toEqual([
      { method: 'eq', args: ['id', ITEM_ID] },
      { method: 'eq', args: ['status', 'unresponded'] },
    ]);
    expect(updateCalls.some((c) => c.method === 'neq')).toBe(false);
  });

  it('without expectedStatus the guard is unchanged — .neq(status, handled), no status .eq (the other two callers)', async () => {
    const { from, updateCalls } = makeSbFor({ data: OK_ROW, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(true);

    expect(updateCalls).toContainEqual({ method: 'neq', args: ['status', 'handled'] });
    expect(updateCalls.filter((c) => c.method === 'eq')).toEqual([{ method: 'eq', args: ['id', ITEM_ID] }]);
  });

  it('a lost race (the row moved on, so the guarded UPDATE matches nothing) refuses with a message naming the expected status', async () => {
    const { from, activityCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: 'unresponded' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Item not found or no longer unresponded');
    // Fix round 2 (MED): a lost race is a real CAS refusal (0 rows matched
    // the WHERE) — refused must read true.
    if (!res.ok) expect(res.refused).toBe(true);

    // The refusal is audited, same as the default guard's refusal path.
    const insertCall = activityCalls.find((c) => c.method === 'insert');
    expect(insertCall!.args[0]).toMatchObject({
      action: 'action_failed',
      detail: { action: 'handled', error: 'Item not found or no longer unresponded' },
    });
  });

  it('the default refusal message is untouched for callers that pass no expectedStatus', async () => {
    const { from } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Item not found or already handled');
  });

  it('the constant the followup gate reads is the same one it passes as the CAS — they cannot drift', () => {
    expect(ANCHORED_ITEM_RESOLVABLE_STATUS).toBe('unresponded');
    expect(shouldResolveAnchoredItem('done', ANCHORED_ITEM_RESOLVABLE_STATUS)).toBe(true);
    expect(shouldResolveAnchoredItem('done', 'completed')).toBe(false);
    expect(shouldResolveAnchoredItem('done', 'dismissed')).toBe(false);
  });

  // Row 320(c): the reply route's legal pre-statuses are a SET, not a single
  // value (ReplyComposer renders on both an 'unresponded' and an already-
  // 'handled' row — InboxList.tsx / InWorksSection.tsx) — expectedStatus
  // accepts an array and guards with `.in(...)`, never `.eq(...)`/`.neq(...)`.
  it('with an array expectedStatus, the UPDATE guards on .in(status, [...]) and NEVER on .eq or .neq', async () => {
    const { from, updateCalls } = makeSbFor({ data: OK_ROW, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });
    expect(res.ok).toBe(true);

    expect(updateCalls).toContainEqual({ method: 'in', args: ['status', ['unresponded', 'handled']] });
    expect(updateCalls.some((c) => c.method === 'neq')).toBe(false);
    expect(updateCalls.filter((c) => c.method === 'eq')).toEqual([{ method: 'eq', args: ['id', ITEM_ID] }]);
  });

  it('an array expectedStatus refusal names all the expected statuses, joined', async () => {
    const { from } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('Item not found or no longer unresponded/handled');
  });

  // The concrete row 320(c) harm: a row that moved to 'completed' between the
  // ReplyComposer opening and the send landing must be REFUSED by the write —
  // never resurrected to 'handled' — so a real send-then-write on an item that
  // is NOW 'completed' has to come back not-ok.
  it('a stale-composer race — the item is now completed — refuses instead of resurrecting it to handled', async () => {
    const { from, updateCalls } = makeSbFor({ data: null, error: null });
    sbRef.current = { from };

    const res = await markItemHandledLocal(ITEM_ID, OPERATOR_ID, NOW, { expectedStatus: ['unresponded', 'handled'] });
    expect(res.ok).toBe(false);
    // The guard itself is the positive .in(...), which a 'completed' row does
    // not satisfy — the mock's { data: null } models exactly that 0-row match.
    expect(updateCalls).toContainEqual({ method: 'in', args: ['status', ['unresponded', 'handled']] });
  });
});
