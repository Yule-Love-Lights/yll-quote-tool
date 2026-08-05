// src/lib/leads/fieldLead.ts
// Field-lead GHL sync for the text-ops bot's captureLead tool (Phase 3 of the
// 2026-07-19 text-ops plan, ledger #168 / task #11). A field lead is a
// brand-new homeowner a crew installer met in person and got verbal SMS
// consent from. The bot's confirm-yes gate (see summarizeCaptureLead in
// botWriteTools.ts) IS the consent record — the crew must affirm the
// homeowner agreed to be contacted before a "yes" ever reaches this module.
//
// Because consent is already confirmed here, this is the OPPOSITE of
// partialLead.ts: that sync deliberately WITHHOLDS 'new lead' (no consent
// yet). This one deliberately INCLUDES it (Naldo's locked decision,
// 2026-08) so the SAME GHL workflow that drips a completed website lead also
// drips a field lead — the workflow keys off 'new lead' + 'web-lead-<service>'.
// 'field-lead' and 'sms-consent' ride alongside so staff can tell at a glance
// this contact came from the field with verbal consent, not a web form.
//
// Deliberately NO opportunity (findOrCreateOpportunityForContact) — Naldo's
// call: enrollment here means "tag for automation", not a pipeline card.
//
// Field leads are phone-only by nature (no email collected on a ladder), so
// the household guard mirrors partialLead.ts: search for an existing contact
// by phone BEFORE the upsert, and omit name fields when a match's name
// genuinely differs — a lead phoned in under one name must never overwrite a
// real contact's identity.

import { upsertContact, addContactTags, createContactNote, searchContacts } from '@/lib/integrations/highlevel';
import {
  splitLeadName,
  existingNameDiffers,
  normalizePhoneForCompare,
  SERVICE_FIELD_VALUE,
  type LeadService,
} from '@/lib/leads/leadService';
import type { CrmContact } from '@/lib/integrations/types';

export type FieldLeadInput = {
  name: string;
  phone: string;
  address?: string | null;
  note?: string | null;
  service: LeadService;
};

export type SyncFieldLeadResult = {
  status: 'synced' | 'error';
  ghlContactId?: string;
  syncError?: string;
  /**
   * Set ONLY on a household-name mismatch (an existing contact matched by
   * phone but under a different name, so the upsert omitted the crew's typed
   * name to protect the real contact's identity). The caller (runCaptureLead)
   * uses this to tell the crew the truth — the contact was NOT renamed to
   * what they typed — instead of implying the new name landed.
   */
  savedContactName?: string;
};

// Strips newlines from a field a crew member's free text could carry (note,
// name, phone) — same injection guard as leadService's (unexported)
// stripNewlinesForNote, kept local here rather than exporting a private
// helper from a shared module just for this one caller.
function stripNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

// Household guard — fail-open on a search hiccup (same contract as
// partialLead.ts's findExistingContact). Field leads have no email, so the
// lookup is phone-only.
async function findExistingContact(phone: string): Promise<CrmContact | null> {
  const wantPhone = normalizePhoneForCompare(phone);
  if (!wantPhone) return null;
  try {
    const results = await searchContacts(wantPhone);
    return results.find((c) => normalizePhoneForCompare(c.phone) === wantPhone) ?? null;
  } catch {
    return null;
  }
}

function buildFieldLeadNoteBody(input: FieldLeadInput): string {
  const lines = [`New field lead — ${SERVICE_FIELD_VALUE[input.service]} — captured via text-ops bot.`];
  if (input.note) lines.push(`Note: ${stripNewlines(input.note.trim())}`);
  return lines.join('\n');
}

// Mirrors leadService.ts's buildHouseholdNoteBody — a household-mismatch
// discrepancy MUST leave a trace on the contact, not just silently skip the
// name fields, or the office has no idea a different person called this in.
function buildHouseholdNoteBody(input: FieldLeadInput, existingName: string): string {
  const typedName = stripNewlines(input.name.trim());
  const safeExistingName = stripNewlines(existingName.trim());
  const phone = stripNewlines(input.phone.trim());
  return (
    `Household note: captured in the field as ${typedName} using this contact's phone on file. ` +
    `Contact name kept as ${safeExistingName}. Submitted phone: ${phone}.`
  );
}

/**
 * Sync one crew-captured field lead to GHL: upsert the contact, tag it for
 * the SAME automation a completed website form triggers, and drop a note.
 *
 * Failure contract mirrors partialLead.ts / leadService.ts for the upsert:
 * upsertContact is the only call allowed to THROW (no contact yet means
 * nothing to report — the caller, runCaptureLead in botWriteTools.ts, turns
 * that into a plain-text reply rather than letting it reach the webhook).
 *
 * PAST the upsert, tags and notes are handled separately on purpose: the tag
 * step is what actually ENROLLS the contact (addContactTags carries 'new
 * lead'), so a tag failure is a real status:'error' — the person is NOT
 * enrolled. Notes are best-effort context; a note failure must never
 * downgrade an already-enrolled contact to status:'error', or a staff ping
 * that should fire (tags landed) would get silently suppressed.
 */
export async function syncFieldLeadToGhl(input: FieldLeadInput): Promise<SyncFieldLeadResult> {
  const phone = input.phone.trim();
  const fullName = input.name.trim();
  const { firstName, lastName } = splitLeadName(fullName);

  const existing = await findExistingContact(phone);
  const isHousehold = existing !== null && existingNameDiffers(existing.fullName, fullName);
  const nameIsSafe = fullName !== '' && !isHousehold;

  const { contact } = await upsertContact({
    ...(nameIsSafe ? { firstName, lastName: lastName || undefined } : {}),
    phone,
    // Same protection as the name fields: on a household match this address
    // belongs to whoever is ALREADY at that phone number, not the person the
    // crew met in the field — sending it would overwrite the real contact's
    // street address with an unrelated one.
    ...(isHousehold ? {} : { address1: input.address?.trim() || undefined }),
    source: 'Field Lead (Text-Ops Bot)',
  });

  // Enrollment-critical: 'new lead' is the tag the GHL workflow keys off, so a
  // failure HERE means the person is genuinely not enrolled — report it.
  // Order matches Naldo's locked decision — new lead FIRST, then the two
  // provenance/consent tags, then the service tag the workflow also matches on.
  try {
    await addContactTags(contact.id, [
      'new lead',
      'field-lead',
      'sms-consent',
      `web-lead-${input.service}`,
    ]);
  } catch (err) {
    return {
      status: 'error',
      ghlContactId: contact.id,
      syncError: err instanceof Error ? err.message : 'Unknown HighLevel error',
    };
  }

  // Best-effort from here — the contact IS enrolled once the tags above
  // landed, so a note hiccup is logged, not surfaced as a sync failure.
  // TWO INDEPENDENT try/catch blocks, deliberately: the household note and the
  // regular field-lead note are unrelated facts (a name discrepancy vs. the
  // capture context), and a failure writing ONE must never stop the OTHER
  // from being attempted — a household match whose discrepancy-note write
  // throws must still get its ordinary context note, not end up with zero
  // notes on the contact.
  if (isHousehold) {
    // Household note FIRST (mirrors leadService.ts's ordering) so it's the
    // most prominent entry when the office opens the contact.
    try {
      await createContactNote(contact.id, buildHouseholdNoteBody(input, existing?.fullName ?? ''));
    } catch (err) {
      console.warn('[fieldLead] household note write failed (contact still enrolled):', err);
    }
  }
  try {
    await createContactNote(contact.id, buildFieldLeadNoteBody(input));
  } catch (err) {
    console.warn('[fieldLead] field-lead note write failed (contact still enrolled):', err);
  }

  return {
    status: 'synced',
    ghlContactId: contact.id,
    ...(isHousehold ? { savedContactName: existing?.fullName || undefined } : {}),
  };
}
