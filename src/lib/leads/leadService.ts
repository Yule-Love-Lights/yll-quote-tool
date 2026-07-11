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
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages } from '@/lib/integrations/ghlPipelineMap';

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
// christmas/permanent/event-wedding reuse the quote tool's own pipeline map
// (their pipelines already exist in GHL and are used by the quote-send flow
// too). landscape has no pipeline yet — it's resolved purely from env so the
// dev can wire it up later without a code change.
export type LeadPipeline = { pipelineId: string; entryStageId: string };

export function resolveLeadPipeline(service: LeadService): LeadPipeline | null {
  switch (service) {
    case 'christmas': {
      const stages = resolvePipelineStages('holiday');
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'permanent': {
      const stages = resolvePipelineStages('permanent');
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'event-wedding': {
      const stages = resolvePipelineStages('event');
      return { pipelineId: stages.pipelineId, entryStageId: stages.entry };
    }
    case 'landscape': {
      const pipelineId = process.env.HIGHLEVEL_PIPELINE_ID_LANDSCAPE;
      const entryStageId = process.env.HIGHLEVEL_STAGE_LANDSCAPE_ENTRY;
      if (!pipelineId || !entryStageId) return null;
      return { pipelineId, entryStageId };
    }
  }
}

function missingLandscapeEnvVars(): string[] {
  const missing: string[] = [];
  if (!process.env.HIGHLEVEL_PIPELINE_ID_LANDSCAPE) missing.push('HIGHLEVEL_PIPELINE_ID_LANDSCAPE');
  if (!process.env.HIGHLEVEL_STAGE_LANDSCAPE_ENTRY) missing.push('HIGHLEVEL_STAGE_LANDSCAPE_ENTRY');
  return missing;
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
export function buildLeadNoteBody(lead: LeadInput): string {
  const lines: string[] = [
    `New website lead — ${SERVICE_FIELD_VALUE[lead.service]} — form: ${lead.formVariant}`,
  ];
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  if (lead.utm && Object.keys(lead.utm).length > 0) {
    lines.push(`UTM: ${Object.entries(lead.utm).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (lead.landingUrl) lines.push(`Landing page: ${lead.landingUrl}`);
  return lines.join('\n');
}

// ─── syncLeadToGhl ──────────────────────────────────────────────────────
// The one GHL round-trip a saved lead goes through: upsert the contact, tag
// it, stamp the service field, drop a note with the raw context, then
// find-or-create its opportunity in the right pipeline. Throws on any GHL
// failure (upsertContact/addContactTags/etc) — the ROUTE is responsible for
// catching that and leaving the lead row 'pending' for retry; a missing
// landscape pipeline is NOT an error and returns a 'deferred' result instead.
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
  status: 'synced' | 'deferred';
  ghlContactId?: string;
  ghlOpportunityId?: string;
  syncError?: string;
};

export async function syncLeadToGhl(lead: LeadInput): Promise<SyncLeadToGhlResult> {
  const { firstName, lastName } = splitLeadName(lead.name);

  const { contact } = await upsertContact({
    firstName,
    lastName: lastName || undefined,
    email: lead.email,
    phone: lead.phone,
    address1: lead.address ?? undefined,
    source: 'Website Form',
  });

  await addContactTags(contact.id, ['new lead', `web-lead-${lead.service}`]);

  const fieldId = process.env.HIGHLEVEL_CONTACT_FIELD_SERVICE;
  if (fieldId) {
    await upsertContactCustomField(contact.id, fieldId, SERVICE_FIELD_VALUE[lead.service]);
  }

  if (lead.notes || lead.utm || lead.landingUrl) {
    await createContactNote(contact.id, buildLeadNoteBody(lead));
  }

  const pipeline = resolveLeadPipeline(lead.service);
  if (!pipeline) {
    return {
      status: 'deferred',
      ghlContactId: contact.id,
      syncError: `GHL pipeline not configured for "${lead.service}" — missing env var(s): ${missingLandscapeEnvVars().join(', ')}`,
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
}
