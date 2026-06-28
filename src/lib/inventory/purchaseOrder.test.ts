import { describe, it, expect } from 'vitest';
import { computePurchaseOrder, purchaseOrderSignature } from './purchaseOrder';

describe('purchaseOrderSignature (auto-send dedup)', () => {
  it('is stable regardless of line order', () => {
    const a = purchaseOrderSignature([{ sku: 'B', order: 7 }, { sku: 'A', order: 3 }]);
    const b = purchaseOrderSignature([{ sku: 'A', order: 3 }, { sku: 'B', order: 7 }]);
    expect(a).toBe(b);
  });
  it('changes when a quantity changes', () => {
    expect(purchaseOrderSignature([{ sku: 'A', order: 3 }])).not.toBe(
      purchaseOrderSignature([{ sku: 'A', order: 4 }]),
    );
  });
  it('empty order → empty signature', () => {
    expect(purchaseOrderSignature([])).toBe('');
  });
});

describe('computePurchaseOrder (#82 Phase 3 auto-ordering)', () => {
  it('orders the shortfall, drops covered SKUs, sorts by SKU', () => {
    expect(
      computePurchaseOrder([
        { sku: 'B', needed: 10, onHand: 3 }, // short 7
        { sku: 'A', needed: 5, onHand: 5 }, // covered → dropped
        { sku: 'C', needed: 4, onHand: 9 }, // over-stocked → dropped
        { sku: 'D', needed: 6, onHand: 0 }, // untracked/none → order all 6
      ]),
    ).toEqual([
      { sku: 'B', needed: 10, onHand: 3, order: 7 },
      { sku: 'D', needed: 6, onHand: 0, order: 6 },
    ]);
  });

  it('ceils fractional need and floors negative on-hand at 0', () => {
    expect(computePurchaseOrder([{ sku: 'X', needed: 10.2, onHand: -3 }])).toEqual([
      { sku: 'X', needed: 11, onHand: 0, order: 11 },
    ]);
  });

  it('returns [] when everything is covered', () => {
    expect(computePurchaseOrder([{ sku: 'A', needed: 2, onHand: 2 }])).toEqual([]);
  });
});
