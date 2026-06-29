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

export const INBOX_STATUSES = ['unresponded', 'handled', 'dismissed'] as const;
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
