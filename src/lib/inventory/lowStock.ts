// src/lib/inventory/lowStock.ts
// Pure low-stock detection (#82 stock loop). A SKU is "low" when it has a reorder
// point set AND on-hand is at/below it — the same rule the Stock tab's LOW flag
// and the WhatsApp bot's `low` command use. Kept pure so the alert email + any UI
// share one definition.

export type OnHandLike = { sku: string; on_hand_qty: number; reorder_point: number };
export type LowStockItem = { sku: string; onHand: number; reorderPoint: number };

export function lowStockItems(rows: OnHandLike[]): LowStockItem[] {
  return rows
    .filter((r) => r.reorder_point > 0 && r.on_hand_qty <= r.reorder_point)
    .map((r) => ({ sku: r.sku, onHand: r.on_hand_qty, reorderPoint: r.reorder_point }))
    .sort((a, b) => a.sku.localeCompare(b.sku));
}
