import { describe, it, expect } from 'vitest';
import { lowStockItems } from './lowStock';

describe('lowStockItems (#82 low-stock alert)', () => {
  it('flags SKUs at/below their reorder point (with one set), sorted by SKU', () => {
    expect(
      lowStockItems([
        { sku: 'B', on_hand_qty: 2, reorder_point: 5 }, // below → low
        { sku: 'A', on_hand_qty: 5, reorder_point: 5 }, // equal → low (at point)
        { sku: 'C', on_hand_qty: 9, reorder_point: 5 }, // above → ok
        { sku: 'D', on_hand_qty: 0, reorder_point: 0 }, // no reorder point → ignored
      ]),
    ).toEqual([
      { sku: 'A', onHand: 5, reorderPoint: 5 },
      { sku: 'B', onHand: 2, reorderPoint: 5 },
    ]);
  });

  it('returns [] when nothing is low', () => {
    expect(lowStockItems([{ sku: 'A', on_hand_qty: 10, reorder_point: 5 }])).toEqual([]);
  });
});
