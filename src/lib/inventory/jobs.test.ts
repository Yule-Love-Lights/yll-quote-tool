import { describe, it, expect } from 'vitest';
import { isActiveFulfillment, groupByStage, computeStockDeductions, type FulfillmentCard } from './jobs';

const card = (over: Partial<FulfillmentCard>): FulfillmentCard => ({
  id: 'j1',
  jobNumber: 1000,
  quoteId: 'q1',
  designId: null,
  stage: 'to_be_ordered',
  status: 'to_schedule',
  customerName: 'A',
  customerAddress: '1 St',
  itemCount: 0,
  installDate: null,
  isTest: false,
  ...over,
});

describe('isActiveFulfillment', () => {
  it('is active only pre-install (to_schedule / scheduled)', () => {
    expect(isActiveFulfillment('to_schedule')).toBe(true);
    expect(isActiveFulfillment('scheduled')).toBe(true);
    expect(isActiveFulfillment('installed')).toBe(false);
    expect(isActiveFulfillment('requires_invoicing')).toBe(false);
    expect(isActiveFulfillment('done')).toBe(false);
    expect(isActiveFulfillment('cancelled')).toBe(false);
  });
});

describe('groupByStage', () => {
  it('buckets cards into all four columns (empty columns present, order stable)', () => {
    const g = groupByStage([
      card({ id: 'a', stage: 'to_be_ordered' }),
      card({ id: 'b', stage: 'ready_for_install' }),
      card({ id: 'c', stage: 'to_be_ordered' }),
    ]);
    expect(Object.keys(g)).toEqual([
      'to_be_ordered',
      'awaiting_pickup',
      'to_be_prepared',
      'ready_for_install',
    ]);
    expect(g.to_be_ordered.map((c) => c.id)).toEqual(['a', 'c']);
    expect(g.awaiting_pickup).toEqual([]);
    expect(g.ready_for_install.map((c) => c.id)).toEqual(['b']);
  });
});

describe('computeStockDeductions (#82 Phase 2)', () => {
  it('deducts tracked SKUs, floors at 0, skips untracked + zero-need', () => {
    expect(
      computeStockDeductions([
        { sku: 'A', qty: 3, onHand: 10 }, // → 7
        { sku: 'B', qty: 8, onHand: 5 }, // → floors at 0 (deducted 5, not 8)
        { sku: 'C', qty: 2, onHand: null }, // untracked → skip
        { sku: 'D', qty: 0, onHand: 4 }, // zero need → skip
        { sku: 'E', qty: 4, onHand: 0 }, // nothing on hand → no change → skip
      ]),
    ).toEqual([
      { sku: 'A', before: 10, deducted: 3, after: 7 },
      { sku: 'B', before: 5, deducted: 5, after: 0 },
    ]);
  });
});
