// Identity resolution — collapse the same human across channels into ONE
// dashboard_contacts card. Pure: takes a candidate identity + the existing
// contacts and decides match / no-match / ambiguous. The caller (an adapter)
// does the DB read + write; this module never touches I/O.
//
// Match order (strongest first):
//   1. ghl_contact_id — canonical + unique, wins outright.
//   2. normalized email — stronger than phone (households share a mobile).
//   3. normalized phone (E.164).
// Append new identifiers on a match; NEVER silently auto-merge ambiguous
// duplicates (identifiers pointing at two different contacts) — flag for a human.

import type { ContactIdentity, StoredContact } from './types';
import { normalizeEmail, normalizeName, normalizePhone } from './normalize';

export type MatchReason = 'ghl' | 'email' | 'phone';

export type MatchResult = {
  /** The matched contact, or null (no match OR ambiguous). */
  contact: StoredContact | null;
  /** Which identifier matched, or null when no single match. */
  reason: MatchReason | null;
  /** True when identifiers resolve to >1 distinct contact — do not auto-merge. */
  ambiguous: boolean;
};

function normEmails(c: ContactIdentity): string[] {
  return (c.emails ?? []).map(normalizeEmail).filter((e): e is string => e !== null);
}
function normPhones(c: ContactIdentity): string[] {
  return (c.phones ?? []).map(normalizePhone).filter((p): p is string => p !== null);
}
function uniqueById(contacts: StoredContact[]): StoredContact[] {
  const seen = new Map<string, StoredContact>();
  for (const c of contacts) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

export function resolveIdentity(candidate: ContactIdentity, existing: StoredContact[]): MatchResult {
  // 1. ghl_contact_id — canonical, unique → wins outright.
  const ghlId = candidate.ghlContactId ?? null;
  if (ghlId) {
    const byGhl = existing.find((c) => c.ghlContactId !== null && c.ghlContactId === ghlId);
    if (byGhl) return { contact: byGhl, reason: 'ghl', ambiguous: false };
  }

  // 2 + 3. email then phone. Gather every distinct contact any identifier hits.
  const emails = normEmails(candidate);
  const phones = normPhones(candidate);
  const emailMatches = emails.length
    ? existing.filter((c) => c.emails.some((e) => emails.includes(e)))
    : [];
  const phoneMatches = phones.length
    ? existing.filter((c) => c.phones.some((p) => phones.includes(p)))
    : [];

  const distinct = uniqueById([...emailMatches, ...phoneMatches]);
  if (distinct.length === 0) return { contact: null, reason: null, ambiguous: false };
  if (distinct.length > 1) return { contact: null, reason: null, ambiguous: true };

  // Exactly one contact. Email is the stronger reason when it contributed.
  const reason: MatchReason = emailMatches.length > 0 ? 'email' : 'phone';
  return { contact: distinct[0], reason, ambiguous: false };
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Merge a candidate's identifiers into a matched contact. Emails/phones are
 * unioned (normalized + deduped); ghl id and display name are filled only when
 * the contact lacks them (never overwrite the canonical/representative value).
 */
export function appendIdentifiers(contact: StoredContact, candidate: ContactIdentity): StoredContact {
  return {
    ...contact,
    ghlContactId: contact.ghlContactId ?? candidate.ghlContactId ?? null,
    emails: union(contact.emails, normEmails(candidate)),
    phones: union(contact.phones, normPhones(candidate)),
    displayName:
      contact.displayName ?? (candidate.displayName != null ? normalizeName(candidate.displayName) : null),
  };
}
