// HighLevel (GoHighLevel / LeadConnector) API client. Wraps the subset of
// endpoints the quote tool uses: contact search, contact fetch, opportunity
// create/update.
//
// Auth: Private Integration token scoped to a single Location. We don't
// support agency-level or multi-location operation in Phase 1 — Yule Love
// Lights is one business with one GHL location. If franchise expansion
// happens later, we'd introduce a per-tenant token table and look up by
// org id on each call.
//
// Docs: https://highlevel.stoplight.io/docs/integrations/
// API base: https://services.leadconnectorhq.com
// Version header: Version: 2021-07-28  (required — the gateway 400s without it)

import type { CrmContact, HighLevelContact, HighLevelOpportunity } from './types';

const API_BASE = 'https://services.leadconnectorhq.com';
const API_VERSION_HEADER = '2021-07-28';

export class HighLevelError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'HighLevelError';
  }
}

export function isHighLevelConfigured(): boolean {
  return !!(process.env.HIGHLEVEL_API_KEY && process.env.HIGHLEVEL_LOCATION_ID);
}

function requireConfig(): { apiKey: string; locationId: string } {
  const apiKey = process.env.HIGHLEVEL_API_KEY;
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!apiKey || !locationId) {
    throw new HighLevelError(
      'HighLevel not configured. Set HIGHLEVEL_API_KEY and HIGHLEVEL_LOCATION_ID in .env.local',
    );
  }
  return { apiKey, locationId };
}

async function ghlFetch<T>(
  path: string,
  init: RequestInit = {},
  version: string = API_VERSION_HEADER,
): Promise<T> {
  const { apiKey } = requireConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Version': version,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HighLevelError(
      `HighLevel ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`,
      res.status,
      body.slice(0, 2000),
    );
  }
  return res.json() as Promise<T>;
}

// ─── Contact search ───────────────────────────────────────────────────────
// Used by the "start a new quote" flow to pre-fill customer info. Operator
// types a name/email/phone; we search HighLevel; they pick the match.
//
// Endpoint: GET /contacts/?locationId=...&query=...
// Returns up to 20 matches. If we need more later, switch to the
// /contacts/search POST endpoint which supports richer filtering.
export async function searchContacts(query: string, limit = 20): Promise<CrmContact[]> {
  if (!query.trim()) return [];
  const { locationId } = requireConfig();
  const params = new URLSearchParams({
    locationId,
    query: query.trim(),
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  const json = await ghlFetch<{ contacts?: HighLevelContact[] }>(`/contacts/?${params}`);
  return (json.contacts ?? []).map(toCrmContact);
}

// ─── Contact fetch ────────────────────────────────────────────────────────
// When the quote tool starts from a HighLevel workflow or email link with
// a specific contactId in the URL, we hydrate the full record here.
export async function getContact(contactId: string): Promise<CrmContact> {
  const json = await ghlFetch<{ contact: HighLevelContact }>(`/contacts/${encodeURIComponent(contactId)}`);
  return toCrmContact(json.contact);
}

// ─── Opportunity search (by contact) ──────────────────────────────────────
// Customers exist in HighLevel BEFORE they hit our quote tool — they were
// captured via lead forms or manual entry and already have an opportunity
// card in the Christmas Lights pipeline (typically at "📭Open" stage).
// When the admin picks a contact in the autocomplete, we look up that
// existing card and attach our quote to it instead of creating a duplicate.
//
// Endpoint: GET /opportunities/search?location_id=...&pipeline_id=...&contact_id=...
// Returns all opportunities matching the filters. We narrow to "open" /
// non-lost statuses and take the most recent.
export async function findOpportunityForContact(
  contactId: string,
  pipelineId: string,
): Promise<HighLevelOpportunity | null> {
  const { locationId } = requireConfig();
  const params = new URLSearchParams({
    location_id: locationId,
    pipeline_id: pipelineId,
    contact_id: contactId,
  });
  const json = await ghlFetch<{ opportunities?: HighLevelOpportunity[] }>(
    `/opportunities/search?${params}`,
  );
  const list = json.opportunities ?? [];
  if (list.length === 0) return null;
  // Prefer open opportunities over won/lost/abandoned. If multiple open
  // cards exist (rare), the first is fine — GHL returns them in createdAt
  // desc order which matches "most recent activity" semantics.
  const open = list.find(o => o.status === 'open');
  return open ?? list[0];
}

// ─── Opportunity create ───────────────────────────────────────────────────
// Creates a pipeline card in GHL when a quote is saved. Lets the sales
// pipeline view show "3 open quotes waiting on customer signature" etc.
// without humans manually moving cards.
//
// Endpoint: POST /opportunities/
// Required: locationId, contactId, pipelineId, pipelineStageId
// Optional but useful: name, monetaryValue, status
export type CreateOpportunityInput = {
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  name: string;            // e.g., "2026 Holiday Lights — 123 Main St"
  monetaryValue?: number;  // quote total
  source?: string;         // e.g., 'ai-quote-tool'
};

export async function createOpportunity(input: CreateOpportunityInput): Promise<HighLevelOpportunity> {
  const { locationId } = requireConfig();
  const body = {
    locationId,
    contactId: input.contactId,
    pipelineId: input.pipelineId,
    pipelineStageId: input.pipelineStageId,
    name: input.name,
    monetaryValue: input.monetaryValue,
    status: 'open' as const,
    source: input.source ?? 'ai-quote-tool',
  };
  const json = await ghlFetch<{ opportunity: HighLevelOpportunity }>('/opportunities/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return json.opportunity;
}

// ─── Find OR create opportunity ────────────────────────────────────────────
// Convenience wrapper for the save-quote flow. Given a contact, returns
// their existing pipeline card (typical case — customer was in the pipeline
// before opening the quote tool) or creates a new one at "Make Quote" stage
// as a fallback (edge case — contact exists but no opportunity yet).
export async function findOrCreateOpportunityForContact(input: {
  contactId: string;
  pipelineId: string;
  fallbackStageId: string;   // e.g., HIGHLEVEL_STAGE_QUOTE_CREATED (Make Quote)
  fallbackName: string;       // used only if we create
  monetaryValue?: number;
}): Promise<{ opportunity: HighLevelOpportunity; created: boolean }> {
  const existing = await findOpportunityForContact(input.contactId, input.pipelineId);
  if (existing) return { opportunity: existing, created: false };
  const fresh = await createOpportunity({
    contactId: input.contactId,
    pipelineId: input.pipelineId,
    pipelineStageId: input.fallbackStageId,
    name: input.fallbackName,
    monetaryValue: input.monetaryValue,
  });
  return { opportunity: fresh, created: true };
}

// ─── Opportunity stage advance ────────────────────────────────────────────
// When the quote is "sent" or "accepted," we move the card to the next
// stage. Stage IDs are discovered once (see listPipelines below) and
// stored in env vars — HIGHLEVEL_STAGE_QUOTE_SENT, etc.
export async function updateOpportunityStage(
  opportunityId: string,
  pipelineStageId: string,
): Promise<HighLevelOpportunity> {
  const json = await ghlFetch<{ opportunity: HighLevelOpportunity }>(
    `/opportunities/${encodeURIComponent(opportunityId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ pipelineStageId }),
    },
  );
  return json.opportunity;
}

// ─── Opportunity update (stage + card fields) ──────────────────────────────
// Generalizes updateOpportunityStage: set any of stage / name / monetary value
// on an existing card. Used by "Send Quote" (#37) to advance the card to Bid
// Sent AND refresh its title ("FirstName LastName") + value (quote total) in
// one call. Only the provided fields are sent — undefined fields are left
// untouched (so we never blank out an existing value). We intentionally do NOT
// touch `source` here: on an existing card it records where the lead came from.
export type UpdateOpportunityFields = {
  pipelineStageId?: string;
  name?: string;
  monetaryValue?: number;
};

export async function updateOpportunity(
  opportunityId: string,
  fields: UpdateOpportunityFields,
): Promise<HighLevelOpportunity> {
  const body: Record<string, unknown> = {};
  if (fields.pipelineStageId !== undefined) body.pipelineStageId = fields.pipelineStageId;
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.monetaryValue !== undefined) body.monetaryValue = fields.monetaryValue;
  const json = await ghlFetch<{ opportunity: HighLevelOpportunity }>(
    `/opportunities/${encodeURIComponent(opportunityId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
  return json.opportunity;
}

// ─── Pipelines list (one-time setup helper) ───────────────────────────────
// Not called from production code — used manually via a dev script to
// discover pipelineId + stage IDs so we can set the env vars.
// Call once during setup, record the IDs in .env.local.
export async function listPipelines(): Promise<unknown> {
  const { locationId } = requireConfig();
  return ghlFetch(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
}

// ─── Conversations: send SMS / Email ───────────────────────────────────────
// Deliver the portal link to the customer through GHL so it lands in the
// Conversations tab (#37). The conversations API historically uses a different
// Version header than contacts/opportunities. Success = no throw; the raw send
// result is returned for logging/debugging.
//
// ⚠️ The exact request shape (Version, fromNumber / emailFrom / replyTo field
// names) is confirmed by a live test send — adjust here if the live probe shows
// GHL expects different keys.
const CONVERSATIONS_API_VERSION = '2021-04-15';

type SendMessageResult = { messageId?: string; conversationId?: string; [k: string]: unknown };

export async function sendSms(input: {
  contactId: string;
  message: string;
  fromNumber?: string; // E.164, e.g. +16315170186; omit to use the location default
}): Promise<SendMessageResult> {
  return ghlFetch<SendMessageResult>(
    '/conversations/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'SMS',
        contactId: input.contactId,
        message: input.message,
        ...(input.fromNumber ? { fromNumber: input.fromNumber } : {}),
      }),
    },
    CONVERSATIONS_API_VERSION,
  );
}

export async function sendEmail(input: {
  contactId: string;
  subject: string;
  html: string;
  emailFrom?: string; // e.g. "Yule Love Lights <sales@yulelovelights.com>" — sets the from + reply-to
}): Promise<SendMessageResult> {
  // NOTE: GHL's `replyTo` field is an enum (not an address) — passing an email
  // there 422s. The from address (emailFrom) is what replies route back to.
  return ghlFetch<SendMessageResult>(
    '/conversations/messages',
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'Email',
        contactId: input.contactId,
        subject: input.subject,
        html: input.html,
        ...(input.emailFrom ? { emailFrom: input.emailFrom } : {}),
      }),
    },
    CONVERSATIONS_API_VERSION,
  );
}

// ─── Mapper: HighLevel → CrmContact ───────────────────────────────────────
// Centralized so a schema drift on GHL's side only breaks here, not in
// every consumer. Also where we strip the raw field before it escapes
// to the browser (API routes set raw=undefined before returning).
function toCrmContact(hl: HighLevelContact): CrmContact {
  return {
    id: hl.id,
    source: 'highlevel',
    firstName: hl.firstName,
    lastName: hl.lastName,
    fullName:
      hl.contactName ??
      ([hl.firstName, hl.lastName].filter(Boolean).join(' ') || undefined),
    email: hl.email,
    phone: hl.phone,
    address1: hl.address1,
    city: hl.city,
    state: hl.state,
    postalCode: hl.postalCode,
    raw: hl,
  };
}
