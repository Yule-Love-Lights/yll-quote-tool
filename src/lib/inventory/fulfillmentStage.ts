// src/lib/inventory/fulfillmentStage.ts
// The fulfillment / materials-Kanban axis of a job (#82 Slice 3) — a DIFFERENT
// axis from the billing JobStatus (src/lib/jobStatus.ts). A job moves through
// these four stages while its materials get ordered, picked up, prepped, and
// staged for install. The billing side leaves jobs.fulfillment_stage NULL at
// creation, so NULL is treated as the first stage (To Be Ordered).
//
// Pure module (no Supabase) so the data layer, the API, and the board UI all
// share one source of truth. Movement is a free Kanban (any stage → any stage);
// there's no strict transition table — staff manage the board operationally.

export type FulfillmentStage =
  | 'to_be_ordered'
  | 'awaiting_pickup'
  | 'to_be_prepared'
  | 'ready_for_install';

/** The four stages, in fulfillment order (board column order). */
export const FULFILLMENT_STAGES: readonly FulfillmentStage[] = [
  'to_be_ordered',
  'awaiting_pickup',
  'to_be_prepared',
  'ready_for_install',
] as const;

export const FULFILLMENT_STAGE_LABELS: Record<FulfillmentStage, string> = {
  to_be_ordered: 'To Be Ordered',
  awaiting_pickup: 'Awaiting Pickup',
  to_be_prepared: 'To Be Prepared',
  ready_for_install: 'Ready For Install',
};

/** A new job (jobs.fulfillment_stage NULL) starts here. */
export const DEFAULT_FULFILLMENT_STAGE: FulfillmentStage = 'to_be_ordered';

/** Narrow an unknown value to a FulfillmentStage, or null if it isn't one. */
export function asFulfillmentStage(v: unknown): FulfillmentStage | null {
  return typeof v === 'string' && (FULFILLMENT_STAGES as readonly string[]).includes(v)
    ? (v as FulfillmentStage)
    : null;
}

/** A job's resolved stage — NULL/unknown (the #83-created default) ⇒ first stage. */
export function fulfillmentStageOf(v: unknown): FulfillmentStage {
  return asFulfillmentStage(v) ?? DEFAULT_FULFILLMENT_STAGE;
}
