// Domain logic for the website lead-capture route (POST /api/leads). The
// company website (WordPress) embeds custom quote-request forms per service
// line; this module knows how to resolve a lead's service to the right GHL
// pipeline and how to sync one saved lead row into HighLevel (contact +
// tags + note + opportunity). Kept separate from the route so the route
// handler stays thin and this logic is unit-testable without an HTTP layer.
//
// Replaces the old plugin behavior of routing EVERY lead into the Christmas
// pipeline — each service now lands its opportunity in its OWN pipeline.

import {
  upsertContact,
  addContactTags,
  upsertContactCustomField,
  createContactNote,
  findOrCreateOpportunityForContact,
  searchContacts,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages } from '@/lib/integrations/ghlPipelineMap';
import type { CrmContact } from '@/lib/integrations/types';

// ─── Lead service (the website form's own vocabulary — NOT the quote tool's
// ServiceType) ───────────────────────────────────────────────────────────
export const LEAD_SERVICES = ['christmas', 'permanent', 'event-wedding', 'landscape'] as const;
export type LeadService = (typeof LEAD_SERVICES)[number];

/** Narrow an unknown value to a LeadService, or null if it isn't one. */
export function asLeadService(v: unknown): LeadService | null {
  return typeof v === 'string' && (LEAD_SERVICES as readonly string[]).includes(v)
    ? (v as LeadService)
    : null;
}

// ─── Pipeline resolution ────────────────────────────────────────────────
// All 4 lead services reuse the quote tool's own pipeline map — their
// pipelines already exist in GHL and are used by the quote-send flow too.
// landscape rides the SAME live GHL pipeline as permanent_bistro (#117 — the
// Landscape Lighting pipeline; bistro cards already land there, see
// ghlPipelineMap.ts), so a website landscape lead resolves through that map
// entry too (WT-50; was previously env-driven via two vars that were never
// configured in prod, so every landscape lead silently deferred forever).
export type LeadPipeline = { pipelineId: string; entryStageId: string };

export function resolveLeadPipeline(service: LeadService): LeadPipeline | null {
  switch (service) {
    // envOverrides:false — a website lead is a BRAND NEW contact with no
    // card yet, so it must land at the pipeline's own entry stage (📭Open).
    // The quote-flow env override (HIGHLEVEL_STAGE_QUOTE_CREATED) points at
    // the mid-pipeline "Make Quote" stage in the live account — right for a
    // quote created off an EXISTING lead, wrong for a brand-new one.
    case 'christmas': {
      const stages = resolvePipelineStages('holiday', { envOverrides: false });
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'permanent': {
      const stages = resolvePipelineStages('permanent', { envOverrides: false });
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'event-wedding': {
      const stages = resolvePipelineStages('event', { envOverrides: false });
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'landscape': {
      const stages = resolvePipelineStages('permanent_bistro', { envOverrides: false });
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
  }
}

// ─── contact.service custom field ──────────────────────────────────────
// The GHL field id is a per-env setting (HIGHLEVEL_CONTACT_FIELD_SERVICE) —
// when unset, the field write is skipped entirely (the dev hasn't matched
// the field's dropdown options to these labels in the GHL UI yet).
export const SERVICE_FIELD_VALUE: Record<LeadService, string> = {
  christmas: 'Christmas',
  permanent: 'Permanent',
  'event-wedding': 'Event/Wedding',
  landscape: 'Landscape',
};

// ─── Name split ─────────────────────────────────────────────────────────
// The old plugin dropped every word past the second (firstName + one word of
// lastName) — don't repeat that. First word is firstName; EVERY remaining
// word is lastName, joined back with single spaces.
export function splitLeadName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const [firstName, ...rest] = parts;
  return { firstName: firstName ?? '', lastName: rest.join(' ') };
}

// ─── Note body ──────────────────────────────────────────────────────────
// Strips newlines from the two fields a submitter fully controls the raw
// text of (landingUrl, each utm value) — without this, a crafted value like
// "https://x/\nFAKE STATUS: approved" could inject a fake extra line into
// the note. `notes` is deliberately left alone: it's legitimately free text
// and is meant to stay multi-line.
function stripNewlinesForNote(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

export function buildLeadNoteBody(lead: LeadInput): string {
  const lines: string[] = [
    `New website lead — ${SERVICE_FIELD_VALUE[lead.service]} — form: ${lead.formVariant}`,
  ];
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  if (lead.utm && Object.keys(lead.utm).length > 0) {
    lines.push(
      `UTM: ${Object.entries(lead.utm)
        .map(([k, v]) => `${k}=${stripNewlinesForNote(v)}`)
        .join(', ')}`,
    );
  }
  if (lead.landingUrl) lines.push(`Landing page: ${stripNewlinesForNote(lead.landingUrl)}`);
  return lines.join('\n');
}

// ─── Household / spousal contact handling ──────────────────────────────
// Live-proven bug: GHL's /contacts/upsert matches an existing contact by
// email/phone and OVERWRITES its firstName/lastName. When a second person in
// the same household (spouse, shared phone) submits the form under a
// different name, that silently erases the original contact's identity.
// Fix: search for an existing contact BEFORE the upsert; if one is found
// under a genuinely different name, upsert WITHOUT name fields (so the
// original name survives) and record who actually submitted this one.

function normalizeEmailForCompare(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}

// Compare on the NATIONAL number, not the raw digit string. HighLevel stores
// US numbers in E.164 ('+16315550100' -> 11 digits, leading country code)
// while the website form collects 10 digits, so a plain digit-strip compare
// NEVER matches a phone-only household. The guard below then sees no existing
// contact and lets the upsert send name fields — and GHL, whose own matching
// DOES normalize the country code, happily overwrites the real contact's
// name. Shared with partialLead.ts so both sync paths agree.
export function normalizePhoneForCompare(phone: string | undefined | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * True when existingName is present and differs (case-insensitively, trimmed)
 * from submittedName. An empty/missing existingName is treated as NOT
 * differing — there's no identity to protect yet.
 */
export function existingNameDiffers(
  existingName: string | undefined | null,
  submittedName: string,
): boolean {
  const existing = (existingName ?? '').trim();
  if (!existing) return false;
  return existing.toLowerCase() !== submittedName.trim().toLowerCase();
}

export function buildHouseholdNoteBody(lead: LeadInput, existingName: string): string {
  const submittedName = stripNewlinesForNote(lead.name);
  const submittedPhone = stripNewlinesForNote(lead.phone);
  const safeExistingName = stripNewlinesForNote(existingName);
  return (
    `Household note: ${submittedName} submitted a website ${SERVICE_FIELD_VALUE[lead.service]} ` +
    `request using this contact's email/phone on file. Contact name kept as ${safeExistingName}. ` +
    `Submitted phone: ${submittedPhone}.`
  );
}

// Pre-check: search by email first, falling back to phone when the email
// search comes up empty, then pick the first result that actually matches
// the lead's email or phone (defensive — a text-query search can return
// near-matches, not just exact ones). Fail-open: a search hiccup must never
// block or lose a lead sync, so any throw here is swallowed and treated as
// "no existing contact found."
async function findHouseholdMatch(lead: LeadInput): Promise<CrmContact | null> {
  try {
    let results = await searchContacts(lead.email);
    if (results.length === 0) {
      results = await searchContacts(lead.phone);
    }
    const wantEmail = normalizeEmailForCompare(lead.email);
    const wantPhone = normalizePhoneForCompare(lead.phone);
    return (
      results.find(
        c =>
          (!!wantEmail && normalizeEmailForCompare(c.email) === wantEmail) ||
          (!!wantPhone && normalizePhoneForCompare(c.phone) === wantPhone),
      ) ?? null
    );
  } catch {
    return null;
  }
}

// ─── syncLeadToGhl ──────────────────────────────────────────────────────
// The one GHL round-trip a saved lead goes through: upsert the contact, tag
// it, stamp the service field, drop a note with the raw context, then
// find-or-create its opportunity in the right pipeline.
//
// Failure contract: upsertContact is the only call allowed to THROW (no
// contact yet means nothing partial to report — the ROUTE's own catch is the
// backstop, leaving the row 'pending' for retry). Every step AFTER the
// contact exists catches its own failure and returns status 'error' WITH the
// ghlContactId already captured, so a partial sync never loses the contact
// id. Every LeadService now resolves to a real, live pipeline (WT-50), but
// resolveLeadPipeline's return type stays nullable and 'deferred' stays a
// defensive fallback for a future service added without its pipeline wired
// up yet — a missing pipeline is NOT an error.
export type LeadInput = {
  name: string;
  email: string;
  phone: string;
  address?: string | null;
  service: LeadService;
  notes?: string | null;
  utm?: Record<string, string> | null;
  landingUrl?: string | null;
  formVariant: string;
};

export type SyncLeadToGhlResult = {
  status: 'synced' | 'deferred' | 'error';
  ghlContactId?: string;
  ghlOpportunityId?: string;
  syncError?: string;
};

// contact.service is a GHL CHECKBOX-dataType custom field: GHL stores (and
// expects back) an ARRAY of selected option strings, not a scalar. It may
// come back off the upsertContact response as a string (older/legacy data)
// or an array — normalize defensively either way.
function normalizeCheckboxValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' && value ? [value] : [];
}

// opts.skipNotes — set by the RETRY worker when the row already has a
// ghl_contact_id (a sync that failed AFTER the contact was created). Both note
// calls below are the ONLY non-idempotent GHL steps here, so re-posting them on
// retry would duplicate the note; skipping them lets the retry safely re-run the
// idempotent steps (tags/field/opportunity) to finish a partial sync. Trade-off:
// if the note itself was the failing step, that note never lands — a missing
// note is far cheaper than a duplicate, and the row (Supabase) is the source of
// truth for the lead's context regardless.
export async function syncLeadToGhl(
  lead: LeadInput,
  opts: { skipNotes?: boolean } = {},
): Promise<SyncLeadToGhlResult> {
  const { firstName, lastName } = splitLeadName(lead.name);

  // Household pre-check — one extra read before the upsert, only to decide
  // whether name fields are safe to send. Fail-open: a search hiccup falls
  // through to the plain (pre-existing) path below.
  const householdMatch = await findHouseholdMatch(lead);
  const isHousehold =
    householdMatch !== null && existingNameDiffers(householdMatch.fullName, lead.name);

  // upsertContact is the one call allowed to throw — with no contact yet,
  // there's nothing partial to report, so the ROUTE's own catch is the
  // backstop (keeps the row 'pending' for retry). On the household path we
  // omit firstName/lastName entirely so the upsert can't overwrite the
  // original contact's identity.
  const { contact } = await upsertContact({
    ...(isHousehold ? {} : { firstName, lastName: lastName || undefined }),
    email: lead.email,
    phone: lead.phone,
    address1: lead.address ?? undefined,
    source: 'Website Form',
  });

  // Every step from here catches its OWN failure (below) so a partial sync
  // never loses the contact id — the route needs ghl_contact_id even when a
  // later step (tag/field/note/opportunity) fails.
  try {
    const tags = isHousehold
      ? ['new lead', `web-lead-${lead.service}`, 'household-second-contact']
      : ['new lead', `web-lead-${lead.service}`];
    await addContactTags(contact.id, tags);

    const fieldId = process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE;
    if (fieldId) {
      // Checkbox-field updates REPLACE the whole selection set (unlike a
      // text field's upsert), so we read whatever is already selected on
      // this contact and UNION in this lead's service label rather than
      // overwriting. Without this, a contact who already submitted a
      // Christmas lead would lose that selection the moment they also
      // submit a Permanent one.
      const existing = normalizeCheckboxValue(
        contact.customFields?.find(f => f.id === fieldId)?.value,
      );
      const union = Array.from(new Set([...existing, SERVICE_FIELD_VALUE[lead.service]]));
      await upsertContactCustomField(contact.id, fieldId, union);
    }

    if (isHousehold && !opts.skipNotes) {
      // Independent of the notes/utm/landingUrl guard below — staff need to
      // see this even when the submitter left every optional field blank.
      // Skipped on retry (skipNotes) — see the opts.skipNotes note above.
      await createContactNote(
        contact.id,
        buildHouseholdNoteBody(lead, householdMatch!.fullName ?? ''),
      );
    }

    if ((lead.notes || lead.utm || lead.landingUrl) && !opts.skipNotes) {
      // The retry worker SKIPS this call once ghl_contact_id is already set on
      // the row (skipNotes) — createContactNote is NOT idempotent, so re-running
      // the sync on retry would otherwise post a duplicate note.
      await createContactNote(contact.id, buildLeadNoteBody(lead));
    }

    const pipeline = resolveLeadPipeline(lead.service);
    if (!pipeline) {
      return {
        status: 'deferred',
        ghlContactId: contact.id,
        syncError: `GHL pipeline not configured for "${lead.service}"`,
      };
    }

    const { opportunity } = await findOrCreateOpportunityForContact({
      contactId: contact.id,
      pipelineId: pipeline.pipelineId,
      fallbackStageId: pipeline.entryStageId,
      fallbackName: lead.name,
      source: 'Website Leads',
    });

    return {
      status: 'synced',
      ghlContactId: contact.id,
      ghlOpportunityId: opportunity.id,
    };
  } catch (err) {
    return {
      status: 'error',
      ghlContactId: contact.id,
      syncError: err instanceof Error ? err.message : 'Unknown HighLevel error',
    };
  }
}
