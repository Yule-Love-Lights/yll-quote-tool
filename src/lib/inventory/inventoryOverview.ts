// src/lib/inventory/inventoryOverview.ts
// Pure view-model for the Inventory Overview landing (#82 / #91). Shapes the
// already-fetched fulfillment cards, low-stock items, and purchase-order shortfall
// into a compact at-a-glance summary: job counts per stage + capped "needs
// attention" lists with their true totals. No Supabase — the page fetches; this
// only aggregates, so it's trivially unit-testable.

import {
  FULFILLMENT_STAGES,
  FULFILLMENT_STAGE_LABELS,
  fulfillmentStageOf,
  type FulfillmentStage,
} from './fulfillmentStage';

export type OverviewStage = { stage: FulfillmentStage; label: string; count: number };
export type OverviewLowStock = { sku: string; name: string; onHand: number; reorderPoint: number };
export type OverviewOrderLine = { sku: string; name: string; order: number };

export type InventoryOverview = {
  stages: OverviewStage[];
  totalJobs: number;
  lowStock: { items: OverviewLowStock[]; total: number };
  toOrder: { lines: OverviewOrderLine[]; total: number; jobCount: number };
};

// Top-N shown per "needs attention" list; the rest are summarized as "+N more".
export const OVERVIEW_LIST_CAP = 8;

export function buildInventoryOverview(input: {
  cards: { stage: unknown }[];
  lowStock: OverviewLowStock[];
  toOrder: { lines: OverviewOrderLine[]; jobCount: number };
  cap?: number;
}): InventoryOverview {
  const cap = input.cap ?? OVERVIEW_LIST_CAP;
  const stages = FULFILLMENT_STAGES.map((stage) => ({
    stage,
    label: FULFILLMENT_STAGE_LABELS[stage],
    // NULL/unknown (the #83-created default) resolves to the first stage.
    count: input.cards.filter((c) => fulfillmentStageOf(c.stage) === stage).length,
  }));
  return {
    stages,
    totalJobs: input.cards.length,
    lowStock: { items: input.lowStock.slice(0, cap), total: input.lowStock.length },
    toOrder: {
      lines: input.toOrder.lines.slice(0, cap),
      total: input.toOrder.lines.length,
      jobCount: input.toOrder.jobCount,
    },
  };
}
