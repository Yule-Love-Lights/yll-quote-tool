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
};

// Strips newlines from the one field a crew member's free text could carry
// (note) — same injection guard as leadService's (unexported) stripNewlinesForNote,
// kept local here rather than exporting a private helper from a shared module
// just for this one caller.
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

/**
 * Sync one crew-captured field lead to GHL: upsert the contact, tag it for
 * the SAME automation a completed website form triggers, and drop a note.
 *
 * Failure contract mirrors partialLead.ts / leadService.ts: upsertContact is
 * the only call allowed to THROW (no contact yet means nothing to report —
 * the caller, runCaptureLead in botWriteTools.ts, turns that into a plain-text
 * reply rather than letting it reach the webhook). Every step AFTER the
 * contact exists catches its own failure and still returns the contact id, so
 * a tag/note hiccup never loses the captured contact.
 */
export async function syncFieldLeadToGhl(input: FieldLeadInput): Promise<SyncFieldLeadResult> {
  const phone = input.phone.trim();
  const fullName = input.name.trim();
  const { firstName, lastName } = splitLeadName(fullName);

  const existing = await findExistingContact(phone);
  const nameIsSafe = fullName !== '' && !(existing && existingNameDiffers(existing.fullName, fullName));

  const { contact } = await upsertContact({
    ...(nameIsSafe ? { firstName, lastName: lastName || undefined } : {}),
    phone,
    address1: input.address?.trim() || undefined,
    source: 'Field Lead (Text-Ops Bot)',
  });

  try {
    // Order matches Naldo's locked decision — new lead FIRST (the tag the GHL
    // workflow actually keys off), then the two provenance/consent tags, then
    // the service tag the workflow also matches on.
    await addContactTags(contact.id, [
      'new lead',
      'field-lead',
      'sms-consent',
      `web-lead-${input.service}`,
    ]);
    await createContactNote(contact.id, buildFieldLeadNoteBody(input));
    return { status: 'synced', ghlContactId: contact.id };
  } catch (err) {
    return {
      status: 'error',
      ghlContactId: contact.id,
      syncError: err instanceof Error ? err.message : 'Unknown HighLevel error',
    };
  }
}
