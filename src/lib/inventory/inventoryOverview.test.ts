import { describe, it, expect } from 'vitest';
import { buildInventoryOverview } from './inventoryOverview';

describe('buildInventoryOverview', () => {
  it('counts jobs per fulfillment stage; NULL/unknown stage falls to To Be Ordered', () => {
    const ov = buildInventoryOverview({
      cards: [
        { stage: 'to_be_ordered' },
        { stage: null }, // #83 creates jobs with NULL fulfillment_stage → first stage
        { stage: 'weird' }, // unknown → first stage
        { stage: 'awaiting_pickup' },
        { stage: 'ready_for_install' },
      ],
      lowStock: [],
      toOrder: { lines: [], jobCount: 0 },
    });
    const by = Object.fromEntries(ov.stages.map((s) => [s.stage, s.count]));
    expect(by.to_be_ordered).toBe(3);
    expect(by.awaiting_pickup).toBe(1);
    expect(by.to_be_prepared).toBe(0);
    expect(by.ready_for_install).toBe(1);
    expect(ov.totalJobs).toBe(5);
    // labels come through in board order
    expect(ov.stages.map((s) => s.label)).toEqual([
      'To Be Ordered', 'Awaiting Pickup', 'To Be Prepared', 'Ready For Install',
    ]);
  });

  it('caps the low-stock + to-order lists but reports the true total', () => {
    const lowStock = Array.from({ length: 11 }, (_, i) => ({ sku: `S${i}`, name: `n${i}`, onHand: 0, reorderPoint: 5 }));
    const lines = Array.from({ length: 10 }, (_, i) => ({ sku: `P${i}`, name: `p${i}`, order: i + 1 }));
    const ov = buildInventoryOverview({ cards: [], lowStock, toOrder: { lines, jobCount: 4 }, cap: 8 });
    expect(ov.lowStock.items).toHaveLength(8);
    expect(ov.lowStock.total).toBe(11);
    expect(ov.toOrder.lines).toHaveLength(8);
    expect(ov.toOrder.total).toBe(10);
    expect(ov.toOrder.jobCount).toBe(4);
  });

  it('handles the cold-start empty state (4 zero-count stages, empty lists)', () => {
    const ov = buildInventoryOverview({ cards: [], lowStock: [], toOrder: { lines: [], jobCount: 0 } });
    expect(ov.totalJobs).toBe(0);
    expect(ov.stages).toHaveLength(4);
    expect(ov.stages.every((s) => s.count === 0)).toBe(true);
    expect(ov.lowStock.total).toBe(0);
    expect(ov.toOrder.total).toBe(0);
  });
});
