import { describe, it, expect } from 'vitest';
import { prepJobMessage, lowStockMessage, poSentMessage, capList } from './telegramMessages';

const BASE = 'https://quote.yulelovelights.com';

describe('prepJobMessage', () => {
  it('headers with the customer name and Job #', () => {
    const msg = prepJobMessage({
      customerName: 'Jane Doe',
      jobNumber: 1042,
      materials: [],
      unbound: [],
      baseUrl: BASE,
    });
    expect(msg).toContain('New job to prep');
    expect(msg).toContain('Jane Doe');
    expect(msg).toContain('Job #1042');
  });

  it('flags each material as in-stock / short / not-tracked', () => {
    const msg = prepJobMessage({
      customerName: 'Jane Doe',
      jobNumber: 1042,
      materials: [
        { sku: '1001', name: 'C9 Warm White', qty: 120, onHand: 200, short: false },
        { sku: '1042', name: 'Green clips', qty: 200, onHand: 150, short: true },
        { sku: '2003B', name: 'Red bow', qty: 2, onHand: null, short: false },
      ],
      unbound: [],
      baseUrl: BASE,
    });
    expect(msg).toContain('C9 Warm White (1001) ×120');
    expect(msg).toContain('✅ in stock');
    expect(msg).toContain('Green clips (1042) ×200');
    expect(msg).toContain('⚠️ short (150 on hand)');
    expect(msg).toContain('Red bow (2003B) ×2');
    expect(msg).toContain('➖ not tracked');
  });

  it('lists unbound concepts as needing a SKU', () => {
    const msg = prepJobMessage({
      customerName: null,
      jobNumber: null,
      materials: [],
      unbound: [{ label: '48" Noble wreath bow', qty: 3 }],
      baseUrl: BASE,
    });
    expect(msg).toContain('48" Noble wreath bow ×3');
    expect(msg).toContain('no SKU bound');
  });

  it('says nothing-projected when there are no materials and no unbound', () => {
    const msg = prepJobMessage({
      customerName: 'Jane Doe',
      jobNumber: 1042,
      materials: [],
      unbound: [],
      baseUrl: BASE,
    });
    expect(msg).toContain('No tracked materials projected');
  });

  it('includes a tappable jobs link', () => {
    const msg = prepJobMessage({ customerName: null, jobNumber: null, materials: [], unbound: [], baseUrl: BASE });
    expect(msg).toContain(`${BASE}/inventory/jobs`);
  });
});

describe('lowStockMessage', () => {
  it('headers with the count and lists each newly-low item', () => {
    const msg = lowStockMessage({
      items: [
        { name: 'C9 Warm White', sku: '1001', onHand: 12, reorderPoint: 50 },
        { name: 'Green clips', sku: '1042', onHand: 0, reorderPoint: 100 },
      ],
      baseUrl: BASE,
    });
    expect(msg).toContain('2 new item');
    expect(msg).toContain('C9 Warm White (1001): 12 on hand (reorder 50)');
    expect(msg).toContain('Green clips (1042): 0 on hand (reorder 100)');
    expect(msg).toContain(`${BASE}/inventory/orders`);
  });
});

describe('poSentMessage', () => {
  it('headers with the job count and lists what was ordered', () => {
    const msg = poSentMessage({
      lines: [
        { name: 'C9 Warm White', sku: '1001', order: 88 },
        { name: 'Green clips', sku: '1042', order: 250 },
      ],
      jobCount: 6,
      baseUrl: BASE,
    });
    expect(msg).toContain('Purchase order sent to supplier');
    expect(msg).toContain('6 job');
    expect(msg).toContain('C9 Warm White (1001) ×88');
    expect(msg).toContain('Green clips (1042) ×250');
    expect(msg).toContain(`${BASE}/inventory/orders`);
  });
});

describe('capList', () => {
  it('returns the list unchanged when within the cap', () => {
    expect(capList(['a', 'b', 'c'], 40)).toEqual(['a', 'b', 'c']);
  });
  it('truncates and appends a "+N more" line when over the cap', () => {
    const bullets = Array.from({ length: 45 }, (_, i) => `• item ${i}`);
    const out = capList(bullets, 40);
    expect(out).toHaveLength(41); // 40 kept + 1 summary line
    expect(out[40]).toContain('+5 more');
    expect(out).not.toContain('• item 40'); // the 41st bullet is dropped
  });
});
