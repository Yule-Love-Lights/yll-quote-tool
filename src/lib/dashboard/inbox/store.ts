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
import { appendIdentifiers, findDuplicatePairs, mergeContacts, resolveIdentity } from './identity';
import { decideInboxState } from './reducer';
import { isDueToday, quoteSentNoReplyFollowUp } from './followups';
import type { MetricItem } from './responseMetrics';

// ─── Pure ingest planner ────────────────────────────────────────────────────

export type ExistingItem = {
  id: string;
  contactId: string | null;
  status: InboxStatus;
  notifiedLevels: number[];
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
  contactOp: ContactOp;
  item: ItemRow;
  autoResolved: boolean;
  reopened: boolean;
  ambiguous: boolean;
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
    existing: existing ? { status: existing.status, notifiedLevels: existing.notifiedLevels } : null,
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

  // notified_levels is owned by the escalate cron. Ingest only PRESERVES it
  // (and resets it on reopen) — it must never advance a level, or the cron would
  // skip that escalation email.
  const notifiedLevels = decision.reopened ? [] : (existing?.notifiedLevels ?? []);

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
    contactOp,
    item,
    autoResolved: decision.autoResolved,
    reopened: decision.reopened,
    ambiguous,
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
    .select('id, contact_id, status, notified_levels')
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

export type OpenItemsResult = { ok: true; items: OpenInboxItem[] } | { ok: false; error: string };

export async function listOpenItems(limit = 100): Promise<OpenItemsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .select(
      'id, source, channel, direction, last_message_at, preview, subject, escalation_level, contact_id, lead_kind, quote_value, ' +
        'dashboard_contacts ( display_name, primary_email, primary_phone, assigned_to )',
    )
    .eq('status', 'unresponded')
    .order('last_message_at', { ascending: true })
    .limit(limit);
  if (error) return { ok: false, error: error.message };

  const contactIds = [...new Set((data ?? []).map((r) => (r as unknown as { contact_id: string | null }).contact_id).filter((c): c is string => !!c))];
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

  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((row): OpenInboxItem => {
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
  return { ok: true, items };
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
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'handled', inbox_item_id: itemId });
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
  const { error } = await sb
    .from('inbox_items')
    .update({ status: 'dismissed', handled_by: operatorId, handled_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', itemId);
  if (error) return { ok: false, error: error.message };
  await sb.from('dashboard_activity').insert({ actor: operatorId, action: 'dismissed', inbox_item_id: itemId });
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
    .select('id, last_message_at, notified_levels, escalation_level, preview, dashboard_contacts ( display_name )')
    .eq('status', 'unresponded');
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((row): EscalatableItem => {
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

/** Create a follow-up for an inbox item once (idempotent on inbox_item_id+reason). */
export async function ensureFollowUp(input: {
  inboxItemId: string;
  contactId: string | null;
  reason: string;
  sentAt: Date;
}): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const { data } = await sb
    .from('follow_ups')
    .select('id')
    .eq('inbox_item_id', input.inboxItemId)
    .eq('reason', input.reason)
    .limit(1);
  if (data && data.length > 0) return; // already created (any status) — don't duplicate
  const fu = quoteSentNoReplyFollowUp({ contactId: input.contactId, inboxItemId: input.inboxItemId, sentAt: input.sentAt });
  await sb.from('follow_ups').insert({
    contact_id: fu.contactId,
    inbox_item_id: fu.inboxItemId,
    due_at: fu.dueAt.toISOString(),
    reason: fu.reason,
    status: fu.status,
    assigned_to: fu.assignedTo,
    created_by: fu.createdBy,
  });
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

/** Items in the trailing `sinceDays` window (by last_message_at) for analytics.
 *  `truncated` is true when the window hit the row cap, so the UI can say the
 *  stats are based on a sample rather than silently under-reporting. */
export async function listItemsForMetrics(sinceDays = 30): Promise<MetricsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const { data, error } = await sb
    .from('inbox_items')
    .select('status, last_message_at, handled_at, handled_by, source')
    .gte('last_message_at', since)
    .limit(METRICS_ROW_CAP);
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((r): MetricItem => ({
    status: r.status as string,
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at as string) : null,
    handledAt: r.handled_at ? new Date(r.handled_at as string) : null,
    handledBy: (r.handled_by as string | null) ?? null,
    source: r.source as string,
  }));
  return { ok: true, items, truncated: items.length >= METRICS_ROW_CAP };
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
