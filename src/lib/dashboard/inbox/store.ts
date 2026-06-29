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
  InboxSource,
  InboxStatus,
  NormalizedTouch,
  StoredContact,
} from './types';
import { normalizeEmail, normalizePhone } from './normalize';
import { appendIdentifiers, resolveIdentity } from './identity';
import { decideInboxState } from './reducer';

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
  if (identity.ghlContactId) conds.push(`ghl_contact_id.eq.${identity.ghlContactId}`);
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
    await sb
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

export type OpenInboxItem = {
  id: string;
  source: InboxSource;
  channel: string | null;
  direction: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  subject: string | null;
  escalationLevel: number;
  contact: { displayName: string | null; email: string | null; phone: string | null } | null;
};

export type OpenItemsResult = { ok: true; items: OpenInboxItem[] } | { ok: false; error: string };

export async function listOpenItems(limit = 100): Promise<OpenItemsResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .select(
      'id, source, channel, direction, last_message_at, preview, subject, escalation_level, ' +
        'dashboard_contacts ( display_name, primary_email, primary_phone )',
    )
    .eq('status', 'unresponded')
    .order('last_message_at', { ascending: false })
    .limit(limit);
  if (error) return { ok: false, error: error.message };
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

// ─── Handled write-back support ─────────────────────────────────────────────

export type HandledTarget = {
  source: InboxSource;
  externalId: string;
  sourceMessageId: string | null;
  ghlContactId: string | null;
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
    .select('source, external_id, source_message_id, dashboard_contacts ( ghl_contact_id )')
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
  contact: { displayName: string | null } | null;
  preview: string | null;
};
export type EscalatableResult = { ok: true; items: EscalatableItem[] } | { ok: false; error: string };

export async function listEscalatableItems(): Promise<EscalatableResult> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };
  const { data, error } = await sb
    .from('inbox_items')
    .select('id, last_message_at, notified_levels, preview, dashboard_contacts ( display_name )')
    .eq('status', 'unresponded');
  if (error) return { ok: false, error: error.message };
  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((row): EscalatableItem => {
    const c = (row.dashboard_contacts as Record<string, unknown> | null) ?? null;
    return {
      id: String(row.id),
      lastMessageAt: (row.last_message_at as string | null) ?? null,
      notifiedLevels: (row.notified_levels as number[] | null) ?? [],
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
