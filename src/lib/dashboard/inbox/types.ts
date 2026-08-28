// Shared types + runtime constants for the unified inbox. Kept in one place so
// the normalize / identity / escalation / followups modules (and later the
// adapters + routes) agree on the shape of a "touch", a contact, and an item.
//
// Mirrors migrations/2026-06-28-dashboard-tables.sql. SHARED-QUEUE model
// (confirmed with Naldo 2026-06-28): an item needs no owner — assigned_to /
// handled_by are nullable and "unclaimed" is the normal open state.

// ─── Enumerations (runtime arrays so they're iterable + guard-able) ─────────
export const INBOX_SOURCES = ['ghl', 'gmail', 'quotetool', 'homeworks'] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export const INBOX_STATUSES = ['unresponded', 'handled', 'dismissed', 'completed'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export type Direction = 'inbound' | 'outbound';
export type Channel = 'sms' | 'email' | 'call' | 'fb' | 'ig' | 'app';

/** Escalation severity (also the inbox_items.escalation_level int). */
export const ESCALATION_LEVEL = { NONE: 0, AMBER: 1, RED: 2, EOD: 3 } as const;
export type EscalationLevel = (typeof ESCALATION_LEVEL)[keyof typeof ESCALATION_LEVEL];

export function isInboxSource(v: unknown): v is InboxSource {
  return typeof v === 'string' && (INBOX_SOURCES as readonly string[]).includes(v);
}
export function isInboxStatus(v: unknown): v is InboxStatus {
  return typeof v === 'string' && (INBOX_STATUSES as readonly string[]).includes(v);
}

// ─── Identity ───────────────────────────────────────────────────────────────
/** Identifiers extracted from one inbound touch, fed to identity resolution. */
export type ContactIdentity = {
  ghlContactId?: string | null;
  emails?: string[];
  phones?: string[];
  displayName?: string | null;
};

/** An existing dashboard_contacts row, trimmed to what identity matching needs. */
export type StoredContact = {
  id: string;
  ghlContactId: string | null;
  /** Normalized (lowercased) emails. */
  emails: string[];
  /** Normalized (E.164) phones. */
  phones: string[];
  displayName: string | null;
};

// ─── Normalized touch (adapter output → upsert input) ───────────────────────
/** One inbound touch normalized to a source-agnostic shape. */
export type NormalizedTouch = {
  source: InboxSource;
  externalId: string;
  sourceMessageId?: string | null;
  direction?: Direction | null;
  channel?: Channel | null;
  lastMessageAt: Date;
  preview?: string | null;
  subject?: string | null;
  identity: ContactIdentity;
  raw?: unknown;
  leadKind?: 'lead' | 'automated' | null;
  quoteValue?: number | null;
  /** #252: true when this touch is pure GHL system/CRM activity (e.g.
   *  "Opportunity created"), not a customer message. Resolved by the adapter;
   *  consumed only by store.ts's planIngest, which is the one place that knows
   *  whether a row already exists for this conversation — see its `skip` doc. */
  isActivityNoise?: boolean | null;
};

/** A single open inbox item shaped for the /inbox UI (server-fetch → client prop).
 *  Lives here (no server imports) so client components import it cleanly. */
export type OpenInboxItem = {
  id: string;
  source: InboxSource;
  channel: string | null;
  direction: string | null;
  lastMessageAt: string | null;
  preview: string | null;
  subject: string | null;
  escalationLevel: number;
  leadKind: 'lead' | 'automated';
  quoteValue: number | null;
  isReturning: boolean;
  /** The linked contact id (for claim/assign actions); null on an unlinked item. */
  contactId: string | null;
  /** The contact's current assignee (auth.users id), or null when unclaimed. */
  assignedTo: string | null;
  contact: { displayName: string | null; email: string | null; phone: string | null } | null;
  /** Row 321: true for a `quotetool` item whose external_id carries the
   *  `:color-request` suffix (store.ts's isColorRequestExternalId) — badges the
   *  row and confirm-gates its Handled/Mark-completed buttons so a still-live
   *  colour request can't be silently buried by the ordinary buttons. Optional
   *  so existing fixtures that don't set it keep reading as false (no badge). */
  isColorRequest?: boolean;
};

/** A candidate duplicate contact pair, shaped for the merge UI. */
export type DuplicateContactView = {
  on: string; // 'ghl' | 'email' | 'phone'
  a: { id: string; name: string | null; email: string | null; phone: string | null };
  b: { id: string; name: string | null; email: string | null; phone: string | null };
};

/** A pending follow-up due today, shaped for the /inbox "due today" strip. */
export type DueFollowUp = {
  id: string;
  reason: string;
  dueAt: string;
  contactName: string | null;
  /** #229: contact phone/email alongside the name — lets a downstream NAMED
   *  render (the morning digest) fall back name → phone → email when a
   *  dashboard_contacts row has no display_name (a real live case: a dropped
   *  lead whose contact row was created from a bare inbound touch). The strip
   *  itself doesn't need these; they ride along for that one consumer. */
  contactPhone: string | null;
  contactEmail: string | null;
  /** Row 390: non-null only when this nudge is a RE-CHASE (row 385's re-arm
   *  after 7 quiet days on a handled item) — the silence-start anchor
   *  (`follow_ups.re_chase_since`), so the strip can label it and show how
   *  long the customer has been quiet. Null for an ordinary first-time
   *  "quote sent, no reply" nudge. */
  reChaseSince: string | null;
};

/** Row 321: one quote with a live `approval_snapshot.pendingColorRequest`, for
 *  the /inbox "Pending colour requests" section — read straight off the quote
 *  (store.ts's listPendingColorRequests), independent of any inbox item's
 *  status, so a hidden/completed/dismissed inbox row can never suppress it. */
export type PendingColorRequestItem = {
  quoteId: string;
  quoteNumber: number | null;
  customerName: string | null;
  label: string;
  requestedAt: string | null;
};

// ─── Follow-ups ─────────────────────────────────────────────────────────────
/** A follow-up to insert (DB assigns id/created_at). */
export type NewFollowUp = {
  contactId: string | null;
  inboxItemId: string | null;
  dueAt: Date;
  reason: string;
  status: 'pending' | 'done' | 'dismissed';
  assignedTo: string | null;
  createdBy: string | null;
};
