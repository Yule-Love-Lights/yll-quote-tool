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
  PendingColorRequestItem,
  StoredContact,
} from './types';
import { normalizeEmail, normalizePhone } from './normalize';
import { isUuid } from './validate';
import {
  planCallFollowUps,
  MIN_CALL_SECONDS,
  type CallFollowUpItem,
  type CallFollowUpStamp,
  type ContactCall,
} from './callFollowUp';
import { appendIdentifiers, findDuplicatePairs, mergeContacts, resolveIdentity } from './identity';
import { leadForwardsAnsweredBy } from './leadForward';
import { decideInboxState } from './reducer';
import { isAnsweredByDirection } from './escalation';
import { FOLLOWUP_REASONS, isDueToday, mayReChaseHandled, quoteSentNoReplyFollowUp, reChaseAnchor } from './followups';
import type { MetricItem, WindowKey, ReopenCounts } from './responseMetrics';
import { addSuppressedSenders, removeSuppressedSenders } from './suppression';
import { shouldSuppressOnDismiss } from './dismissSuppression';
import { applyBucketFilter, inverseOf, type ReverseAction } from './lifecycle';
import { listOperatorAccounts } from '@/lib/auth/adminUsers';
import { deriveStatus, isParkedLegacyRebookDraft, type QuoteStatus } from '@/lib/quoteStatus';
// Row 391: the ET day boundary, DST-correct. Lives in the payroll module
// because that is where the two-transition-day bug was found and fixed; it is
// a pure function of an instant, so listDueFollowUps borrows it rather than
// keeping a second copy that could drift out of agreement with it.
import { etMidnightAfter } from '@/lib/opsMidnightClose';

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
 * Clear any open FORWARDED-LEAD row this outbound touch answers (Naldo,
 * 2026-09-01). Best effort: a failure here must never fail the ingest that
 * triggered it, because the touch itself is the thing that matters.
 *
 * Why it lives outside planIngest: that planner is keyed to ONE row, the one
 * carrying this touch's own source + external id. A forwarded lead is a
 * DIFFERENT row on a DIFFERENT channel, and its own channel is a no-reply
 * relay it can never receive an outbound on, so nothing per-row could ever
 * resolve it. See leadForward.ts for the real case that prompted this.
 *
 * Deliberately identity-matched, not contact-matched: see the same file for
 * why a contact-level match would clear a real lead because an unrelated
 * number on a merged contact was dialled.
 */
async function clearLeadForwardsAnsweredBy(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  touch: NormalizedTouch,
  now: Date,
): Promise<{ id: string; from: { status: string; wasFollowed: boolean } }[]> {
  const phones = touch.identity.phones ?? [];
  const emails = touch.identity.emails ?? [];
  if (phones.length === 0 && emails.length === 0) return [];

  // Only OPEN gmail rows can be forwarded leads awaiting an answer. Small by
  // construction (the open list is a handful of rows), so this is one narrow
  // read rather than a join.
  const { data, error } = await sb
    .from('inbox_items')
    .select('id, subject, preview, status, last_message_at, followed_up_at')
    .eq('source', 'gmail')
    .eq('status', 'unresponded');
  if (error || !data) {
    // Say so. A swallowed schema, RLS or transient failure here would make the
    // whole feature permanently inert with no signal anywhere, which looks
    // exactly like "it was never built" (premerge technical lens, 2026-09-02).
    console.error('[inbox] lead-forward auto-clear: candidate read failed:', error?.message);
    return [];
  }

  const raw = data as {
    id: string;
    subject: string | null;
    preview: string | null;
    status: string;
    last_message_at: string | null;
    followed_up_at: string | null;
  }[];
  const rows = raw.map((r) => ({
    id: r.id,
    subject: r.subject,
    preview: r.preview,
    status: r.status,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at) : null,
  }));

  const ids = leadForwardsAnsweredBy(rows, { phones, emails, at: touch.lastMessageAt });
  if (ids.length === 0) return [];
  // The state each row is being moved OUT of, captured before the write. A
  // Reverse reads detail.from to restore it (inverseOf in lifecycle.ts), so an
  // auto-clear without this reverses to a guess rather than to what was there.
  const priorById = new Map(
    raw.filter((r) => ids.includes(r.id)).map((r) => [r.id, { status: r.status, wasFollowed: !!r.followed_up_at }]),
  );

  // status only, plus the auto-resolve stamps the existing outbound path uses:
  // handled_by null means the system did it, not a person.
  const { data: updated, error: updErr } = await sb
    .from('inbox_items')
    .update({ status: 'handled', handled_by: null, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .in('id', ids)
    // Re-assert the open status in the WHERE clause: between the read above and
    // this write, a person may have dismissed or completed the row, and the
    // sweep must not overwrite a decision someone actually made.
    .eq('status', 'unresponded')
    // Report the rows the write ACTUALLY changed, the way every other guarded
    // update in this file does. Returning the pre-write candidates instead
    // would log a successful clear for a row this call lost the race on, which
    // is a false line in the audit trail (premerge technical lens, 2026-09-02).
    .select('id');
  if (updErr) {
    console.error('[inbox] lead-forward auto-clear: update failed:', updErr.message);
    return [];
  }
  const changedIds = ((updated ?? []) as { id: string }[]).map((r) => r.id);
  return changedIds.map((id) => ({
    id,
    from: priorById.get(id) ?? { status: 'unresponded', wasFollowed: false },
  }));
}

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

  // 4. A forwarded lead answered by this outbound touch clears too. AFTER the
  // touch's own write, so a failure here cannot cost us the touch.
  if (isAnsweredByDirection(touch.direction)) {
    const cleared = await clearLeadForwardsAnsweredBy(sb, touch, now);
    for (const { id: clearedId, from } of cleared) {
      if (clearedId === itemId) continue; // never log the row we just wrote twice
      await sb.from('dashboard_activity').insert({
        actor: 'system',
        action: 'handled',
        inbox_item_id: clearedId,
        contact_id: null,
        // `auto` + `reason` + `from` is the shape the rest of this file uses
        // for a system decision (see the quote_terminal auto-complete). It is
        // not decoration: listActivity only surfaces a reason when
        // `detail.auto` is set, and Reverse reads `detail.from` to restore the
        // state the row came out of. The first cut used `autoResolved` and no
        // `from`, so the explanation was write-only and a Reverse would have
        // guessed (premerge staff lens, 2026-09-02).
        detail: { auto: true, reason: 'lead_forward_answered_by_outbound', from, outboundSource: touch.source },
      });
    }
  }

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
 * Row 321: true when a quotetool item's external_id carries the color-request
 * suffix apply-color-request/color-change-request mint (`${quoteId}:color-
 * request` — see quoteIdPrefix's own doc above). Used both to exclude a live
 * request from #317's terminal auto-complete (completeTerminalQuoteItems
 * below) and to badge/confirm-gate the row in the /inbox UI (InboxList.tsx,
 * InWorksSection.tsx) so the ordinary Handled/Mark-completed buttons can't
 * silently bury it — see ledger row 321's Kristie Tibbetts case (a plain Mark
 * completed left her request unfulfilled and invisible for three weeks).
 */
export function isColorRequestExternalId(externalId: string): boolean {
  return externalId.endsWith(':color-request');
}

/**
 * Row 321 fix-round FIX 1 (technical HIGH + staff MED, converged): batch-
 * fetches which of `quoteIds` currently has a LIVE
 * `approval_snapshot.pendingColorRequest` — the shared seam listOpenItems and
 * listInWorks both call so a `:color-request`-shaped item's badge/confirm-gate
 * tracks the REAL live state of the request, not merely its external_id's
 * shape. Before this fix `isColorRequest` was pure shape (isColorRequestExternalId
 * alone), which caused two bugs the review converged on: (a) IN_WORKS_SELECT
 * never selected external_id at all, so the InWorksSection "awaiting" bucket
 * read isColorRequest:false unconditionally — an ordinary Handled -> Followed
 * (snooze) -> Mark completed sequence could bury a still-pending request with
 * no confirm and no server check; (b) shape alone meant the badge/confirm kept
 * warning FOREVER even after staff applied the colour via ColorRequestPanel,
 * training operators to click through a confirm that no longer meant anything.
 *
 * Mirrors fetchHiddenLegacyRebookQuoteIds's batched-not-per-row pattern (ONE
 * query for every candidate id) but is DELIBERATELY independent of
 * EXCLUDE_LEGACY_REBOOK_FROM_INBOX / fetchHiddenLegacyRebookQuoteIds — that
 * flag exists to hide parked YLL Neighbor drafts and its own doc comment says
 * it flips off once #157 ships; coupling the color-request badge's
 * correctness to an unrelated feature flag would silently break the badge the
 * day that flag flips.
 *
 * Fails SAFE the OPPOSITE direction from fetchHiddenLegacyRebookQuoteIds's own
 * fail-open: `failed:true` here must make the caller show MORE badges/
 * confirms (over-warn), never fewer — a query error is not proof a pending
 * request was resolved, and silently dropping the guard on a real error is
 * exactly the live-prod failure row 321 exists to close. See
 * isLiveColorRequestItem below for how the caller applies `failed`.
 */
async function fetchLiveColorRequestQuoteIds(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  quoteIds: readonly string[],
): Promise<{ liveIds: Set<string>; failed: boolean }> {
  if (quoteIds.length === 0) return { liveIds: new Set(), failed: false };
  const { data, error } = await sb.from('quotes').select('id, approval_snapshot').in('id', quoteIds);
  if (error) {
    console.error('[inbox] color-request liveness lookup failed:', error.message);
    return { liveIds: new Set(), failed: true };
  }
  const liveIds = new Set(
    ((data ?? []) as { id: string; approval_snapshot: { pendingColorRequest?: unknown } | null }[])
      .filter((q) => !!q.approval_snapshot?.pendingColorRequest)
      .map((q) => String(q.id)),
  );
  return { liveIds, failed: false };
}

/**
 * Row 321 fix-round FIX 1: the shared "should this row badge/confirm-gate as
 * a live colour request" decision — shape (isColorRequestExternalId) AND
 * liveness (fetchLiveColorRequestQuoteIds's result), never shape alone. A
 * bare "quote sent" item (no `:color-request` suffix) is never flagged by
 * this, even if its quote happens to carry a pendingColorRequest — the badge
 * stays scoped to the item that actually represents the customer's ask, same
 * as before this fix. `lookup.failed` fails SAFE (over-warn): every
 * shape-matching row reads as still-live rather than silently dropping the
 * guard — see fetchLiveColorRequestQuoteIds's own doc for why. Pure — no
 * I/O — so it's directly unit-testable without a DB.
 */
function isLiveColorRequestItem(
  source: unknown,
  externalId: string,
  lookup: { liveIds: ReadonlySet<string>; failed: boolean },
): boolean {
  if (source !== 'quotetool' || !isColorRequestExternalId(externalId)) return false;
  return lookup.failed || lookup.liveIds.has(quoteIdPrefix(externalId));
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
      'dashboard_contacts ( display_name, primary_email, primary_phone, assigned_to, ghl_contact_id )',
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

  // Row 321 fix-round FIX 1: batched liveness lookup, scoped to the
  // color-request-shaped quotetool ids on THIS PAGE (trimmed, post legacy-
  // exclusion/slice — the actual page about to render) — ONE query, never
  // per-row. See fetchLiveColorRequestQuoteIds's own doc for the fail-safe
  // direction and why this is independent of the legacy-rebook flag above.
  const colorRequestQuoteIds = [
    ...new Set(
      (trimmed as unknown as Record<string, unknown>[])
        .filter((r) => r.source === 'quotetool' && isColorRequestExternalId(String(r.external_id ?? '')))
        .map((r) => quoteIdPrefix(String(r.external_id)))
        .filter(isUuid),
    ),
  ];
  const colorRequestLookup = await fetchLiveColorRequestQuoteIds(sb, colorRequestQuoteIds);

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
      // The HighLevel contact id, distinct from contactId above: that one is
      // the dashboard_contacts row id used for claim/assign, this one is what
      // /customers/[contactId] and the HighLevel app both address a customer
      // by. Null on a contact that has never been linked to the CRM.
      ghlContactId: (c?.ghl_contact_id as string | null) ?? null,
      assignedTo: (c?.assigned_to as string | null) ?? null,
      contact: c
        ? {
            displayName: (c.display_name as string | null) ?? null,
            email: (c.primary_email as string | null) ?? null,
            phone: (c.primary_phone as string | null) ?? null,
          }
        : null,
      // Row 321: badges + confirm-gates Handled/Mark-completed in InboxList.tsx
      // so a still-live colour request can't be silently buried by them. Fix-
      // round FIX 1: now driven by the batched LIVENESS lookup above, not
      // shape alone — see isLiveColorRequestItem's own doc.
      isColorRequest: isLiveColorRequestItem(row.source, String(row.external_id ?? ''), colorRequestLookup),
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

/** Row 308: best-effort trace for the FAILURE branch of the four action
 *  functions below (markItemHandledLocal / dismissItem / markItemFollowed /
 *  markItemCompleted). Before this, dashboard_activity only ever got a row on
 *  the SUCCESS path of those four — so a systemic "our writes are failing"
 *  pattern (a lost race, an RLS misconfiguration, a genuine DB error) left no
 *  durable trace; prod confirmed zero failure-type actions in ~1.13M rows.
 *  The action-column value is always the literal 'action_failed' (never one
 *  of the four verbs); `action` names WHICH of the four attempts failed
 *  inside `detail`, alongside the same `error` string the caller is already
 *  returning to its own caller. Mirrors recordSuppressedFollowUp's (#230a)
 *  fire-and-forget shape: never blocks or throws, so an audit-write failure
 *  can never turn an already-failed action into a doubly-failed request.
 *  Renders on /inbox/activity like every other row — listActivity's own
 *  filter excludes only 'ingested'/'escalated'. */
async function recordActionFailed(
  inboxItemId: string,
  actor: string | null,
  action: string,
  error: string,
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  try {
    await sb.from('dashboard_activity').insert({
      actor,
      action: 'action_failed',
      inbox_item_id: inboxItemId,
      detail: { action, error },
    });
  } catch (e) {
    console.warn('[inbox] action-failure audit write failed (non-fatal):', e);
  }
}

/** How a follow-up was recorded. 'call' is written by the automatic sweep that
 *  reads outbound calls (callFollowUp.ts); the manual button and a sent reply
 *  pass nothing and keep their original audit shape.
 *
 *  It rides the SAME `detail.auto` + `detail.reason` channel the terminal-quote
 *  auto-complete already uses (row 317 FIX 4), because that channel is the one
 *  ActivityLog actually renders — see AUTO_REASON_LABEL there. A bespoke key
 *  would have been written and read by nobody, which the pre-merge staff lens
 *  caught it being in the first cut of this change. */
export type { FollowedVia } from './followBacking';
import { DEFAULT_FOLLOWED_VIA, type FollowedVia } from './followBacking';

/** The `detail.reason` value a call-driven follow-up carries. Must stay in step
 *  with AUTO_REASON_LABEL in ActivityLog.tsx, which turns it into words. */
export const FOLLOWED_VIA_CALL_REASON = 'phone_call';

export type HandledTarget = {
  source: InboxSource;
  externalId: string;
  sourceMessageId: string | null;
  ghlContactId: string | null;
  displayName: string | null;
};
// Row 366 fix round 2 (MED): `refused` distinguishes WHY ok is false — true
// for a legitimate CAS refusal (the WHERE clause matched zero rows: the item
// really did move to a status this call didn't expect, e.g. another operator's
// concurrent Mark-completed/Dismiss), false for a genuine backend failure
// (service role unconfigured, or the query itself errored) where nothing is
// actually known about the item's current status. Callers that need to tell a
// benign lost-race apart from a real failure (reply/route.ts, since its send
// already fired and can't be undone either way) read this instead of trying to
// pattern-match the `error` string.
export type MarkHandledResult = { ok: true; target: HandledTarget } | { ok: false; error: string; refused: boolean };

/**
 * Stamp an item handled locally FIRST (attribution never depends on the external
 * write-back), and return the coordinates the route needs to mark the source
 * read. Uses a status guard so two operators can't double-apply. `operatorId`
 * must be a real auth.users uuid, or null — inbox_items.handled_by is a
 * nullable `uuid` column ("NULL when system auto-resolved" per its schema
 * comment); never pass a display name/email string here.
 *
 * Row 366: the default guard is the NEGATIVE `.neq('status','handled')`. A
 * caller that first READ the status (or knows the fixed set of statuses its own
 * UI surface can legally be in) should pass `expectedStatus` — a single value or
 * an array — which swaps that guard for a POSITIVE `.eq(...)`/`.in(...)` so the
 * check is carried across the read→write gap as one atomic UPDATE...WHERE.
 * Without it, a row that moved to 'completed'/'dismissed' in that gap passes
 * `.neq('status','handled')` and gets silently RESURRECTED to 'handled'.
 *
 * Row 320(c): the doc here previously claimed the negative default was
 * correct for /api/dashboard/handled and /api/dashboard/reply because their
 * "whole intent is handle this, whatever it currently is" — that claim was
 * never actually checked against those routes' real UI reachability and does
 * not hold. /api/dashboard/handled's button only ever renders on a
 * listOpenItems row (bucket 'needs_reply': status==='unresponded'); ReplyComposer
 * only ever renders on a needs_reply/awaiting_reply/handled row, i.e. status
 * ∈ {'unresponded','handled'} (applyBucketFilter, lifecycle.ts, excludes
 * completed/dismissed by construction). Neither caller legitimately expects
 * to resolve a 'completed'/'dismissed' row — a stale click/composer racing a
 * concurrent Mark-completed/Dismiss should be REFUSED, not resurrect the
 * terminal row — so both now pass their real legal-status set below.
 */
export async function markItemHandledLocal(
  itemId: string,
  operatorId: string | null,
  now: Date,
  opts?: { expectedStatus?: string | string[] },
): Promise<MarkHandledResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured', refused: false };
  const expectedStatus = opts?.expectedStatus ?? null;
  const from = await priorStateOf(sb, itemId);
  const update = sb
    .from('inbox_items')
    .update({ status: 'handled', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId);
  const { data, error } = await (expectedStatus === null
    ? update.neq('status', 'handled')
    : Array.isArray(expectedStatus)
      ? update.in('status', expectedStatus)
      : update.eq('status', expectedStatus))
    .select('source, external_id, source_message_id, dashboard_contacts ( ghl_contact_id, display_name )')
    .maybeSingle();
  if (error) {
    await recordActionFailed(itemId, operatorId, 'handled', error.message);
    return { ok: false, error: error.message, refused: false };
  }
  if (!data) {
    // Row 311 fix-round FIX 4: hoisted, mirroring the sibling guard functions'
    // own `const msg = '...'` pattern (markItemFollowed / markItemCompleted) —
    // this repeated the literal twice.
    const msg = expectedStatus === null
      ? 'Item not found or already handled'
      : `Item not found or no longer ${Array.isArray(expectedStatus) ? expectedStatus.join('/') : expectedStatus}`;
    await recordActionFailed(itemId, operatorId, 'handled', msg);
    return { ok: false, error: msg, refused: true };
  }
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
/**
 * Row 387: same POSITIVE-CAS treatment markItemHandledLocal got in row 366, and
 * the consequence here is worse, which is why this was worth doing rather than
 * leaving as parity tidiness.
 *
 * The default guard is the NEGATIVE `.neq('status','dismissed')`. That passes on
 * a row which has meanwhile become 'handled' or 'completed' — so a stale click
 * (an operator whose earlier action's fetch threw, or a second operator racing
 * the first) silently flips a GENUINELY ANSWERED lead to dismissed. And dismiss
 * does not stop at the status: it also calls addSuppressedSenders, so that
 * customer's future messages are auto-filtered out of the default view.
 * InboxList's own comment at the `unreachableActions` lock describes exactly
 * this path (InboxList.tsx, the `lockedTo` block) — the UI added a client-side
 * lock to avoid it, but the server had no guard at all behind it.
 *
 * A caller that knows the fixed set of statuses its UI surface can legally be in
 * should pass `expectedStatus`, swapping the negative guard for a positive
 * `.eq(...)`/`.in(...)` carried across the read→write gap as one atomic
 * UPDATE...WHERE. The only Dismiss control in the app is InboxList's "Not a
 * lead", fed by listOpenItems → applyBucketFilter(..., 'needs_reply') →
 * `status = 'unresponded'`, so that is the whole legal set (see the route).
 * Note that 'handled' must NOT be in it: a row a colleague answered in the
 * read→write gap is exactly what this guard exists to refuse.
 *
 * `refused: true` distinguishes a lost CAS race (the WHERE matched zero rows —
 * real evidence the row moved) from a backend failure, mirroring
 * MarkHandledResult. Without `expectedStatus` the legacy no-match behaviour is
 * unchanged: a benign `{ ok: true }` no-op, since under `.neq` a zero-row match
 * can only mean "already dismissed".
 */
/**
 * Do these identifiers belong to somebody we have quoted? (S75)
 *
 * The last line of defence before a dismiss silences a sender. Best-effort and
 * fails CLOSED on any error: if we cannot prove they are NOT a customer, we do
 * not suppress. Losing a suppression is a bit more inbox noise; a wrong
 * suppression loses a customer's mail silently for months, which is what
 * actually happened.
 */
async function identifiersBelongToACustomer(
  sb: ReturnType<typeof getSupabaseServiceClient>,
  identifiers: (string | null)[],
): Promise<boolean> {
  if (!sb) return true;
  const emails = identifiers
    .filter((v): v is string => !!v && v.includes('@'))
    .map((v) => v.trim().toLowerCase());
  if (!emails.length) return false;
  try {
    const { data, error } = await sb
      .from('quotes')
      .select('id')
      .in('customer_email', emails)
      .limit(1);
    if (error) return true; // cannot tell -> do not suppress
    return (data?.length ?? 0) > 0;
  } catch {
    return true; // cannot tell -> do not suppress
  }
}

export async function dismissItem(
  itemId: string,
  operatorId: string | null,
  now: Date,
  opts?: { expectedStatus?: string | string[] },
): Promise<{ ok: boolean; error?: string; refused?: boolean }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const expectedStatus = opts?.expectedStatus ?? null;
  const from = await priorStateOf(sb, itemId);
  const update = sb
    .from('inbox_items')
    .update({ status: 'dismissed', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId);
  const { data, error } = await (expectedStatus === null
    ? update.neq('status', 'dismissed')
    : Array.isArray(expectedStatus)
      ? update.in('status', expectedStatus)
      : update.eq('status', expectedStatus))
    .select('source, lead_kind, dashboard_contacts ( primary_email, primary_phone )')
    .maybeSingle();
  if (error) {
    await recordActionFailed(itemId, operatorId, 'dismissed', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) {
    // With a POSITIVE guard a zero-row match means the row is no longer in a
    // legally-dismissable state — REFUSE, and critically do NOT fall through to
    // addSuppressedSenders below, which would suppress a real customer over a
    // dismiss that never happened.
    if (expectedStatus !== null) {
      const msg = `Item not found or no longer ${Array.isArray(expectedStatus) ? expectedStatus.join('/') : expectedStatus}`;
      await recordActionFailed(itemId, operatorId, 'dismissed', msg);
      return { ok: false, error: msg, refused: true };
    }
    // Already dismissed → no-op: don't log a duplicate reversible row or re-suppress
    // (a stray reverse of that row would un-suppress a still-dismissed sender).
    return { ok: true };
  }
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'dismissed', inbox_item_id: itemId, detail: { from } });
  const row = data as {
    source?: string | null;
    dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null };
  } | null;
  const c = row?.dashboard_contacts;
  // S75 — the dismiss ALWAYS lands; this only decides whether the sender is
  // silenced from here on. It used to be unconditional, which is how five
  // paying customers ended up silenced by staff correctly dismissing our own
  // "we sent a quote" rows and a lead forward. See dismissSuppression.ts for
  // the traced cases. The check fails CLOSED: anything that looks like one of
  // our customers keeps notifying us.
  if (c) {
    const identifiers = [c.primary_email ?? null, c.primary_phone ?? null];
    const decision = shouldSuppressOnDismiss({
      source: row?.source ?? null,
      isKnownCustomer: await identifiersBelongToACustomer(sb, identifiers),
    });
    if (decision.suppress) {
      await addSuppressedSenders(identifiers, { actor: operatorId, inboxItemId: itemId });
    } else {
      // Say so in the activity trail rather than silently doing nothing, so a
      // staffer wondering why a sender still notifies them can find the answer.
      await sb.from('dashboard_activity').insert({
        actor: operatorId ?? 'system',
        action: 'dismiss_suppression_skipped',
        inbox_item_id: itemId,
        detail: { reason: decision.reason },
      });
    }
  }
  // #252 follow-up-autoclose: dismissed is terminal — its conversation is not
  // a real lead, so any pending nag anchored to it should die with it. Only on
  // the matched (real transition) path above, never the already-dismissed no-op.
  await closeFollowUpsForResolvedItem(itemId, 'dismissed');
  return { ok: true };
}

/** Snooze an item: stamp followed_up_at (the reply route does this on send [A]; a
 *  manual "I followed up" does it without sending [B]). Hides from the open list
 *  until a newer message clears it. Service-role glue.
 *
 * Row 306 (10th sibling-parity instance): this used to be a bare
 * `.update({followed_up_at}).eq('id', itemId)` — no status guard at all, unlike
 * its three siblings (markItemHandledLocal's `.neq('status','handled')`,
 * dismissItem's `.neq('status','dismissed')`, markItemCompleted's positive
 * `.in('status', [...])`). Concrete harm (row 311): a "Mark completed" click
 * whose fetch throws may have already landed server-side; if the operator then
 * clicks "Followed" instead, this call would silently stamp followed_up_at on a
 * row that is really 'completed' — a terminal row no inbox list re-queries, so
 * the corruption is invisible. Guarded the same POSITIVE-match way as
 * markItemCompleted (AGENTS.md's positive-seam-gate convention: `.in(...)`
 * fails CLOSED on a future 5th status; a negative `.neq` pair would fail OPEN)
 * — only 'unresponded' and 'handled' are legal source statuses for a Follow.
 *
 * Row 311 fix-round FIX 1 (the status guard above still lets a RETRY re-stamp
 * followed_up_at, since this function never changes status — the headline row
 * 306 harm): the two real callers need opposite behavior on an already-followed
 * row. [A] the reply route (api/dashboard/reply) calls this right after a REAL
 * send — the item may already be followed from an earlier round, and
 * re-stamping is CORRECT there: the customer's waiting clock should restart
 * because we just genuinely wrote to them. [B] the standalone "Followed"
 * button (api/dashboard/followed) is a manual snooze with no send attached —
 * every legitimate path to it starts from a row with followed_up_at NULL
 * (InboxList's button only renders on open-queue rows; InWorksSection's only
 * on handled-bucket rows, followed null by definition), so a retry landing
 * AFTER an earlier attempt already stamped it is not a fresh follow-up, just a
 * duplicate click/lost-race — restamping there would silently reset the
 * waiting clock for no real reason. `opts.allowRestamp` differentiates the two
 * (default false — the SAFER read, so an unknown future caller fails closed
 * into "don't restamp" rather than silently reproducing the row 306 bug): true
 * adds no extra guard (status-only, as before — the reply route's own call
 * site passes this); false additionally requires `.is('followed_up_at', null)`
 * in the same UPDATE...WHERE (CAS-style, same idiom as the siblings — no
 * separate read-check-then-act). `alreadyFollowed` on a false-path refusal
 * lets the caller (followed/route.ts) tell a genuine "already snoozed" no-op
 * apart from a real guard block — see that route for why it treats the two
 * differently. */
export async function markItemFollowed(
  itemId: string,
  operatorId: string,
  now: Date,
  opts?: { allowRestamp?: boolean; via?: FollowedVia; requireNoInboundAfter?: Date },
): Promise<{ ok: true } | { ok: false; error: string; alreadyFollowed?: boolean }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const allowRestamp = opts?.allowRestamp ?? false;
  const from = await priorStateOf(sb, itemId);
  let query = sb
    .from('inbox_items')
    .update({
      followed_up_at: now.toISOString(),
      // Row 502: record WHAT backed this stamp, so the row itself can say
      // whether anything corroborates it. A caller passing nothing records
      // 'manual', the honest reading and the one that fails closed: a future
      // path that forgets to say cannot arrive looking backed.
      followed_via: (opts?.via ?? DEFAULT_FOLLOWED_VIA) satisfies FollowedVia,
      updated_at: now.toISOString(),
    })
    .eq('id', itemId)
    .in('status', ['unresponded', 'handled']);
  if (!allowRestamp) {
    query = query.is('followed_up_at', null);
  }
  // Enforce the caller's anchor AT THE WRITE, not only at the read that chose
  // this row. The automatic call sweep reads a snapshot of eligible items and
  // then writes them one by one, so a customer reply landing through the
  // ingest webhook in that gap would be overwritten: planIngest clears
  // followed_up_at on any newer inbound, and a stale stamp written afterwards
  // would push that unanswered customer back into "awaiting their reply" and
  // hide them from the list whose job is to surface them. Found by the
  // pre-merge technical lens. This makes the update itself refuse when a newer
  // inbound has arrived, which check-then-act cannot do.
  if (opts?.requireNoInboundAfter) {
    const iso = opts.requireNoInboundAfter.toISOString();
    query = query.or(`last_inbound_at.is.null,last_inbound_at.lte.${iso}`);
  }
  const { data, error } = await query.select('id').maybeSingle();
  if (error) {
    await recordActionFailed(itemId, operatorId, 'followed', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) {
    // Row 311 fix-round 2 (delta-verify MED): `from` above is only the
    // PRE-update snapshot, and TOCTOU makes it stale — a row whose snapshot
    // showed wasFollowed=true can go TERMINAL (completed/dismissed by another
    // operator) between the snapshot and this guarded UPDATE. The UPDATE then
    // matches 0 rows because of the STATUS guard, not the followed_up_at
    // guard, but trusting the stale snapshot would mislabel that terminal
    // refusal as a benign duplicate: followed/route.ts turns
    // alreadyFollowed:true into a 200 {ok:true}, and InWorksSection.tsx's
    // act() moveGroups any 200 into "awaiting" — a phantom client-side move
    // for a row that is really terminal server-side, invisible until reload.
    // Re-read the row's CURRENT state instead of trusting the snapshot.
    // priorStateOf already fails safe here: it returns undefined on "row not
    // found" AND on a read error (it only inspects `data`, never `error`), so
    // an erroring or empty re-read falls straight into the generic refusal
    // below and never claims alreadyFollowed.
    const current = await priorStateOf(sb, itemId);
    const stillLegalStatus = current?.status === 'unresponded' || current?.status === 'handled';
    if (!allowRestamp && stillLegalStatus && current?.wasFollowed) {
      // Genuine duplicate: the row is STILL a legal source status right now
      // (not terminal) and is already followed — a real duplicate click or
      // lost race, not a terminal-status guard block wearing a stale label.
      const msg = 'Already marked followed';
      await recordActionFailed(itemId, operatorId, 'followed', msg);
      return { ok: false, error: msg, alreadyFollowed: true };
    }
    const msg = 'Item is completed or dismissed; cannot mark followed';
    await recordActionFailed(itemId, operatorId, 'followed', msg);
    return { ok: false, error: msg };
  }
  // `via` records HOW this follow-up happened, so the activity log can tell a
  // phone call apart from a text. Omitted by the two original callers (the
  // manual button and a sent reply), which keeps their audit rows the shape
  // they already were. Written as auto/reason because that is the pair
  // listActivity maps into ActivityRow.autoReason and ActivityLog renders.
  await sb.from('dashboard_activity').insert({
    actor: operatorId,
    action: 'followed',
    inbox_item_id: itemId,
    detail: { from, ...(opts?.via === 'call' ? { auto: true, reason: FOLLOWED_VIA_CALL_REASON } : {}) },
  });
  // PR #1005 (premerge STAFF lens, HIGH): "I followed up" is the answer to
  // "you should follow up", so it retires this item's due nag. Before this,
  // the ONLY staff-initiated way to close a quote_sent_no_reply follow-up was
  // the strip's Done button; PR #1005 deleted that strip, and every remaining
  // close path is a system one (quoteFollowUpDecision's 'close' branch when
  // the quote is approved or goes dead, sweepOrphanedFollowUps,
  // sweepResolvedItemFollowUps) or a whole-conversation action
  // (markItemCompleted / dismissItem, via closeFollowUpsForResolvedItem). A
  // staffer who rings a customer and hears "still deciding" would have had
  // nothing to click, and the "Follow-up due" pill that inherited the strip's
  // signal would have stayed lit on that row until the deal itself ended —
  // decaying into exactly the wallpaper the pill exists to avoid.
  //
  // Hung HERE rather than in the two routes so the two callers cannot drift:
  // the manual Followed button (followed/route.ts) and a sent reply
  // (reply/route.ts, allowRestamp) are both "staff acted on this
  // conversation" and both must retire the nag. Reason-scoped, unlike
  // closeFollowUpsForResolvedItem: the item is NOT terminal here, and it is
  // specifically the no-reply chase that this action answers.
  //
  // The nag comes BACK, which is the point — this is a snooze, not a delete.
  // ensureFollowUp re-arms it after RECHASE_QUIET_DAYS of silence, anchored on
  // the follow_ups row's own updated_at, which this close bumps via the
  // dashboard_set_updated_at trigger (see mayReChaseHandled's doc). One case
  // re-arms sooner: an item still 'unresponded' is outside that skip set
  // entirely, so its nag returns on the next reconcile tick. That is correct
  // rather than a leak — 'unresponded' means the customer has written and is
  // unanswered — and ingestTouch runs BEFORE ensureFollowUp in the same tick
  // (sync.ts), so a quote item usually heals to 'handled' first anyway. Zero
  // prod rows carry that shape today: all 33 items with a pending nag are
  // 'handled' (measured 2026-08-27).
  //
  // Best-effort: closeFollowUp catches and logs its own failures and returns
  // 0, so a failed close never fails the operator's Followed/reply action.
  //
  // FIX-ROUND DELTA-VERIFY (MED): gated on the item being 'handled', which is
  // the only status where the snooze this promises actually holds. An
  // 'unresponded' item sits OUTSIDE ensureFollowUp's skip set, so closing its
  // nag would have re-armed it on the next reconcile tick (~5 min) carrying
  // its ORIGINAL, already-elapsed due date — the pill blinking off and
  // straight back on, under a button whose own tooltip says "snoozed until
  // they reply". Round 1 called that case "correct rather than a leak"
  // because an unanswered customer outranks a snooze; that reasoning holds
  // for the NAG, and was still the wrong thing to promise in the UI. Not
  // closing it leaves that path exactly as it was before PR #1005 — no
  // regression, no false promise. `from` is the pre-update snapshot and the
  // UPDATE does not touch status, so it is the right read; when it is
  // undefined (row vanished, or a failed read) this correctly does nothing.
  if (from?.status === 'handled') {
    await closeFollowUp(itemId, FOLLOWUP_REASONS.quoteSentNoReply);
  }
  return { ok: true };
}

export async function recordWriteback(itemId: string, sync: unknown): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  // #342 fix round (technical lens MED 3): this used to discard the update's
  // own error — the same silent-failure shape the row exists to fix, one hop
  // upstream of the read side. A failed PERSIST of the computed write-back
  // outcome is now at least logged (still fire-and-forget/best-effort by
  // design, per this function's callers, so it stays void — but no longer
  // silent).
  const { error } = await sb.from('inbox_items').update({ handled_channel_sync: sync }).eq('id', itemId);
  if (error) console.error('[inbox] recordWriteback failed to persist handled_channel_sync:', error.message);
}

export type GmailWritebackFailure = {
  id: string;
  /** Display name, falling back to email, falling back to a placeholder —
   *  never blank, so the /inbox banner always names WHO is affected. */
  label: string;
  /** handled_channel_sync.gmailLabelError, when the row's catch block
   *  recorded one. Already bounded to 500 chars at the source (sync.ts's
   *  errMsg) — not re-truncated here. Always null for 'unconfigured' (there
   *  is no per-item error — the whole channel was down). */
  error: string | null;
  /** 'failed' = a live token attempted the write-back and it threw.
   *  'unconfigured' = Gmail had no credentials at all when this ran (#342
   *  fix round MED 1) — a systemic outage, not a per-item error, and worth
   *  its own copy in the UI rather than being read as "N write-backs failed". */
  status: 'failed' | 'unconfigured';
};

export type GmailWritebackFailuresResult =
  | {
      ok: true;
      items: GmailWritebackFailure[];
      /** Combined (failed + unconfigured) TRUE count — drives ONLY the
       *  truncation check below, never rendered as-is. Fix round MED
       *  (delta-verify): a mixed population printed under this one number
       *  made a condition-specific headline ("Gmail isn't connected —
       *  {total}") state a count that included rows the sentence wasn't
       *  describing. Use failedCount/unconfiguredCount for anything a
       *  human reads. */
      total: number;
      /** TRUE (unbounded, not just the returned page) count of
       *  gmailLabel==='failed' rows — from a separate head:true query, not
       *  derived from `items` (which is capped at `limit`), because the
       *  whole point of this fix is a correct number under truncation. */
      failedCount: number;
      /** Same as failedCount, for gmailLabel==='unconfigured'. */
      unconfiguredCount: number;
      truncated: boolean;
    }
  | { ok: false; error: string };

const GMAIL_WRITEBACK_FAILURES_LIMIT = 25;

/**
 * #342 fix round (staff lens BLOCK, 2 HIGH): recordWriteback (above) has
 * always persisted runHandledWriteback's per-channel outcome into
 * handled_channel_sync — but nothing ever READ it, so a broken Gmail token
 * failed silently while staff kept marking items Handled. PR #886 took the
 * Gmail branch from ~4 lead-forward rows to the overwhelming majority of
 * Gmail traffic (sync.ts's runHandledWriteback doc comment), so a dead token
 * is now a fleet-wide blind spot, not a corner case.
 *
 * Returns the actual FAILING ROWS (id + a human label + the stored error),
 * not just a count — round 1 shipped a bare `count:'exact', head:true`
 * number with no way to learn WHICH items were affected. Bounded to
 * GMAIL_WRITEBACK_FAILURES_LIMIT (most-recently-handled first, since those
 * are the ones a token fix should retry first); `total` is the TRUE
 * unbounded count (Postgres/PostgREST's exact count ignores .limit()), and
 * `truncated` says whether the list under-represents it.
 *
 * No time window: these are Handled items whose external Gmail state never
 * actually synced, which stays true until either a fixed token successfully
 * retries the write-back (see the retry-gmail-sync route) or an operator
 * acknowledges it — not something that ages out on its own.
 *
 * Round-1 bug this fixes in itself: `const { count } = await sb...` used to
 * discard `error` — a query FAILURE made `count` null, `?? 0` turned that
 * into a confident "0 failures", and the banner went dark on a broken
 * monitor. Now a query error returns `ok:false` so the caller can render a
 * "couldn't check" state instead of a false all-clear (the exact bug class
 * this whole row exists to fix, reproduced inside the first fix — caught by
 * the staff lens's MED finding).
 *
 * Fix round (technical lens, 2 more MEDs):
 *   - MED 1: also matches gmailLabel==='unconfigured' (sync.ts now records
 *     this instead of leaving the field unset when Gmail has no credentials
 *     at all) — a total outage must not read as zero failures.
 *   - MED 2: scoped to status='handled'. Reopening a Handled item resets
 *     status to 'unresponded' (reducer.ts) but the upsert OMITS
 *     handled_channel_sync on reopen, so the stale sync state is preserved
 *     verbatim (store.ts's ingestTouch upsert comment, ~line 571) — without
 *     this filter, a reopened-then-still-open item could keep tripping the
 *     banner for a write-back that no longer describes its current state.
 *     Verified against prod: 0 rows currently in that state, but 188
 *     all-time reopen events make it a real latent case, not theoretical.
 *
 * Second fix round (delta-verify MED): the banner used to headline with
 * `total` (failed+unconfigured combined) under BOTH condition-specific
 * sentences — "Gmail isn't connected — {total}" stated a number that, in a
 * mixed population, counted rows the sentence wasn't describing. No fixture
 * exercised a mixed population, so nothing caught it. Runs two additional
 * head:true count queries (in parallel with the page query) so
 * failedCount/unconfiguredCount are TRUE unbounded numbers — not derived
 * from the capped `items` page, which would under-count exactly the
 * truncated-and-mixed case that exposed the bug.
 */
export async function listGmailWritebackFailures(
  limit = GMAIL_WRITEBACK_FAILURES_LIMIT,
): Promise<GmailWritebackFailuresResult> {
  const sb = getSupabaseServiceClient();
  // Unconfigured (no service-role key, e.g. local dev) mirrors this file's
  // existing convention (getReopenCounts et al.): "no data available" is not
  // itself a monitoring failure, so this returns the all-clear shape, not
  // ok:false.
  if (!sb) return { ok: true, items: [], total: 0, failedCount: 0, unconfiguredCount: 0, truncated: false };

  const [pageRes, failedRes, unconfiguredRes] = await Promise.all([
    sb
      .from('inbox_items')
      .select('id, handled_channel_sync, dashboard_contacts ( display_name, primary_email )', { count: 'exact' })
      .eq('status', 'handled')
      .in('handled_channel_sync->>gmailLabel', ['failed', 'unconfigured'])
      .order('handled_at', { ascending: false })
      .limit(limit),
    sb
      .from('inbox_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'handled')
      .eq('handled_channel_sync->>gmailLabel', 'failed'),
    sb
      .from('inbox_items')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'handled')
      .eq('handled_channel_sync->>gmailLabel', 'unconfigured'),
  ]);

  if (pageRes.error) {
    console.error('[inbox] listGmailWritebackFailures query failed:', pageRes.error.message);
    return { ok: false, error: pageRes.error.message };
  }
  if (failedRes.error) {
    console.error('[inbox] listGmailWritebackFailures failedCount query failed:', failedRes.error.message);
    return { ok: false, error: failedRes.error.message };
  }
  if (unconfiguredRes.error) {
    console.error('[inbox] listGmailWritebackFailures unconfiguredCount query failed:', unconfiguredRes.error.message);
    return { ok: false, error: unconfiguredRes.error.message };
  }

  const rows = (pageRes.data ?? []) as unknown as Array<{
    id: string;
    handled_channel_sync: Record<string, unknown> | null;
    dashboard_contacts: { display_name: string | null; primary_email: string | null } | null;
  }>;
  const items: GmailWritebackFailure[] = rows.map((r) => {
    const c = r.dashboard_contacts;
    const label = c?.display_name || c?.primary_email || 'Unknown contact';
    const status = r.handled_channel_sync?.gmailLabel === 'unconfigured' ? 'unconfigured' : 'failed';
    const err = status === 'unconfigured' ? null : r.handled_channel_sync?.gmailLabelError;
    return { id: r.id, label, error: typeof err === 'string' ? err : null, status };
  });
  const total = pageRes.count ?? items.length;
  const failedCount = failedRes.count ?? 0;
  const unconfiguredCount = unconfiguredRes.count ?? 0;
  return { ok: true, items, total, failedCount, unconfiguredCount, truncated: total > items.length };
}

export type GmailWritebackRetryTarget =
  | { ok: true; target: HandledTarget }
  | { ok: false; error: string };

/**
 * #342 fix round: the coordinates runHandledWriteback (sync.ts) needs to
 * RETRY the Gmail write-back for an already-Handled item — deliberately NOT
 * markItemHandledLocal's job (that stamps status='handled' with a
 * `.neq('status','handled')` guard against double-apply; this item is
 * already handled, only the external write-back is being reattempted, so
 * that guard doesn't apply and must not be reused here).
 *
 * Refuses (ok:false) unless the row's OWN stored handled_channel_sync
 * currently says gmailLabel==='failed' or 'unconfigured' — so this can't be
 * repurposed into a generic "fire a write-back at any item id" endpoint; it
 * only ever replays a write-back that is known to be missing or broken.
 * ('unconfigured' added in the fix round alongside sync.ts's MED 1 fix —
 * once a token is restored, a row that failed only because Gmail was
 * entirely unconfigured is just as retryable as one that threw.)
 *
 * Also requires status='handled' (fix round MED 2, same reasoning as
 * listGmailWritebackFailures' own doc comment): a reopened item's stale
 * write-back outcome is not something this route should replay.
 *
 * Re-running runHandledWriteback here is safe to call more than once:
 *   - GHL mark-read: a plain PUT {status:'read'} — setting an already-read
 *     conversation read again is a no-op.
 *   - GHL tags: POST /contacts/{id}/tags MERGES (documented + verified
 *     against the live API — see addContactTags' own doc comment in
 *     highlevel.ts), so re-adding a tag the contact already has is a no-op.
 *   - Gmail modifyMessage: add/remove-label is Gmail's own idempotent
 *     primitive — adding a label already present, or removing UNREAD that's
 *     already removed, both no-op. getOrCreateLabel finds-before-creates.
 * None of the three write-back steps has any OTHER side effect (no email
 * sent, no activity-log row from runHandledWriteback itself), so replaying
 * the exact same call is safe.
 */
export async function getGmailWritebackRetryTarget(itemId: string): Promise<GmailWritebackRetryTarget> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .select('source, external_id, source_message_id, status, handled_channel_sync, dashboard_contacts ( ghl_contact_id, display_name )')
    .eq('id', itemId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Item not found' };

  const row = data as unknown as Record<string, unknown>;
  if (row.status !== 'handled') {
    return { ok: false, error: 'This item is no longer Handled — its Gmail write-back state is stale' };
  }
  const sync = (row.handled_channel_sync as Record<string, unknown> | null) ?? null;
  if (sync?.gmailLabel !== 'failed' && sync?.gmailLabel !== 'unconfigured') {
    return { ok: false, error: 'This item has no recorded Gmail write-back failure to retry' };
  }
  const c = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
  return {
    ok: true,
    target: {
      source: row.source as InboxSource,
      externalId: row.external_id as string,
      sourceMessageId: (row.source_message_id as string | null) ?? null,
      ghlContactId: (c?.ghl_contact_id as string | null) ?? null,
      displayName: (c?.display_name as string | null) ?? null,
    },
  };
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
    // Row 385: this lookup used to filter `.eq('status','pending')` and select
    // only `id`. It now fetches the ONE row for this (item, reason) whatever its
    // status — the table's `unique (inbox_item_id, reason)` constraint guarantees
    // at most one — because the re-chase decision below needs that row's
    // `updated_at` (when the nag was last touched), and a second query for it
    // would be wasteful. The pending early-return is preserved exactly: a
    // pending row still means "don't duplicate".
    const { data, error: pendingErr } = await sb
      .from('follow_ups')
      .select('id, status, updated_at')
      .eq('inbox_item_id', input.inboxItemId)
      .eq('reason', input.reason)
      .limit(1);
    if (pendingErr) {
      console.error('[inbox] ensureFollowUp: pending lookup failed (skipping item):', pendingErr.message);
      return 'failed';
    }
    const existingNudge = (data as { id: string; status: string; updated_at: string | null }[] | null)?.[0] ?? null;
    if (existingNudge?.status === 'pending') return 'skipped'; // a pending one already exists — don't duplicate

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
    //
    // Row 287(b) (Jason's ruling, same "HANDLED MEANS DONE" principle as row
    // 252, whose own follow-up-Done coupling PR #1005 has since deleted along
    // with the strip that drove it): 'handled' now skips too, not just
    // 'completed'/'dismissed'. Before this, a follow-up an operator had
    // explicitly marked Done re-armed to 'pending' on the very next reconcile
    // tick (≤5 min later) for any item merely 'handled' — every OTHER
    // sent-but-unapproved-quote tick re-requests kind:'create', so the "Done"
    // action was silently undone almost immediately, reading to staff as a
    // broken button. The escape hatch that keeps this from silently dropping a
    // genuinely-open conversation: a real NEW inbound message reopens the item
    // to 'unresponded' (ingestTouch's reducer, see this file's own comments
    // near 'reopened'), which is outside this skip set and resumes normal
    // re-arming immediately — so this only silences the nag while nothing new
    // has actually happened. A quote's own approval/decline/going-dead closes
    // its nag through a completely separate path (quoteFollowUpDecision
    // returning 'close', sync.ts) that never reads item status at all, so
    // that closure is unaffected either way.
    //
    // THAT GAP IS NOW CLOSED (row 385, Jason's ruling 2026-08-24). This
    // paragraph used to read "KNOWN UNCOVERED GAP ... not fixed here, and this
    // skip set is NOT to be weakened to work around it", describing the case
    // where staff reply once, the customer goes quiet, no new inbound ever
    // arrives, and the quote never reaches a terminal status — outside BOTH
    // escape hatches above, so nothing ever re-chased it. The 'handled' skip
    // below is now TIME-CONDITIONAL rather than absolute, which closes exactly
    // that case without weakening anything: see mayReChaseHandled (followups.ts)
    // for why the quiet window is anchored to the nag's own updated_at and not
    // to handled_at. 'completed' and 'dismissed' remain absolute skips.
    const { data: item, error: itemErr } = await sb.from('inbox_items').select('status, handled_at').eq('id', input.inboxItemId).maybeSingle();
    if (itemErr) {
      console.error('[inbox] ensureFollowUp: item status lookup failed (skipping item):', itemErr.message);
      return 'failed';
    }
    const itemRow = item as { status: string; handled_at: string | null } | null;
    const itemStatus = itemRow?.status ?? null;
    // 'completed' and 'dismissed' stay HARD skips: those are staff saying the
    // conversation is finished, and nothing about elapsed time changes that.
    if (itemStatus === 'completed' || itemStatus === 'dismissed') return 'skipped';
    // Row 385: 'handled' is the one status where silence is meaningful — staff
    // replied and the customer never wrote back (a real inbound would have
    // reopened the item to 'unresponded'). Skip while the quiet window is still
    // running; once it has elapsed, fall through and let the upsert below re-arm
    // the nag. See mayReChaseHandled for why the anchor is the nag's own
    // updated_at rather than handled_at — anchoring on handled_at would undo
    // every Done click five minutes later, which is the bug row 287(b) fixed.
    let isReChase = false;
    // Row 390: the silence-start anchor, when this write IS a re-chase — kept
    // outside the `if` so it's undefined (never touched) rather than
    // possibly-stale for the ordinary first-nudge path. Persisted below as
    // follow_ups.re_chase_since so a reader can tell a re-chase apart
    // from a first-time nudge instead of rendering both identically.
    let reChaseSince: Date | null = null;
    if (itemStatus === 'handled') {
      const anchorInputs = {
        lastNudgeAt: existingNudge?.updated_at ? new Date(existingNudge.updated_at) : null,
        handledAt: itemRow?.handled_at ? new Date(itemRow.handled_at) : null,
      };
      const canReChase = mayReChaseHandled({ ...anchorInputs, now: new Date() });
      if (!canReChase) return 'skipped';
      isReChase = true;
      // reChaseAnchor mirrors mayReChaseHandled's own anchor computation
      // exactly (same helper, same inputs) — canReChase being true already
      // proves this anchor is non-null and finite, so no re-guard needed here.
      reChaseSince = reChaseAnchor(anchorInputs);
    }
    const fu = quoteSentNoReplyFollowUp({ contactId: input.contactId, inboxItemId: input.inboxItemId, sentAt: input.sentAt, afterDays: input.afterDays });
    // Row 385 (staff-lens MED): a RE-CHASE is due NOW, not on the long-past date
    // the original send implies. quoteSentNoReplyFollowUp derives due_at from
    // `sentAt + afterDays`, so re-arming a nag for a quote sent 90 days ago would
    // stamp a due date 87 days in the past. Two things go wrong with that: the
    // digest reports it as 87 days overdue when staff have in fact been prompt
    // (opsDigest reads due_at), and listDueFollowUps sorts oldest-first under a
    // 100-row cap, so ancient re-chases would crowd genuinely-fresh nags out of
    // the strip. It became due the moment the quiet window elapsed, which is now.
    const dueAt = isReChase ? new Date() : fu.dueAt;
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
        due_at: dueAt.toISOString(),
        reason: fu.reason,
        status: fu.status,
        assigned_to: fu.assignedTo,
        created_by: fu.createdBy,
        // Row 390: explicit null on every non-re-chase write (not merely
        // omitted) so a row's flag can't go stale — e.g. a done re-chase row
        // later re-armed as an ordinary fresh nudge (a genuinely new "quote
        // sent" cycle) must not keep reporting the OLD silence window.
        re_chase_since: isReChase ? reChaseSince!.toISOString() : null,
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
 *  an accurate metric.
 *
 *  Row 320(b): this used to discard the query's `error` entirely, so a genuine
 *  DB failure here was indistinguishable from the legitimate "nothing pending
 *  to close" no-op — both silently returned 0, with no breadcrumb. Its sibling
 *  sweeps (sweepOrphanedFollowUps, sweepResolvedItemFollowUps) both check and
 *  log this same query's error (#825/#310's precedent); this now matches. */
export async function closeFollowUp(inboxItemId: string, reason: string): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;
  // PR #1005 fix-round delta-verify (LOW): wrapped, matching its sibling
  // closeFollowUpsForResolvedItem's non-fatal contract. Row 320(b) already
  // handled a RETURNED error here; a THROWN one (a dropped socket, a DNS
  // failure) still escaped to the caller. That was survivable while every
  // caller was the reconcile's own try/catch, but markItemFollowed now calls
  // this on an operator action and its comment claims the close can never
  // fail that action — this is what makes the claim true rather than nearly
  // true.
  try {
    const { data, error } = await sb
      .from('follow_ups')
      .update({ status: 'done' })
      .eq('inbox_item_id', inboxItemId)
      .eq('reason', reason)
      .eq('status', 'pending')
      .select('id');
    if (error) {
      console.error('[inbox] closeFollowUp failed:', error.message);
      return 0;
    }
    return data ? data.length : 0;
  } catch (e) {
    console.error('[inbox] closeFollowUp threw (non-fatal):', e);
    return 0;
  }
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

// row 317 fix-round FIX 2: batched lookup of which of `itemIds` were most
// recently REVERSED — mirrors fetchQuoteStatusesById/fetchPendingFollowUpItemIds's
// pattern above (#307: ONE query for every candidate id, never a per-row
// query — same discipline #814's batched lookups follow). Uses the SAME
// state-changing action set as reverseItemState's wrong-occurrence guard
// (below, row 312 fix-round FIX 5(b)): REVERSIBLE_ACTIONS (module-scope
// const declared further down this file — referencing it here is safe, this
// function's body only runs once the module has fully loaded) plus 'reversed'
// itself (what this is looking for) and 'reopened' (a genuinely-new inbound
// that supersedes an older reversed/completed row) — same tie-break order too
// (created_at desc, then id desc, for the same determinism reason row 312
// fix-round FIX 5(a) documents on reverseItemState's own query).
//
// Fails CLOSED, like #827's wrong-occurrence guard does on its own query
// error: a query error is NOT proof nothing was reversed, and silently
// re-completing an item an operator explicitly reversed is exactly the wrong
// thing to fail open on. `failed` lets the caller (completeTerminalQuoteItems)
// count this as a genuine auto-complete error (FIX 3, below) rather
// than a quiet "nothing eligible" no-op.
async function fetchReversedItemIds(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  itemIds: readonly string[],
): Promise<{ reversedIds: Set<string>; failed: boolean }> {
  if (itemIds.length === 0) return { reversedIds: new Set(), failed: false };
  const { data, error } = await sb
    .from('dashboard_activity')
    .select('inbox_item_id, action')
    .in('inbox_item_id', itemIds)
    .in('action', [...REVERSIBLE_ACTIONS, 'reversed', 'reopened'])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) {
    console.warn('[inbox] terminal-quote auto-complete: reversed-row lookup failed (non-fatal):', error.message);
    return { reversedIds: new Set(), failed: true };
  }
  // Rows arrive newest-first (per the ORDER above) — the FIRST occurrence of
  // each inbox_item_id in iteration order is its most recent state-changing
  // action; later occurrences of the same id are older and ignored.
  const latestActionByItem = new Map<string, string>();
  for (const row of (data ?? []) as { inbox_item_id: string | null; action: string }[]) {
    if (!row.inbox_item_id || latestActionByItem.has(row.inbox_item_id)) continue;
    latestActionByItem.set(row.inbox_item_id, row.action);
  }
  const reversedIds = new Set<string>();
  for (const [itemId, action] of latestActionByItem) {
    if (action === 'reversed') reversedIds.add(itemId);
  }
  return { reversedIds, failed: false };
}

// ─── Terminal-quote auto-complete (#317) ────────────────────────────────────
// Jason's ruling (ledger #317, 2026-08-20, quoted verbatim in the row): once a
// quote's own status derives (deriveStatus) into booked/declined/abandoned
// (quotetool.ts's isAutoCompleteTerminalQuote), the customer "should not show
// up in inbox anymore" — every quotetool item tied to that quote (the bare
// "quote sent" item, external_id === quoteId, AND a `${quoteId}:color-request`
// sibling if one exists — quoteIdPrefix's suffix) is treated as if staff
// clicked Mark completed. Extends #756's isDeadQuote-into-`answered` seam
// (normalizeQuoteTouch, quotetool.ts) one step further: that seam already
// drives the BARE item's touch to 'outbound' for a terminal quote, which the
// reducer (already-shipped, unchanged here) resolves to 'handled' — this
// function is the separate step that finishes the job to 'completed' AND
// reaches the color-request sibling the per-quote reconcile touch structurally
// never can (a different external_id — see normalizeQuoteTouch/ingestTouch,
// which only ever look up `external_id === q.id` exactly).
//
// THE HARD CONSTRAINT (a lens HIGH on #317, pre-merge): never complete a row
// CURRENTLY in the needs_reply bucket (an unanswered inbound) — the live case
// is Susan Pace-Burke's `:color-request` item, unanswered, on a BOOKED quote.
//
// A SECOND HARD CONSTRAINT (row 321, S43 wrap CUSTOMER lens HIGH — LIVE PROD
// CASE): once staff clicks plain "Handled" (not the actual apply/dismiss
// flow) on a `:color-request` item, THIS constraint above no longer protects
// it — status is 'handled', not needs_reply. See the FIX below the FIX-1/
// FIX-2 pair for the added guard: never complete a `:color-request` item
// while its quote's `approval_snapshot.pendingColorRequest` is still live.
// Kristie Tibbetts' request sat unfulfilled and invisible for three weeks
// this exact way.
//
// FIX 1 (row 317 fix-round, customer MED + technical HIGH, one fix):
// eligibility is narrower than "not needs_reply" — it is POSITIVELY
// `status === 'handled'`, nothing else. bucketOf's 'awaiting_reply' bucket
// (lifecycle.ts) also admits status='unresponded' rows with followed_up_at
// set: that is the SNOOZE case (staff clicked Followed on an inbound without
// ever replying to it) — Jason's ruling's own literal exception, "they sent
// us a message and we didn't reply" — so it must never auto-complete, same as
// needs_reply. A prior version of this eligibility check used bucketOf() and
// admitted 'awaiting_reply' wholesale, which silently swept the snooze case in
// too (0 live rows affected — verified by lens SQL, every current awaiting row
// is handled+followed, not unresponded+followed — but the shape was wrong by
// construction). Restricting to the raw `status` column also closes a timing
// hole the bucketOf-based check left open: the SELECT above and the UPDATE
// below are two round-trips, and a genuinely-new inbound landing in that
// window (ingestTouch's reducer reopens the row to status='unresponded' —
// needs_reply) would still have matched the old two-value CAS
// (`.in('status', ['unresponded','handled'])`) on the UPDATE even though the
// row no longer belongs in any eligible bucket by the time the write lands.
// Eligibility below is a POSITIVE allowlist of exactly one status value —
// needs_reply, the snooze case, and the two already-terminal buckets
// (completed, dismissed) are all left untouched by construction, not by a
// negative exclusion (AGENTS.md Pitfalls' positive-seam-gate convention).
//
// Bypasses ingestTouch/planIngest entirely (a direct read-then-guarded-write,
// mirroring closeQuoteInboxNoise/markItemCompleted) rather than teaching the
// reducer a quote-specific status — matching the SAME design call the #222
// TRACKS_OUTBOUND_FIRST_OBSERVATION comment already made ("the alternative,
// teaching this pure, source-generic reducer about a quote-specific flag, is
// worse"). One consequence worth being explicit about: because this never
// calls ingestTouch a second time, #826's noopReingest (which only ever
// short-circuits ingestTouch's OWN upsert) cannot swallow this write — this
// function's UPDATE runs independently of whatever ingestTouch decided this
// tick, including a noop.
//
// Unlike closeQuoteInboxNoise (the view-only-toggle cleanup, #187 FIX 1),
// this DELIBERATELY DOES reach the `:color-request` sibling: view-only is not
// "the customer is done" (a pending colour request stays actionable on a
// view-only quote — see closeQuoteInboxNoise's own doc), but
// booked/declined/abandoned genuinely is, per Jason's ruling, except for the
// needs_reply carve-out above.
//
// Reversible for free: writes the SAME `action: 'completed'` + `detail.from`
// shape markItemCompleted does (REVERSIBLE_ACTIONS already includes
// 'completed'), so the existing reverseItemState stillMatches/CAS path
// (#827-style: re-reads the row, only reverses if it's still in the state
// this action produced) covers these rows with zero new code — distinguished
// from a staff completion via `actor: 'system'` (renders "System" in
// ActivityLog, the established convention) and `detail.auto`/`detail.reason`,
// not a new `action` string (which would need REVERSIBLE_ACTIONS + UI
// changes for no benefit).
//
// Best-effort — never throws (mirrors closeQuoteInboxNoise's non-fatal
// contract; a lookup/write hiccup here must never abort the reconcile tick).
// Returns how many items were actually completed, plus `failed` (row 317
// fix-round FIX 3, mirrors runQuoteToolReconcile's existing followUpErrors
// convention, sync.ts — see QuoteReconcileSummary's own doc): true when a
// Supabase read/write inside this call genuinely errored, so the caller can
// count a degraded tick instead of it reading identically to "0 eligible
// rows this time", which is a legitimate, non-degraded outcome.
export async function completeTerminalQuoteItems(
  quoteId: string,
  now: Date,
): Promise<{ completed: number; failed: boolean }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { completed: 0, failed: false };
  try {
    const { data, error } = await sb
      .from('inbox_items')
      .select('id, external_id, status, followed_up_at')
      .eq('source', 'quotetool')
      .in('external_id', [quoteId, `${quoteId}:color-request`]);
    if (error) {
      console.warn('[inbox] terminal-quote auto-complete: item lookup failed (non-fatal):', error.message);
      return { completed: 0, failed: true };
    }
    const rows = (data ?? []) as { id: string; external_id: string; status: InboxStatus; followed_up_at: string | null }[];
    if (!rows.length) return { completed: 0, failed: false };

    // FIX 1 (row 317 fix-round): status === 'handled' is the ONLY eligible
    // shape — see the doc above. Deliberately NOT bucketOf(): bucketOf's
    // 'awaiting_reply' bucket also covers the snooze case (unresponded +
    // followed_up_at set), which this must exclude.
    const eligibleByStatus = rows.filter((r) => r.status === 'handled');
    if (!eligibleByStatus.length) return { completed: 0, failed: false };

    // FIX (row 321, S43 wrap CUSTOMER lens HIGH): #838 (FIX 1 immediately
    // above) means a plain "Handled" click now makes a `:color-request` item
    // auto-completable — but the customer's request is still sitting live on
    // `quotes.approval_snapshot.pendingColorRequest`, unapplied, until staff
    // works it through ColorRequestPanel. Excluded here BEFORE the write, not
    // merely badged in the UI, because the whole point of this function is
    // that it runs unattended (a cron reconcile tick), with no operator in
    // the loop to see a badge. Only fetches the quote when a color-request-
    // shaped candidate is actually present (the common case — most terminal
    // quotes never had one) — never a per-row query, mirrors
    // fetchReversedItemIds' batched-not-per-row convention just below. Fails
    // CLOSED on a lookup error (same rationale as fetchReversedItemIds' own
    // doc): a query error is not proof the request was resolved, and silently
    // completing a possibly-still-pending request is exactly wrong to fail
    // open on.
    const colorRequestExternalId = `${quoteId}:color-request`;
    let eligibleByColorRequest = eligibleByStatus;
    if (eligibleByStatus.some((r) => r.external_id === colorRequestExternalId)) {
      const { data: quoteRow, error: quoteErr } = await sb
        .from('quotes')
        .select('approval_snapshot')
        .eq('id', quoteId)
        .maybeSingle<{ approval_snapshot: { pendingColorRequest?: unknown } | null }>();
      if (quoteErr) {
        console.warn('[inbox] terminal-quote auto-complete: pending-color-request lookup failed (non-fatal):', quoteErr.message);
        return { completed: 0, failed: true };
      }
      if (quoteRow?.approval_snapshot?.pendingColorRequest) {
        eligibleByColorRequest = eligibleByStatus.filter((r) => r.external_id !== colorRequestExternalId);
      }
    }
    if (!eligibleByColorRequest.length) return { completed: 0, failed: false };

    // FIX 2 (row 317 fix-round, staff HIGH + admin MED converged): a row an
    // operator explicitly Reversed is a deliberate human override of the auto
    // rule for THAT item — without this, eligibility has no memory of that
    // override and the very next reconcile tick (≤5 min later) re-completes
    // it, forever. See fetchReversedItemIds' own doc for the exact
    // action-set convention (mirrors reverseItemState's wrong-occurrence
    // guard below) and the fail-closed rationale. A NEW inbound after the
    // reverse still reopens the item to needs_reply via ingestTouch — FIX 1's
    // status==='handled' gate above already excludes that shape on its own,
    // so this skip never blocks a genuinely new touch from resolving normally.
    const { reversedIds, failed: reversedLookupFailed } = await fetchReversedItemIds(
      sb,
      eligibleByColorRequest.map((r) => r.id),
    );
    if (reversedLookupFailed) return { completed: 0, failed: true };
    const eligible = eligibleByColorRequest.filter((r) => !reversedIds.has(r.id));
    if (!eligible.length) return { completed: 0, failed: false };

    const nowIso = now.toISOString();
    const { data: updated, error: updErr } = await sb
      .from('inbox_items')
      .update({ status: 'completed', followed_up_at: null, handled_by: null, handled_at: nowIso, updated_at: nowIso })
      .in('id', eligible.map((r) => r.id))
      // FIX 1 (row 317 fix-round): narrowed from a two-value
      // `.in('status', ['unresponded', 'handled'])` CAS to a single-value
      // `.eq('status', 'handled')` CAS, matching the eligibility narrowing
      // above — a concurrent reopen (ingestTouch flips status to
      // 'unresponded' on a genuinely-new inbound landing between the SELECT
      // above and this UPDATE) now falls OUTSIDE the guard and is silently
      // excluded from `updated` below, closing the timing hole the old
      // two-value CAS left open (see the doc above this function).
      .eq('status', 'handled')
      .select('id');
    if (updErr) {
      console.warn('[inbox] terminal-quote auto-complete: item resolve failed (non-fatal):', updErr.message);
      return { completed: 0, failed: true };
    }

    const updatedIds = new Set(((updated ?? []) as { id: string }[]).map((r) => r.id));
    const completedRows = eligible.filter((r) => updatedIds.has(r.id));
    if (!completedRows.length) return { completed: 0, failed: false };

    await sb.from('dashboard_activity').insert(
      completedRows.map((r) => ({
        actor: 'system',
        action: 'completed',
        inbox_item_id: r.id,
        detail: {
          auto: true,
          reason: 'quote_terminal',
          from: { status: r.status, wasFollowed: !!r.followed_up_at },
        },
      })),
    );
    await Promise.all(completedRows.map((r) => closeFollowUpsForResolvedItem(r.id, 'completed')));
    return { completed: completedRows.length, failed: false };
  } catch (e) {
    console.warn('[inbox] terminal-quote auto-complete failed (non-fatal):', e);
    return { completed: 0, failed: true };
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
/**
 * Mark inbox items followed when staff have PHONED that person, using the
 * calls already recorded in `call_recordings`. Naldo's ask, 2026-09-02: the
 * /inbox "In the works" list kept nagging about people staff had rung, because
 * nothing but a text or a button click ever cleared a row.
 *
 * The rule lives in callFollowUp.ts and is pure; this function is the thin
 * database wrapper around it. See planCallFollowUps for why it stamps at the
 * CALL's time (that is what makes re-running this a no-op) and callQualifies
 * for the outbound / 30-second / after-the-anchor clauses.
 *
 * SCOPE is deliberately the "In the works" section and nothing else, matching
 * what was asked for: the two buckets that section renders (see
 * applyBucketFilter in lifecycle.ts) are
 *   • awaiting  — followed_up_at set, status not completed/dismissed
 *   • handled   — status 'handled', followed_up_at null
 * The needs-reply list at the TOP of /inbox (status 'unresponded' with no
 * follow-up stamp) is EXCLUDED on purpose. Those are people waiting on US, and
 * snoozing one because somebody phoned would hide a live unanswered customer
 * from the list whose entire job is to show them.
 *
 * `dryRun` returns the plan without writing, which is how the one-off backfill
 * over historical calls was reviewed before it ran.
 *
 * Best-effort per row, like the other sweeps here: one failed stamp is counted
 * and skipped rather than aborting the tick.
 */
export async function sweepCallFollowUps(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<{ ok: true; planned: CallFollowUpStamp[]; stamped: number; failed: number } | { ok: false; error: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const limit = opts.limit ?? 5000;

  // Both "In the works" buckets in one read: anything not terminal that either
  // carries a follow-up stamp or is sitting handled. The `.or` mirrors
  // applyBucketFilter's two predicates rather than re-deriving them loosely —
  // a row must be in one of those two buckets to be eligible.
  const { data: itemRows, error: itemErr } = await sb
    .from('inbox_items')
    .select('id, status, followed_up_at, last_inbound_at, last_message_at, contact_id, dashboard_contacts(ghl_contact_id)')
    .not('status', 'in', '(completed,dismissed)')
    .or('followed_up_at.not.is.null,status.eq.handled')
    .limit(limit);
  if (itemErr) return { ok: false, error: itemErr.message };

  const items: CallFollowUpItem[] = (itemRows ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const contact = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
    return {
      id: String(row.id),
      ghlContactId: (contact?.ghl_contact_id as string | null) ?? null,
      followedUpAt: row.followed_up_at ? new Date(String(row.followed_up_at)) : null,
      lastInboundAt: row.last_inbound_at ? new Date(String(row.last_inbound_at)) : null,
      lastMessageAt: row.last_message_at ? new Date(String(row.last_message_at)) : null,
    };
  });

  const contactIds = [...new Set(items.map((i) => i.ghlContactId).filter((id): id is string => !!id))];
  if (contactIds.length === 0) return { ok: true, planned: [], stamped: 0, failed: 0 };

  // Filter on the qualifying clauses in the QUERY as well as in the pure rule.
  // The rule is still the authority (callQualifies re-checks every clause); this
  // just avoids dragging every ring-out across the wire.
  const { data: callRows, error: callErr } = await sb
    .from('call_recordings')
    .select('ghl_contact_id, direction, called_at, duration_seconds, is_test, skip_reason')
    .in('ghl_contact_id', contactIds)
    .eq('direction', 'outbound')
    .gte('duration_seconds', MIN_CALL_SECONDS)
    // Newest first, so that if the cap ever bites it drops the OLDEST calls —
    // the ones least likely to be the latest qualifying call for any row.
    // Without an order the surviving set past the cap is non-deterministic, and
    // so is which call the planner picks as "latest" (pre-merge admin lens).
    .order('called_at', { ascending: false })
    .limit(limit);
  if (callErr) return { ok: false, error: callErr.message };

  const calls: ContactCall[] = (callRows ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      ghlContactId: (row.ghl_contact_id as string | null) ?? null,
      direction: (row.direction as string | null) ?? null,
      durationSeconds: typeof row.duration_seconds === 'number' ? row.duration_seconds : null,
      calledAt: new Date(String(row.called_at)),
      isTest: row.is_test === true,
      junkReason: (row.skip_reason as string | null) ?? null,
    };
  });

  const planned = planCallFollowUps({ items, calls });
  if (opts.dryRun) return { ok: true, planned, stamped: 0, failed: 0 };

  let stamped = 0;
  let failed = 0;
  for (const stamp of planned) {
    // allowRestamp: this is the re-chase case by design. A row already marked
    // followed that has gone quiet again SHOULD have its clock reset by a real
    // phone call — that is the behaviour Naldo chose, and the reason the manual
    // button refuses to restamp (a duplicate click must not move the customer's
    // waiting clock) does not apply to a genuine new conversation.
    const res = await markItemFollowed(stamp.itemId, 'system', stamp.calledAt, {
      allowRestamp: true,
      via: 'call',
      // The same instant the plan was built against. If the customer has
      // written since this snapshot was read, the UPDATE matches nothing and
      // their row correctly stays in the needs-reply state the webhook put it
      // in, instead of being snoozed by a call that predates their reply.
      requireNoInboundAfter: stamp.calledAt,
    });
    if (res.ok) stamped += 1;
    else failed += 1;
  }
  return { ok: true, planned, stamped, failed };
}

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

/** Row 391: the read cap on `listDueFollowUps`, named so the truncation signal
 *  below can be derived from it rather than from a repeated literal. */
export const DUE_FOLLOW_UPS_CAP = 100;

export type DueFollowUpsResult =
  | {
      ok: true;
      items: DueFollowUp[];
      /** Row 391: the REAL number of pending follow-ups due today or earlier,
       *  independent of the page cap — the direct analogue of listOpenItems'
       *  `totalOpen`, and floored the same way so `totalDue - items.length`
       *  can never go negative. */
      totalDue: number;
      /** Row 391: true when the cap hid due follow-ups from this page. */
      truncated: boolean;
    }
  | { ok: false; error: string };

/**
 * Pending follow-ups due today or overdue (ET). PR #1005 deleted the top
 * strip this fed; today it backs the "N follow-ups due" count beside the
 * In-the-works awaiting bucket AND (#229)
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
  // Row 391: the cap is applied by the DB BEFORE the isDueToday filter below,
  // and the read is oldest-first, so a backlog of 100+ overdue nags fills the
  // page and today's fresh ones never arrive. Two halves to the fix:
  //  (a) bound the QUERY to the same due window the filter enforces, so the cap
  //      is spent only on rows that can actually appear (they already were —
  //      due_at ascending makes the due rows a prefix — but this is what lets
  //      Postgrest's exact count mean "due", not "pending at any future date");
  //  (b) report that count, so the strip can say how many are not shown.
  // The bound is the ET start of tomorrow, exclusive, which is exactly
  // isDueToday's `etDayKey(dueAt) <= etDayKey(now)`. It reuses payroll's
  // etMidnightAfter rather than re-deriving ET midnight here: that function
  // already carries the DST-convergence fix (a naive noon-offset probe is an
  // hour wrong on both transition days), and a second copy would drift.
  const dueBefore = etMidnightAfter(now).toISOString();
  const { data, error, count } = await sb
    .from('follow_ups')
    .select(
      'id, reason, due_at, re_chase_since, dashboard_contacts ( display_name, primary_phone, primary_email )',
      { count: 'exact' },
    )
    .eq('status', 'pending')
    .lt('due_at', dueBefore)
    .order('due_at', { ascending: true })
    .limit(DUE_FOLLOW_UPS_CAP);
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
        // Row 390: non-null only for a re-chase (row 385's re-arm after 7
        // quiet days on a handled item) — see ensureFollowUp's own write of
        // this column for the full reasoning.
        reChaseSince: (r.re_chase_since as string | null) ?? null,
      };
    });
  // Row 391: `count` is null only if Postgrest didn't return one (it should,
  // with { count: 'exact' }) — fall back to the page length rather than lie
  // low. Floored against items.length for the same reason listOpenItems floors
  // totalOpen: the strip subtracts these, and a negative "N more not shown"
  // would be worse than no signal at all. The floor also absorbs the one way
  // the two can legitimately disagree — the isDueToday filter is evaluated in
  // JS while the count comes from the SQL bound, so a row sitting within a
  // millisecond of the ET boundary can be counted and then filtered out.
  const totalDue = Math.max(count ?? items.length, items.length);
  return { ok: true, items, totalDue, truncated: totalDue > items.length };
}

export type PendingColorRequestsResult =
  | { ok: true; items: PendingColorRequestItem[] }
  | { ok: false; error: string };

/**
 * Row 321 (S43 wrap CUSTOMER lens, HIGH — LIVE PROD CASE): the ONLY existing
 * view of a pending colour request was `ColorRequestPanel`, gated on
 * `approval_snapshot?.pendingColorRequest` and rendered only on that ONE
 * quote's own /admin/quotes/[id] page — nothing else in the app surfaced it,
 * so once the inbox item that announced it left the board (Handled/Mark
 * completed, or #317's terminal auto-complete), the request became invisible
 * with no trace but a generic activity row. Kristie Tibbetts' colour request
 * sat unfulfilled for three weeks this way (her inbox item was marked
 * completed on 08-18; her quote's pendingColorRequest is still set today).
 *
 * This reads pendingColorRequest DIRECTLY off `quotes.approval_snapshot` —
 * independent of any inbox_items row's status — so a hidden/completed/
 * dismissed inbox item can never suppress it. Feeds a standing /inbox section
 * (PendingColorRequestsSection) that lists every quote with a live request
 * and links to the admin page where ColorRequestPanel can act on it.
 *
 * Bounded + single query, same chokepoint filters (is_test/view_only) as
 * listQuotesForDashboard (queries.ts) — the live population is 2 quotes
 * today; `limit` guards the pathological case without ever fetching more than
 * one page over the wire. `.not('approval_snapshot->pendingColorRequest',
 * 'is', null)` filters server-side (confirmed against prod: matches exactly
 * the 2 live requests, `EXPLAIN` shows one Seq Scan over the ~190-row quotes
 * table — no per-row fetch, no N+1).
 *
 * Row 321 fix-round FIX 5 (customer LOW): `.order('id', ...)` paired with
 * `.limit()` — this repo's established convention (the #185 precedent, e.g.
 * the returning-proxy count query above) — so the capped subset is
 * DETERMINISTIC. Without it, the in-memory oldest-first sort below only holds
 * within an ARBITRARY (unordered-query) subset once the live population ever
 * exceeds `limit`; a request could nondeterministically drop off the list
 * between loads.
 */
export async function listPendingColorRequests(limit = 200): Promise<PendingColorRequestsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('quotes')
    .select('id, customer_name, quote_number, approval_snapshot')
    .eq('is_test', false)
    .eq('view_only', false)
    .not('approval_snapshot->pendingColorRequest', 'is', null)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as {
    id: string;
    customer_name: string | null;
    quote_number: number | null;
    approval_snapshot: { pendingColorRequest?: { label?: string; requestedAt?: string } } | null;
  }[])
    .map((r): PendingColorRequestItem | null => {
      const pending = r.approval_snapshot?.pendingColorRequest;
      if (!pending) return null; // defensive — the query filter above already excludes these
      return {
        quoteId: String(r.id),
        quoteNumber: r.quote_number,
        customerName: r.customer_name,
        label: pending.label || 'Colour change',
        requestedAt: pending.requestedAt ?? null,
      };
    })
    .filter((i): i is PendingColorRequestItem => i !== null)
    // Oldest request first — the longest-waiting customer surfaces at the top,
    // matching every other /inbox strip's stalest-first convention. A tiny
    // in-memory sort over a population capped at `limit` (2 rows today).
    .sort((a, b) => (a.requestedAt ?? '').localeCompare(b.requestedAt ?? ''));
  return { ok: true, items };
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
  /** Needed with `preview` to recognise a forwarded lead. See IN_WORKS_SELECT.
   *  Optional so the existing fixtures that omit it keep compiling, the same
   *  concession isColorRequest makes just below. */
  subject?: string | null;
  customerName: string | null;
  lastActivityAt: string | null;
  // #307: null for every 'awaiting' row (the rule set below only evaluates the
  // 'handled' bucket) and for a 'handled' row where none of the three signals
  // fire. Non-null is the single displayed reason — see needsLookReason's own
  // doc comment for why only one shows when a row trips more than one rule.
  needsLookReason: string | null;
  /** What backed the follow-up stamp: call, reply, manual, or null for a
   *  stamp written before the column existed. See followBacking.ts. */
  followedVia?: string | null;
  /** Row 321: true when this item both LOOKS like a colour request (a
   *  `quotetool` item whose external_id carries the `:color-request` suffix)
   *  AND its backing quote still carries a LIVE
   *  `approval_snapshot.pendingColorRequest` — badges + confirm-gates "Mark
   *  completed" in InWorksSection.tsx. Applies to BOTH the 'awaiting' and
   *  'handled' buckets — fix-round FIX 1 added external_id to
   *  IN_WORKS_SELECT for both precisely to close the HIGH where the
   *  'awaiting' bucket read this as false unconditionally; do not narrow it
   *  back to handled-only. See isLiveColorRequestItem for the shape+liveness
   *  rule, including its fail-safe over-warn direction on a lookup error.
   *  Optional so existing fixtures that omit it read as false. */
  isColorRequest?: boolean;
};
export type InWorksResult =
  | {
      ok: true;
      awaiting: InWorksItem[];
      handled: InWorksItem[];
      // #307 review fix 2: true when either of the two needsLookReason evidence
      // lookups (quote status, pending follow-up) failed and fell back to an
      // empty result — meaning some row may be missing its reason and reads as
      // settled when the evidence for that couldn't be checked. PR #1005: that
      // now covers the AWAITING bucket too (a missing "Follow-up due" pill),
      // not just 'handled' rows missing a "Needs a look" reason.
      evidenceIncomplete: boolean;
    }
  | { ok: false; error: string };

// Row 321 fix-round FIX 1 (technical HIGH): external_id now selected for BOTH
// buckets — it used to be handled-only ("avoid churning the shared select"),
// which is exactly what let the HIGH through: the 'awaiting' bucket (the
// Handled -> Followed/snooze path) read isColorRequest:false unconditionally
// no matter what, because the column was never fetched at all. That earlier
// scoping call is overruled here; every InWorksItem now carries external_id.
// `subject` (2026-09-02): parseLeadForwardDisplay needs BOTH subject and
// preview -- the subject carries the platform marker, the preview carries the
// phone and email -- so without it InWorksSection could only ever show
// "Reply in Gmail" on a forwarded lead, which is the one thing replying will
// not do. #268's fix round found that and deliberately left it, documented, as
// a follow-up needing this change. This is that follow-up.
const IN_WORKS_SELECT =
  'id, source, external_id, channel, subject, preview, followed_up_at, followed_via, handled_at, status, dashboard_contacts ( display_name )';

// #307: the 'handled' bucket alone also needs direction (rule b) to compute
// "Needs a look" — the 'awaiting' bucket's query stays on the narrower
// IN_WORKS_SELECT. PR #1005 gives awaiting rows needsLookReason rule (c)
// (follow-up due) from a set keyed on id, which this select already carries;
// rules (a) and (b) still do not apply there, so this column stays
// handled-only. See listInWorks' awaiting mapping for why only rule (c).
const IN_WORKS_HANDLED_SELECT = IN_WORKS_SELECT + ', direction';

function mapInWorksRow(
  rows: unknown[],
  tsKey: 'followed_up_at' | 'handled_at',
  colorRequestLookup: { liveIds: ReadonlySet<string>; failed: boolean },
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
      subject: (row.subject as string | null) ?? null,
      customerName: (c?.display_name as string | null) ?? null,
      lastActivityAt: (row[tsKey] as string | null) ?? null,
      followedVia: (row.followed_via as string | null) ?? null,
      needsLookReason: reasonFor ? reasonFor(row) : null,
      // Row 321 fix-round FIX 1: shape AND liveness, for BOTH buckets now
      // that external_id is selected on both — see isLiveColorRequestItem's
      // own doc for the fail-safe direction on a lookup error.
      isColorRequest: isLiveColorRequestItem(row.source, String(row.external_id ?? ''), colorRequestLookup),
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
 *
 * PR #1005: bounded to follow-ups actually DUE (due_at before the ET start of
 * tomorrow — the same bound listDueFollowUps uses, via the same
 * etMidnightAfter, so the two can never drift onto different definitions of
 * "due"). Before this it matched any PENDING row, and every nag is created
 * pending the moment a quote is sent with a due date three days out — so a
 * quote sent an hour ago would have rendered "Follow-up due" immediately,
 * which is a false claim on staff's screen. Zero rows differ in prod today
 * (33 pending, all 33 already due, measured 2026-08-27); this is the
 * structural fix, not an incident. It matters now because PR #1005 feeds this
 * set to the AWAITING bucket too, where a freshly-followed-up quote is the
 * normal case rather than the exception.
 */
async function fetchPendingFollowUpItemIds(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  itemIds: readonly string[],
  now: Date,
): Promise<{ ids: Set<string>; failed: boolean }> {
  if (itemIds.length === 0) return { ids: new Set(), failed: false };
  const { data, error } = await sb
    .from('follow_ups')
    .select('inbox_item_id')
    .eq('status', 'pending')
    .lt('due_at', etMidnightAfter(now).toISOString())
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
 *  carries needsLookReason (#307) — computed from two BATCHED lookups (a
 *  quote-status map + a due-follow-up set), never a per-row query; PR #1005 also
 *  gives every AWAITING row the follow-up-due reason from that same set (see
 *  the comment at its mapping call for why only that one rule applies there).
 *  `evidenceIncomplete` (#307 review fix 2) is true when either of those two
 *  lookups failed and fell back to empty — the caller renders that as a
 *  visible note rather than only the server-side console.error already inside
 *  each lookup. */
export async function listInWorks(limit = 200, now: Date = new Date()): Promise<InWorksResult> {
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

  const awaitingRows = (aw.data ?? []) as unknown as Record<string, unknown>[];
  const handledRows = (hd.data ?? []) as unknown as Record<string, unknown>[];
  // PR #1005: BOTH buckets now, not handled-only. The "Follow-ups due today"
  // strip that used to carry this signal at the top of /inbox is deleted in
  // this same change; 31 of its 33 live rows were anchored to items sitting in
  // the AWAITING bucket (measured 2026-08-27), so scoping this lookup to
  // `handled` would have dropped the signal for 94% of them rather than moving
  // it. The awaiting bucket's own amber "Follow up — Nd quiet" chip is not a
  // substitute: it fires on elapsed time alone (68 of 91 awaiting rows today),
  // where this fires on a real due follow-up.
  const followUpLookupIds = [...new Set([...awaitingRows, ...handledRows].map((r) => String(r.id)))];
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
  // Row 321 fix-round FIX 1: color-request liveness ids come from BOTH
  // buckets — unlike quotetoolQuoteIds above (needsLookReason only applies to
  // the handled bucket), the HIGH this fix closes is specifically the
  // AWAITING bucket never carrying isColorRequest at all. ONE query covers
  // both buckets combined, not one per bucket.
  const colorRequestQuoteIds = [
    ...new Set(
      [...awaitingRows, ...handledRows]
        .filter((r) => r.source === 'quotetool' && isColorRequestExternalId(String(r.external_id ?? '')))
        .map((r) => quoteIdPrefix(String(r.external_id)))
        .filter(isUuid),
    ),
  ];
  const [quoteStatusResult, pendingFollowUpResult, colorRequestLookup] = await Promise.all([
    fetchQuoteStatusesById(sb, quotetoolQuoteIds),
    fetchPendingFollowUpItemIds(sb, followUpLookupIds, now),
    fetchLiveColorRequestQuoteIds(sb, colorRequestQuoteIds),
  ]);
  const quoteStatusById = quoteStatusResult.statuses;
  const pendingFollowUpItemIds = pendingFollowUpResult.ids;

  const handled = mapInWorksRow(handledRows, 'handled_at', colorRequestLookup, (row) => {
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

  // PR #1005: the awaiting bucket gets ONLY the follow-up-due reason, never the
  // other two needsLookReason rules. That is deliberate, not an oversight:
  // rule (a) "Quote unanswered" is true of nearly every row in this bucket by
  // construction (you followed up on a sent, unapproved quote — that is what
  // the bucket IS), so surfacing it here would paint ~everything and mean
  // nothing, which is the exact wallpaper problem the deleted strip's
  // replacement is supposed to avoid. Rule (b) needs `direction`, which the
  // awaiting query deliberately does not select. Routed through the shared
  // needsLookReason rather than emitting the string inline so the two buckets
  // can never drift onto two different wordings for one condition.
  const awaiting = mapInWorksRow(awaitingRows, 'followed_up_at', colorRequestLookup, (row) =>
    needsLookReason({
      direction: null,
      quoteStatus: null,
      followUpPending: pendingFollowUpItemIds.has(String(row.id)),
    }),
  );

  return {
    ok: true,
    awaiting,
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
 * the operator via the ok:false path; a wrongly-allowed clobber is not).
 *
 * Row 321 fix-round FIX 1(b) (server-side backstop): a client window.confirm()
 * is not a guard — it can be stale, bypassed, or raced. Before the status-
 * guarded UPDATE runs, a `:color-request`-shaped item whose quote still has a
 * live approval_snapshot.pendingColorRequest is REFUSED, mirroring
 * completeTerminalQuoteItems' own hard exclusion of the same shape (see that
 * function's doc). Chosen over allow-with-audit: the whole point of this
 * feature is that a colour request stays actionable until ColorRequestPanel
 * resolves it (apply/dismiss) — completing the INBOX message while
 * pendingColorRequest stays set would reproduce Kristie Tibbetts' exact bug
 * with an audit trail bolted on, not fix it. An operator who genuinely
 * resolved this by phone records that via ColorRequestPanel's own Dismiss
 * flow (which prompts for a reason) — that clears pendingColorRequest and
 * this guard then passes normally on the next attempt. markItemHandledLocal
 * deliberately does NOT get the same guard: 'handled' is not terminal — the
 * item stays fully tracked (badge + confirm both still apply) in
 * InWorksSection's 'handled'/'awaiting' buckets either way, so nothing is
 * buried by that action alone; only Mark completed actually removes the item
 * from every inbox list. Fails CLOSED on its own lookup error, same
 * direction as completeTerminalQuoteItems' pendingColorRequest check: a query
 * error is not proof the request was resolved. */
export async function markItemCompleted(
  itemId: string,
  operatorId: string | null,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);

  // Row 321 fix-round FIX 1(b): a targeted, separate `inbox_items` lookup for
  // external_id — never folded into priorStateOf above, which is shared by
  // three OTHER actions whose dashboard_activity `detail.from` shape this
  // must not change. This select itself runs on EVERY markItemCompleted call
  // — a second inbox_items round-trip alongside priorStateOf's own, on the
  // general hot path (not just shape-matching items); only the follow-on
  // 'quotes' query below is conditional, firing solely when the item is
  // actually shape-matching. Accepted tradeoff, not an oversight: folding
  // this into priorStateOf would risk that shared `detail.from` contract for
  // its three other callers, and an extra small select on every completion
  // is cheaper than that risk.
  const target = await sb.from('inbox_items').select('external_id').eq('id', itemId).maybeSingle();
  const targetExternalId = String((target.data as { external_id?: string | null } | null)?.external_id ?? '');
  if (isColorRequestExternalId(targetExternalId)) {
    const quoteId = quoteIdPrefix(targetExternalId);
    const { data: quoteRow, error: quoteErr } = await sb
      .from('quotes')
      .select('approval_snapshot')
      .eq('id', quoteId)
      .maybeSingle<{ approval_snapshot: { pendingColorRequest?: unknown } | null }>();
    if (quoteErr) {
      const msg = "Could not confirm the colour request is resolved — try again";
      await recordActionFailed(itemId, operatorId, 'completed', msg);
      return { ok: false, error: msg };
    }
    if (quoteRow?.approval_snapshot?.pendingColorRequest) {
      const msg = "This customer has a pending colour change request — resolve it from the quote's admin page first";
      await recordActionFailed(itemId, operatorId, 'completed', msg);
      return { ok: false, error: msg };
    }
  }

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
  if (error) {
    await recordActionFailed(itemId, operatorId, 'completed', error.message);
    return { ok: false, error: error.message };
  }
  if (!data) {
    const msg = 'Item not found, already completed, or dismissed';
    await recordActionFailed(itemId, operatorId, 'completed', msg);
    return { ok: false, error: msg };
  }
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
  /** row 317 fix-round FIX 4 (staff LOW): non-null only when this row's own
   *  `detail.auto` is true (currently only completeTerminalQuoteItems's
   *  'completed' rows) — carries `detail.reason` so ActivityLog can render WHY
   *  an action was automatic, not just THAT it was (friendlyActor already
   *  covers the THAT-it-was-System half). null for every operator-driven row,
   *  including 'system'-actor rows that aren't auto (e.g. setEscalation). */
  autoReason: string | null;
  /** Row 311 fix-round FIX 2: only meaningful when action === 'action_failed'
   *  — `{ action: <the verb that failed>, error: <message> }`, the same shape
   *  recordActionFailed writes (above). Every other action's own `detail`
   *  (e.g. `{ from }`) is not surfaced through this field — ActivityLog has no
   *  use for it. Optional/nullable so the pre-existing synthetic 'reversed'
   *  row ActivityLog.tsx builds client-side (which never had a detail) still
   *  satisfies this type unchanged. */
  detail?: { action?: string; error?: string } | null;
};
export type ActivityResult = { ok: true; rows: ActivityRow[] } | { ok: false; error: string };

// row 312: 'reclassified' added — the 26 S41 data-op rows say "reversible by
// setting followed_up_at back to null" in their own detail text; it belongs
// here so /inbox/activity actually renders the Reverse button that wording
// promises (see inverseOf's 'reclassified' case, lifecycle.ts).
const REVERSIBLE_ACTIONS = new Set(['handled', 'followed', 'completed', 'dismissed', 'reclassified']);

/**
 * row 312 fix-round FIX 3 (MED, admin lens, prod-verified): the bare action
 * string 'reclassified' covers TWO populations in prod (confirmed via a direct
 * query, 2026-08-20) — 26 S41 bucket-refile rows (`actor: 'system'`, detail
 * carries `followedUpAtSetTo`/`from`/`to`; inverseOf('reclassified')'s premise
 * — "only ever set followed_up_at" — holds) and 8 `actor:
 * 'assistant-backfill-268'` rows (2026-08-14, a lead_kind/contact repoint;
 * detail carries `reason`/`customer`/`from_contact` and NONE of the 8 carry
 * followedUpAtSetTo — the inverse's premise is false for them). Today the 8 are
 * refused only by the emergent luck of their item's current followed_up_at
 * reading null — gate on the PAYLOAD shape instead of the bare action string so
 * that holds by construction. Non-'reclassified' actions are unaffected (their
 * detail shape has never split into two populations).
 */
export function isReversibleActivity(action: string, detail: unknown): boolean {
  if (!REVERSIBLE_ACTIONS.has(action)) return false;
  if (action !== 'reclassified') return true;
  return !!(detail && typeof detail === 'object' && 'followedUpAtSetTo' in (detail as Record<string, unknown>));
}

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
      // `detail` is needed twice over: isReversibleActivity (row 312 fix round)
      // uses it to tell the two 'reclassified' populations apart, and an
      // 'action_failed' row (row 311 fix round) renders WHICH action failed and
      // why — see ActivityRow's own doc comment.
      .select(
        'id, action, actor, inbox_item_id, created_at, detail, inbox_items ( dashboard_contacts ( display_name ) )',
      )
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
    // row 317 fix-round FIX 4: only ever non-null when the row's own writer
    // set `detail.auto === true` (completeTerminalQuoteItems, above) — an
    // operator-driven row's detail never carries that shape.
    const detail = row.detail as { auto?: boolean; reason?: string } | null;
    return {
      id: String(row.id),
      action: String(row.action),
      actor,
      actorName: actor ? (labels.get(actor) ?? null) : null,
      itemId: (row.inbox_item_id as string | null) ?? null,
      customerName: (item?.dashboard_contacts?.display_name as string | null) ?? null,
      at: (row.created_at as string | null) ?? null,
      reversible: isReversibleActivity(String(row.action), row.detail),
      autoReason: detail?.auto ? (detail.reason ?? null) : null,
      detail: (row.detail as { action?: string; error?: string } | null) ?? null,
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

  const reversible: ReverseAction[] = ['handled', 'followed', 'completed', 'dismissed', 'reclassified'];
  // row 312 fix-round FIX 3 (MED): the bare action-string check above is
  // necessary but not sufficient for 'reclassified' — see isReversibleActivity's
  // doc (two prod populations share the action string; only one's inverse
  // premise holds). A direct POST naming an unreversible-by-payload row is
  // refused here with the same message a genuinely-unreversible action gets.
  if (!reversible.includes(a.action as ReverseAction) || !isReversibleActivity(a.action, a.detail)) {
    return { ok: false, error: 'This entry cannot be reversed' };
  }
  const action = a.action as ReverseAction;

  // row 312(c) wrong-occurrence guard: stillMatches (below) only checks that the
  // CURRENT state happens to equal what this action would have produced — it
  // can't tell that state apart from an unrelated LATER action that coincidentally
  // landed the item back in the same state (e.g. a later Reverse restores
  // status='handled', which then also matches a much-older, unrelated 'handled'
  // row for the same item). Require this row to actually be the most recent
  // state-changing row for the item before trusting stillMatches at all.
  // row 312 fix-round FIX 5(b) (LOW, hardening): 'reopened' added to the tracked
  // action set. A reopen (ingestTouch, on a genuinely-newer inbound) sets status
  // back to 'unresponded' — a real state change this guard should know about.
  // Verified NON-exploitable today without this: if a 'reopened' row landed
  // after the row being reversed, stillMatches (below) already catches the
  // divergence (curRow.status would read 'unresponded', not the action's
  // expected value) and refuses independently. Added anyway so this guard's own
  // action list stays self-documenting/complete rather than relying on a
  // different check to cover the gap.
  const { data: latest, error: latestErr } = await sb
    .from('dashboard_activity')
    .select('id')
    .eq('inbox_item_id', a.inbox_item_id)
    .in('action', [...reversible, 'reversed', 'reopened'])
    .order('created_at', { ascending: false })
    // row 312 fix-round FIX 5(a) (LOW, hardening): secondary tiebreaker so two
    // rows sharing an identical created_at (e.g. a batch data-op script that
    // stamps the same timestamp across many inserts) resolve deterministically
    // instead of depending on whatever order Postgres happens to return ties
    // in. `id` is a random uuid (gen_random_uuid()), not chronological, so this
    // doesn't recover true insertion order on a real tie — it only guarantees
    // the SAME row wins every time this query runs, mirroring the #185
    // determinism comment elsewhere in this file (listOpenItems' `returning`
    // count).
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  // row 312 fix-round FIX 2 (MED, technical + staff converged): the prior code
  // destructured only `{ data: latest }` — a query ERROR left `latest` null/
  // undefined and the `if (latest && ...)` guard below read that as "no later
  // row exists," silently PASSING the wrong-occurrence check on a failed read
  // (fails OPEN). Opposite of this function's other two reads (the `act` and
  // `cur` lookups above/below), which both fail CLOSED today — a query error on
  // either one leaves their `data` null too, and `if (!data) return { ok: false,
  // ... }` refuses regardless of whether the null came from a real error or a
  // genuine not-found. Fail closed here too: a query error is NOT proof no later
  // action exists, and Reverse is exactly the wrong feature to fail open on.
  if (latestErr) {
    return { ok: false, error: 'Could not verify this is the latest action for this item — try again' };
  }
  if (latest && String((latest as { id: string }).id) !== activityId) {
    return { ok: false, error: 'A later action already changed this item; nothing to reverse from here' };
  }

  // Only reverse if the item is STILL in the state this action produced — otherwise
  // a later action superseded it and reversing now would clobber the newer state.
  // This is a fast, friendly pre-check only — it does NOT by itself de-dupe a
  // double-clicked reverse (a read-check-then-act has a race window between this
  // read and the write below); the atomic CAS on the update IS what de-dupes it,
  // see the fix-round comment there.
  const { data: cur } = await sb
    .from('inbox_items')
    .select('status, followed_up_at')
    .eq('id', a.inbox_item_id)
    .maybeSingle();
  if (!cur) return { ok: false, error: 'Item not found' };
  const curRow = cur as { status: string; followed_up_at: string | null };
  // 'reclassified', like 'followed', only ever sets followed_up_at — never
  // status — so its match check is the same shape (see inverseOf's doc).
  const stillMatches =
    action === 'followed' || action === 'reclassified' ? curRow.followed_up_at != null : curRow.status === action;
  if (!stillMatches) return { ok: false, error: 'Item state has changed since this action; nothing to reverse' };

  const t = inverseOf(action, a.detail?.from as { status?: InboxStatus; wasFollowed?: boolean } | undefined);

  const upd: Record<string, unknown> = { updated_at: now.toISOString() };
  if (t.status) upd.status = t.status;
  if (t.clearFollowed) upd.followed_up_at = null;
  if (t.setFollowed) upd.followed_up_at = now.toISOString();

  // row 312 fix-round HIGH (technical lens, sibling-parity class): re-encode the
  // SAME condition `stillMatches` just checked, atomically, IN the update's WHERE
  // — mirrors markItemHandledLocal / dismissItem's sibling CAS idiom in this same
  // file (`.eq('id').neq('status', target).select().maybeSingle()`, no-row-
  // matched = refused). Without this the read above and this write are two
  // separate round-trips: a concurrent write (e.g. another operator's Mark
  // handled) landing in that window would be silently clobbered by an
  // unconditional update, and a double-clicked Reverse would double-apply (the
  // OLD comment here claimed the read-check alone "de-dupes" that — false, since
  // read-check-then-act has no such property on its own). The CAS closes both:
  // after the first write succeeds the row's status/followed_up_at no longer
  // matches `action`'s condition, so a second concurrent call's WHERE matches
  // zero rows and it gets the same honest refusal as the wrong-occurrence guard
  // above, instead of clobbering the first call's result.
  let casQuery = sb.from('inbox_items').update(upd).eq('id', a.inbox_item_id);
  casQuery =
    action === 'followed' || action === 'reclassified'
      ? casQuery.not('followed_up_at', 'is', null)
      : casQuery.eq('status', action);
  const { data: casRow, error } = await casQuery.select('id').maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!casRow) return { ok: false, error: 'Item state has changed since this action; nothing to reverse' };

  if (t.unsuppress) {
    const { data: c } = await sb
      .from('inbox_items')
      .select('dashboard_contacts ( primary_email, primary_phone )')
      .eq('id', a.inbox_item_id)
      .maybeSingle();
    const dc = (
      c as { dashboard_contacts?: { primary_email?: string | null; primary_phone?: string | null } } | null
    )?.dashboard_contacts;
    if (dc)
      await removeSuppressedSenders([dc.primary_email ?? null, dc.primary_phone ?? null], {
        actor: operatorId ?? null,
        inboxItemId: a.inbox_item_id,
        note: 'reversed a dismiss',
      });
  }

  // row 312 fix-round FIX 4 (MED, admin lens): carry the reversed row's own id
  // + the prior values this reverse is clearing/restoring, mirroring the
  // `detail: { from }` shape the forward siblings (markItemHandledLocal,
  // dismissItem, markItemCompleted) already write. `curRow` and `activityId`
  // are already in scope — without this, a 'reversed' row told you WHAT action
  // got undone but not WHICH activity row or what state it undid, so the audit
  // trail couldn't answer "what did this reverse actually change" without
  // cross-referencing the original row by hand.
  await sb.from('dashboard_activity').insert({
    actor: operatorId,
    action: 'reversed',
    inbox_item_id: a.inbox_item_id,
    detail: {
      reversed_action: a.action,
      reversedActivityId: activityId,
      from: { status: curRow.status, followedUpAt: curRow.followed_up_at },
    },
  });

  return { ok: true };
}
