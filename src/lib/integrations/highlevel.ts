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
  constructor(
    message: string,
    public status?: number,
    public body?: string,
    // #264: set only by ghlFetch's own timeout branch below — lets a caller
    // (POST /api/quotes/[id]/send) tell "GHL rejected the request" apart from
    // "we gave up waiting for a response," which matters because a timeout is
    // NOT a confirmed failure (GHL may have already processed the request
    // server-side before our socket gave up).
    public timedOut?: boolean,
  ) {
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

// Hard per-call deadline (ledger #264). Every GHL call in this file funnels
// through this one function, so ONE timeout here bounds the whole class —
// contact ops, opportunity CRUD, conversations (SMS/email) send, custom
// fields — with no per-caller changes needed. Previously ghlFetch had no
// cancellation at all: a hung connection stalled the caller (most acutely
// POST /api/quotes/[id]/send, whose four concurrent tasks all fail to settle
// until every GHL call either resolves or rejects) indefinitely.
//
// This is a REAL cancellation (AbortController tears down the in-flight
// socket), unlike ghlTenure.ts's PUSH_DEADLINE_MS: that wrapper is a
// Promise.race the caller loses, but its own comment says the underlying
// call "may still complete in the background" because "ghlFetch has no
// AbortController; out of scope to add one here." This ships that
// deferred piece at the source instead of re-wrapping each caller.
//
// Idiom: manual AbortController + setTimeout, cleared in finally — mirrors
// valor.ts's HOSTED_PAGE_TIMEOUT_MS pattern (the closest analog: another
// "wrap a 3rd-party API, throw a typed error, distinguish a timeout from a
// real rejection" module), and the dominant convention across this repo's
// other outbound integrations (googleMaps.ts, telegramMedia.ts,
// transcribe.ts, valorVault.ts, valorBalance.ts). NOT AbortSignal.timeout():
// confirmed empirically that vitest's vi.useFakeTimers()/advanceTimersByTimeAsync
// does not advance AbortSignal.timeout()'s internal clock in this repo's test
// environment (it does advance a plain setTimeout), so that idiom can't be
// covered by the fake-timer test this fix requires (step 8) — a correctness
// reason, not just a style preference.
//
// 10s matches this repo's other 3rd-party-API timeouts (Valor's
// HOSTED_PAGE_TIMEOUT_MS / googleMaps.ts's DEFAULT_TIMEOUT_MS, both 10_000) —
// generous for one HTTP round trip to a well-behaved SaaS API, while keeping
// the send route's worst-case chain (findOpportunityForContact →
// createOpportunity → resurrect's getOpportunity + updateOpportunity →
// upsertContactCustomField, up to 5 sequential GHL calls when a duplicate
// card is resurrected) bounded at ~50s instead of unbounded. Applied PER
// CALL, not per logical operation.
const GHL_TIMEOUT_MS = 10_000;

// Exported for src/lib/calls/* (calls_merge_plan_2026-08.md slice S2):
// reuse this file's auth/timeout/error-shape handling for the calls export
// and transcription endpoints instead of standing up a second HighLevel
// client, per the plan's decision to reconcile rather than duplicate.
export async function ghlFetch<T>(
  path: string,
  init: RequestInit = {},
  version: string = API_VERSION_HEADER,
): Promise<T> {
  const { apiKey } = requireConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHL_TIMEOUT_MS);
  const label = `${init.method ?? 'GET'} ${path}`;
  function timeoutError(phase: string): HighLevelError {
    return new HighLevelError(
      `HighLevel ${label} timed out after ${GHL_TIMEOUT_MS}ms (${phase})`,
      undefined,
      undefined,
      true,
    );
  }
  // #264 round 2, FIX 2: the timer is now cleared only after the ENTIRE call
  // — headers AND body — has been consumed. Round 1 cleared it right after
  // fetch() resolved, so a fast-headers/slow-body response (confirmed live:
  // a local server that sends 200 headers then stalls the body) hung past
  // the "10s bounds the whole class" claim — the deadline never covered the
  // res.json()/res.text() read at all. An abort mid-body-read rejects that
  // read with the same AbortError fetch() itself throws on a connect-phase
  // abort (verified against a real hung-body response), so the same
  // controller.signal.aborted check classifies it.
  try {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Version': version,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError('connecting');
      throw err;
    }
    if (!res.ok) {
      // A body-read abort here still resolves to an empty string (the same
      // fallback the original `.catch(() => '')` already used) rather than
      // being reclassified as timedOut: the HTTP status already arrived and
      // is a KNOWN, non-ambiguous outcome (GHL responded with a real non-2xx
      // code) — only the descriptive error text is missing, unlike the
      // connect-phase and success-body-read cases below, where a timeout
      // means we never learned the outcome at all.
      const body = await res.text().catch(() => '');
      throw new HighLevelError(
        `HighLevel ${label} → ${res.status}: ${body.slice(0, 400)}`,
        res.status,
        body.slice(0, 2000),
      );
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      if (controller.signal.aborted) throw timeoutError('reading the response body');
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
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

// ─── Contacts: full paginated listing (referral sweep) ────────────────────
// Unlike searchContacts above (a bounded, text-query autocomplete), this
// pages through EVERY contact in the location, used by the referral sweep
// (src/lib/referralSweep.ts) to eventually reach all of them. POST
// /contacts/search with searchAfter cursor paging; shape confirmed live in
// this repo already (scripts/winback-recon.ts, S31): a batch shorter than
// the requested pageLimit means "last page", and the last returned row
// carries its OWN `searchAfter` array, which is the cursor for the next
// call. Sorted by dateAdded ascending on purpose: a brand-new contact lands
// at the END of the list, so a cursor that only ever moves forward
// eventually reaches it (see referralSweep.ts's cursor-persistence comment
// for how a wrap-around keeps that true run after run).
//
// Returns RAW HighLevelContact objects (not the redacted CrmContact shape):
// the sweep needs tags + customFields, which toCrmContact strips.
export type ContactSearchPage = {
  contacts: HighLevelContact[];
  /** Cursor for the next page; undefined means this was the last page. */
  nextSearchAfter?: unknown[];
};

export async function searchContactsPage(input: {
  pageLimit?: number;
  searchAfter?: unknown[];
}): Promise<ContactSearchPage> {
  const { locationId } = requireConfig();
  const pageLimit = Math.min(Math.max(input.pageLimit ?? 100, 1), 100);
  const body: Record<string, unknown> = {
    locationId,
    pageLimit,
    filters: [],
    sort: [{ field: 'dateAdded', direction: 'asc' }],
    ...(input.searchAfter ? { searchAfter: input.searchAfter } : {}),
  };
  const json = await ghlFetch<{ contacts?: (HighLevelContact & { searchAfter?: unknown[] })[] }>(
    '/contacts/search',
    { method: 'POST', body: JSON.stringify(body) },
  );
  const contacts = json.contacts ?? [];
  const last = contacts[contacts.length - 1];
  return {
    contacts,
    // A short page (fewer rows than asked for) is GHL's own "no more" signal:
    // don't hand back a cursor even if the last row happens to carry one.
    nextSearchAfter: contacts.length >= pageLimit ? last?.searchAfter : undefined,
  };
}

// ─── Contact fetch ────────────────────────────────────────────────────────
// When the quote tool starts from a HighLevel workflow or email link with
// a specific contactId in the URL, we hydrate the full record here.
export async function getContact(contactId: string): Promise<CrmContact> {
  const json = await ghlFetch<{ contact: HighLevelContact }>(`/contacts/${encodeURIComponent(contactId)}`);
  return toCrmContact(json.contact);
}

// Server-only variant that returns the RAW HighLevel record (never forward to
// the browser — see CrmContactInternal's own doc comment). Added for #314's
// approval-time event-date reconciliation (ghlEventDate.ts's
// getEventDateFromGhl): the public getContact() above redacts customFields
// via toCrmContact's default overload, but #314 needs to read the CURRENT
// value of a specific custom field to detect drift from an earlier silent
// push failure. Reuses the SAME `{ includeRaw: true }` overload already
// declared on toCrmContact below (previously unused) rather than adding a
// second contact-fetch path.
export async function getContactInternal(contactId: string): Promise<CrmContactInternal> {
  const json = await ghlFetch<{ contact: HighLevelContact }>(`/contacts/${encodeURIComponent(contactId)}`);
  return toCrmContact(json.contact, { includeRaw: true });
}

// ─── Contact create ───────────────────────────────────────────────────────
// Creates a brand-new GHL contact — used by the referral landing page (#41
// /refer/<code> submit) to get a referred lead into HighLevel immediately, so
// staff can follow up from the CRM they already work out of. Mirrors
// createOpportunity's request shape (locationId + POST /contacts/, default
// Version header). Unlike searchContacts/getContact this WRITES — callers
// should only invoke it when they actually mean to create a new record (no
// dedupe/search-first here; that's the caller's job if it matters for them).
export type CreateContactInput = {
  name?: string;
  email?: string;
  phone?: string;
  address1?: string;
  tags?: string[];
  source?: string;
};

export async function createContact(input: CreateContactInput): Promise<CrmContact> {
  const { locationId } = requireConfig();
  const body = {
    locationId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    ...(input.address1 ? { address1: input.address1 } : {}),
    tags: input.tags ?? [],
    source: input.source ?? 'ai-quote-tool',
  };
  const json = await ghlFetch<{ contact: HighLevelContact }>('/contacts/', {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

// Unlike findOpportunityForContact above (which filters to status==='open',
// right for the resurrect-vs-create quote flow), this returns EVERY
// opportunity for the contact in the given pipeline regardless of status.
// Needed by the referral sweep's suppression check (src/lib/referralSweep.ts):
// a card sitting in a "Declined"/"Do Not Call" STAGE must be caught even if
// its separate `status` field was never flipped away from 'open'. Per
// UpdateOpportunityFields above, this app's own updateOpportunityStage NEVER
// sets status at all, only pipelineStageId, so a stage-based suppression
// check cannot safely filter on status the way findOpportunityForContact
// does. Also used by the sweep's "ever booked" check across every known
// pipeline (see ghlPipelineMap.ts's allPipelineStages).
export async function findAllOpportunitiesForContact(
  contactId: string,
  pipelineId: string,
): Promise<HighLevelOpportunity[]> {
  const { locationId } = requireConfig();
  const params = new URLSearchParams({
    location_id: locationId,
    pipeline_id: pipelineId,
    contact_id: contactId,
  });
  const json = await ghlFetch<{ opportunities?: HighLevelOpportunity[] }>(
    `/opportunities/search?${params}`,
  );
  return json.opportunities ?? [];
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
  name: string;            // the customer's name, e.g., "Jane Smith" (#247)
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

// ─── Duplicate-opportunity detection (#172) ────────────────────────────────
// GHL location settings can forbid a second opportunity per contact — POST
// /opportunities/ then 400s for ANY contact that already has a card
// (open/won/lost/abandoned all count), with a structured body:
//   { code: 'OPPORTUNITY_NO_DUPLICATE', meta: { existingId } }
// Parses that out defensively (the body may not be JSON at all, or may lack
// a usable existingId) so a caller can resurrect the existing card instead of
// failing outright. Returns null for anything that isn't a recognizable
// duplicate error.
export function parseDuplicateOpportunityError(err: unknown): string | null {
  if (!(err instanceof HighLevelError) || !err.body) return null;
  try {
    const parsed = JSON.parse(err.body) as { code?: string; meta?: { existingId?: string } };
    if (parsed.code === 'OPPORTUNITY_NO_DUPLICATE' && parsed.meta?.existingId) {
      return parsed.meta.existingId;
    }
    return null;
  } catch {
    // Body wasn't parseable JSON — ghlFetch truncates bodies to 2000 chars, so
    // a padded-out duplicate error could arrive with its closing braces cut
    // off. Fall back to a field-level scan before giving up.
    if (err.body.includes('"OPPORTUNITY_NO_DUPLICATE"')) {
      const m = err.body.match(/"existingId"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

// ─── Opportunity fetch (by id) ─────────────────────────────────────────────
// Read one card. Used by the resurrect path to inspect the existing card's
// real status/pipeline before overwriting it (#172 review HIGH — never
// blind-write a card we haven't looked at).
export async function getOpportunity(opportunityId: string): Promise<HighLevelOpportunity> {
  const json = await ghlFetch<{ opportunity: HighLevelOpportunity }>(
    `/opportunities/${encodeURIComponent(opportunityId)}`,
  );
  return json.opportunity;
}

// ─── Duplicate-card resurrect (#172) ───────────────────────────────────────
// Shared recovery for a createOpportunity that 400'd OPPORTUNITY_NO_DUPLICATE
// (used by findOrCreateOpportunityForContact AND the send route's inline
// create — one implementation so guards can't drift). Returns null when the
// error isn't a recognizable duplicate (caller rethrows the original).
//
// Guard (review HIGH, 3× corroborated): fetch the existing card FIRST. An
// OPEN card here can only mean an active deal outside the pipeline we
// searched (or a race) — never hijack it; throw a descriptive error instead.
// A non-open card (abandoned/lost/won) is deliberately resurrected: status
// open, moved to the intended pipeline/stage, name overwritten, and
// monetaryValue reset to the new deal's value (or 0 — last year's figure on
// this year's card misreports the pipeline). Every resurrect logs the card's
// prior status/pipeline so a surprising board change is traceable.
export async function resurrectDuplicateOpportunity(
  err: unknown,
  input: { pipelineId: string; pipelineStageId: string; name: string; monetaryValue?: number },
): Promise<HighLevelOpportunity | null> {
  const existingId = parseDuplicateOpportunityError(err);
  if (!existingId) return null;
  const existing = await getOpportunity(existingId);
  if (existing.status === 'open') {
    throw new HighLevelError(
      `Contact already has an ACTIVE opportunity ${existingId} (status open, pipeline ${existing.pipelineId}) outside the target pipeline — refusing to move a live deal. Resolve the card in HighLevel, then retry.`,
      409,
    );
  }
  console.warn(
    '[highlevel] resurrecting opportunity (#172):',
    { opportunityId: existingId, priorStatus: existing.status, priorPipelineId: existing.pipelineId, targetPipelineId: input.pipelineId },
  );
  return updateOpportunity(existingId, {
    status: 'open',
    pipelineId: input.pipelineId,
    pipelineStageId: input.pipelineStageId,
    name: input.name,
    monetaryValue: input.monetaryValue ?? 0,
  });
}

// ─── Find OR create opportunity ────────────────────────────────────────────
// Convenience wrapper for the save-quote flow. Given a contact, returns
// their existing OPEN pipeline card (typical case — customer was in the
// pipeline before opening the quote tool), or creates a new one at the
// fallback stage (edge case — contact exists but no open opportunity yet).
//
// #172: findOpportunityForContact only reuses an OPEN card, so a contact
// whose only card is won/lost/abandoned falls through to createOpportunity —
// which then 400s (OPPORTUNITY_NO_DUPLICATE) because GHL's location setting
// forbids a second card per contact. Jason-approved: RESURRECT that card
// instead of failing — reopen it (status: 'open'), move it to the intended
// pipeline/stage, and overwrite its name + monetary value. The business is
// actively re-engaging abandoned/past customers, so reviving a dead card on
// a fresh quote is the intended behavior, not a silent accident.
export async function findOrCreateOpportunityForContact(input: {
  contactId: string;
  pipelineId: string;
  fallbackStageId: string;   // HIGHLEVEL_STAGE_QUOTE_CREATED — the ENTRY stage (e.g. Open), never Make Quote
  fallbackName: string;       // used if we create OR resurrect
  monetaryValue?: number;
  source?: string;            // used only if we create; falls through to createOpportunity's own default ('ai-quote-tool') when omitted
}): Promise<{ opportunity: HighLevelOpportunity; created: boolean; resurrected?: boolean }> {
  const existing = await findOpportunityForContact(input.contactId, input.pipelineId);
  if (existing) return { opportunity: existing, created: false };
  try {
    const fresh = await createOpportunity({
      contactId: input.contactId,
      pipelineId: input.pipelineId,
      pipelineStageId: input.fallbackStageId,
      name: input.fallbackName,
      monetaryValue: input.monetaryValue,
      source: input.source,
    });
    return { opportunity: fresh, created: true };
  } catch (err) {
    const opportunity = await resurrectDuplicateOpportunity(err, {
      pipelineId: input.pipelineId,
      pipelineStageId: input.fallbackStageId,
      name: input.fallbackName,
      monetaryValue: input.monetaryValue,
    });
    if (!opportunity) throw err;
    return { opportunity, created: false, resurrected: true };
  }
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
// #172: pipelineId + status are additive, used only by the duplicate-card
// resurrect path (findOrCreateOpportunityForContact) to move a won/lost/
// abandoned card into the intended pipeline and reopen it.
export type UpdateOpportunityFields = {
  pipelineStageId?: string;
  pipelineId?: string;
  name?: string;
  monetaryValue?: number;
  status?: 'open';
};

export async function updateOpportunity(
  opportunityId: string,
  fields: UpdateOpportunityFields,
): Promise<HighLevelOpportunity> {
  const body: Record<string, unknown> = {};
  if (fields.pipelineStageId !== undefined) body.pipelineStageId = fields.pipelineStageId;
  if (fields.pipelineId !== undefined) body.pipelineId = fields.pipelineId;
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.monetaryValue !== undefined) body.monetaryValue = fields.monetaryValue;
  if (fields.status !== undefined) body.status = fields.status;
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
  value: string | string[],
): Promise<void> {
  // value is string[] for CHECKBOX-dataType fields (GHL expects an array of
  // selected option strings there — a scalar string silently fails to land)
  // and a plain string for TEXT-dataType fields. Callers know which shape
  // their field expects; this function just passes it through untouched.
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    body: JSON.stringify({ customFields: [{ id: fieldId, value }] }),
  });
}

// ─── Location custom fields (list / create) ────────────────────────────────
// Backs the #200 "Years with YLL" tenure field: every OTHER contact custom
// field in this app (quoteLinkFieldId in ghlPipelineMap.ts, REFERRAL_LINK_
// FIELD_ENV in referrals.ts) is a FIXED id pasted into an env var after the
// dev hand-creates the field in the GHL UI. #200 locked a different design —
// no new env var, no manual dashboard step — so the field is resolved BY
// NAME at runtime and created via the API the first time it's missing (see
// resolveTenureFieldId in src/lib/integrations/ghlTenure.ts, the only caller).
//
// Endpoints per the public docs (marketplace.gohighlevel.com/docs/ghl/
// locations/{get-custom-fields,create-custom-field}): GET/POST /locations/
// {locationId}/customFields, same API base + Version header as every other
// call in this file. ⚠️ NOT independently confirmed against the live API (no
// token in this build environment) — the response wrapper shapes below are
// inferred from this file's own established conventions (an array response
// wrapped under a name matching the resource, e.g. `conversations`/
// `opportunities` above) and defensively parsed on the create side to accept
// either shape. Needs a live verify at deploy (ledger #200 calls this out).
export type GhlCustomField = {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  model?: string;
};

/** Every custom field defined on the CONTACT model for this location. */
export async function listLocationCustomFields(): Promise<GhlCustomField[]> {
  const { locationId } = requireConfig();
  const json = await ghlFetch<{ customFields?: GhlCustomField[] }>(
    `/locations/${encodeURIComponent(locationId)}/customFields?model=contact`,
  );
  return json.customFields ?? [];
}

/**
 * Create one new CONTACT custom field. NOT idempotent by itself — calling it
 * twice with the same name creates two fields — callers must list-then-create
 * (never call this blind); see resolveTenureFieldId's find-or-create.
 *
 * Response wrapper unconfirmed live (see the section note above): accepts
 * either an unwrapped field object or one nested under `customField`.
 */
export async function createLocationCustomField(input: {
  name: string;
  dataType: string;
}): Promise<GhlCustomField> {
  const { locationId } = requireConfig();
  const json = await ghlFetch<{ customField?: GhlCustomField } & Partial<GhlCustomField>>(
    `/locations/${encodeURIComponent(locationId)}/customFields`,
    {
      method: 'POST',
      body: JSON.stringify({ name: input.name, dataType: input.dataType, model: 'contact' }),
    },
  );
  const field = json.customField ?? (json as GhlCustomField);
  if (!field?.id) {
    throw new HighLevelError(
      `HighLevel POST /locations/.../customFields returned no field id for "${input.name}"`,
    );
  }
  return field;
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
  // Optional so a caller can omit name fields entirely on a household match
  // (see leadService.syncLeadToGhl) — sending them there would overwrite the
  // existing contact's name via GHL's email/phone-matched upsert.
  firstName?: string;
  lastName?: string;
  // email/phone are each optional — GHL's /contacts/upsert matches on EITHER
  // identifier, so a caller with only one (e.g. a partial/abandoned-form lead
  // that got a phone typed but no email yet — see leads/partialLead.ts) can
  // upsert with just that one. The caller is responsible for supplying at
  // least one; sending neither would create an unmatchable orphan contact.
  // undefined keys are dropped by JSON.stringify below, so an omitted field is
  // simply not sent.
  email?: string;
  phone?: string;
  address1?: string;
  source?: string;
};

export async function upsertContact(
  input: UpsertContactInput,
): Promise<{ contact: HighLevelContact; new: boolean }> {
  const { locationId } = requireConfig();
  // Only include identifiers that are actually present. undefined keys are
  // already dropped by JSON.stringify, but this also guards a caller that passes
  // an empty string — a blank email/phone must be OMITTED, not sent to GHL as a
  // real (empty) value that could clobber an existing contact's field.
  const body: Record<string, unknown> = { locationId };
  if (input.firstName !== undefined) body.firstName = input.firstName;
  if (input.lastName !== undefined) body.lastName = input.lastName;
  if (input.email) body.email = input.email;
  if (input.phone) body.phone = input.phone;
  if (input.address1 !== undefined) body.address1 = input.address1;
  if (input.source !== undefined) body.source = input.source;
  return ghlFetch<{ contact: HighLevelContact; new: boolean }>('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Contact note create ────────────────────────────────────────────────
// POST /contacts/{contactId}/notes — attaches a free-text note to the
// contact's timeline (e.g. the website lead's raw notes / UTM / landing-page
// context, which don't fit any existing custom field).
// HighLevel WRAPS the created note rather than returning it bare: six real
// notes were written with a null id before the database showed it (see
// noteIdFrom in src/lib/calls/postNotes.ts). The type says so now, so the
// next caller that wants the id does not inherit the same wrong assumption.
type ContactNoteResult = {
  id?: string;
  note?: { id?: string; body?: string } | null;
  notes?: { id?: string; body?: string }[] | null;
  body?: string;
  [k: string]: unknown;
};

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

// ─── Rep identity ───────────────────────────────────────────────────────────
// Resolves a GHL staff user id (call_recordings.ghl_user_id, straight off the
// call message -- ground truth, not a guess) to that user's email + display
// name, for call_transcripts.rep_email/rep_name (calls_merge_plan_2026-08.md,
// rep-assignment ruling). Pattern donor: the yll-call-copilot repo's
// getGhlUserEmail (src/lib/ghl/recordings.ts, master fb1bf326) -- same
// endpoint and same best-effort posture, extended here to also resolve a
// display name (that repo never needed one) using the same firstName/
// lastName-join-with-fallback convention toCrmContact already uses above.
//
// Endpoint: GET /users/{userId} -- unverified against a live payload, same
// caveat the copilot's own version carries.
//
// Best-effort: ANY failure (network, 404, malformed body) degrades to
// { email: null, name: null } rather than throwing -- src/lib/calls/
// pipeline.ts stores null fields rather than failing the whole recording
// over an identity lookup, matching the existing contact-hydrate posture in
// that file.
export type GhlUserIdentity = { email: string | null; name: string | null };

export async function getGhlUser(userId: string): Promise<GhlUserIdentity> {
  try {
    const json = await ghlFetch<{ email?: string; firstName?: string; lastName?: string; name?: string }>(
      `/users/${encodeURIComponent(userId)}`,
    );
    const name = json.name ?? ([json.firstName, json.lastName].filter(Boolean).join(' ') || null);
    return { email: json.email ?? null, name };
  } catch (err) {
    console.error(`GHL user lookup failed for ${userId}:`, err);
    return { email: null, name: null };
  }
}
