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

import { asServiceType, DEFAULT_SERVICE_TYPE, type ServiceType } from '@/lib/serviceType';

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
  /** #235: quote went cold — never approved, never declined. */
  abandoned: string;
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
    abandoned: 'eb127233-055b-44fb-a942-cefd7d6bef1f', // ⛔Abandoned (#235, discovered live 2026-08-11)
  },
  event: {
    pipelineId: 'YfCi5jy8Alc3oD5AfXmV', // Event Lighting
    entry: 'c6e089f5-c458-47a0-a7ae-25385df6a53f', // Open
    sent: 'b2262023-6986-4727-98e6-638ce45aedfe', // Bid Sent
    depositPaid: '4f6a7739-9bc9-4c27-a140-1ca9f58798fd', // Booked
    installed: '3375d0d6-0c1d-4e22-a40e-1430a771afc3', // Installed
    declined: '239ec700-bd21-49ba-9691-f0a9b44637b0', // Declined
    abandoned: 'b133090d-9890-405f-a075-16c8ee9c73e7', // Abandoned (#235, discovered live 2026-08-11)
  },
  permanent: {
    pipelineId: 'OqpjVflTdgmjmUQmbcSF', // Permanent Lighting
    entry: 'c052d345-8e95-4716-a7e7-62e63937b5ea', // New Lead
    sent: '4e507d3d-a939-44c3-a448-250a4b0ed353', // Proposal Sent
    depositPaid: 'f4bfe29f-5d5a-4725-a6d2-1f5f19ec4010', // Closed
    installed: 'b2192f2e-eee9-4a1b-9749-4f458f007c55', // Installed
    // #235 (Jason, 2026-08-11, live GHL evidence): the permanent pipeline DOES
    // now have a real "Declined" stage — the 2026-07-09 note below claiming it
    // has none was true THEN but is stale; the old "Abandoned" reuse as a
    // declined substitute was the conflation this repoint undoes. Declined
    // repointed to the real stage; Abandoned is now free to mean gone-cold,
    // consistent with the other three pipelines.
    declined: '2714e48e-b486-457e-9da2-59893196d404', // Declined
    abandoned: '5a5f2e27-6dde-452c-8619-df1871908c8c', // Abandoned
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
    abandoned: 'd9d1ebea-8b31-4651-a687-db80a7482a6a', // Abandoned (#235, discovered live 2026-08-11)
  },
};

// ─── Legacy rebook (#156): "Yule Love Lights Neighbors" pipeline ──────────
// Quotes migrated from last year's Jobber data (legacy_rebook = true) keep
// service_type='holiday' — pricing and the portal both depend on it — but
// their GHL card must NEVER land in the Christmas Lights pipeline: that would
// fire the regular holiday drip workflows on a customer who already has a
// signed history with us. Routing keys on the quote's legacy_rebook flag
// alone (checked in resolvePipelineStages BEFORE the service-type dispatch),
// never on service_type.
//
// IDs discovered live from the GHL API (2026-07-16). `entry` reuses the Bid
// Sent stage id: a legacy rebook's opportunity is only ever created at send
// time — there's no separate "brand-new lead" moment for a migrated quote,
// unlike a normal holiday lead captured off the website.
const NEIGHBORS_STAGES: PipelineStages = {
  pipelineId: 'TIYqklVJ349F5heaSkCs', // Yule Love Lights Neighbors
  entry: '9ada8238-1e95-4242-b567-7edf3bef6c2c', // Bid Sent
  sent: '9ada8238-1e95-4242-b567-7edf3bef6c2c', // Bid Sent
  depositPaid: 'da6521b1-b945-4484-8251-6c6dc487c860', // Booked
  installed: 'eb773949-401d-4e61-959c-3d5b1d92f77e', // Installed
  declined: 'abe1ed98-1091-4b70-bc6f-ae786cbea333', // Declined for 2026
  // #235 (Jason, 2026-08-11): this pipeline has NO dedicated Abandoned stage in
  // GHL, so abandoning a Neighbors quote routes to the SAME "Declined for 2026"
  // stage as a real decline — those two states are indistinguishable in GHL
  // for this one pipeline. Accepted tradeoff: our tool's quote status (declined
  // vs abandoned) still tells them apart. Do NOT "fix" this by hunting for a
  // separate stage — there isn't one.
  abandoned: 'abe1ed98-1091-4b70-bc6f-ae786cbea333', // Declined for 2026
};

/**
 * Resolve the pipeline + stage ids to use for a quote's service_type.
 *
 * BACKWARD COMPAT: for HOLIDAY ONLY, the legacy single-pipeline env vars
 * (HIGHLEVEL_PIPELINE_ID, HIGHLEVEL_STAGE_QUOTE_CREATED/SENT/APPROVED, with
 * SIGNED as the APPROVED fallback) override the map wherever they're set —
 * Vercel already has these configured for prod, and this keeps holiday's
 * behavior byte-identical. There are no legacy env vars for `installed`,
 * `declined`, or `abandoned` (nothing moved those stages before this change),
 * so those three always come from the map even for holiday.
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
 *
 * opts.legacyRebook (#156) — POSITIVE gate, checked FIRST, before the
 * service-type dispatch below: true routes to the Neighbors pipeline no
 * matter what serviceType is passed. A legacy_rebook quote's service_type
 * stays 'holiday' (pricing/portal depend on it), so this can never be
 * expressed as a serviceType value — it's a separate flag on the quote row,
 * and callers must read it off their own quote SELECT and pass it through.
 * Env overrides (HIGHLEVEL_PIPELINE_ID_NEIGHBORS etc.) still honor
 * opts.envOverrides the same way holiday's legacy vars do.
 */
export function resolvePipelineStages(
  serviceType?: string | null,
  opts?: { envOverrides?: boolean; legacyRebook?: boolean },
): PipelineStages {
  const envOverrides = opts?.envOverrides ?? true;

  if (opts?.legacyRebook === true) {
    if (!envOverrides) return NEIGHBORS_STAGES;
    const sentStage = process.env.HIGHLEVEL_STAGE_NEIGHBORS_SENT || NEIGHBORS_STAGES.sent;
    return {
      pipelineId: process.env.HIGHLEVEL_PIPELINE_ID_NEIGHBORS || NEIGHBORS_STAGES.pipelineId,
      entry: sentStage, // opportunities are only ever created at send time
      sent: sentStage,
      depositPaid: process.env.HIGHLEVEL_STAGE_NEIGHBORS_DEPOSIT_PAID || NEIGHBORS_STAGES.depositPaid,
      installed: process.env.HIGHLEVEL_STAGE_NEIGHBORS_INSTALLED || NEIGHBORS_STAGES.installed,
      declined: process.env.HIGHLEVEL_STAGE_NEIGHBORS_DECLINED || NEIGHBORS_STAGES.declined,
      // #235: no per-env override — same "no dedicated Abandoned stage" reason
      // NEIGHBORS_STAGES.abandoned reuses the Declined id.
      abandoned: NEIGHBORS_STAGES.abandoned,
    };
  }

  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  const base = PIPELINE_MAP[type];

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
    abandoned: base.abandoned,
  };
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
 *
 * opts.legacyRebook (#156) — POSITIVE gate, same as resolvePipelineStages:
 * true resolves the NEIGHBOR field (HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR)
 * regardless of serviceType, and NEVER falls back to the holiday field when
 * that var is unset — a stamp on the holiday field would feed the Christmas
 * Lights drip automations, the exact collision this routing exists to avoid.
 */
export function quoteLinkFieldId(
  serviceType?: string | null,
  opts?: { legacyRebook?: boolean },
): string | undefined {
  return process.env[quoteLinkFieldEnvVar(serviceType, opts)] || undefined;
}

/**
 * The env var NAME (not its value) backing quoteLinkFieldId's resolution for
 * a service_type — exported so call sites can name the exact var they're
 * missing in a warn/log message without duplicating this map.
 */
export function quoteLinkFieldEnvVar(
  serviceType?: string | null,
  opts?: { legacyRebook?: boolean },
): string {
  if (opts?.legacyRebook === true) return 'HIGHLEVEL_CONTACT_FIELD_QUOTE_LINK_NEIGHBOR';
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  return QUOTE_LINK_FIELD_ENV[type];
}
