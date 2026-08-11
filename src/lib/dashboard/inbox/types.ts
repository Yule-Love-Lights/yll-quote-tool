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
  // #223: fallback identifiers for the morning digest's named list, so a
  // contact with no display_name (the exact Aug-6 dropped-lead shape) still
  // renders as SOMETHING actionable instead of "(no name)".
  contactPhone: string | null;
  contactEmail: string | null;
  // #223 review HIGH1: true when this follow-up is anchored to a
  // legacy_rebook ("YLL Neighbor") quote. This page (the /inbox strip) keeps
  // showing it — that's existing, documented behavior — but a consumer that
  // must never surface a rebook customer by name (the digest) filters on it.
  isLegacyRebook: boolean;
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
