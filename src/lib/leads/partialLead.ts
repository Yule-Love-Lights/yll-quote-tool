// Partial / abandoned-form lead sync (quote-forms-partial-save).
//
// A "partial lead" is what we capture when a visitor types their contact info
// into a website / referral form but LEAVES before completing + consenting to
// SMS. We still want that data — in our own table (source of truth, sync_status
// 'partial') and in GHL so it's visible where the team works — but it must NEVER
// enter the automated SMS drips: those are triggered by the 'new lead' tag (see
// leadService.syncLeadToGhl) and texting someone who never checked the consent
// box is not acceptable (the whole reason POST /api/leads hard-requires
// consent:true before it syncs).
//
// So a partial sync is deliberately the STRIPPED-DOWN version of syncLeadToGhl:
//   * upsert the contact (idempotent on email/phone — repeated captures as the
//     visitor blurs each field just update the same contact),
//   * add ONLY a neutral 'partial-lead' tag — NOT 'new lead', NOT
//     'web-lead-<service>' (either could be wired to a GHL workflow that texts),
//   * create NO opportunity (a pipeline card can trigger stage automations) and
//     NO note (createContactNote is non-idempotent, so re-posting on every
//     capture would pile up duplicates — the website_leads row holds the
//     context instead).
// When the visitor later completes the form WITH consent, the normal
// syncLeadToGhl path adds 'new lead' to the very same contact and enrolls them
// then — as they intended.

import { upsertContact, addContactTags, searchContacts } from '@/lib/integrations/highlevel';
import { splitLeadName, existingNameDiffers } from '@/lib/leads/leadService';
import type { CrmContact } from '@/lib/integrations/types';

export type PartialLeadInput = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  // Free-text label for the GHL contact `source` (e.g. 'Website Form (partial)').
  source?: string;
};

export type SyncPartialLeadResult = {
  status: 'synced' | 'error';
  ghlContactId?: string;
  syncError?: string;
};

function normalizeEmailForCompare(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}
function normalizePhoneForCompare(phone: string | undefined | null): string {
  return (phone ?? '').replace(/\D/g, '');
}

// Same household guard as syncLeadToGhl: find any existing contact by this
// lead's email (then phone), so we can decide whether it's safe to send name
// fields. Fail-open — a search hiccup must never block a partial sync, so any
// throw is swallowed and treated as "no existing contact found."
async function findExistingContact(input: PartialLeadInput): Promise<CrmContact | null> {
  const email = (input.email ?? '').trim();
  const phone = (input.phone ?? '').trim();
  try {
    let results: CrmContact[] = [];
    if (email) results = await searchContacts(email);
    if (results.length === 0 && phone) results = await searchContacts(phone);
    const wantEmail = normalizeEmailForCompare(email);
    const wantPhone = normalizePhoneForCompare(phone);
    return (
      results.find(
        (c) =>
          (!!wantEmail && normalizeEmailForCompare(c.email) === wantEmail) ||
          (!!wantPhone && normalizePhoneForCompare(c.phone) === wantPhone),
      ) ?? null
    );
  } catch {
    return null;
  }
}

// Sync one partial lead to GHL: a contact + the neutral 'partial-lead' tag, and
// nothing that could trigger an SMS. Caller must supply at least one of
// email/phone (an unmatchable contact is worthless). Failure contract mirrors
// syncLeadToGhl: upsertContact is the only call allowed to THROW (no contact yet
// = nothing partial to report; the route's own catch records it on the row and
// the data is never lost). The tag step catches its own failure and still
// returns the contact id, so a tag hiccup never loses the captured contact.
export async function syncPartialLeadToGhl(input: PartialLeadInput): Promise<SyncPartialLeadResult> {
  const email = (input.email ?? '').trim();
  const phone = (input.phone ?? '').trim();
  const fullName = (input.name ?? '').trim();

  const { firstName, lastName } = splitLeadName(fullName);

  // Only send name fields when they can't clobber an existing contact's
  // identity — a half-typed / mistyped name on an abandoned form must not
  // overwrite a real contact GHL already matched by email/phone.
  const existing = await findExistingContact(input);
  const nameIsSafe = fullName !== '' && !(existing && existingNameDiffers(existing.fullName, fullName));

  const { contact } = await upsertContact({
    ...(nameIsSafe ? { firstName, lastName: lastName || undefined } : {}),
    email: email || undefined,
    phone: phone || undefined,
    address1: input.address?.trim() || undefined,
    source: input.source ?? 'Website Form (partial)',
  });

  try {
    // ONLY 'partial-lead' — see the module header for why nothing drip-adjacent
    // (no 'new lead', no service tag, no opportunity, no note) is added here.
    await addContactTags(contact.id, ['partial-lead']);
    return { status: 'synced', ghlContactId: contact.id };
  } catch (err) {
    return {
      status: 'error',
      ghlContactId: contact.id,
      syncError: err instanceof Error ? err.message : 'Unknown HighLevel error',
    };
  }
}
