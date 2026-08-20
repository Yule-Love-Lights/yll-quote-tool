// Inbox persistence layer (service-role). Splits into:
//   • planIngest()  — PURE: resolves identity + the reducer decision into a plan
//                     of DB operations. Fully unit-tested (store.test.ts).
//   • I/O functions — thin glue over the service-role Supabase client following
//                     the house idiom (src/lib/dashboard/queries.ts). These read/
//                     write the tables from migrations/2026-06-28-dashboard-tables.sql
//                     and CANNOT run until that migration is applied + SUPABASE_
//                     SERVICE_ROLE_KEY is set. They are intentionally not unit-
//                     tested (covered by tsc + route tests + review); keep them thin.
//
// All writes go through the service-role client (bypasses RLS) — the browser
// never touches these.

import { getSupabaseServiceClient } from '@/lib/supabase';
import type {
  ContactIdentity,
  DueFollowUp,
  DuplicateContactView,
  InboxSource,
  InboxStatus,
  NormalizedTouch,
  OpenInboxItem,
  StoredContact,
} from './types';
import { normalizeEmail, normalizePhone } from './normalize';
import { isUuid } from './validate';
import { appendIdentifiers, findDuplicatePairs, mergeContacts, resolveIdentity } from './identity';
import { decideInboxState } from './reducer';
import { isAnsweredByDirection } from './escalation';
import { FOLLOWUP_REASONS, isDueToday, quoteSentNoReplyFollowUp } from './followups';
import type { MetricItem, WindowKey, ReopenCounts } from './responseMetrics';
import { addSuppressedSenders, removeSuppressedSenders } from './suppression';
import { applyBucketFilter, inverseOf, type ReverseAction } from './lifecycle';
import { listOperatorAccounts } from '@/lib/auth/adminUsers';
import { deriveStatus, isParkedLegacyRebookDraft, type QuoteStatus } from '@/lib/quoteStatus';

// ─── Pure ingest planner ────────────────────────────────────────────────────

export type ExistingItem = {
  id: string;
  contactId: string | null;
  status: InboxStatus;
  notifiedLevels: number[];
  lastMessageAt: Date | null;
  /** #316: the rest of the stored row's touch-derived fields. Read ONLY by the
   *  unresponded-item noop check below (see `noopReingest`'s doc) to catch a
   *  material change that doesn't move last_message_at — e.g. a still-DRAFT
   *  quotetool lead's lastMessageAt is pinned to created_at (quotetool.ts's
   *  normalizeQuoteTouch), so staff editing that draft's total changes
   *  preview/quote_value with NO timestamp movement at all. All optional:
   *  findExistingItem always populates them from the real row; a hand-built
   *  test fixture that omits one just never qualifies for that noop path
   *  (undefined never `===` a real value — fails safe, never over-skips a
   *  write it shouldn't).
   *
   *  Honesty note on source_message_id specifically (review fix, #316
   *  follow-up): every live touch-producing path sets it to null —
   *  normalizeGhlConversation (ghl.ts), normalizeGmailThread (gmail.ts),
   *  normalizeQuoteTouch (quotetool.ts), parseIngestPayload (ingest.ts). The
   *  ONLY site that ever populates a real one is gmail.ts's rare lead-forward
   *  branch (buildLeadForwardTouch). So for essentially all live traffic this
   *  field compares null===null and contributes zero discriminating power
   *  today; it stays in the comparison for future-proofing (a real
   *  per-message id eventually reaching more sources) and to catch that one
   *  lead-forward case — not because it's doing real work today. The fields
   *  that actually discriminate live traffic are last_message_at (compared
   *  separately, above) plus direction/channel/preview/subject/lead_kind/
   *  quote_value here. */
  direction?: string | null;
  channel?: string | null;
  preview?: string | null;
  subject?: string | null;
  sourceMessageId?: string | null;
  leadKind?: string | null;
  quoteValue?: number | null;
  /** #316 follow-up (review FIX 2): the two raw-JSON fields getItemForReply
   *  falls back to when the joined dashboard_contacts row lacks them (see
   *  getItemForReply below) — raw.highlevel_contact_id / raw.customer_name.
   *  Selected narrowly via a PostgREST JSON-path expression (findExistingItem
   *  below), not by fetching the whole raw blob. Only the quotetool source's
   *  raw (`raw: q`, a DashboardQuote row) ever carries these keys today —
   *  ghl.ts/gmail.ts/ingest.ts's raw shapes don't have them, so for those
   *  sources both sides compare null===null and this pair is inert, same
   *  fail-safe direction as every other field here. Concrete case this
   *  closes: a draft quote gets linked to a GHL contact via
   *  /api/integrations/highlevel/attach (writes quotes.highlevel_contact_id
   *  only, never dashboard_contacts or inbox_items) — without this pair, if
   *  none of the OTHER 7 fields changed on the next reconcile tick, the tick
   *  would noop and inbox_items.raw would stay frozen pre-attach, leaving
   *  getItemForReply's fallback showing "no GHL contact" on an item that IS
   *  linked. */
  rawHighlevelContactId?: string | null;
  rawCustomerName?: string | null;
};

export type ContactOp =
  | { kind: 'insert'; identity: ContactIdentity; ambiguous: boolean }
  | { kind: 'update'; contactId: string; merged: StoredContact }
  | { kind: 'keep'; contactId: string | null };

export type ItemRow = {
  source: InboxSource;
  external_id: string;
  source_message_id: string | null;
  direction: string | null;
  channel: string | null;
  last_message_at: string; // ISO
  preview: string | null;
  subject: string | null;
  status: InboxStatus;
  escalation_level: number;
  notified_levels: number[];
  raw: unknown;
  lead_kind: string | null;
  quote_value: number | null;
};

export type IngestPlan = {
  /** When true, do nothing. Two independent reasons feed this:
   *   1. An outbound touch with no existing item is usually us cold-contacting
   *      — there's no unresponded lead to track (avoids noise). Some sources,
   *      and GHL's 'call' channel specifically (#252 slice F — a placed call
   *      is a deliberate reach-out), deliberately track outbound-only first
   *      observations (positive allowlist below); a conversation we REPLIED
   *      to keeps its existing item and still auto-resolves.
   *   2. #252: a GHL activity-noise touch (touch.isActivityNoise) that has an
   *      EXISTING item — skip so pure CRM activity can never bump/reopen a
   *      real conversation. The opposite-polarity twin of reason 1: that rule
   *      skips on `!existing`, this one skips on `existing`. An activity-noise
   *      touch with NO existing item is deliberately never skipped here — a
   *      conversation's first-ever touch must always be observable, even when
   *      the only snapshot GHL ever hands the poller is an activity row (see
   *      ghl.ts's ACTIVITY_NOISE_TYPES comment for the full swallow scenario). */
  skip: boolean;
  /** WHY `skip` is true (null when it's false). Exists so a caller (sync.ts's
   *  activityNoiseSkipped counter) can tell the two skip reasons apart —
   *  `touch.isActivityNoise` alone is NOT enough, because it says nothing about
   *  whether `existing` was present: a brand-new (no existing item) GHL
   *  conversation whose latest event is BOTH activity noise AND outbound is a
   *  reason-1 cold-outbound skip, not a #252 reason-2 skip, even though
   *  isActivityNoise is true on that touch. */
  skipReason: 'cold-outbound' | 'activity-noise-existing' | null;
  /** When true, an item is being re-ingested with NOTHING to persist — same
   *  status, same last_message_at, no reopen / auto-resolve / snooze-clear.
   *  The reconcile cron re-reads these every minute, so writing them anyway
   *  floods inbox_items (fresh updated_at) + dashboard_activity with dead
   *  'ingested' rows. ingestTouch short-circuits on it (#110 W7-004). Two
   *  cases feed this:
   *    1. A RESOLVED item (handled/completed/dismissed) — the original
   *       #110 W7-004 case. Same status + same last_message_at is sufficient;
   *       nothing else about a resolved item's display depends on the touch.
   *    2. #316: an UNRESOLVED ('unresponded') item whose touch-derived fields
   *       (direction/channel/preview/subject/source_message_id/lead_kind/
   *       quote_value, plus the raw.highlevel_contact_id/raw.customer_name
   *       pair added in the review FIX 2 follow-up — see ExistingItem's doc
   *       for what each field actually discriminates on live traffic) ALSO
   *       match the stored row — same status + same last_message_at is not
   *       enough here, because a still-DRAFT
   *       quotetool lead's lastMessageAt is pinned to created_at, so an
   *       edited draft total can change preview/quote_value with the
   *       timestamp frozen. Deliberately does NOT compare escalation_level —
   *       that's a pure function of (last_message_at, now), so it changes on
   *       almost every tick for an aging open item and would defeat this
   *       noop entirely; the separately-scheduled escalate cron (runEscalation,
   *       every 10 min, sync.ts) is what keeps the STORED column caught up,
   *       independent of ingest — skipping the ingest-time write just means
   *       the displayed level can lag by <=10 minutes after crossing a
   *       threshold, which is exactly what that cron exists to backstop. */
  noopReingest: boolean;
  contactOp: ContactOp;
  item: ItemRow;
  autoResolved: boolean;
  reopened: boolean;
  ambiguous: boolean;
  clearFollowedUp: boolean;
};

// #222: sources listed here need an inbox item even when FIRST seen as outbound,
// because downstream work (the quote_sent_no_reply follow-up) anchors on that
// item. A quote created and sent between two 5-minute cron ticks is only ever
// observed as outbound, so without this it got no item and therefore no
// follow-up — a real customer silently owed one (live case: quote #1263, a
// 7.75-second draft window). Positive allowlist, never a negative test, per
// AGENTS.md Pitfalls: every other source's outbound-only first observation
// stays skipped as noise (a cold outbound Gmail touch, or a cold outbound GHL
// text/email touch, is not a lead we owe a reply to) — EXCEPT GHL's 'call'
// channel, a #252 slice F exception documented below. The item auto-resolves
// to 'handled', so it anchors the follow-up without entering the operator's
// open inbox list.
//
// ACCEPTED TRADEOFF (#222 pre-merge review): this also covers SENT legacy_rebook
// ("YLL Neighbor") quotes. Today that is 2 rows. But the Neighbor pool is ~114-124
// quotes designed to go out as a deliberate send WAVE (#155/#157) — if a scripted
// wave ever sends them faster than the 5-minute cron can observe any of them as a
// draft, each one mints a follow-up in a single tick and lands in the due-today
// strip at once. Accepted rather than special-cased here: a quote we actually sent
// genuinely is owed a follow-up, and the alternative (teaching this pure,
// source-generic reducer about a quote-specific flag) is worse. If that wave is
// ever scripted, stagger the sends or cap follow-up creation per reconcile run.
const TRACKS_OUTBOUND_FIRST_OBSERVATION: ReadonlySet<InboxSource> = new Set<InboxSource>(['quotetool']);

// #252 slice F: a channel-aware EXCEPTION layered on top of the source
// allowlist above — GHL's 'call' channel also tracks outbound-first-
// observation; no other GHL channel does (a cold outbound GHL SMS/email still
// skips as noise, unchanged). Slice A's live probe (row 252, "PROBE DONE"
// section) settled two facts that motivate this: (1) calls are real and
// common, not dead code — an answered outbound call arrives as GHL's
// TYPE_CALL/outbound, which ghl.ts's CHANNEL_BY_TYPE already maps to channel
// 'call' (11 of the 40 newest conversations in the probe were calls); (2) a
// PLACED call — answered or no-answer — is a deliberate reach-out worth a
// record, unlike a cold outbound text/email blast. Without this exception a
// staff member who calls a never-before-ingested lead leaves NO trace
// anywhere in the inbox: no item, no contact, no dashboard_activity row.
// no-answer flows through identically to answered here, verified against the
// adapter: GHL's per-message `status` (completed/no-answer) lives only on
// getConversationMessages(), never on the /conversations/search summary this
// adapter reads — HighLevelConversation (src/lib/integrations/types.ts)
// carries no status field at all, so channel/direction (the only two things
// this check reads) are identical for both outcomes; ghl.ts's channelOf/
// directionOf can't tell them apart, and neither does this function. Positive
// match, per AGENTS.md Pitfalls: checks touch.channel === 'call' (never a
// negative !== test), so a GHL channel this repo doesn't recognize yet
// defaults to staying skipped, not silently tracked.
function tracksOutboundFirstObservation(source: InboxSource, channel: NormalizedTouch['channel']): boolean {
  return TRACKS_OUTBOUND_FIRST_OBSERVATION.has(source) || (source === 'ghl' && channel === 'call');
}

// #316 follow-up (review FIX 2): safely pull one string field out of a
// touch's `raw` blob — typed `unknown` on NormalizedTouch because every
// source shapes it differently (a GhlConversation, a GmailThreadLite, a
// DashboardQuote row, an arbitrary ingest POST body). Only the quotetool
// source's raw ever carries highlevel_contact_id/customer_name (it IS a
// DashboardQuote row); every other source's raw lacks both keys, so this
// returns null for them — same null===null fail-safe direction as every
// other unrespondedNoContentChange comparison below.
function rawStringField(raw: unknown, key: string): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Decide what an inbound/outbound touch should do, given the matching contact
 * candidates and the existing item (if any). PURE — no I/O.
 *
 * Identity is resolved only for a NEW item; an existing item keeps its contact
 * link. Ambiguous matches are NEVER auto-merged — we insert a fresh contact and
 * flag it for manual review.
 */
export function planIngest(input: {
  candidates: StoredContact[];
  existing: ExistingItem | null;
  touch: NormalizedTouch;
  now: Date;
}): IngestPlan {
  const { candidates, existing, touch, now } = input;

  const decision = decideInboxState({
    existing: existing ? { status: existing.status, notifiedLevels: existing.notifiedLevels, lastMessageAt: existing.lastMessageAt } : null,
    touch,
    now,
  });

  let contactOp: ContactOp;
  let ambiguous = false;
  if (existing) {
    contactOp = { kind: 'keep', contactId: existing.contactId };
  } else {
    const match = resolveIdentity(touch.identity, candidates);
    if (match.ambiguous) {
      ambiguous = true;
      contactOp = { kind: 'insert', identity: touch.identity, ambiguous: true };
    } else if (match.contact) {
      contactOp = { kind: 'update', contactId: match.contact.id, merged: appendIdentifiers(match.contact, touch.identity) };
    } else {
      contactOp = { kind: 'insert', identity: touch.identity, ambiguous: false };
    }
  }

  // Clear the followed/snooze flag only when a genuinely-newer INBOUND message
  // arrives (so a reconcile re-ingesting the SAME message preserves the snooze,
  // and — critically — our OWN outbound reply, which is newer than the customer's
  // inbound, does NOT wipe the snooze: a sent reply leaves the item 'handled' +
  // followed, awaiting their next inbound). null existing timestamp → treat as
  // newer (mirrors the handled-reopen guard).
  const clearFollowedUp =
    !!existing &&
    !isAnsweredByDirection(touch.direction) &&
    (existing.lastMessageAt == null || touch.lastMessageAt.getTime() > existing.lastMessageAt.getTime());

  // notified_levels is owned by the escalate cron. Ingest only PRESERVES it
  // (and resets it on reopen) — it must never advance a level, or the cron would
  // skip that escalation email.
  const notifiedLevels = decision.reopened ? [] : (existing?.notifiedLevels ?? []);

  // #110 W7-004 / #316: an item re-ingested with nothing to persist is a no-op.
  // Shared preconditions for EITHER case below: an existing item, no state
  // transition the reducer made (no auto-resolve / reopen / snooze-clear), same
  // status, and an unchanged last_message_at (our own outbound reply re-read
  // every reconcile, or a still-open conversation nobody has touched, are both
  // the common case). Everything that actually changes state — reopen,
  // auto-resolve, snooze-clear, a newer message — falls through and writes
  // normally, for both cases.
  const commonNoopPreconditions =
    !!existing &&
    !decision.autoResolved &&
    !decision.reopened &&
    !clearFollowedUp &&
    decision.status === existing.status &&
    existing.lastMessageAt != null &&
    touch.lastMessageAt.getTime() === existing.lastMessageAt.getTime();

  // Case 1 (#110 W7-004): a RESOLVED item (handled/completed/dismissed).
  // Nothing else about a resolved item's display depends on the touch, so the
  // shared preconditions alone are sufficient.
  const isResolvedStatus =
    decision.status === 'handled' || decision.status === 'completed' || decision.status === 'dismissed';

  // Case 2 (#316): an UNRESOLVED ('unresponded') item ALSO needs its
  // touch-derived fields to match the stored row before it's a true no-op —
  // unlike a resolved item, an unresponded item's last_message_at can be
  // pinned (a still-DRAFT quotetool lead pins it to created_at; see
  // quotetool.ts's normalizeQuoteTouch) while a real edit changes what's
  // shown (a draft's total → preview + quote_value). Compares every
  // touch-derived field the upsert writes that could plausibly change without
  // moving last_message_at, plus (review FIX 2, #316 follow-up) the
  // raw.highlevel_contact_id/raw.customer_name pair getItemForReply falls
  // back to. Not every field pulls equal weight on live traffic today:
  // source_message_id is null on every path except gmail.ts's rare
  // lead-forward branch, and the raw pair is only ever non-null for the
  // quotetool source — both stay in the comparison for future-proofing and
  // fail-safe symmetry with the rest, not because they discriminate most
  // traffic (see ExistingItem's doc for the honest breakdown). Deliberately
  // EXCLUDES escalation_level (see the IngestPlan.noopReingest doc above —
  // it's a pure function of elapsed time, not of the touch, and the escalate
  // cron owns keeping it current independent of ingest) and notified_levels
  // (already byte-identical to `existing` here by construction — see
  // `notifiedLevels` above, `reopened` is false whenever this runs).
  const unrespondedNoContentChange =
    decision.status === 'unresponded' &&
    (touch.direction ?? null) === existing?.direction &&
    (touch.channel ?? null) === existing?.channel &&
    (touch.preview ?? null) === existing?.preview &&
    (touch.subject ?? null) === existing?.subject &&
    (touch.sourceMessageId ?? null) === existing?.sourceMessageId &&
    (touch.leadKind ?? 'lead') === existing?.leadKind &&
    (touch.quoteValue ?? null) === existing?.quoteValue &&
    rawStringField(touch.raw, 'highlevel_contact_id') === existing?.rawHighlevelContactId &&
    rawStringField(touch.raw, 'customer_name') === existing?.rawCustomerName;

  const noopReingest = commonNoopPreconditions && (isResolvedStatus || unrespondedNoContentChange);

  const item: ItemRow = {
    source: touch.source,
    external_id: touch.externalId,
    source_message_id: touch.sourceMessageId ?? null,
    direction: touch.direction ?? null,
    channel: touch.channel ?? null,
    last_message_at: touch.lastMessageAt.toISOString(),
    preview: touch.preview ?? null,
    subject: touch.subject ?? null,
    status: decision.status,
    escalation_level: decision.escalationLevel,
    notified_levels: notifiedLevels,
    raw: touch.raw ?? null,
    lead_kind: touch.leadKind ?? 'lead',
    quote_value: touch.quoteValue ?? null,
  };

  // #252: reason 1 (outbound, no existing item) OR reason 2 (activity noise,
  // existing item) — see the `skip`/`skipReason` field docs above. Mutually
  // exclusive by construction (reason 1 requires `!existing`, reason 2
  // requires `existing`), so evaluation order doesn't matter.
  const coldOutboundSkip =
    !existing && touch.direction === 'outbound' && !tracksOutboundFirstObservation(touch.source, touch.channel);
  const activityNoiseExistingSkip = !!existing && !!touch.isActivityNoise;
  const skipReason: IngestPlan['skipReason'] = activityNoiseExistingSkip
    ? 'activity-noise-existing'
    : coldOutboundSkip
      ? 'cold-outbound'
      : null;

  return {
    skip: coldOutboundSkip || activityNoiseExistingSkip,
    skipReason,
    noopReingest,
    contactOp,
    item,
    autoResolved: decision.autoResolved,
    reopened: decision.reopened,
    ambiguous,
    clearFollowedUp,
  };
}

// ─── I/O glue (service-role; untested — see header) ─────────────────────────

function nonNull<T>(xs: (T | null)[]): T[] {
  return xs.filter((x): x is T => x !== null);
}

function toStoredContact(row: Record<string, unknown>): StoredContact {
  return {
    id: String(row.id),
    ghlContactId: (row.ghl_contact_id as string | null) ?? null,
    emails: (row.emails as string[] | null) ?? [],
    phones: (row.phones as string[] | null) ?? [],
    displayName: (row.display_name as string | null) ?? null,
  };
}

/** Contacts matching ANY identifier of the touch (the resolveIdentity input). */
async function findCandidates(identity: ContactIdentity): Promise<StoredContact[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const emails = nonNull((identity.emails ?? []).map(normalizeEmail));
  const phones = nonNull((identity.phones ?? []).map(normalizePhone));
  const conds: string[] = [];
  // ghl ids are alphanumeric; only interpolate one that matches a safe pattern so
  // a crafted value can't inject PostgREST .or() syntax. emails are delimiter-free
  // (normalizeEmail) and phones are +digits, so both are safe to interpolate.
  if (identity.ghlContactId && /^[A-Za-z0-9_-]+$/.test(identity.ghlContactId)) {
    conds.push(`ghl_contact_id.eq.${identity.ghlContactId}`);
  }
  if (emails.length) conds.push(`emails.ov.{${emails.join(',')}}`);
  if (phones.length) conds.push(`phones.ov.{${phones.join(',')}}`);
  if (!conds.length) return [];
  const { data, error } = await sb
    .from('dashboard_contacts')
    .select('id, ghl_contact_id, emails, phones, display_name')
    .or(conds.join(','));
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map(toStoredContact);
}

async function findExistingItem(source: InboxSource, externalId: string): Promise<ExistingItem | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  // #316: also selects the touch-derived columns planIngest's unresponded-item
  // noop check compares (see ExistingItem's doc) — direction/channel/preview/
  // subject/source_message_id/lead_kind/quote_value — plus (review FIX 2) the
  // raw.highlevel_contact_id/raw.customer_name pair, pulled narrowly via a
  // PostgREST JSON-path select (raw->>key, aliased) rather than fetching the
  // whole raw blob per row.
  const { data } = await sb
    .from('inbox_items')
    .select(
      'id, contact_id, status, notified_levels, last_message_at, direction, channel, preview, subject, source_message_id, lead_kind, quote_value, raw_highlevel_contact_id:raw->>highlevel_contact_id, raw_customer_name:raw->>customer_name',
    )
    .eq('source', source)
    .eq('external_id', externalId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  return {
    id: String(row.id),
    contactId: (row.contact_id as string | null) ?? null,
    status: row.status as InboxStatus,
    notifiedLevels: (row.notified_levels as number[] | null) ?? [],
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at as string) : null,
    direction: (row.direction as string | null) ?? null,
    channel: (row.channel as string | null) ?? null,
    preview: (row.preview as string | null) ?? null,
    subject: (row.subject as string | null) ?? null,
    sourceMessageId: (row.source_message_id as string | null) ?? null,
    leadKind: (row.lead_kind as string | null) ?? null,
    quoteValue: (row.quote_value as number | null) ?? null,
    rawHighlevelContactId: (row.raw_highlevel_contact_id as string | null) ?? null,
    rawCustomerName: (row.raw_customer_name as string | null) ?? null,
  };
}

function contactInsertRow(identity: ContactIdentity) {
  const emails = nonNull((identity.emails ?? []).map(normalizeEmail));
  const phones = nonNull((identity.phones ?? []).map(normalizePhone));
  return {
    display_name: identity.displayName ?? null,
    primary_email: emails[0] ?? null,
    primary_phone: phones[0] ?? null,
    emails,
    phones,
    ghl_contact_id: identity.ghlContactId ?? null,
  };
}

export type IngestOutcome =
  | {
      ok: true;
      skipped: boolean;
      itemId: string | null;
      contactId: string | null;
      autoResolved: boolean;
      reopened: boolean;
      ambiguous: boolean;
      /** #252: WHY a skip happened (null when not skipped, or skipped for a
       *  reason other than planIngest's `skip` — e.g. #110 W7-004's
       *  noopReingest). Mirrors IngestPlan.skipReason; see its doc. */
      skipReason: 'cold-outbound' | 'activity-noise-existing' | null;
    }
  | { ok: false; error: string };

/**
 * Ingest one normalized touch: resolve identity, upsert the contact + item
 * idempotently (UNIQUE(source, external_id)), and log activity. Returns the
 * notifyLevel so the caller can fire an escalation email if a level was crossed.
 */
export async function ingestTouch(touch: NormalizedTouch, now: Date): Promise<IngestOutcome> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  const existing = await findExistingItem(touch.source, touch.externalId);
  const candidates = existing ? [] : await findCandidates(touch.identity);
  const plan = planIngest({ candidates, existing, touch, now });

  // Outbound with no existing item → nothing to track. Do not write.
  if (plan.skip) {
    return { ok: true, skipped: true, itemId: null, contactId: null, autoResolved: false, reopened: false, ambiguous: false, skipReason: plan.skipReason };
  }

  // #110 W7-004 / #316: an item (resolved OR unresponded — see noopReingest's
  // doc) re-ingested with nothing to persist — skip the item upsert AND the
  // 'ingested' activity insert so the every-minute reconcile cron stops
  // flooding both tables with no-change writes. `existing` is non-null
  // whenever noopReingest is true. Not a plan.skip reason, so skipReason is null.
  if (plan.noopReingest) {
    return { ok: true, skipped: true, itemId: existing?.id ?? null, contactId: existing?.contactId ?? null, autoResolved: false, reopened: false, ambiguous: false, skipReason: null };
  }

  // 1. Resolve the contact id.
  let contactId: string | null;
  if (plan.contactOp.kind === 'keep') {
    contactId = plan.contactOp.contactId;
  } else if (plan.contactOp.kind === 'update') {
    const m = plan.contactOp.merged;
    const { error: updErr } = await sb
      .from('dashboard_contacts')
      .update({
        ghl_contact_id: m.ghlContactId,
        emails: m.emails,
        phones: m.phones,
        display_name: m.displayName,
        primary_email: m.emails[0] ?? null,
        primary_phone: m.phones[0] ?? null,
      })
      .eq('id', plan.contactOp.contactId);
    // Check the error like the insert/item paths do — otherwise merged
    // identifiers can be silently dropped while the item still links to the row.
    if (updErr) return { ok: false, error: updErr.message };
    contactId = plan.contactOp.contactId;
  } else {
    const { data, error } = await sb
      .from('dashboard_contacts')
      .insert(contactInsertRow(plan.contactOp.identity))
      .select('id')
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? 'contact insert failed' };
    contactId = String((data as { id: string }).id);
  }

  // 2. Upsert the item (idempotent on source+external_id).
  const itemUpsert: Record<string, unknown> = {
    ...plan.item,
    contact_id: contactId,
    updated_at: now.toISOString(),
  };
  if (plan.autoResolved) {
    itemUpsert.handled_by = null; // system auto-resolve
    itemUpsert.handled_at = now.toISOString();
  }
  // Followed/snooze flag: clear it on a genuinely-newer message so the item
  // returns to the open list. OMITTED otherwise → the upsert preserves the
  // existing value (re-ingesting the same message keeps the snooze).
  if (plan.clearFollowedUp) itemUpsert.followed_up_at = null;
  // #110 W7-003: stamp the customer's last INBOUND time only on inbound touches.
  // OMITTED on outbound → the upsert preserves it, so the auto-resolve (which
  // overwrites last_message_at with our outbound reply) can't corrupt the
  // response-time measure (handled_at − last_inbound_at).
  if (!isAnsweredByDirection(touch.direction)) itemUpsert.last_inbound_at = touch.lastMessageAt.toISOString();
  const { data: itemData, error: itemErr } = await sb
    .from('inbox_items')
    .upsert(itemUpsert, { onConflict: 'source,external_id' })
    .select('id')
    .single();
  if (itemErr || !itemData) return { ok: false, error: itemErr?.message ?? 'item upsert failed' };
  const itemId = String((itemData as { id: string }).id);

  // 3. Activity log.
  const action = plan.autoResolved ? 'handled' : plan.reopened ? 'reopened' : 'ingested';
  await sb.from('dashboard_activity').insert({
    actor: 'system',
    action,
    inbox_item_id: itemId,
    contact_id: contactId,
    detail: { source: touch.source, ambiguous: plan.ambiguous, autoResolved: plan.autoResolved },
  });

  return {
    ok: true,
    skipped: false,
    itemId,
    contactId,
    autoResolved: plan.autoResolved,
    reopened: plan.reopened,
    ambiguous: plan.ambiguous,
    skipReason: null,
  };
}

// ─── Reads for the UI / poll ────────────────────────────────────────────────

// WT-41: `truncated`/`totalOpen` mirror the pattern listItemsForMetrics already
// exposes for ResponseAnalytics — the page is capped at `limit` (oldest-first),
// but `totalOpen` is the REAL count of open items (via Postgrest's exact count,
// unaffected by .limit()), so the UI can say "N more not shown" instead of
// silently under-reporting once open items exceed the cap.
//
// #265: `totalOpen` (and `items`) deliberately stay UNFILTERED by lead_kind —
// they describe the same raw "every open item" population the /inbox page's
// "Show N filtered" toggle (InboxList.tsx) needs to fetch automated rows to
// display on demand. `totalLeads` is the sibling number: the same population
// minus lead_kind='automated' noise (mirrors listEscalatableItems' own
// `.or('lead_kind.is.null,lead_kind.neq.automated')` filter), for consumers
// that want "how many actually need a reply" — currently only the morning
// digest. Never repurpose `totalOpen` itself for this: it must stay the same
// population as `items`/`items.length`, or the WT-41 truncation math above
// (`totalOpen - items.length`) can go negative/silently stop firing.
export type OpenItemsResult =
  | { ok: true; items: OpenInboxItem[]; totalOpen: number; totalLeads: number; truncated: boolean }
  | { ok: false; error: string };

// ─── Legacy-rebook inbox exclusion (#157, escalation coverage + ingest-time
// gating added #181) ───
// "YLL Neighbors": quotes migrated from last year's Jobber data
// (legacy_rebook = true, migrations/2026-07-16-legacy-rebook.sql). They're real
// drafts, so runQuoteToolReconcile folds each into an unresponded touch same as
// any other draft quote — flooding the operator inbox with 100+ items nobody
// needs to action yet. This hides them from the INBOX SURFACES ONLY (the /inbox
// open-items list AND escalation — amber/red alert emails + the EOD digest, both
// read via listEscalatableItems below), AND from ever being ingested as an
// unsent draft touch in the first place (quotetool.ts's normalizeQuoteTouch
// imports this same constant): every dashboard/stats consumer (metrics.ts,
// insights.ts, serviceMetrics.ts, referralMetrics.ts, needsAction.ts,
// workflowBoard.ts) reads quotes directly and is untouched by this flag — legacy
// quotes keep counting everywhere except the inbox + escalation surfaces.
//
// Flip to false once the dedicated "YLL Neighbors" rebook flow ships (task
// #157) and these should resurface as normal inbox leads again — one switch,
// covers both the display-side filter here and the quotetool.ts ingest guard.
export const EXCLUDE_LEGACY_REBOOK_FROM_INBOX = true;

// A generous ceiling above the caller's `limit` to over-fetch by whenever the
// flag above is active. The ~114 migrated drafts (as of 2026-07) share roughly
// the same last_message_at (the import run), so — sorted oldest-first — they
// could otherwise occupy the ENTIRE page and starve genuinely open leads that
// arrived after the migration. 200 comfortably covers today's batch with room
// to grow; only affects listOpenItems' internal fetch size, never the caller's
// `limit`-sized returned page.
const LEGACY_REBOOK_FETCH_BUFFER = 200;

/**
 * #183 BUG 1: a quotetool item's external_id is USUALLY the bare quote id, but
 * the color-change-request route (apply-color-request/route.ts) suffixes it
 * `${quoteId}:color-request` so its notification never collides with the
 * quote-sent reconcile item. Strip that suffix (if present) to recover the
 * underlying quote id — used both to build the `.in('id', …)` lookup list
 * below (a suffixed value there is NOT a valid uuid and Postgres rejects the
 * WHOLE `.in()` with 22P02, silently poisoning the exclusion for every item on
 * the page) and by excludeLegacyRebookItems' own match (so a legacy quote's
 * color-request item is excluded too, not just its bare-id sibling).
 */
export function quoteIdPrefix(externalId: string): string {
  const i = externalId.indexOf(':');
  return i === -1 ? externalId : externalId.slice(0, i);
}

/**
 * #157: drop items whose backing quote id is in `hiddenQuoteIds`. Only a
 * 'quotetool' item can match — its external_id is the quote id, optionally
 * suffixed `:color-request` (quoteIdPrefix strips it, #183 BUG 1) — so every
 * other source is untouched by construction, even if an id happened to
 * collide. Pure — no I/O — hence unit-testable on its own (store.test.ts).
 * `hiddenQuoteIds` is produced by fetchHiddenLegacyRebookQuoteIds below (the
 * #252 slice-G predicate, not a raw legacy_rebook flag) — see that function's
 * doc comment for what "hidden" means.
 */
export function excludeLegacyRebookItems<T extends { source: unknown; external_id: unknown }>(
  items: T[],
  hiddenQuoteIds: ReadonlySet<string>,
): T[] {
  if (hiddenQuoteIds.size === 0) return items;
  return items.filter(
    (item) => !(item.source === 'quotetool' && hiddenQuoteIds.has(quoteIdPrefix(String(item.external_id)))),
  );
}

/**
 * #252 slice G: a legacy_rebook ("YLL Neighbor") quote is hidden from the
 * inbox/escalation surfaces ONLY when it's a genuine parked draft nobody has
 * sent. #157/#181 originally hid every legacy_rebook quote regardless of
 * status or quote_sent_at — that blanket rule swallowed a real customer's
 * live BOOKED colour-change ask (quote #1129) for 14 days.
 *
 * #263: this is now a thin re-export of the ONE shared predicate
 * (isParkedLegacyRebookDraft, @/lib/quoteStatus) instead of its own
 * raw-`status`-column check — store.ts, quotetool.ts's ingest guard, the
 * text-ops bot, and the morning digest all used to define "hidden draft"
 * independently and could silently drift apart (they had: this function once
 * trusted the persisted `status` string directly). Deriving off deriveStatus
 * instead of the raw column also closes #267(b): a legacy_rebook row that's
 * actually been PAID (deposit_paid_at set) is never hidden here even if its
 * persisted status column lagged behind at 'draft'. See the predicate's own
 * doc comment for the full reasoning. Pure — no I/O.
 */
export const isHiddenLegacyRebookQuote = isParkedLegacyRebookDraft;

/**
 * #252 slice G: the ONE seam listOpenItems and listEscalatableItems both call
 * to decide which of the quotetool ids on their current page back a hidden
 * (parked-draft) legacy_rebook quote — so the two surfaces can't drift onto
 * different predicates again (they had: listEscalatableItems' own comment used
 * to document hiding "regardless of quote_sent_at" as an accepted, narrower-
 * than-ingest tradeoff). Batch-fetches only the ids passed in; empty input
 * skips the query entirely (the common case for ghl/gmail/homeworks-only
 * pages). Fails OPEN + VISIBLY on a lookup error (#183 BUG 1) — returns an
 * empty set (nothing hidden) rather than swallow the error or throw. Hiding a
 * real customer on a transient query failure is the worse outcome; #252 exists
 * because a hidden customer went unnoticed for 14 days.
 */
async function fetchHiddenLegacyRebookQuoteIds(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quotetoolIds: readonly string[],
): Promise<Set<string>> {
  if (quotetoolIds.length === 0) return new Set();
  // #263: the predicate moved from a raw `status` read to deriveStatus, which
  // also needs deposit_paid_at/customer_approved_at/viewed_at — the original
  // #252 SELECT only fetched `status`/`quote_sent_at` and would have silently
  // under-derived every row to 'draft' on the missing columns.
  const { data: quoteRows, error } = await sb
    .from('quotes')
    .select('id, legacy_rebook, status, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at')
    .in('id', quotetoolIds);
  if (error) {
    console.error('[inbox] legacy-rebook exclusion lookup failed:', error.message);
    return new Set();
  }
  return new Set(
    (
      (quoteRows ?? []) as {
        id: string;
        legacy_rebook: boolean | null;
        status: QuoteStatus | null;
        quote_sent_at: string | null;
        customer_approved_at: string | null;
        deposit_paid_at: string | null;
        viewed_at: string | null;
      }[]
    )
      .filter(isHiddenLegacyRebookQuote)
      .map((q) => String(q.id)),
  );
}

export async function listOpenItems(limit = 100): Promise<OpenItemsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  // #157: over-fetch when the legacy filter is active — see
  // LEGACY_REBOOK_FETCH_BUFFER above.
  const fetchLimit = EXCLUDE_LEGACY_REBOOK_FROM_INBOX ? limit + LEGACY_REBOOK_FETCH_BUFFER : limit;

  // #252 slice C: the base query is bound to a const BEFORE applyBucketFilter
  // — inlining the .select(...) call directly as the generic call's argument
  // hits a real `tsc` "Type instantiation is excessively deep" error (the
  // nested dashboard_contacts relation in the select string, combined with
  // bidirectional generic inference on the inline argument).
  const baseQuery = sb.from('inbox_items').select(
    'id, source, external_id, channel, direction, last_message_at, preview, subject, escalation_level, contact_id, lead_kind, quote_value, ' +
      'dashboard_contacts ( display_name, primary_email, primary_phone, assigned_to )',
    { count: 'exact' },
  );
  const { data, error, count } = await applyBucketFilter(baseQuery, 'needs_reply')
    .order('last_message_at', { ascending: true })
    .limit(fetchLimit);
  if (error) return { ok: false, error: error.message };

  let rows = (data ?? []) as unknown as Record<string, unknown>[];
  let legacyExcluded = 0;

  // #157/#252: batch-fetch the quotetool ids present on THIS page and drop any
  // that back a hidden (parked-draft) legacy_rebook quote — see
  // isHiddenLegacyRebookQuote for the exact predicate. Skips the extra query
  // entirely when the page has no quotetool items (the common case for
  // ghl/gmail/homeworks-only pages).
  // #183 BUG 1: derive+filter through quoteIdPrefix/isUuid — a suffixed
  // `:color-request` id (or any other malformed value) is NOT a valid uuid, and
  // Postgres's `.in()` rejects the ENTIRE query (22P02) if even one entry in the
  // list doesn't parse as one, which used to silently empty legacyQuoteIds for
  // every item on the page.
  if (EXCLUDE_LEGACY_REBOOK_FROM_INBOX) {
    const quotetoolIds = [
      ...new Set(
        rows
          .filter((r) => r.source === 'quotetool')
          .map((r) => quoteIdPrefix(String(r.external_id)))
          .filter(isUuid),
      ),
    ];
    if (quotetoolIds.length) {
      const hiddenQuoteIds = await fetchHiddenLegacyRebookQuoteIds(sb, quotetoolIds);
      const before = rows.length;
      rows = excludeLegacyRebookItems(rows as { source: unknown; external_id: unknown }[], hiddenQuoteIds);
      legacyExcluded = before - rows.length;
    }
  }

  // #265: automated-noise count within the SAME fetch window `legacyExcluded`
  // above already used (post-legacy-exclusion `rows`, before the page slice) —
  // feeds totalLeads below. Computed here (not via a query-level `.or(...)`
  // filter like listEscalatableItems' sibling filter) because this query's
  // `rows`/`items` must keep INCLUDING automated rows — InboxList.tsx's
  // "Show N filtered" toggle depends on them still being fetched so staff can
  // view automated notices (e.g. a TYPE_NO_SHOW touch) on demand. Filtering
  // the query itself would silently break that toggle for every consumer.
  // Structurally safe to subtract straight from totalOpen below: a quotetool
  // item is NEVER lead_kind='automated' (quotetool.ts's normalizeQuoteTouch
  // hardcodes leadKind: 'lead'), so this set and the legacy-rebook-hidden set
  // (quotetool-only, per excludeLegacyRebookItems) never overlap.
  // Same truncation-safety direction as totalOpen's own count below: if raw
  // unresponded volume ever exceeds fetchLimit, this only sees automated rows
  // INSIDE the window, so it under-counts automated noise — which means
  // totalLeads (totalOpen − this) errs toward OVER-, never under-, reporting.
  // A true lead can never silently vanish from the digest's count this way.
  const automatedInWindow = rows.filter((r) => r.lead_kind === 'automated').length;

  const trimmed = rows.slice(0, limit);

  // "Returning" proxy: a contact with >1 inbox_items across ALL statuses (any
  // channel, incl. handled/dismissed history). NOTE: a single customer with two
  // channels open right now also reads as returning — acceptable for v1 (we chose
  // this over the dormant quote_customer_id link).
  const contactIds = [...new Set(trimmed.map((r) => (r as unknown as { contact_id: string | null }).contact_id).filter((c): c is string => !!c))];
  const returning = new Set<string>();
  if (contactIds.length) {
    // #185: this was UNBOUNDED — every historical inbox_items row (any status,
    // any channel, all time) for up to `contactIds.length` (<=100) contacts. It
    // only needs to know whether each contact has >1 row (a Set-membership
    // check), so a generous cap is a no-op for realistic per-contact history
    // and just bounds the pathological case (mirrors the 5000 cap already used
    // a few lines below in getReopenCounts' distinct() for the same reason —
    // an unbounded historical read on this table). NOT a per-contact limit —
    // that would risk truncating one contact's rows before its second one is
    // seen and silently flipping it back to "not returning".
    const { data: counts } = await sb
      .from('inbox_items')
      .select('contact_id')
      .in('contact_id', contactIds)
      // Ordered so the capped subset is DETERMINISTIC — without an order, a
      // page whose contacts exceed the cap could nondeterministically flip a
      // contact's "returning" badge between loads (review LOW, #185).
      .order('contact_id', { ascending: true })
      .limit(5000);
    const tally = new Map<string, number>();
    for (const row of counts ?? []) {
      const cid = (row as { contact_id: string }).contact_id;
      tally.set(cid, (tally.get(cid) ?? 0) + 1);
    }
    for (const [cid, n] of tally) if (n > 1) returning.add(cid);
  }

  const items = (trimmed as unknown as Record<string, unknown>[]).map((row): OpenInboxItem => {
    const c = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
    return {
      id: String(row.id),
      source: row.source as InboxSource,
      channel: (row.channel as string | null) ?? null,
      direction: (row.direction as string | null) ?? null,
      lastMessageAt: (row.last_message_at as string | null) ?? null,
      preview: (row.preview as string | null) ?? null,
      subject: (row.subject as string | null) ?? null,
      escalationLevel: (row.escalation_level as number | null) ?? 0,
      leadKind: (row.lead_kind === 'automated' ? 'automated' : 'lead'),
      quoteValue: (row.quote_value as number | null) ?? null,
      isReturning: row.contact_id ? returning.has(row.contact_id as string) : false,
      contactId: (row.contact_id as string | null) ?? null,
      assignedTo: (c?.assigned_to as string | null) ?? null,
      contact: c
        ? {
            displayName: (c.display_name as string | null) ?? null,
            email: (c.primary_email as string | null) ?? null,
            phone: (c.primary_phone as string | null) ?? null,
          }
        : null,
    };
  });
  // count is null only if Postgrest didn't return one (shouldn't happen with
  // { count: 'exact' }, but fall back to the page length rather than lie low).
  // #157: subtract the legacy items excluded from THIS fetch so "N more not
  // shown" never counts a hidden YLL Neighbor draft as a still-open lead.
  // Best-effort if the fetch window didn't cover every matching row (rare,
  // given the buffer above) — errs toward over-, never under-, reporting,
  // matching the pre-#157 behavior this WT-41 signal already relies on.
  const totalOpen = Math.max((count ?? rows.length) - legacyExcluded, items.length);
  // #265: totalOpen minus the SAME window's automated count (see
  // automatedInWindow above) — the sibling-parity fix for the digest/inbox
  // count disagreement. Floored against the page's own lead-only tally
  // (never report fewer leads than are literally sitting in `items`),
  // mirroring totalOpen's own floor against items.length one line up.
  const leadItemsInPage = items.filter((i) => i.leadKind !== 'automated').length;
  const totalLeads = Math.max(totalOpen - automatedInWindow, leadItemsInPage);
  return { ok: true, items, totalOpen, totalLeads, truncated: totalOpen > items.length };
}

// ─── Claim / assign (shared-queue "I've got this", Phase 1.5) ───────────────
// Assignment lives on the contact (you own the customer, not one message).

export async function claimContact(contactId: string, operatorId: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { error } = await sb.from('dashboard_contacts').update({ assigned_to: operatorId }).eq('id', contactId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'assigned', contact_id: contactId, detail: { assignedTo: operatorId } });
  return { ok: true };
}

export async function releaseContact(contactId: string, operatorId: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { error } = await sb.from('dashboard_contacts').update({ assigned_to: null }).eq('id', contactId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'assigned', contact_id: contactId, detail: { released: true } });
  return { ok: true };
}

// ─── Handled write-back support ─────────────────────────────────────────────

// ─── Prior-state helper (private) ───────────────────────────────────────────

/** Read an item's current status + followed_up_at BEFORE a state-changing update
 *  so we can log { from } in dashboard_activity. Returns undefined when the item
 *  is not found or the client is unavailable. */
async function priorStateOf(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  itemId: string,
): Promise<{ status: string; wasFollowed: boolean } | undefined> {
  if (!sb) return undefined;
  const { data } = await sb
    .from('inbox_items')
    .select('status, followed_up_at')
    .eq('id', itemId)
    .maybeSingle();
  if (!data) return undefined;
  const row = data as { status: string; followed_up_at: string | null };
  return { status: row.status, wasFollowed: !!row.followed_up_at };
}

export type HandledTarget = {
  source: InboxSource;
  externalId: string;
  sourceMessageId: string | null;
  ghlContactId: string | null;
  displayName: string | null;
};
export type MarkHandledResult = { ok: true; target: HandledTarget } | { ok: false; error: string };

/**
 * Stamp an item handled locally FIRST (attribution never depends on the external
 * write-back), and return the coordinates the route needs to mark the source
 * read. Uses a status guard so two operators can't double-apply. `operatorId`
 * must be a real auth.users uuid, or null — inbox_items.handled_by is a
 * nullable `uuid` column ("NULL when system auto-resolved" per its schema
 * comment); never pass a display name/email string here.
 */
export async function markItemHandledLocal(itemId: string, operatorId: string | null, now: Date): Promise<MarkHandledResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);
  const { data, error } = await sb
    .from('inbox_items')
    .update({ status: 'handled', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId)
    .neq('status', 'handled')
    .select('source, external_id, source_message_id, dashboard_contacts ( ghl_contact_id, display_name )')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Item not found or already handled' };
  const row = data as unknown as Record<string, unknown>;
  const c = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'handled', inbox_item_id: itemId, detail: { from } });
  return {
    ok: true,
    target: {
      source: row.source as InboxSource,
      externalId: String(row.external_id),
      sourceMessageId: (row.source_message_id as string | null) ?? null,
      ghlContactId: (c?.ghl_contact_id as string | null) ?? null,
      displayName: (c?.display_name as string | null) ?? null,
    },
  };
}

/** `operatorId` must be a real auth.users uuid, or null — see markItemHandledLocal's
 *  doc comment; inbox_items.handled_by never accepts a display name/email string. */
export async function dismissItem(itemId: string, operatorId: string | null, now: Date): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);
  const { data, error } = await sb
    .from('inbox_items')
    .update({ status: 'dismissed', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId)
    .neq('status', 'dismissed')
    .select('dashboard_contacts ( primary_email, primary_phone )')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  // Already dismissed → no-op: don't log a duplicate reversible row or re-suppress
  // (a stray reverse of that row would un-suppress a still-dismissed sender).
  if (!data) return { ok: true };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'dismissed', inbox_item_id: itemId, detail: { from } });
  const c = (data as { dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null } } | null)?.dashboard_contacts;
  if (c) await addSuppressedSenders([c.primary_email ?? null, c.primary_phone ?? null]);
  // #252 follow-up-autoclose: dismissed is terminal — its conversation is not
  // a real lead, so any pending nag anchored to it should die with it. Only on
  // the matched (real transition) path above, never the already-dismissed no-op.
  await closeFollowUpsForResolvedItem(itemId, 'dismissed');
  return { ok: true };
}

/** Snooze an item: stamp followed_up_at (the reply route does this on send [A]; a
 *  manual "I followed up" does it without sending [B]). Hides from the open list
 *  until a newer message clears it. Service-role glue. */
export async function markItemFollowed(itemId: string, operatorId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);
  const { error } = await sb
    .from('inbox_items')
    .update({ followed_up_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'followed', inbox_item_id: itemId, detail: { from } });
  return { ok: true };
}

export async function recordWriteback(itemId: string, sync: unknown): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb.from('inbox_items').update({ handled_channel_sync: sync }).eq('id', itemId);
}

// ─── Escalation support ─────────────────────────────────────────────────────

export type EscalatableItem = {
  id: string;
  lastMessageAt: string | null;
  notifiedLevels: number[];
  /** Currently-stored display level — so the cron only writes when it changed. */
  escalationLevel: number;
  contact: { displayName: string | null } | null;
  preview: string | null;
};
export type EscalatableResult = { ok: true; items: EscalatableItem[] } | { ok: false; error: string };

export async function listEscalatableItems(): Promise<EscalatableResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  // #110 W7-005: a manually-Followed item (followed_up_at stamped, status still
  // 'unresponded') must NOT keep firing amber/red alerts + EOD digests — it's
  // been handled outside the tool. Mirrors listOpenItems' needs_reply bucket;
  // an inbound clears followed_up_at (planIngest.clearFollowedUp) and re-arms
  // escalation. #252 slice C: the status/followed_up_at pair below is exactly
  // the needs_reply bucket, routed through the same applyBucketFilter
  // listOpenItems uses — the lead_kind .or(...) is an escalation-only
  // narrowing on TOP of that bucket, not part of the bucket definition itself.
  // (baseQuery is bound to a const before applyBucketFilter for the same
  // reason as listOpenItems — see its comment.)
  const baseQuery = sb
    .from('inbox_items')
    .select(
      'id, source, external_id, last_message_at, notified_levels, escalation_level, preview, dashboard_contacts ( display_name )',
    );
  const { data, error } = await applyBucketFilter(baseQuery, 'needs_reply').or(
    'lead_kind.is.null,lead_kind.neq.automated',
  );
  if (error) return { ok: false, error: error.message };

  let rows = (data ?? []) as unknown as Record<string, unknown>[];

  // #181/#252: the same #157 exclusion listOpenItems applies to the /inbox
  // display — a YLL Neighbor item must never fire an amber/red alert or land
  // in the EOD digest either, so it stays invisible on every escalation
  // surface, not just the open-items list. Reuses excludeLegacyRebookItems +
  // fetchHiddenLegacyRebookQuoteIds (the exact same predicate, fed the same
  // way: batch-fetch quotes for the quotetool ids on this read) so the two
  // surfaces can never disagree.
  // #252 slice G: narrowed from "every legacy_rebook item, regardless of
  // status/quote_sent_at" to "only a genuine unsent DRAFT" (see
  // isHiddenLegacyRebookQuote) — a sent/viewed/approved/booked Neighbor quote
  // now behaves like a normal quote here too, matching quotetool.ts's ingest-
  // time guard rather than the old, broader hide-everything rule.
  // #183 BUG 1: same fix as listOpenItems — derive+filter through
  // quoteIdPrefix/isUuid so a suffixed `:color-request` id can't poison the
  // `.in()` lookup (Postgres 22P02 on a malformed uuid), and check the lookup
  // error instead of silently swallowing it.
  if (EXCLUDE_LEGACY_REBOOK_FROM_INBOX) {
    const quotetoolIds = [
      ...new Set(
        rows
          .filter((r) => r.source === 'quotetool')
          .map((r) => quoteIdPrefix(String(r.external_id)))
          .filter(isUuid),
      ),
    ];
    if (quotetoolIds.length) {
      const hiddenQuoteIds = await fetchHiddenLegacyRebookQuoteIds(sb, quotetoolIds);
      rows = excludeLegacyRebookItems(rows as { source: unknown; external_id: unknown }[], hiddenQuoteIds);
    }
  }

  const items = (rows as unknown as Record<string, unknown>[]).map((row): EscalatableItem => {
    const c = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
    return {
      id: String(row.id),
      lastMessageAt: (row.last_message_at as string | null) ?? null,
      notifiedLevels: (row.notified_levels as number[] | null) ?? [],
      escalationLevel: (row.escalation_level as number | null) ?? 0,
      preview: (row.preview as string | null) ?? null,
      contact: c ? { displayName: (c.display_name as string | null) ?? null } : null,
    };
  });
  return { ok: true, items };
}

export async function setEscalation(
  itemId: string,
  fields: { escalationLevel: number; notifiedLevels: number[] },
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb
    .from('inbox_items')
    .update({ escalation_level: fields.escalationLevel, notified_levels: fields.notifiedLevels })
    .eq('id', itemId);
  await sb.from('dashboard_activity').insert({ actor: 'system', action: 'escalated', inbox_item_id: itemId, detail: fields });
}

/** Heartbeat for the escalation watchdog (sync_cursors.<source>.last_run_at). */
export async function recordSyncRun(source: string, status: 'ok' | 'error', error?: string): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb
    .from('sync_cursors')
    .upsert(
      { source, last_run_at: new Date().toISOString(), last_status: status, last_error: error ?? null },
      { onConflict: 'source' },
    );
}

export async function getSyncCursor(
  source: string,
): Promise<{ lastRunAt: string | null; cursor: Record<string, unknown> | null }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { lastRunAt: null, cursor: null };
  const { data } = await sb.from('sync_cursors').select('last_run_at, cursor').eq('source', source).maybeSingle();
  if (!data) return { lastRunAt: null, cursor: null };
  const row = data as Record<string, unknown>;
  return {
    lastRunAt: (row.last_run_at as string | null) ?? null,
    cursor: (row.cursor as Record<string, unknown> | null) ?? null,
  };
}

export async function setSyncCursor(source: string, cursor: Record<string, unknown>): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb.from('sync_cursors').upsert({ source, cursor }, { onConflict: 'source' });
}

// ─── Follow-ups ─────────────────────────────────────────────────────────────

/** Create a follow-up for an inbox item once (idempotent on inbox_item_id+reason
 *  while a PENDING one exists). WT-43: scoped to status='pending' — an item's id
 *  is stable, so a prior follow-up marked 'done' must NOT block a fresh nudge
 *  (e.g. a second "quote sent, no reply" cycle weeks later on the same
 *  still-unapproved item). Without the status scope, clicking Done once
 *  permanently killed the nudge for that item+reason forever.
 *
 *  Returns 'created' on an actual write, 'skipped' for a legitimate no-op (a
 *  pending row already exists, or the anchored item is already resolved —
 *  see the churn-gate comment below), or 'failed' when a read errored/threw.
 *  #310 fix-round: a plain boolean collapsed 'skipped' and 'failed' into the
 *  same `false`, so the caller (runQuoteToolReconcile, sync.ts) had no way to
 *  count a degraded tick separately from an ordinary one — see its
 *  `followUpErrors` field. */
export async function ensureFollowUp(input: {
  inboxItemId: string;
  contactId: string | null;
  reason: string;
  sentAt: Date;
  // WT-44: cadence override so the "Follow-up reminder (days)" setting can
  // drive when the strip nudge is due; falls back to DEFAULT_FOLLOW_UP_DAYS.
  afterDays?: number;
}): Promise<'created' | 'skipped' | 'failed'> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 'skipped';
  // #310: this whole body used to run unguarded — a throw from either read
  // below (or the upsert) escaped straight into runQuoteToolReconcile's single
  // top-level try/catch (sync.ts), aborting the WHOLE reconcile tick (zeroing
  // every counter, skipping both tail sweeps) over one bad read on one quote.
  // Wrapped + each read's own {error} checked, mirroring this file's other
  // best-effort I/O (closeQuoteInboxNoise, closeFollowUpsForResolvedItem):
  // fail open by skipping just this item, log, and let the next tick (5 min
  // later) retry — never let one item's read failure take down the batch.
  try {
    const { data, error: pendingErr } = await sb
      .from('follow_ups')
      .select('id')
      .eq('inbox_item_id', input.inboxItemId)
      .eq('reason', input.reason)
      .eq('status', 'pending')
      .limit(1);
    if (pendingErr) {
      console.error('[inbox] ensureFollowUp: pending lookup failed (skipping item):', pendingErr.message);
      return 'failed';
    }
    if (data && data.length > 0) return 'skipped'; // a pending one already exists — don't duplicate

    // #252 churn gate: quoteFollowUpDecision (quotetool.ts) derives kind:'create'
    // from the QUOTE's own fields alone — never the anchored item's status — so
    // the reconcile asks for a follow-up on EVERY tick for any sent-but-unapproved,
    // non-dead quote. Once that item is resolved and its nag auto-closed
    // (closeFollowUpsForResolvedItem), the upsert below would flip the 'done' row
    // straight back to 'pending' every 5 minutes forever; sweepResolvedItemFollowUps
    // re-closes it later in the same tick, so the end-of-tick state looks right and
    // nothing fails — the only visible symptoms are permanent write churn and an
    // inflated followUpsCreated counter. Same class as the #230(b) gate on the
    // suppress branch, which exists because decision.kind is recomputed per tick.
    // Costs one read, and only on the path that would otherwise write: the
    // early-return above already covers the steady state.
    const { data: item, error: itemErr } = await sb.from('inbox_items').select('status').eq('id', input.inboxItemId).maybeSingle();
    if (itemErr) {
      console.error('[inbox] ensureFollowUp: item status lookup failed (skipping item):', itemErr.message);
      return 'failed';
    }
    const itemStatus = (item as { status: string } | null)?.status ?? null;
    if (itemStatus === 'completed' || itemStatus === 'dismissed') return 'skipped';
    const fu = quoteSentNoReplyFollowUp({ contactId: input.contactId, inboxItemId: input.inboxItemId, sentAt: input.sentAt, afterDays: input.afterDays });
    // WT-43: UPSERT, not insert. The table has `unique (inbox_item_id, reason)`
    // with no status predicate, so once a prior nudge is marked 'done' a plain
    // insert 23505s (swallowed by supabase-js into {error}) and the nudge never
    // re-arms. Conflict-target the constraint so a 'done' row is flipped back to
    // 'pending' with a fresh due_at (and no pending row exists here, guaranteed by
    // the early-return above, so this never resets a live pending nudge).
    await sb.from('follow_ups').upsert(
      {
        contact_id: fu.contactId,
        inbox_item_id: fu.inboxItemId,
        due_at: fu.dueAt.toISOString(),
        reason: fu.reason,
        status: fu.status,
        assigned_to: fu.assignedTo,
        created_by: fu.createdBy,
      },
      { onConflict: 'inbox_item_id,reason' },
    );
    return 'created';
  } catch (e) {
    console.error('[inbox] ensureFollowUp failed (skipping item):', e);
    return 'failed';
  }
}

/** Mark a pending follow-up for an item done (e.g. the quote got approved).
 *  Returns how many rows were closed (0 when there was none) so callers can keep
 *  an accurate metric. */
export async function closeFollowUp(inboxItemId: string, reason: string): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;
  const { data } = await sb
    .from('follow_ups')
    .update({ status: 'done' })
    .eq('inbox_item_id', inboxItemId)
    .eq('reason', reason)
    .eq('status', 'pending')
    .select('id');
  return data ? data.length : 0;
}

/**
 * Close EVERY pending follow-up anchored to `itemId`, called once that item
 * reaches a terminal state (completed/dismissed) — the conversation is over,
 * so any nag still chasing it is stale (#252 follow-up-autoclose). Unlike
 * closeFollowUp/sweepOrphanedFollowUps, this does NOT scope to a `reason`:
 * FOLLOWUP_REASONS has exactly one member today (quote_sent_no_reply), and
 * there is no manual-follow-up-creation path that anchors a different reason
 * to an inbox item, but the item's own terminal-ness invalidates ANY follow-up
 * anchored to it — a future new reason should die with the item too, not slip
 * through a reason-scoped filter. A 'handled' item is NOT terminal (that's the
 * normal "quote sent, awaiting reply" case the nag exists to chase) — callers
 * must only invoke this on the completed/dismissed transition itself.
 *
 * Best-effort — never throws, so a close failure never fails the caller's
 * completion/dismissal (mirrors closeQuoteInboxNoise's non-fatal contract).
 * Returns how many rows were closed (0 on no-op or a swallowed failure).
 *
 * `terminalStatus` is the status that triggered the close; it is recorded on the
 * audit row so /inbox/activity can say WHY the nag went away (see below).
 */
export async function closeFollowUpsForResolvedItem(
  itemId: string,
  terminalStatus: 'completed' | 'dismissed',
): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;
  try {
    const { data, error } = await sb
      .from('follow_ups')
      .update({ status: 'done' })
      .eq('inbox_item_id', itemId)
      .eq('status', 'pending')
      .select('id');
    if (error) {
      console.warn('[inbox] follow-up close on resolve failed (non-fatal):', error.message);
      return 0;
    }
    const closedIds = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (closedIds.length) await recordAutoClosedFollowUps(itemId, closedIds, terminalStatus);
    return closedIds.length;
  } catch (e) {
    console.warn('[inbox] follow-up close on resolve failed (non-fatal):', e);
    return 0;
  }
}

/** #252, same reasoning as #230(a)'s recordSuppressedFollowUp directly below:
 *  a follow-up closed by the system rather than by an operator clicking Done
 *  would otherwise leave NO human-visible trace — it just disappears off the
 *  "due today" strip, and follow_ups has no column recording who closed a row.
 *  One activity row per closed follow-up, carrying the status that triggered it,
 *  so /inbox/activity can answer "why did that nag go away". Best-effort and
 *  deliberately swallowed: an audit-write failure must never turn a successful
 *  close into a reported failure, nor fail the caller's completion/dismissal. */
async function recordAutoClosedFollowUps(
  inboxItemId: string,
  followUpIds: string[],
  terminalStatus: 'completed' | 'dismissed',
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  try {
    await sb.from('dashboard_activity').insert(
      followUpIds.map((followUpId) => ({
        actor: 'system',
        action: 'followup_autoclosed',
        inbox_item_id: inboxItemId,
        detail: { followUpId, terminalStatus },
      })),
    );
  } catch (e) {
    console.warn('[inbox] follow-up auto-close audit write failed (non-fatal):', e);
  }
}

/** #230(a): the ONLY human-visible trace of a #220 internal-domain follow-up
 *  suppression used to be a console.warn in a Vercel log stream nobody opens —
 *  a real customer misclassified as internal would be silently dropped with no
 *  way to notice. Logs it to dashboard_activity instead, which the /inbox
 *  /activity page's ActivityLog already renders (it excludes only 'ingested'/
 *  'escalated' — see listActivity's own doc). Best-effort, mirrors the other
 *  system-actor activity writes (e.g. setEscalation's 'escalated' insert) —
 *  never blocks the reconcile loop on a logging failure. */
export async function recordSuppressedFollowUp(inboxItemId: string, detail: Record<string, unknown>): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb.from('dashboard_activity').insert({ actor: 'system', action: 'followup_suppressed', inbox_item_id: inboxItemId, detail });
}

// ─── View-only toggle-ON inbox cleanup (#187a) ──────────────────────────────
// queries.ts's dashboard chokepoint (`.eq('view_only', false)`) drops a
// flipped-view-only quote out of the reconcile feed entirely, so
// runQuoteToolReconcile (sync.ts) never visits it again — a PENDING
// quote_sent_no_reply follow-up on it would sit due-forever. Close it up
// front instead, at the moment staff flips the flag ON.

/**
 * Close the PENDING "sent, no reply" follow-up + resolve the un-resolved
 * quotetool inbox item for `quoteId` (its bare-uuid external_id — the "quote
 * sent" touch), called right after a view-only toggle-ON write succeeds.
 *
 * Deliberately does NOT touch a `${quoteId}:color-request` item (#187 review
 * #660 FIX 1): the colour-change-request flow is INTENTIONALLY live on a
 * view-only portal — color-change-request/route.ts is public and ungated on
 * view_only, and ColorRequestPanel (admin quote detail) renders on any
 * pending request regardless of view_only. Completing that item would hide a
 * still-actionable customer ask under a "Quote marked view-only" note that
 * falsely implies staff already handled it.
 *
 * Best-effort — never throws (the toggle write already succeeded; this is
 * cleanup, mirroring apply-color-request's resolveInboxRequest). `operatorId`
 * must be a real auth.users uuid, or null — inbox_items.handled_by is a
 * nullable `uuid` column ("NULL when system auto-resolved" per its schema
 * comment); never pass a display name/email string here.
 */
export async function closeQuoteInboxNoise(quoteId: string, operatorId: string | null): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  try {
    const { data: items, error: itemsErr } = await sb
      .from('inbox_items')
      .select('id, status, followed_up_at')
      .eq('source', 'quotetool')
      .eq('external_id', quoteId);
    if (itemsErr) {
      console.warn('[inbox] view-only cleanup: item lookup failed (non-fatal):', itemsErr.message);
      return;
    }
    const rows = (items ?? []) as { id: string; status: string; followed_up_at: string | null }[];
    if (!rows.length) return;
    const itemIds = rows.map((r) => r.id);

    // quote_sent_no_reply follow-ups only ever anchor on this bare-uuid item
    // (ensureFollowUp is always called with the "quote touch" item's id, never
    // a color-request notification's), so nothing further to filter here.
    const { error: fuErr } = await sb
      .from('follow_ups')
      .update({ status: 'done' })
      .in('inbox_item_id', itemIds)
      .eq('reason', FOLLOWUP_REASONS.quoteSentNoReply)
      .eq('status', 'pending');
    if (fuErr) {
      console.warn('[inbox] view-only cleanup: follow-up close failed (non-fatal):', fuErr.message);
    }

    // Only resolve items that aren't already resolved — never re-stamp a
    // dismissed/completed item's handled_at/handled_by.
    const openRows = rows.filter((r) => r.status !== 'completed' && r.status !== 'dismissed');
    if (!openRows.length) return;
    const openIds = openRows.map((r) => r.id);
    const now = new Date().toISOString();
    const { error: itemUpdateErr } = await sb
      .from('inbox_items')
      .update({ status: 'completed', handled_by: operatorId, handled_at: now })
      .in('id', openIds);
    if (itemUpdateErr) {
      console.warn('[inbox] view-only cleanup: item resolve failed (non-fatal):', itemUpdateErr.message);
      return;
    }
    // #187 review FIX 4 (#660): carry each item's PRIOR status/follow state
    // into detail.from, mirroring markItemCompleted's priorStateOf capture —
    // a later Reverse calls inverseOf('completed', detail.from) (see
    // lifecycle.ts + this file's applyReverse below), which reads
    // detail.from.status specifically and falls back to 'handled' when it's
    // missing or shaped wrong (a bare string has no `.status`). Without this,
    // Reverse always restored to 'handled' regardless of the item's real
    // prior bucket.
    await sb.from('dashboard_activity').insert(
      openRows.map((r) => ({
        actor: operatorId,
        action: 'completed',
        inbox_item_id: r.id,
        detail: { note: 'Quote marked view-only', from: { status: r.status, wasFollowed: !!r.followed_up_at } },
      })),
    );
  } catch (e) {
    console.warn('[inbox] view-only cleanup failed (non-fatal):', e);
  }
}

// ─── Orphaned + view-only follow-up sweep (#183 BUG 3, #187 review FIX 2) ───
// runQuoteToolReconcile's main loop (sync.ts) only walks quotes returned by
// listQuotesForDashboard — a quote row that's been DELETED entirely is never
// visited there, so a pending quote_sent_no_reply follow-up anchored to it can
// never be closed by the main loop and sits overdue-pending forever, showing
// in the "due today" strip every day. This sweep finds and closes those.
//
// #187 review FIX 2 (#660): the SAME class of problem hits a quote that's
// merely flagged view_only (not deleted). closeQuoteInboxNoise closes the
// follow-up instantly on the toggle-ON write, but runQuoteToolReconcile
// snapshots ALL quotes ONCE up front (listQuotesForDashboard(500)) and then
// loops over that snapshot for seconds — if the toggle lands mid-pass, the
// loop is still holding the quote's PRE-toggle row, so quoteFollowUpDecision
// still reads it as sent-but-unapproved and ensureFollowUp's WT-43 upsert
// flips our just-closed 'done' row straight back to 'pending'. Because the
// quote is now view_only, it's excluded from every FUTURE reconcile's
// snapshot too (queries.ts's chokepoint) — nothing else would ever revisit
// it, so the resurrected follow-up would sit pending forever. This sweep
// closes those too, self-healing the race within one reconcile pass.

/** Pure decision: which of the given inbox-item ids (from pending
 *  quote_sent_no_reply follow-ups) are orphaned — their underlying quote no
 *  longer exists. `inboxItems` maps an inbox item id to its external_id (the
 *  quote id, optionally `:color-request`-suffixed — quoteIdPrefix strips it,
 *  same derivation as BUG 1); `existingQuoteIds` is the set of quote ids that
 *  DO still exist. A follow-up whose inbox item can't be resolved at all is
 *  left alone (not this sweep's job — it has nothing to confirm dead). No
 *  I/O — unit-testable on its own (store.test.ts). */
export function findOrphanedFollowUpItems(
  followUps: readonly { inboxItemId: string | null }[],
  inboxItems: readonly { id: string; externalId: string }[],
  existingQuoteIds: ReadonlySet<string>,
): string[] {
  const externalIdByItemId = new Map(inboxItems.map((i) => [i.id, i.externalId]));
  const orphaned = new Set<string>();
  for (const fu of followUps) {
    if (!fu.inboxItemId) continue;
    const externalId = externalIdByItemId.get(fu.inboxItemId);
    if (externalId == null) continue;
    if (!existingQuoteIds.has(quoteIdPrefix(externalId))) orphaned.add(fu.inboxItemId);
  }
  return [...orphaned];
}

/** Pure decision: which of the given inbox-item ids (from pending
 *  quote_sent_no_reply follow-ups) anchor a quote that's now flagged
 *  view_only=true (#187 review FIX 2, #660) — the reconcile-race backstop
 *  described in the section header above. `viewOnlyQuoteIds` is the set of
 *  quote ids (among the follow-ups' candidate quotes) that currently have
 *  view_only=true. Mirrors findOrphanedFollowUpItems's shape exactly (same
 *  externalId→item map, same quoteIdPrefix derivation), just testing set
 *  MEMBERSHIP instead of set ABSENCE. No I/O — unit-testable on its own. */
export function findViewOnlyFollowUpItems(
  followUps: readonly { inboxItemId: string | null }[],
  inboxItems: readonly { id: string; externalId: string }[],
  viewOnlyQuoteIds: ReadonlySet<string>,
): string[] {
  const externalIdByItemId = new Map(inboxItems.map((i) => [i.id, i.externalId]));
  const frozen = new Set<string>();
  for (const fu of followUps) {
    if (!fu.inboxItemId) continue;
    const externalId = externalIdByItemId.get(fu.inboxItemId);
    if (externalId == null) continue;
    if (viewOnlyQuoteIds.has(quoteIdPrefix(externalId))) frozen.add(fu.inboxItemId);
  }
  return [...frozen];
}

/**
 * Close pending follow-ups (of `reason`) whose quotetool inbox item's
 * underlying quote row EITHER no longer exists OR is now flagged
 * view_only=true (#187 review FIX 2, #660 — the reconcile-race backstop). One
 * batched query each way (mirrors the #157/#183-BUG-1 lookup-batching style):
 * follow_ups → inbox_items → quotes existence+view_only →
 * findOrphanedFollowUpItems + findViewOnlyFollowUpItems → closeFollowUp per
 * match. Fails open (closes nothing) on a lookup error rather than guessing.
 * Returns how many follow-ups were closed.
 */
export async function sweepOrphanedFollowUps(reason: string): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;

  const { data: pending, error: pendingErr } = await sb
    .from('follow_ups')
    .select('id, inbox_item_id')
    .eq('reason', reason)
    .eq('status', 'pending')
    // #310: was unbounded — PostgREST silently truncates at its 1000-row
    // default, so past that this sweep would stop covering rows with no
    // error and no signal. follow_ups holds 57 today; 5000 mirrors the cap
    // already used a few times in this file (getReopenCounts' distinct(),
    // the returning-contact tally above) for the same "generous headroom,
    // bound the pathological case" reasoning.
    // Ordered so the capped subset is DETERMINISTIC — without an order, a
    // table past the cap could nondeterministically flip which rows this
    // sweep covers on each run (same reasoning as the #185 precedent above).
    .order('id', { ascending: true })
    .limit(5000);
  if (pendingErr) {
    console.error('[inbox] orphan follow-up sweep: pending lookup failed:', pendingErr.message);
    return 0;
  }
  const followUpRows = (pending ?? []) as { id: string; inbox_item_id: string | null }[];
  const itemIds = [...new Set(followUpRows.map((r) => r.inbox_item_id).filter((id): id is string => !!id))];
  if (!itemIds.length) return 0;

  const { data: items, error: itemsErr } = await sb.from('inbox_items').select('id, external_id, source').in('id', itemIds);
  if (itemsErr) {
    console.error('[inbox] orphan follow-up sweep: inbox_items lookup failed:', itemsErr.message);
    return 0;
  }
  // Same source==='quotetool' guard as the two exclusion call sites above:
  // quote_sent_no_reply rows only ever anchor on quotetool items today, but
  // that's an implicit invariant — enforce it here so a future reason reuse or
  // hand-inserted row can never mis-derive a quote id from another source's
  // external_id shape (review hardening, #183).
  const itemRows = ((items ?? []) as { id: string; external_id: string; source: string }[])
    .filter((r) => r.source === 'quotetool')
    .map((r) => ({
      id: r.id,
      externalId: r.external_id,
    }));

  const candidateQuoteIds = [...new Set(itemRows.map((r) => quoteIdPrefix(r.externalId)).filter(isUuid))];
  let existingQuoteIds = new Set<string>();
  let viewOnlyQuoteIds = new Set<string>();
  if (candidateQuoteIds.length) {
    const { data: quoteRows, error: quoteErr } = await sb
      .from('quotes')
      .select('id, view_only')
      .in('id', candidateQuoteIds);
    if (quoteErr) {
      console.error('[inbox] orphan follow-up sweep: quotes lookup failed:', quoteErr.message);
      return 0;
    }
    const rows = (quoteRows ?? []) as { id: string; view_only: boolean | null }[];
    existingQuoteIds = new Set(rows.map((q) => String(q.id)));
    viewOnlyQuoteIds = new Set(rows.filter((q) => q.view_only === true).map((q) => String(q.id)));
  }

  const followUpKeys = followUpRows.map((r) => ({ inboxItemId: r.inbox_item_id }));
  const orphanedItemIds = findOrphanedFollowUpItems(followUpKeys, itemRows, existingQuoteIds);
  const viewOnlyItemIds = findViewOnlyFollowUpItems(followUpKeys, itemRows, viewOnlyQuoteIds);
  const itemIdsToClose = new Set([...orphanedItemIds, ...viewOnlyItemIds]);

  let closed = 0;
  for (const itemId of itemIdsToClose) {
    closed += await closeFollowUp(itemId, reason);
  }
  return closed;
}

/**
 * Self-heal backlog for #252 follow-up-autoclose: markItemCompleted/dismissItem
 * only close a follow-up going FORWARD from the moment they run — a follow-up
 * left pending from BEFORE that fix (its item already sitting completed/
 * dismissed) would otherwise nag "due today" forever. One batched pass per
 * reconcile closes those: all pending follow-ups -> their anchored items'
 * current status -> closeFollowUpsForResolvedItem for every item already in a
 * terminal (completed/dismissed) state. Unscoped by source or reason (see
 * closeFollowUpsForResolvedItem's doc) — a 'handled' item is untouched, same
 * as the write-site fix. Fails open (closes nothing) on a lookup error rather
 * than guessing, mirroring sweepOrphanedFollowUps. Returns how many follow-ups
 * were closed.
 */
export async function sweepResolvedItemFollowUps(): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;

  // #310: was unbounded — same PostgREST 1000-row default-truncation risk as
  // sweepOrphanedFollowUps' pending lookup above (sibling-parity fix, one pass).
  // Ordered so the capped subset is DETERMINISTIC — same #185 precedent cited
  // there.
  const { data: pending, error: pendingErr } = await sb
    .from('follow_ups')
    .select('id, inbox_item_id')
    .eq('status', 'pending')
    .order('id', { ascending: true })
    .limit(5000);
  if (pendingErr) {
    console.error('[inbox] resolved-item follow-up sweep: pending lookup failed:', pendingErr.message);
    return 0;
  }
  const followUpRows = (pending ?? []) as { id: string; inbox_item_id: string | null }[];
  const itemIds = [...new Set(followUpRows.map((r) => r.inbox_item_id).filter((id): id is string => !!id))];
  if (!itemIds.length) return 0;

  const { data: items, error: itemsErr } = await sb.from('inbox_items').select('id, status').in('id', itemIds);
  if (itemsErr) {
    console.error('[inbox] resolved-item follow-up sweep: inbox_items lookup failed:', itemsErr.message);
    return 0;
  }
  // Carry each item's own terminal status through, rather than re-reading it in
  // the close — the audit row records WHICH terminal state retired the nag.
  const terminalItems = ((items ?? []) as { id: string; status: string }[]).filter(
    (r): r is { id: string; status: 'completed' | 'dismissed' } => r.status === 'completed' || r.status === 'dismissed',
  );
  if (!terminalItems.length) return 0;

  let closed = 0;
  for (const item of terminalItems) {
    closed += await closeFollowUpsForResolvedItem(item.id, item.status);
  }
  return closed;
}

export type DueFollowUpsResult = { ok: true; items: DueFollowUp[] } | { ok: false; error: string };

/**
 * Pending follow-ups due today or overdue (ET), for the top strip AND (#229)
 * the morning digest's named "overdue follow-ups" detail.
 *
 * #229 FIX 3 (round 3): a round-2 addition here flagged a follow-up as
 * anchored to a hidden "parked-draft" legacy_rebook quote — REMOVED. That
 * state is structurally IMPOSSIBLE: isHiddenLegacyRebookQuote requires
 * deriveStatus === 'draft', which requires quote_sent_at to be NULL, but
 * quoteFollowUpDecision (quotetool.ts) only ever returns `{ kind: 'create' }`
 * — the one decision that reaches ensureFollowUp — when quote_sent_at IS SET.
 * Mutually exclusive by construction, confirmed empirically against prod (28
 * pending follow-ups, all with quote_sent_at set, zero parked drafts; the 9
 * that ARE legacy_rebook all evaluate false). The flag was always false, so
 * the embed + batch lookup below were dead weight on every /inbox load. A
 * legacy_rebook-anchored follow-up here is for a SENT Neighbor quote (see
 * TRACKS_OUTBOUND_FIRST_OBSERVATION's #222 doc above) — a real customer
 * genuinely owed a reply, not a parked draft — so it is NOT filtered here or
 * by any caller; whether to label/distinguish it by name is a product call,
 * not a code default.
 */
export async function listDueFollowUps(now: Date): Promise<DueFollowUpsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('follow_ups')
    .select('id, reason, due_at, dashboard_contacts ( display_name, primary_phone, primary_email )')
    .eq('status', 'pending')
    .order('due_at', { ascending: true })
    .limit(100);
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as unknown as Record<string, unknown>[])
    .filter((r) => {
      const d = r.due_at as string | null;
      return d ? isDueToday(new Date(d), now) : false;
    })
    .map((r): DueFollowUp => {
      const c = (r.dashboard_contacts as Record<string, unknown> | null) ?? null;
      return {
        id: String(r.id),
        reason: r.reason as string,
        dueAt: r.due_at as string,
        contactName: (c?.display_name as string | null) ?? null,
        contactPhone: (c?.primary_phone as string | null) ?? null,
        contactEmail: (c?.primary_email as string | null) ?? null,
      };
    });
  return { ok: true, items };
}

/** `operatorId` must be a real auth.users uuid, or null — mirrors
 *  markItemHandledLocal's doc comment / the sibling-guard-parity convention:
 *  the route's fallback is `operator?.id ?? null`, never the literal string
 *  'system', so this never has to launder a non-uuid sentinel into a
 *  uuid-typed column if a future change (e.g. coupling this to an
 *  inbox_items.handled_by write) reuses operatorId that way. dashboard_activity
 *  .actor stays a free-text column (schema comment: "auth.users id (as text)
 *  or 'system'"), so a null operator still logs as the literal 'system' there. */
export async function markFollowUpDone(id: string, operatorId: string | null): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { error } = await sb.from('follow_ups').update({ status: 'done' }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId ?? 'system', action: 'handled', detail: { followUpId: id } });
  return { ok: true };
}

// ─── Response-time / SLA analytics ──────────────────────────────────────────

const METRICS_ROW_CAP = 2000;
export type MetricsResult =
  | { ok: true; items: MetricItem[]; truncated: boolean }
  | { ok: false; error: string };

/** All-time items for analytics (capped at METRICS_ROW_CAP, newest first by
 *  last_message_at). `truncated` is true when the cap was hit, so the UI can say
 *  the stats are based on the most recent sample rather than under-reporting.
 *  The component windows down to 90/30 days client-side. */
export async function listItemsForMetrics(): Promise<MetricsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .select('status, last_message_at, last_inbound_at, handled_at, handled_by, source, created_at, direction')
    .order('last_message_at', { ascending: false })
    .limit(METRICS_ROW_CAP);
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((r): MetricItem => ({
    status: r.status as string,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string) : null,
    lastInboundAt: r.last_inbound_at ? new Date(r.last_inbound_at as string) : null,
    handledAt: r.handled_at ? new Date(r.handled_at as string) : null,
    handledBy: (r.handled_by as string | null) ?? null,
    source: r.source as string,
    createdAt: r.created_at ? new Date(r.created_at as string) : null,
    // #252 slice F fix round: needed by responseMetrics.ts's hadNoInboundLeg
    // to distinguish an outbound-born item from a genuine legacy row.
    direction: (r.direction as string | null) ?? null,
  }));
  return { ok: true, items, truncated: items.length >= METRICS_ROW_CAP };
}

/** operator_id → display label (name, falling back to email) for every operator
 *  account, so `handled_by` UUIDs (PS-E1) can be shown as readable names on the
 *  Response-time "By rep" list instead of raw auth UUIDs. Best-effort: an admin-
 *  API failure returns an empty map rather than breaking the analytics render —
 *  the caller falls back to the raw id via responseMetrics' withOperatorLabels. */
export async function getOperatorLabels(): Promise<Map<string, string>> {
  const sb = getSupabaseServiceClient();
  if (!sb) return new Map();
  try {
    const accounts = await listOperatorAccounts(sb);
    return new Map(accounts.map((a) => [a.id, a.name ?? a.email ?? a.id]));
  } catch (e) {
    console.warn('[dashboard/inbox/store] getOperatorLabels failed (continuing with raw ids):', e);
    return new Map();
  }
}

/** Reopen-rate inputs: DISTINCT inbox_items handled vs reopened, per window
 *  (all-time / 90d / 30d). Distinct (not per-event) so a re-handled or re-reopened
 *  item counts once — a faithful "of the customers we handled, how many came back". */
export async function getReopenCounts(now: Date): Promise<ReopenCounts> {
  const fresh = (): ReopenCounts => ({
    all: { handled: 0, reopened: 0 },
    '90': { handled: 0, reopened: 0 },
    '30': { handled: 0, reopened: 0 },
  });
  const sb = getSupabaseServiceClient();
  if (!sb) return fresh();
  const windowDays: Record<WindowKey, number | null> = { all: null, '90': 90, '30': 30 };
  const distinct = async (action: 'handled' | 'reopened', sinceIso: string | null): Promise<number> => {
    let q = sb.from('dashboard_activity').select('inbox_item_id').eq('action', action).not('inbox_item_id', 'is', null);
    if (sinceIso) q = q.gte('created_at', sinceIso);
    const { data } = await q.limit(5000);
    return new Set((data ?? []).map((r) => (r as { inbox_item_id: string }).inbox_item_id)).size;
  };
  // #185: the 3 windows x 2 actions were 6 STRICTLY SEQUENTIAL round-trips
  // (one at a time in the for-loop below). Run every window's pair — and every
  // window against every other — concurrently instead; each distinct() call is
  // independent (a plain SELECT + client-side count), so there's nothing to
  // serialize for.
  const out = fresh();
  const keys = ['all', '90', '30'] as WindowKey[];
  const results = await Promise.all(
    keys.map(async (k) => {
      const days = windowDays[k];
      const sinceIso = days == null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
      const [handled, reopened] = await Promise.all([distinct('handled', sinceIso), distinct('reopened', sinceIso)]);
      return [k, { handled, reopened }] as const;
    }),
  );
  for (const [k, v] of results) out[k] = v;
  return out;
}

// ─── Identity merge (Phase 1.5) ─────────────────────────────────────────────

export type DuplicatesResult = { ok: true; pairs: DuplicateContactView[] } | { ok: false; error: string };

/** Contact pairs that share an identifier — the ambiguous dupes to merge by hand. */
export async function listContactDuplicates(): Promise<DuplicatesResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('dashboard_contacts')
    .select('id, ghl_contact_id, emails, phones, display_name')
    .limit(1000);
  if (error) return { ok: false, error: error.message };
  const contacts = ((data ?? []) as unknown as Record<string, unknown>[]).map(toStoredContact);
  const pairs = findDuplicatePairs(contacts).map((p): DuplicateContactView => ({
    on: p.on,
    a: { id: p.a.id, name: p.a.displayName, email: p.a.emails[0] ?? null, phone: p.a.phones[0] ?? null },
    b: { id: p.b.id, name: p.b.displayName, email: p.b.emails[0] ?? null, phone: p.b.phones[0] ?? null },
  }));
  return { ok: true, pairs };
}

/**
 * Merge `secondaryId` into `primaryId`: union identifiers onto the primary,
 * repoint its items + follow-ups, then delete the secondary. Order matters —
 * repoint BEFORE delete (inbox_items.contact_id is ON DELETE CASCADE), and update
 * the primary's ghl_contact_id AFTER deleting the secondary (the column is UNIQUE,
 * so both rows can't hold it at once).
 */
export async function mergeContactsById(
  primaryId: string,
  secondaryId: string,
  operatorId: string,
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  if (primaryId === secondaryId) return { ok: false, error: 'Cannot merge a contact into itself' };

  const { data, error } = await sb
    .from('dashboard_contacts')
    .select('id, ghl_contact_id, emails, phones, display_name')
    .in('id', [primaryId, secondaryId]);
  if (error) return { ok: false, error: error.message };
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(toStoredContact);
  const primary = rows.find((r) => r.id === primaryId);
  const secondary = rows.find((r) => r.id === secondaryId);
  if (!primary || !secondary) return { ok: false, error: 'Both contacts must exist' };
  const merged = mergeContacts(primary, secondary);

  // 1. Repoint the secondary's items + follow-ups onto the primary (BEFORE delete).
  //    MUST check these: if a repoint fails and we still delete the secondary, its
  //    ON DELETE CASCADE would wipe the un-repointed items/follow-ups (lost history).
  const { error: itemsErr } = await sb.from('inbox_items').update({ contact_id: primaryId }).eq('contact_id', secondaryId);
  if (itemsErr) return { ok: false, error: itemsErr.message };
  const { error: fuErr } = await sb.from('follow_ups').update({ contact_id: primaryId }).eq('contact_id', secondaryId);
  if (fuErr) return { ok: false, error: fuErr.message };

  // 2. Delete the secondary (frees its UNIQUE ghl_contact_id). Not transactional:
  //    a failure on the primary update below leaves the primary with its OLD
  //    identifiers — no data loss, and a re-run merges cleanly. (A Postgres RPC
  //    could make the whole sequence atomic if this ever matters.)
  const { error: delErr } = await sb.from('dashboard_contacts').delete().eq('id', secondaryId);
  if (delErr) return { ok: false, error: delErr.message };

  // 3. Now safe to write the merged identifiers onto the primary.
  const { error: upErr } = await sb
    .from('dashboard_contacts')
    .update({
      ghl_contact_id: merged.ghlContactId,
      emails: merged.emails,
      phones: merged.phones,
      display_name: merged.displayName,
      primary_email: merged.emails[0] ?? null,
      primary_phone: merged.phones[0] ?? null,
    })
    .eq('id', primaryId);
  if (upErr) return { ok: false, error: upErr.message };

  await sb
    .from('dashboard_activity')
    .insert({ actor: operatorId, action: 'merged', contact_id: primaryId, detail: { mergedFrom: secondaryId } });
  return { ok: true };
}

// ─── In-Works + Completed buckets ───────────────────────────────────────────

export type InWorksItem = {
  id: string;
  source: InboxSource;
  channel: string | null;
  preview: string | null;
  customerName: string | null;
  lastActivityAt: string | null;
  // #307: null for every 'awaiting' row (the rule set below only evaluates the
  // 'handled' bucket) and for a 'handled' row where none of the three signals
  // fire. Non-null is the single displayed reason — see needsLookReason's own
  // doc comment for why only one shows when a row trips more than one rule.
  needsLookReason: string | null;
};
export type InWorksResult =
  | {
      ok: true;
      awaiting: InWorksItem[];
      handled: InWorksItem[];
      // #307 review fix 2: true when either of the two needsLookReason evidence
      // lookups (quote status, pending follow-up) failed and fell back to an
      // empty result — meaning some 'handled' row may be missing its reason
      // and reads as settled when the evidence for that couldn't be checked.
      evidenceIncomplete: boolean;
    }
  | { ok: false; error: string };

const IN_WORKS_SELECT =
  'id, source, channel, preview, followed_up_at, handled_at, status, dashboard_contacts ( display_name )';

// #307: the 'handled' bucket alone also needs external_id (to derive the
// backing quote id, quoteIdPrefix) and direction (rule b) to compute "Needs a
// look" — the 'awaiting' bucket's query stays on the narrower IN_WORKS_SELECT
// since none of the three rules apply there (out of scope for this change).
const IN_WORKS_HANDLED_SELECT = IN_WORKS_SELECT + ', external_id, direction';

function mapInWorksRow(
  rows: unknown[],
  tsKey: 'followed_up_at' | 'handled_at',
  reasonFor?: (row: Record<string, unknown>) => string | null,
): InWorksItem[] {
  return (rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    const c = (row.dashboard_contacts as { display_name?: string | null } | null) ?? null;
    return {
      id: String(row.id),
      source: row.source as InboxSource,
      channel: (row.channel as string | null) ?? null,
      preview: (row.preview as string | null) ?? null,
      customerName: (c?.display_name as string | null) ?? null,
      lastActivityAt: (row[tsKey] as string | null) ?? null,
      needsLookReason: reasonFor ? reasonFor(row) : null,
    };
  });
}

/**
 * #307: pure "does the evidence contradict Handled" decision for one handled
 * row. Order is the deliberate single-reason priority when a row trips more
 * than one rule — most concrete/actionable evidence wins:
 *   1. quoteStatus unanswered — a real quote is sitting sent-but-not-approved;
 *      the most concrete, money-bearing evidence a "finished" row is wrong.
 *   2. direction === 'inbound' — the customer's message is the newest thing on
 *      the thread. Weaker signal (a call-closed conversation can still read
 *      this way — see the brief's accepted false-positive note), so it only
 *      shows when rule 1 didn't already give a sharper reason.
 *   3. followUpPending — our own follow-up system already flagged this item;
 *      shown last since today's only follow-up reason (quote_sent_no_reply)
 *      usually already surfaces via rule 1 on the same row.
 * Pure — no I/O — so it's directly unit-testable without a DB.
 */
export function needsLookReason(evidence: {
  direction: string | null;
  quoteStatus: QuoteStatus | null;
  followUpPending: boolean;
}): string | null {
  if (evidence.quoteStatus != null && QUOTE_UNANSWERED_STATUSES.has(evidence.quoteStatus)) {
    return 'Quote unanswered';
  }
  if (evidence.direction === 'inbound') {
    return 'They wrote last';
  }
  if (evidence.followUpPending) {
    return 'Follow-up due';
  }
  return null;
}

// #307 rule (a): a quote is "sent but not approved, not dead" when its derived
// status is one of these three. Deliberately derived via deriveStatus (the
// canonical lifecycle read, per its own doc comment) rather than a raw
// `quote_sent_at != null && customer_approved_at == null` column check — a
// booked-but-somehow-missing-customer_approved_at row would otherwise
// misfire here; deriveStatus's deposit_paid_at-wins precedence correctly
// reads that as 'booked' (approved, not flagged) instead. 'changes_requested'
// is included: the quote was sent, is not approved, and is not in the dead
// set (declined/cancelled/abandoned) — it's an active back-and-forth, not a
// finished one.
const QUOTE_UNANSWERED_STATUSES: ReadonlySet<QuoteStatus> = new Set(['sent', 'viewed', 'changes_requested']);

/**
 * #307: batch-fetches the derived QuoteStatus for every id in `quoteIds` in
 * ONE query (mirrors fetchHiddenLegacyRebookQuoteIds's pattern above — never a
 * per-row query in a loop). On a lookup error this still fails OPEN (returns
 * an empty map rather than throwing — a transient read failure must not crash
 * the page), but unlike fetchHiddenLegacyRebookQuoteIds's fail-open (which is
 * SAFE — an empty result there means "hide nothing"), an empty map here is
 * UNSAFE — it means "no handled row reads as quote-unanswered", which can
 * silently under-populate the one list whose entire premise is that evidence
 * must not go missing. `failed` carries that distinction to the caller so
 * listInWorks can surface it instead of only logging it server-side (#307
 * review fix 2).
 */
async function fetchQuoteStatusesById(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteIds: readonly string[],
): Promise<{ statuses: Map<string, QuoteStatus>; failed: boolean }> {
  if (quoteIds.length === 0) return { statuses: new Map(), failed: false };
  const { data, error } = await sb
    .from('quotes')
    .select('id, status, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at')
    .in('id', quoteIds);
  if (error) {
    console.error('[inbox] needs-a-look quote status lookup failed:', error.message);
    return { statuses: new Map(), failed: true };
  }
  const map = new Map<string, QuoteStatus>();
  for (const q of (data ?? []) as {
    id: string;
    status: QuoteStatus | null;
    quote_sent_at: string | null;
    customer_approved_at: string | null;
    deposit_paid_at: string | null;
    viewed_at: string | null;
  }[]) {
    map.set(String(q.id), deriveStatus(q));
  }
  return { statuses: map, failed: false };
}

/**
 * #307 rule (c): batch-fetches which of `itemIds` has at least one still-
 * pending follow_ups row, in ONE query (`.in('inbox_item_id', itemIds)`) —
 * never a per-row query. Same fail-open-but-report-it convention as its
 * sibling above: `failed` tells listInWorks this specific lookup didn't
 * complete, rather than being indistinguishable from "nothing pending".
 */
async function fetchPendingFollowUpItemIds(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  itemIds: readonly string[],
): Promise<{ ids: Set<string>; failed: boolean }> {
  if (itemIds.length === 0) return { ids: new Set(), failed: false };
  const { data, error } = await sb
    .from('follow_ups')
    .select('inbox_item_id')
    .eq('status', 'pending')
    .in('inbox_item_id', itemIds);
  if (error) {
    console.error('[inbox] needs-a-look pending follow-up lookup failed:', error.message);
    return { ids: new Set(), failed: true };
  }
  return {
    ids: new Set(
      ((data ?? []) as { inbox_item_id: string | null }[])
        .map((r) => r.inbox_item_id)
        .filter((v): v is string => !!v),
    ),
    failed: false,
  };
}

/** Two-group In-Works list: items being actively followed up (awaiting) + locally
 *  handled items that aren't yet dismissed or completed (handled). Both sorted
 *  stalest-first so the longest-waiting surface at the top. Every 'handled' row
 *  also carries needsLookReason (#307) — computed from two BATCHED lookups (a
 *  quote-status map + a pending-follow-up set), never a per-row query.
 *  `evidenceIncomplete` (#307 review fix 2) is true when either of those two
 *  lookups failed and fell back to empty — the caller renders that as a
 *  visible note rather than only the server-side console.error already inside
 *  each lookup. */
export async function listInWorks(limit = 200): Promise<InWorksResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  // #185: the two list fetches are independent (different status/followed_up_at
  // predicates on the same table) — no reason for the second to wait on the
  // first's round-trip.
  // (Each base query is bound to a const before applyBucketFilter for the
  // same reason as listOpenItems — see its comment.)
  const awaitingBaseQuery = sb.from('inbox_items').select(IN_WORKS_SELECT);
  const handledBaseQuery = sb.from('inbox_items').select(IN_WORKS_HANDLED_SELECT);
  const [aw, hd] = await Promise.all([
    applyBucketFilter(awaitingBaseQuery, 'awaiting_reply')
      .order('followed_up_at', { ascending: true })
      .limit(limit),
    applyBucketFilter(handledBaseQuery, 'handled')
      .order('handled_at', { ascending: true })
      .limit(limit),
  ]);
  if (aw.error) return { ok: false, error: aw.error.message };
  if (hd.error) return { ok: false, error: hd.error.message };

  const handledRows = (hd.data ?? []) as unknown as Record<string, unknown>[];
  const handledIds = handledRows.map((r) => String(r.id));
  // #307: only a 'quotetool' item's external_id backs a quote id — same gate
  // excludeLegacyRebookItems/fetchHiddenLegacyRebookQuoteIds use above.
  const quotetoolQuoteIds = [
    ...new Set(
      handledRows
        .filter((r) => r.source === 'quotetool')
        .map((r) => quoteIdPrefix(String(r.external_id)))
        .filter(isUuid),
    ),
  ];
  const [quoteStatusResult, pendingFollowUpResult] = await Promise.all([
    fetchQuoteStatusesById(sb, quotetoolQuoteIds),
    fetchPendingFollowUpItemIds(sb, handledIds),
  ]);
  const quoteStatusById = quoteStatusResult.statuses;
  const pendingFollowUpItemIds = pendingFollowUpResult.ids;

  const handled = mapInWorksRow(handledRows, 'handled_at', (row) => {
    const quoteStatus =
      row.source === 'quotetool'
        ? (quoteStatusById.get(quoteIdPrefix(String(row.external_id))) ?? null)
        : null;
    return needsLookReason({
      direction: (row.direction as string | null) ?? null,
      quoteStatus,
      followUpPending: pendingFollowUpItemIds.has(String(row.id)),
    });
  });

  return {
    ok: true,
    awaiting: mapInWorksRow(aw.data ?? [], 'followed_up_at'),
    handled,
    evidenceIncomplete: quoteStatusResult.failed || pendingFollowUpResult.failed,
  };
}

/** Mark an item completed: capture prior state, stamp status + handled fields,
 *  clear followed_up_at, and write a detailed activity log entry. `operatorId`
 *  must be a real auth.users uuid, or null — see markItemHandledLocal's doc
 *  comment; inbox_items.handled_by never accepts a display name/email string.
 *
 * #224 (S35 wrap, staff MED): status-guarded like its siblings
 * markItemHandledLocal/dismissItem — this used to run on `.eq('id', itemId)`
 * ALONE (no guard at all), so a stale tab could silently re-complete (or
 * un-dismiss into 'completed') an item another operator had already resolved,
 * re-attributing handled_by. Only fires FROM the two states completing is a
 * legal forward transition out of: 'unresponded' (InboxList.tsx fires this
 * directly from the open queue) and 'handled' (InWorksSection.tsx fires it
 * from the handled bucket). Positive `.in(...)` match, not a negative
 * `.neq(...)` pair — the repo's positive-seam-gate convention (AGENTS.md
 * Pitfalls): INBOX_STATUSES (types.ts) is a closed 4-value enum today so the
 * two forms are provably identical, but a negative pair fails OPEN on a
 * future 5th status (silently allowed through) while positive fails CLOSED
 * (silently blocked, the safe direction — a blocked completion is visible to
 * the operator via the ok:false path; a wrongly-allowed clobber is not). */
export async function markItemCompleted(
  itemId: string,
  operatorId: string | null,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);
  const { data, error } = await sb
    .from('inbox_items')
    .update({
      status: 'completed',
      followed_up_at: null,
      handled_by: operatorId,
      handled_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', itemId)
    .in('status', ['unresponded', 'handled'])
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Item not found, already completed, or dismissed' };
  await sb.from('dashboard_activity').insert({
    actor: operatorId,
    action: 'completed',
    inbox_item_id: itemId,
    detail: { from },
  });
  // #252 follow-up-autoclose: completed is terminal — the conversation is
  // finished, so any pending nag anchored to it should die with it. Only on
  // the matched (guard passed) path above, never the guarded-out no-op.
  await closeFollowUpsForResolvedItem(itemId, 'completed');
  return { ok: true };
}

// ─── Send-target resolver ────────────────────────────────────────────────────

export type ReplyItem = {
  id: string;
  source: InboxSource;
  channel: string | null;
  externalId: string;
  ghlContactId: string | null;
  customerName: string | null;
  quoteTotal: number | null;
};

/**
 * Resolve the send-target coordinates for a reply action: source, channel,
 * external ID, GHL contact ID, customer name, and quote total. The GHL contact
 * ID and customer name fall back to the raw payload if the contact row is
 * absent — #316 follow-up (review FIX 2): planIngest's noop check now
 * compares raw.highlevel_contact_id/raw.customer_name (see ExistingItem's
 * doc), so a later attach that changes either un-noops the next reconcile
 * tick and refreshes `raw` instead of leaving this fallback frozen stale.
 */
export async function getItemForReply(itemId: string): Promise<ReplyItem | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data } = await sb
    .from('inbox_items')
    .select('id, source, channel, external_id, quote_value, raw, dashboard_contacts ( ghl_contact_id, display_name )')
    .eq('id', itemId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as Record<string, unknown>;
  const c = (row.dashboard_contacts as { ghl_contact_id?: string | null; display_name?: string | null } | null) ?? null;
  const raw = (row.raw as { highlevel_contact_id?: string | null; customer_name?: string | null } | null) ?? null;
  return {
    id: String(row.id),
    source: row.source as InboxSource,
    channel: (row.channel as string | null) ?? null,
    externalId: String(row.external_id),
    ghlContactId: (c?.ghl_contact_id ?? null) ?? (raw?.highlevel_contact_id ?? null),
    customerName: (c?.display_name ?? null) ?? (raw?.customer_name ?? null),
    quoteTotal: (row.quote_value as number | null) ?? null,
  };
}

// ─── Audit-log read ──────────────────────────────────────────────────────────

export type ActivityRow = {
  id: string;
  action: string;
  actor: string | null;
  actorName: string | null;
  itemId: string | null;
  customerName: string | null;
  at: string | null;
  reversible: boolean;
};
export type ActivityResult = { ok: true; rows: ActivityRow[] } | { ok: false; error: string };

const REVERSIBLE_ACTIONS = new Set(['handled', 'followed', 'completed', 'dismissed']);

/** Paginated, newest-first read of dashboard_activity, joined to the customer
 *  display name via inbox_item → dashboard_contact. actorName resolves the raw
 *  `actor` operator UUID to a readable name via getOperatorLabels (task_bbc6490a)
 *  — best-effort; an unknown id or 'system' stays null and ActivityLog's
 *  friendlyActor labels it ('System' / the raw id). */
export async function listActivity(limit = 100): Promise<ActivityResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const [{ data, error }, labels] = await Promise.all([
    sb
      .from('dashboard_activity')
      // Show operator DECISIONS, not the system firehose: 'ingested' (one row per
      // reconcile touch — thousands) and 'escalated' would otherwise bury the
      // handled/dismissed/followed/completed rows (and their Reverse buttons).
      .select('id, action, actor, inbox_item_id, created_at, inbox_items ( dashboard_contacts ( display_name ) )')
      .not('action', 'in', '(ingested,escalated)')
      .order('created_at', { ascending: false })
      .limit(limit),
    getOperatorLabels(),
  ]);
  if (error) return { ok: false, error: error.message };
  const rows: ActivityRow[] = (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    const item = (row.inbox_items as { dashboard_contacts?: { display_name?: string | null } | null } | null) ?? null;
    const actor = (row.actor as string | null) ?? null;
    return {
      id: String(row.id),
      action: String(row.action),
      actor,
      actorName: actor ? (labels.get(actor) ?? null) : null,
      itemId: (row.inbox_item_id as string | null) ?? null,
      customerName: (item?.dashboard_contacts?.display_name as string | null) ?? null,
      at: (row.created_at as string | null) ?? null,
      reversible: REVERSIBLE_ACTIONS.has(String(row.action)),
    };
  });
  return { ok: true, rows };
}

// ─── State reverse ───────────────────────────────────────────────────────────

/** Reverse a prior state-change activity entry back to the item's prior state.
 *  Fetches the activity row, validates it's reversible, applies the inverse via
 *  inverseOf(), un-suppresses the sender if the reversed action was 'dismissed',
 *  and logs a 'reversed' activity row. */
export async function reverseItemState(
  activityId: string,
  operatorId: string,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  const { data: act } = await sb
    .from('dashboard_activity')
    .select('action, inbox_item_id, detail')
    .eq('id', activityId)
    .maybeSingle();
  if (!act) return { ok: false, error: 'Activity entry not found' };

  const a = act as {
    action: string;
    inbox_item_id: string | null;
    detail: { from?: { status?: string; wasFollowed?: boolean } } | null;
  };
  if (!a.inbox_item_id) return { ok: false, error: 'Entry has no item to reverse' };

  const reversible: ReverseAction[] = ['handled', 'followed', 'completed', 'dismissed'];
  if (!reversible.includes(a.action as ReverseAction)) {
    return { ok: false, error: 'This entry cannot be reversed' };
  }
  const action = a.action as ReverseAction;

  // Only reverse if the item is STILL in the state this action produced — otherwise
  // a later action superseded it and reversing now would clobber the newer state
  // (this also de-dupes a double-clicked reverse).
  const { data: cur } = await sb
    .from('inbox_items')
    .select('status, followed_up_at')
    .eq('id', a.inbox_item_id)
    .maybeSingle();
  if (!cur) return { ok: false, error: 'Item not found' };
  const curRow = cur as { status: string; followed_up_at: string | null };
  const stillMatches = action === 'followed' ? curRow.followed_up_at != null : curRow.status === action;
  if (!stillMatches) return { ok: false, error: 'Item state has changed since this action; nothing to reverse' };

  const t = inverseOf(action, a.detail?.from as { status?: InboxStatus; wasFollowed?: boolean } | undefined);

  const upd: Record<string, unknown> = { updated_at: now.toISOString() };
  if (t.status) upd.status = t.status;
  if (t.clearFollowed) upd.followed_up_at = null;
  if (t.setFollowed) upd.followed_up_at = now.toISOString();

  const { error } = await sb.from('inbox_items').update(upd).eq('id', a.inbox_item_id);
  if (error) return { ok: false, error: error.message };

  if (t.unsuppress) {
    const { data: c } = await sb
      .from('inbox_items')
      .select('dashboard_contacts ( primary_email, primary_phone )')
      .eq('id', a.inbox_item_id)
      .maybeSingle();
    const dc = (
      c as { dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null } } | null
    )?.dashboard_contacts;
    if (dc) await removeSuppressedSenders([dc.primary_email ?? null, dc.primary_phone ?? null]);
  }

  await sb.from('dashboard_activity').insert({
    actor: operatorId,
    action: 'reversed',
    inbox_item_id: a.inbox_item_id,
    detail: { reversed_action: a.action },
  });

  return { ok: true };
}
