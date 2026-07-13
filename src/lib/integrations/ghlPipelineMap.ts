// Per-service-type HighLevel pipeline + stage map (#GHL pipeline sync).
//
// Today only the Christmas Lights pipeline is wired via env vars
// (HIGHLEVEL_PIPELINE_ID + HIGHLEVEL_STAGE_QUOTE_CREATED/SENT/APPROVED/SIGNED),
// so every quote — holiday, permanent, event — moves cards in the SAME
// pipeline regardless of its actual service_type. Permanent and Event each
// have their own pipeline in GHL; this module gives every service_type its
// own set of pipeline + stage ids so the send/decline/deposit-paid/installed
// call sites can resolve "the right card in the right pipeline" from the
// quote's service_type alone.
//
// IDs below were discovered live from the GHL API (2026-07-09) via
// scripts/ghl-list-custom-fields.ts's sibling pipeline-listing call
// (GET /opportunities/pipelines). They are location-scoped identifiers, not
// secrets — safe to commit, same as any other GHL pipeline/stage id already
// visible in the Settings → HighLevel setup page.

import { asServiceType, DEFAULT_SERVICE_TYPE, SERVICE_TYPES, type ServiceType } from '@/lib/serviceType';

export type PipelineStages = {
  pipelineId: string;
  /** Brand-new lead / no card yet. */
  entry: string;
  /** Quote handed to the customer ("Bid Sent" / "Proposal Sent" / etc). */
  sent: string;
  /** Deposit collected — the deal is booked. */
  depositPaid: string;
  /** Job installed / complete. */
  installed: string;
  /** Customer (or staff on their behalf) declined. */
  declined: string;
};

// ─── The three pipelines, one per ServiceType ──────────────────────────────
const PIPELINE_MAP: Record<ServiceType, PipelineStages> = {
  holiday: {
    pipelineId: 'sC6JEcxlGnNDasanlXDN', // Christmas Lights
    entry: '478396dd-a052-41ad-ae73-d528909cd5f4', // 📭Open
    sent: 'd15bc673-2b97-48a6-8a5c-bdf3b6e4d076', // 📨Bid Sent
    depositPaid: '90e7a535-689c-441e-b759-d16742bbd5a9', // ⏰Approved
    installed: 'aa6263d6-20bb-4b65-bd8c-23b75831716b', // ⭐Installed
    declined: '92090ef4-b8d6-4d68-b0f6-b4462e60d658', // ⛔Declined
  },
  event: {
    pipelineId: 'YfCi5jy8Alc3oD5AfXmV', // Event Lighting
    entry: 'c6e089f5-c458-47a0-a7ae-25385df6a53f', // Open
    sent: 'b2262023-6986-4727-98e6-638ce45aedfe', // Bid Sent
    depositPaid: '4f6a7739-9bc9-4c27-a140-1ca9f58798fd', // Booked
    installed: '3375d0d6-0c1d-4e22-a40e-1430a771afc3', // Installed
    declined: '239ec700-bd21-49ba-9691-f0a9b44637b0', // Declined
  },
  permanent: {
    pipelineId: 'OqpjVflTdgmjmUQmbcSF', // Permanent Lighting
    entry: 'c052d345-8e95-4716-a7e7-62e63937b5ea', // New Lead
    sent: '4e507d3d-a939-44c3-a448-250a4b0ed353', // Proposal Sent
    depositPaid: 'f4bfe29f-5d5a-4725-a6d2-1f5f19ec4010', // Closed
    installed: 'b2192f2e-eee9-4a1b-9749-4f458f007c55', // Installed
    // The permanent pipeline has NO dedicated "Declined" stage in GHL — the dev
    // chose "Abandoned" as the closest equivalent (2026-07-09). Revisit if a
    // real Declined stage is added later.
    declined: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned
  },
  // Permanent Bistro Lighting (#117): rides the LANDSCAPE LIGHTING pipeline
  // (Naldo 2026-07-11 — bistro cards live there, not in Permanent). Stage ids
  // discovered live from GET /opportunities/pipelines right after Naldo added
  // Booked/Declined and renamed the rest to mirror event's flow. The pipeline
  // also has an 'Open' stage (31133c9a-…); entry uses 'New Lead' (the first
  // stage) because entry is only the fallback landing spot for a contact with
  // no card yet.
  permanent_bistro: {
    pipelineId: 'GTFURwOGzGLBl2zsdl0N', // Landscape Lighting
    entry: '7e821733-a431-4545-bc65-5e14c5f02877', // New Lead
    sent: '18205538-0225-451b-aae5-5093de433004', // Bid Sent
    depositPaid: '8c7765b3-a2ba-4928-8618-5ec5a1182cb2', // Booked
    installed: 'bf068cce-4d71-480f-9bbc-bab144114e6c', // Installed
    declined: 'ad2127e1-692f-4d42-aecf-3f381793dfeb', // Declined
  },
};

/**
 * Resolve the pipeline + stage ids to use for a quote's service_type.
 *
 * BACKWARD COMPAT: for HOLIDAY ONLY, the legacy single-pipeline env vars
 * (HIGHLEVEL_PIPELINE_ID, HIGHLEVEL_STAGE_QUOTE_CREATED/SENT/APPROVED, with
 * SIGNED as the APPROVED fallback) override the map wherever they're set —
 * Vercel already has these configured for prod, and this keeps holiday's
 * behavior byte-identical. There are no legacy env vars for `installed` or
 * `declined` (nothing moved those stages before this change), so those two
 * always come from the map even for holiday.
 *
 * Permanent and Event always use their own map entries — no env override.
 * An unknown/missing service_type falls back to the default (holiday), same
 * as DEFAULT_SERVICE_TYPE elsewhere in the app.
 *
 * opts.envOverrides (default true) — set false to skip the holiday env-
 * override block above and always return the raw map values. Added for the
 * website lead-capture path (src/lib/leads/leadService.ts): a brand-new lead
 * has no card yet and must enter at the map's own entry stage (📭Open), but
 * HIGHLEVEL_STAGE_QUOTE_CREATED is configured in prod to point at the
 * mid-pipeline "Make Quote" stage (right for the quote-send flow, wrong for
 * a fresh lead).
 */
export function resolvePipelineStages(
  serviceType?: string | null,
  opts?: { envOverrides?: boolean },
): PipelineStages {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  const base = PIPELINE_MAP[type];

  const envOverrides = opts?.envOverrides ?? true;
  if (type !== 'holiday' || !envOverrides) return base;

  const approvedStage =
    process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED || process.env.HIGHLEVEL_STAGE_QUOTE_SIGNED;
  return {
    pipelineId: process.env.HIGHLEVEL_PIPELINE_ID || base.pipelineId,
    entry: process.env.HIGHLEVEL_STAGE_QUOTE_CREATED || base.entry,
    sent: process.env.HIGHLEVEL_STAGE_QUOTE_SENT || base.sent,
    depositPaid: approvedStage || base.depositPaid,
    installed: base.installed,
    declined: base.declined,
  };
}

// ─── Map diagnostics (Settings → HighLevel, WT-51) ─────────────────────────
// Exposes the raw, env-override-free PIPELINE_MAP entries so the settings
// page can list what each service type actually names and cross-check those
// ids against the live GET /opportunities/pipelines result — without this,
// a renamed/deleted pipeline or stage silently stops moving cards for that
// service type with no on-page signal at all.

/** One service type's raw map entry, for display/diagnostics. */
export function listPipelineMapEntries(): Array<{ serviceType: ServiceType; stages: PipelineStages }> {
  return SERVICE_TYPES.map((serviceType) => ({ serviceType, stages: PIPELINE_MAP[serviceType] }));
}

// ─── Quote-link contact custom field, one per ServiceType ─────────────────
// Env var per type — deliberately NOT hardcoded in this module like the
// pipeline/stage ids above. Those ids were discovered live from the GHL API
// and are location-scoped identifiers, safe to commit. These field ids were
// just created by the dev in the GHL UI (2026-07) and belong in env, same as
// any other per-environment/dev-configured secret-adjacent id.
const QUOTE_LINK_FIELD_ENV: Record<ServiceType, string> = {
  holiday: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_HOLIDAY',
  permanent: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_PERMANENT',
  event: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_EVENT',
  // Permanent Bistro Lighting (#117): its OWN "Bistro Quote Link" contact
  // field as of 2026-07-11 (Naldo created it in the GHL UI). Set the id in
  // HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO. This supersedes the v1
  // Perm-field reuse, so a bistro send no longer touches a permanent quote's
  // link value, and a Landscape-pipeline drip can merge {{contact.bistro_quote_link}}.
  permanent_bistro: 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_BISTRO',
};

/**
 * Resolve the HighLevel CONTACT custom field id that holds the quote-link
 * value for a quote's service_type.
 *
 * WHY PER-TYPE (not one shared field): each service_type has its own GHL
 * pipeline with its own drip automations, and those automations merge
 * {{contact.<field>}} to text/email the customer their portal link. A single
 * shared field collides across pipelines — e.g. sending a permanent quote
 * would overwrite the field value a Christmas drip automation is about to
 * merge, so the customer gets the wrong (or a stale) portal link. Splitting
 * the field per service_type keeps each pipeline's automations reading
 * (and being fed) only their own value.
 *
 * Resolved the same way resolvePipelineStages resolves a type: narrow via
 * asServiceType, falling back to DEFAULT_SERVICE_TYPE (holiday) for an
 * unknown/missing service_type. Returns undefined when that type's env var
 * is unset or empty — callers skip the stamp rather than treating a missing
 * field as an error.
 *
 * The legacy single-field HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK env var is DEAD
 * — it is not read here or anywhere else in the app.
 */
export function quoteLinkFieldId(serviceType?: string | null): string | undefined {
  return process.env[quoteLinkFieldEnvVar(serviceType)] || undefined;
}

/**
 * The env var NAME (not its value) backing quoteLinkFieldId's resolution for
 * a service_type — exported so call sites can name the exact var they're
 * missing in a warn/log message without duplicating this map.
 */
export function quoteLinkFieldEnvVar(serviceType?: string | null): string {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  return QUOTE_LINK_FIELD_ENV[type];
}
