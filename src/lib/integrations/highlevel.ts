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

import type {
  CrmContact,
  CrmContactInternal,
  HighLevelContact,
  HighLevelConversation,
  HighLevelMessage,
  HighLevelOpportunity,
} from './types';

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
  return (json.contacts ?? []).map(c => toCrmContact(c));
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
  // Only reuse an OPEN card. Audit fix: previously fell back to list[0] when no
  // open card existed, which resurrected a won/lost/abandoned card for a brand-new
  // quote. Returning null instead lets the caller create a fresh card. If multiple
  // open cards exist (rare), the first is fine — GHL returns them in createdAt
  // desc order which matches "most recent activity" semantics.
  const open = list.find(o => o.status === 'open');
  return open ?? null;
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
  fallbackStageId: string;   // HIGHLEVEL_STAGE_QUOTE_CREATED — the ENTRY stage (e.g. Open), never Make Quote
  fallbackName: string;       // used only if we create
  monetaryValue?: number;
  source?: string;            // used only if we create; falls through to createOpportunity's own default ('ai-quote-tool') when omitted
}): Promise<{ opportunity: HighLevelOpportunity; created: boolean }> {
  const existing = await findOpportunityForContact(input.contactId, input.pipelineId);
  if (existing) return { opportunity: existing, created: false };
  const fresh = await createOpportunity({
    contactId: input.contactId,
    pipelineId: input.pipelineId,
    pipelineStageId: input.fallbackStageId,
    name: input.fallbackName,
    monetaryValue: input.monetaryValue,
    source: input.source,
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

// ─── Conversations: READ (dashboard /inbox, #58) ───────────────────────────
// The read side of the Conversations API, confirmed against the LIVE API by
// scripts/spikes/ghl-conversations.ts. Uses CONVERSATIONS_API_VERSION. The
// dashboard adapter (src/lib/dashboard/inbox/ghl.ts) maps these raw shapes into
// the source-agnostic NormalizedTouch.

// GET /conversations/search?locationId=...&limit=...
// Returns the location's conversations (newest-activity first) + a total count
// for paging. `unresponded` detection keys off lastMessageDirection / unreadCount.
export async function searchConversations(
  opts: { limit?: number } = {},
): Promise<{ conversations: HighLevelConversation[]; total: number }> {
  const { locationId } = requireConfig();
  const params = new URLSearchParams({
    locationId,
    limit: String(Math.min(Math.max(opts.limit ?? 20, 1), 100)),
  });
  const json = await ghlFetch<{ conversations?: HighLevelConversation[]; total?: number }>(
    `/conversations/search?${params}`,
    {},
    CONVERSATIONS_API_VERSION,
  );
  return { conversations: json.conversations ?? [], total: json.total ?? 0 };
}

// GET /conversations/{id}/messages
// Spike finding: the array is DOUBLE-nested under `messages.messages` (not the
// top-level `messages`). We unwrap it here so callers get a flat list.
export async function getConversationMessages(
  conversationId: string,
): Promise<{ messages: HighLevelMessage[] }> {
  const json = await ghlFetch<{ messages?: { messages?: HighLevelMessage[] } }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    {},
    CONVERSATIONS_API_VERSION,
  );
  return { messages: json.messages?.messages ?? [] };
}

// ⚠️ WRITE — PUT /conversations/{id}/messages/{messageId}/status { status: 'read' }
// Used by the Handled write-back to quiet GHL. OPEN QUESTION the spike could NOT
// resolve without mutating GHL: whether marking the last *message* read clears
// the *conversation* unreadCount badge (if not, the reconcile cron re-surfaces a
// handled card). MUST be confirmed by a human-watched test on a throwaway
// conversation before the reconciler is trusted to stay quiet. Do not call from
// any automated path until then.
export async function markConversationRead(
  conversationId: string,
  messageId: string,
): Promise<SendMessageResult> {
  return ghlFetch<SendMessageResult>(
    `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/status`,
    { method: 'PUT', body: JSON.stringify({ status: 'read' }) },
    CONVERSATIONS_API_VERSION,
  );
}

// ⚠️ WRITE — add tags to a contact (Handled write-back: 'dashboard-handled' +
// 'handled-by-<member>'). POST /contacts/{id}/tags { tags } merges (doesn't
// replace) the contact's tags. Uses the default contacts Version header.
export async function addContactTags(contactId: string, tags: string[]): Promise<{ tags?: string[] }> {
  return ghlFetch<{ tags?: string[] }>(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tags }),
  });
}

// ─── Contact custom field upsert ───────────────────────────────────────────
// Stamps a single custom field value onto a contact — e.g. the customer portal
// link, so a GHL workflow/automation can merge {{contact.quote_link}} into a
// message. PUT /contacts/{id} on the same v2 LeadConnector API (services.
// leadconnectorhq.com, Version 2021-07-28) every other call in this file uses —
// NOT the legacy v1 `PUT /v1/contacts/{id}` + `customField: {<fieldId>: value}`
// object shape. This matches the READ side already confirmed live:
// HighLevelContact.customFields is `Array<{ id, value }>` (see types.ts), and
// v2's update endpoint accepts that same array shape back.
//
// ✅ MERGE-VS-REPLACE VERIFIED against the live API (S26, 2026-07-09): a
// throwaway contact carrying a second custom field survived a PUT that sent
// ONLY the quote-link field — v2 merges the `customFields` array per-field, it
// does NOT replace it. So stamping one field here cannot wipe a contact's
// other custom fields. (If GHL ever changes this to replace semantics, switch
// to read-modify-write: GET the contact's customFields, merge, PUT the full
// array — the failure mode would be silent data loss on real customers.)
export async function upsertContactCustomField(
  contactId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    body: JSON.stringify({ customFields: [{ id: fieldId, value }] }),
  });
}

// ─── Contact upsert (website lead capture) ─────────────────────────────────
// POST /contacts/upsert — the v2 LeadConnector endpoint that creates a NEW
// contact or updates the existing match (by email/phone) and reports which
// via `new`. Used by the website lead-capture route (src/app/api/leads) instead
// of a search-then-create/update round trip.
//
// Deliberately does NOT accept tags. GHL's upsert has replace-ish tag
// semantics on some payload shapes, while addContactTags's POST
// /contacts/{id}/tags is confirmed ADDITIVE (see the merge-vs-replace note on
// upsertContactCustomField below) — callers add tags via addContactTags
// AFTER the upsert so re-submitting a form never wipes a contact's existing
// tags.
export type UpsertContactInput = {
  firstName: string;
  lastName?: string;
  email: string;
  phone: string;
  address1?: string;
  source?: string;
};

export async function upsertContact(
  input: UpsertContactInput,
): Promise<{ contact: HighLevelContact; new: boolean }> {
  const { locationId } = requireConfig();
  const body = {
    locationId,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    address1: input.address1,
    source: input.source,
  };
  return ghlFetch<{ contact: HighLevelContact; new: boolean }>('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Contact note create ────────────────────────────────────────────────
// POST /contacts/{contactId}/notes — attaches a free-text note to the
// contact's timeline (e.g. the website lead's raw notes / UTM / landing-page
// context, which don't fit any existing custom field).
type ContactNoteResult = { id?: string; body?: string; [k: string]: unknown };

export async function createContactNote(contactId: string, body: string): Promise<ContactNoteResult> {
  return ghlFetch<ContactNoteResult>(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// ─── Mapper: HighLevel → CrmContact ───────────────────────────────────────
// Centralized so a schema drift on GHL's side only breaks here, not in
// every consumer. Audit fix: redaction is now the DEFAULT — the public
// CrmContact carries no raw source record, so it's safe to forward to the
// browser without a manual strip. The raw HighLevel record is only attached
// when a server-only caller explicitly opts in via { includeRaw: true },
// yielding the off-the-wire CrmContactInternal type.
function toCrmContact(hl: HighLevelContact): CrmContact;
function toCrmContact(hl: HighLevelContact, opts: { includeRaw: true }): CrmContactInternal;
function toCrmContact(
  hl: HighLevelContact,
  opts?: { includeRaw?: boolean },
): CrmContact | CrmContactInternal {
  const base: CrmContact = {
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
  };
  return opts?.includeRaw ? { ...base, raw: hl } : base;
}
