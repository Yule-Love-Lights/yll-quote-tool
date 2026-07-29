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
import { isDueToday, quoteSentNoReplyFollowUp } from './followups';
import type { MetricItem, WindowKey, ReopenCounts } from './responseMetrics';
import { addSuppressedSenders, removeSuppressedSenders } from './suppression';
import { inverseOf, type ReverseAction } from './lifecycle';
import { listOperatorAccounts } from '@/lib/auth/adminUsers';

// ─── Pure ingest planner ────────────────────────────────────────────────────

export type ExistingItem = {
  id: string;
  contactId: string | null;
  status: InboxStatus;
  notifiedLevels: number[];
  lastMessageAt: Date | null;
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
  /** When true, do nothing: an outbound touch with no existing item is us
   *  cold-contacting — there's no unresponded lead to track (avoids noise). A
   *  conversation we REPLIED to keeps its existing item and still auto-resolves. */
  skip: boolean;
  /** When true, a resolved item (handled/completed/dismissed) is being re-ingested
   *  with NOTHING to persist — same status, same last_message_at, no reopen /
   *  auto-resolve / snooze-clear. The reconcile cron re-reads these every minute,
   *  so writing them anyway floods inbox_items (fresh updated_at) + dashboard_activity
   *  with dead 'ingested' rows. ingestTouch short-circuits on it (#110 W7-004). */
  noopReingest: boolean;
  contactOp: ContactOp;
  item: ItemRow;
  autoResolved: boolean;
  reopened: boolean;
  ambiguous: boolean;
  clearFollowedUp: boolean;
};

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

  // #110 W7-004: a resolved item re-ingested with nothing to persist is a no-op.
  // Restricted to resolved statuses (escalation_level is fixed at 0, so skipping
  // never freezes an aging unresponded item's display colour) AND an unchanged
  // last_message_at (our own outbound reply re-read every reconcile is the common
  // case). Everything that actually changes state — reopen, auto-resolve,
  // snooze-clear, a newer message — falls through and writes normally.
  const isResolvedStatus =
    decision.status === 'handled' || decision.status === 'completed' || decision.status === 'dismissed';
  const noopReingest =
    !!existing &&
    !decision.autoResolved &&
    !decision.reopened &&
    !clearFollowedUp &&
    isResolvedStatus &&
    decision.status === existing.status &&
    existing.lastMessageAt != null &&
    touch.lastMessageAt.getTime() === existing.lastMessageAt.getTime();

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

  return {
    skip: !existing && touch.direction === 'outbound',
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
  const { data } = await sb
    .from('inbox_items')
    .select('id, contact_id, status, notified_levels, last_message_at')
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
  | { ok: true; skipped: boolean; itemId: string | null; contactId: string | null; autoResolved: boolean; reopened: boolean; ambiguous: boolean }
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
    return { ok: true, skipped: true, itemId: null, contactId: null, autoResolved: false, reopened: false, ambiguous: false };
  }

  // #110 W7-004: a resolved item re-ingested with nothing to persist — skip the
  // item upsert AND the 'ingested' activity insert so the every-minute reconcile
  // cron stops flooding both tables with no-change writes. `existing` is non-null
  // whenever noopReingest is true.
  if (plan.noopReingest) {
    return { ok: true, skipped: true, itemId: existing?.id ?? null, contactId: existing?.contactId ?? null, autoResolved: false, reopened: false, ambiguous: false };
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
  };
}

// ─── Reads for the UI / poll ────────────────────────────────────────────────

// WT-41: `truncated`/`totalOpen` mirror the pattern listItemsForMetrics already
// exposes for ResponseAnalytics — the page is capped at `limit` (oldest-first),
// but `totalOpen` is the REAL count of open items (via Postgrest's exact count,
// unaffected by .limit()), so the UI can say "N more not shown" instead of
// silently under-reporting once open items exceed the cap.
export type OpenItemsResult =
  | { ok: true; items: OpenInboxItem[]; totalOpen: number; truncated: boolean }
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
 * #157: drop items backed by a legacy_rebook=true ("YLL Neighbor") quote. Only
 * a 'quotetool' item can match — its external_id is the quote id, optionally
 * suffixed `:color-request` (quoteIdPrefix strips it, #183 BUG 1) — so every
 * other source is untouched by construction, even if an id happened to
 * collide. Pure — no I/O — hence unit-testable on its own (store.test.ts).
 */
export function excludeLegacyRebookItems<T extends { source: unknown; external_id: unknown }>(
  items: T[],
  legacyQuoteIds: ReadonlySet<string>,
): T[] {
  if (legacyQuoteIds.size === 0) return items;
  return items.filter(
    (item) => !(item.source === 'quotetool' && legacyQuoteIds.has(quoteIdPrefix(String(item.external_id)))),
  );
}

export async function listOpenItems(limit = 100): Promise<OpenItemsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  // #157: over-fetch when the legacy filter is active — see
  // LEGACY_REBOOK_FETCH_BUFFER above.
  const fetchLimit = EXCLUDE_LEGACY_REBOOK_FROM_INBOX ? limit + LEGACY_REBOOK_FETCH_BUFFER : limit;

  const { data, error, count } = await sb
    .from('inbox_items')
    .select(
      'id, source, external_id, channel, direction, last_message_at, preview, subject, escalation_level, contact_id, lead_kind, quote_value, ' +
        'dashboard_contacts ( display_name, primary_email, primary_phone, assigned_to )',
      { count: 'exact' },
    )
    .eq('status', 'unresponded')
    .is('followed_up_at', null)
    .order('last_message_at', { ascending: true })
    .limit(fetchLimit);
  if (error) return { ok: false, error: error.message };

  let rows = (data ?? []) as unknown as Record<string, unknown>[];
  let legacyExcluded = 0;

  // #157: batch-fetch the quotetool ids present on THIS page and drop any that
  // are a legacy_rebook quote. Skips the extra query entirely when the page has
  // no quotetool items (the common case for ghl/gmail/homeworks-only pages).
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
      const { data: quoteRows, error: quoteErr } = await sb.from('quotes').select('id, legacy_rebook').in('id', quotetoolIds);
      if (quoteErr) {
        // Fail open (unexcluded) but VISIBLY — a silent swallow here is exactly
        // what let ~129 legacy drafts flood the inbox undetected (#183).
        console.error('[inbox] legacy-rebook exclusion lookup failed:', quoteErr.message);
      } else {
        const legacyQuoteIds = new Set(
          ((quoteRows ?? []) as { id: string; legacy_rebook: boolean | null }[])
            .filter((q) => q.legacy_rebook === true)
            .map((q) => String(q.id)),
        );
        const before = rows.length;
        rows = excludeLegacyRebookItems(rows as { source: unknown; external_id: unknown }[], legacyQuoteIds);
        legacyExcluded = before - rows.length;
      }
    }
  }

  const trimmed = rows.slice(0, limit);

  // "Returning" proxy: a contact with >1 inbox_items across ALL statuses (any
  // channel, incl. handled/dismissed history). NOTE: a single customer with two
  // channels open right now also reads as returning — acceptable for v1 (we chose
  // this over the dormant quote_customer_id link).
  const contactIds = [...new Set(trimmed.map((r) => (r as unknown as { contact_id: string | null }).contact_id).filter((c): c is string => !!c))];
  const returning = new Set<string>();
  if (contactIds.length) {
    const { data: counts } = await sb
      .from('inbox_items')
      .select('contact_id')
      .in('contact_id', contactIds);
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
  return { ok: true, items, totalOpen, truncated: totalOpen > items.length };
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
 * read. Uses a status guard so two operators can't double-apply.
 */
export async function markItemHandledLocal(itemId: string, operatorId: string, now: Date): Promise<MarkHandledResult> {
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

export async function dismissItem(itemId: string, operatorId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
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
  const { data, error } = await sb
    .from('inbox_items')
    .select(
      'id, source, external_id, last_message_at, notified_levels, escalation_level, preview, dashboard_contacts ( display_name )',
    )
    .eq('status', 'unresponded')
    // #110 W7-005: a manually-Followed item (followed_up_at stamped, status still
    // 'unresponded') must NOT keep firing amber/red alerts + EOD digests — it's
    // been handled outside the tool. Mirrors listOpenItems; an inbound clears
    // followed_up_at (planIngest.clearFollowedUp) and re-arms escalation.
    .is('followed_up_at', null)
    .or('lead_kind.is.null,lead_kind.neq.automated');
  if (error) return { ok: false, error: error.message };

  let rows = (data ?? []) as unknown as Record<string, unknown>[];

  // #181: the same #157 exclusion listOpenItems applies to the /inbox display —
  // a YLL Neighbor item must never fire an amber/red alert or land in the EOD
  // digest either, so it stays invisible on every escalation surface, not just
  // the open-items list. Reuses excludeLegacyRebookItems (the exact #157
  // predicate, fed the same way: batch-fetch quotes for the quotetool ids on
  // this read) so the two surfaces can never disagree. NOTE this excludes a
  // legacy_rebook quote's item regardless of quote_sent_at — broader than the
  // quotetool.ts ingest-time guard (#181's normalizeQuoteTouch, which only
  // suppresses UNSENT ones from ever being created) — matching #157's existing
  // display behavior (all Neighbor items hidden) rather than fighting it.
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
      const { data: quoteRows, error: quoteErr } = await sb.from('quotes').select('id, legacy_rebook').in('id', quotetoolIds);
      if (quoteErr) {
        console.error('[inbox] legacy-rebook exclusion lookup failed:', quoteErr.message);
      } else {
        const legacyQuoteIds = new Set(
          ((quoteRows ?? []) as { id: string; legacy_rebook: boolean | null }[])
            .filter((q) => q.legacy_rebook === true)
            .map((q) => String(q.id)),
        );
        rows = excludeLegacyRebookItems(rows as { source: unknown; external_id: unknown }[], legacyQuoteIds);
      }
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
 *  permanently killed the nudge for that item+reason forever. */
export async function ensureFollowUp(input: {
  inboxItemId: string;
  contactId: string | null;
  reason: string;
  sentAt: Date;
  // WT-44: cadence override so the "Follow-up reminder (days)" setting can
  // drive when the strip nudge is due; falls back to DEFAULT_FOLLOW_UP_DAYS.
  afterDays?: number;
}): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const { data } = await sb
    .from('follow_ups')
    .select('id')
    .eq('inbox_item_id', input.inboxItemId)
    .eq('reason', input.reason)
    .eq('status', 'pending')
    .limit(1);
  if (data && data.length > 0) return; // a pending one already exists — don't duplicate
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

// ─── Orphaned follow-up sweep (#183 BUG 3) ──────────────────────────────────
// runQuoteToolReconcile's main loop (sync.ts) only walks quotes returned by
// listQuotesForDashboard — a quote row that's been DELETED entirely is never
// visited there, so a pending quote_sent_no_reply follow-up anchored to it can
// never be closed by the main loop and sits overdue-pending forever, showing
// in the "due today" strip every day. This sweep finds and closes those.

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

/**
 * Close pending follow-ups (of `reason`) whose quotetool inbox item's
 * underlying quote row no longer exists. One batched query each way (mirrors
 * the #157/#183-BUG-1 lookup-batching style): follow_ups → inbox_items →
 * quotes existence → findOrphanedFollowUpItems → closeFollowUp per orphan.
 * Fails open (closes nothing) on a lookup error rather than guessing. Returns
 * how many follow-ups were closed.
 */
export async function sweepOrphanedFollowUps(reason: string): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;

  const { data: pending, error: pendingErr } = await sb
    .from('follow_ups')
    .select('id, inbox_item_id')
    .eq('reason', reason)
    .eq('status', 'pending');
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
  if (candidateQuoteIds.length) {
    const { data: quoteRows, error: quoteErr } = await sb.from('quotes').select('id').in('id', candidateQuoteIds);
    if (quoteErr) {
      console.error('[inbox] orphan follow-up sweep: quotes lookup failed:', quoteErr.message);
      return 0;
    }
    existingQuoteIds = new Set(((quoteRows ?? []) as { id: string }[]).map((q) => String(q.id)));
  }

  const orphanedItemIds = findOrphanedFollowUpItems(
    followUpRows.map((r) => ({ inboxItemId: r.inbox_item_id })),
    itemRows,
    existingQuoteIds,
  );

  let closed = 0;
  for (const itemId of orphanedItemIds) {
    closed += await closeFollowUp(itemId, reason);
  }
  return closed;
}

export type DueFollowUpsResult = { ok: true; items: DueFollowUp[] } | { ok: false; error: string };

/** Pending follow-ups due today or overdue (ET), for the top strip. */
export async function listDueFollowUps(now: Date): Promise<DueFollowUpsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('follow_ups')
    .select('id, reason, due_at, dashboard_contacts ( display_name )')
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
      };
    });
  return { ok: true, items };
}

export async function markFollowUpDone(id: string, operatorId: string): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { error } = await sb.from('follow_ups').update({ status: 'done' }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'handled', detail: { followUpId: id } });
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
    .select('status, last_message_at, last_inbound_at, handled_at, handled_by, source, created_at')
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
  const out = fresh();
  for (const k of ['all', '90', '30'] as WindowKey[]) {
    const days = windowDays[k];
    const sinceIso = days == null ? null : new Date(now.getTime() - days * 86_400_000).toISOString();
    out[k] = { handled: await distinct('handled', sinceIso), reopened: await distinct('reopened', sinceIso) };
  }
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
};
export type InWorksResult =
  | { ok: true; awaiting: InWorksItem[]; handled: InWorksItem[] }
  | { ok: false; error: string };

const IN_WORKS_SELECT =
  'id, source, channel, preview, followed_up_at, handled_at, status, dashboard_contacts ( display_name )';

function mapInWorksRow(rows: unknown[], tsKey: 'followed_up_at' | 'handled_at'): InWorksItem[] {
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
    };
  });
}

/** Two-group In-Works list: items being actively followed up (awaiting) + locally
 *  handled items that aren't yet dismissed or completed (handled). Both sorted
 *  stalest-first so the longest-waiting surface at the top. */
export async function listInWorks(limit = 200): Promise<InWorksResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const aw = await sb
    .from('inbox_items')
    .select(IN_WORKS_SELECT)
    .not('followed_up_at', 'is', null)
    .not('status', 'in', '(completed,dismissed)')
    .order('followed_up_at', { ascending: true })
    .limit(limit);
  const hd = await sb
    .from('inbox_items')
    .select(IN_WORKS_SELECT)
    .eq('status', 'handled')
    .is('followed_up_at', null)
    .order('handled_at', { ascending: true })
    .limit(limit);
  if (aw.error) return { ok: false, error: aw.error.message };
  if (hd.error) return { ok: false, error: hd.error.message };
  return {
    ok: true,
    awaiting: mapInWorksRow(aw.data ?? [], 'followed_up_at'),
    handled: mapInWorksRow(hd.data ?? [], 'handled_at'),
  };
}

/** Mark an item completed: capture prior state, stamp status + handled fields,
 *  clear followed_up_at, and write a detailed activity log entry. */
export async function markItemCompleted(
  itemId: string,
  operatorId: string,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const from = await priorStateOf(sb, itemId);
  const { error } = await sb
    .from('inbox_items')
    .update({
      status: 'completed',
      followed_up_at: null,
      handled_by: operatorId,
      handled_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', itemId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({
    actor: operatorId,
    action: 'completed',
    inbox_item_id: itemId,
    detail: { from },
  });
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
 * ID and customer name fall back to the raw payload if the contact row is absent.
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
