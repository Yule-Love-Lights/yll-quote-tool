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
 */
export function resolvePipelineStages(serviceType?: string | null): PipelineStages {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  const base = PIPELINE_MAP[type];

  if (type !== 'holiday') return base;

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
