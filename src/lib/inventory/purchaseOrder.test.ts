import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the two IO seams emailSupplierPurchaseOrder touches: the HighLevel email
// send and the new Telegram ping. The pure tests below don't use either. Also
// mock the on-order ledger (P8) — recordOrder/markOrderSent/cancelOrder are the
// new insert-first-then-send seam.
const { sendEmail, hlConfigured, notifyTelegram, recordOrder, markOrderSent, cancelOrder, sumOpenOnOrder } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({})),
  hlConfigured: { value: true },
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(),
  recordOrder: vi.fn<() => Promise<string | null>>(async () => 'order-1'),
  markOrderSent: vi.fn(async () => {}),
  cancelOrder: vi.fn(async () => 'cancelled' as const),
  sumOpenOnOrder: vi.fn<() => Promise<Map<string, number>>>(async () => new Map()),
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail,
  isHighLevelConfigured: () => hlConfigured.value,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('./orders', () => ({ recordOrder, markOrderSent, cancelOrder, sumOpenOnOrder }));

// WT-27: buildSupplierPurchaseOrder mocks (mirrors purchaseOrderBuild.test.ts /
// purchaseOrderPermanent.test.ts). listCatalog deliberately omits bistro SKUs so
// the fix's BISTRO_CATALOG backfill is the only thing that can resolve their name.
let currentDb: unknown = null;
vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })) }));
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => [{ sku: 'SKU-A', name: 'Holiday Widget' }]) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []) }));

import { computePurchaseOrder, purchaseOrderSignature, emailSupplierPurchaseOrder, buildSupplierPurchaseOrder } from './purchaseOrder';

// A single active permanent-bistro job with a 40ft run — real bistroBomFromQuote
// produces a Thunder-supplier cord line (sku 80324, qty 1) among others.
const BISTRO_QUOTE_ID = 'BIS';
function makeBistroDb() {
  return {
    from(table: string) {
      const b = {
        select: () => b,
        is: () => b,
        eq: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => void) => {
          if (table === 'jobs') {
            return resolve({
              data: [{ quote_id: BISTRO_QUOTE_ID, status: 'to_schedule', stock_decremented_at: null }],
              error: null,
            });
          }
          if (table === 'quotes') {
            return resolve({
              data: [
                {
                  id: BISTRO_QUOTE_ID,
                  is_test: false,
                  approval_snapshot: null,
                  service_type: 'permanent_bistro',
                  inputs: { permanentBistro: { bistro: [{ footage: 40 }], poles: 0 } },
                },
              ],
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  };
}

describe('buildSupplierPurchaseOrder — bistro Thunder SKU names (WT-27)', () => {
  beforeEach(() => {
    currentDb = makeBistroDb();
  });

  it('resolves the real product name for a pooled bistro Thunder SKU, not "(not in catalog)"', async () => {
    const po = await buildSupplierPurchaseOrder();
    const cordLine = po.lines.find((l) => l.sku === '80324');
    expect(cordLine).toBeTruthy();
    expect(cordLine!.name).toBe('E26 Bistro Cord 330ft, 24in spacing');
    expect(cordLine!.name).not.toBe('(not in catalog)');
  });
});

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

describe('computePurchaseOrder (#82 Phase 3 auto-ordering, P8 delta)', () => {
  it('orders the shortfall, drops covered SKUs, sorts by SKU', () => {
    expect(
      computePurchaseOrder([
        { sku: 'B', needed: 10, onHand: 3, onOrder: 0 }, // short 7
        { sku: 'A', needed: 5, onHand: 5, onOrder: 0 }, // covered → dropped
        { sku: 'C', needed: 4, onHand: 9, onOrder: 0 }, // over-stocked → dropped
        { sku: 'D', needed: 6, onHand: 0, onOrder: 0 }, // untracked/none → order all 6
      ]),
    ).toEqual([
      { sku: 'B', needed: 10, onHand: 3, onOrder: 0, order: 7 },
      { sku: 'D', needed: 6, onHand: 0, onOrder: 0, order: 6 },
    ]);
  });

  it('ceils fractional need and floors negative on-hand at 0', () => {
    expect(computePurchaseOrder([{ sku: 'X', needed: 10.2, onHand: -3, onOrder: 0 }])).toEqual([
      { sku: 'X', needed: 11, onHand: 0, onOrder: 0, order: 11 },
    ]);
  });

  it('returns [] when everything is covered', () => {
    expect(computePurchaseOrder([{ sku: 'A', needed: 2, onHand: 2, onOrder: 0 }])).toEqual([]);
  });

  it('subtracts on-order (fully covered) — a delta, not the full cumulative shortfall', () => {
    expect(computePurchaseOrder([{ sku: 'A', needed: 10, onHand: 2, onOrder: 8 }])).toEqual([]);
  });

  it('subtracts on-order partially — orders only what is still uncovered', () => {
    expect(computePurchaseOrder([{ sku: 'A', needed: 10, onHand: 2, onOrder: 3 }])).toEqual([
      { sku: 'A', needed: 10, onHand: 2, onOrder: 3, order: 5 },
    ]);
  });

  it('floors a junk negative on-order at 0 (never subtracts it as if it added supply)', () => {
    expect(computePurchaseOrder([{ sku: 'A', needed: 10, onHand: 2, onOrder: -5 }])).toEqual([
      { sku: 'A', needed: 10, onHand: 2, onOrder: 0, order: 8 },
    ]);
  });
});

describe('emailSupplierPurchaseOrder — Telegram ping (#82 follow-up)', () => {
  const PO = {
    lines: [
      { sku: '1001', name: 'C9 Warm White', needed: 100, onHand: 12, onOrder: 0, order: 88 },
      { sku: '1042', name: 'Green clips', needed: 250, onHand: 0, onOrder: 0, order: 250 },
    ],
    jobCount: 6,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hlConfigured.value = true;
    recordOrder.mockResolvedValue('order-1');
    process.env.THUNDER_ORDER_CONTACT_ID = 'supplier-1';
  });
  afterEach(() => {
    delete process.env.THUNDER_ORDER_CONTACT_ID;
  });

  it('pings the group with the ordered items after a successful send', async () => {
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026', 'manual');
    expect(res.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    const msg = notifyTelegram.mock.calls[0][0] as string;
    expect(msg).toContain('Purchase order sent to supplier');
    expect(msg).toContain('C9 Warm White (1001) ×88');
    expect(msg).toContain('6 job');
  });

  it('does NOT ping when the supplier email is not configured', async () => {
    delete process.env.THUNDER_ORDER_CONTACT_ID;
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026', 'manual');
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyTelegram).not.toHaveBeenCalled();
  });

  it('does NOT ping when the email send throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026', 'manual');
    expect(res.ok).toBe(false);
    expect(notifyTelegram).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('emailSupplierPurchaseOrder — on-order ledger (P8, folds in #110 W7-002)', () => {
  const PO = {
    lines: [{ sku: '1001', name: 'C9 Warm White', needed: 100, onHand: 12, onOrder: 0, order: 88 }],
    jobCount: 6,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hlConfigured.value = true;
    recordOrder.mockResolvedValue('order-1');
    process.env.THUNDER_ORDER_CONTACT_ID = 'supplier-1';
  });
  afterEach(() => {
    delete process.env.THUNDER_ORDER_CONTACT_ID;
  });

  it('records the order BEFORE sending, then marks it sent on success', async () => {
    const res = await emailSupplierPurchaseOrder(PO, 'Jul 6, 2026', 'manual');
    expect(res.ok).toBe(true);
    expect(recordOrder).toHaveBeenCalledWith({
      channel: 'manual',
      lines: [{ sku: '1001', name: 'C9 Warm White', qty: 88 }],
      jobCount: 6,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(markOrderSent).toHaveBeenCalledWith('order-1');
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('does NOT send when recordOrder fails — an unrecorded send would double-ship later', async () => {
    recordOrder.mockResolvedValueOnce(null);
    const res = await emailSupplierPurchaseOrder(PO, 'Jul 6, 2026', 'manual');
    expect(res).toEqual({ ok: false, status: 500, error: 'Could not record the order — not sent.' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(markOrderSent).not.toHaveBeenCalled();
  });

  it('cancels the recorded order when the send fails, so it never sticks around as a phantom open order', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const res = await emailSupplierPurchaseOrder(PO, 'Jul 6, 2026', 'manual');
    expect(res.ok).toBe(false);
    expect(cancelOrder).toHaveBeenCalledWith('order-1');
    expect(markOrderSent).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('concurrent-send guard: cancels + skips the send when OTHER open orders already cover the need (a racing sender got there first)', async () => {
    // PO needs 100 with 12 on hand → our delta is 88. After our insert the open
    // sum is 176 = ours (88) + a concurrent sender's 88; others (88) + onHand
    // (12) ≥ needed (100) → ours is a duplicate.
    sumOpenOnOrder.mockResolvedValueOnce(new Map([['1001', 176]]));
    const res = await emailSupplierPurchaseOrder(PO, 'Jul 6, 2026', 'auto-cron');
    expect(res).toEqual({ ok: false, status: 409, error: 'Duplicate order — an order covering this need was just recorded. Nothing sent.' });
    expect(cancelOrder).toHaveBeenCalledWith('order-1');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(markOrderSent).not.toHaveBeenCalled();
  });

  it('concurrent-send guard: sends normally when the open sum is just our own order (no race)', async () => {
    // Open sum 88 = ours alone; others (0) + onHand (12) < needed (100) → real need, send.
    sumOpenOnOrder.mockResolvedValueOnce(new Map([['1001', 88]]));
    const res = await emailSupplierPurchaseOrder(PO, 'Jul 6, 2026', 'auto-cron');
    expect(res.ok).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(cancelOrder).not.toHaveBeenCalled();
  });
});

// #117 (Naldo 2026-07-11): bistro's THUNDER lines auto-send on the pooled PO;
// Home Depot (posts, concrete) + Amazon (timer) are manual buys, and the
// as-needed zip wire has no computable quantity. Locked against the real BOM
// engine's output so a catalog/engine change can't silently leak a manual-buy
// SKU into the Thunder email.
describe('poolableBistroPoLines (#117 Thunder-only pooling)', () => {
  it('keeps every Thunder line with the engine quantities and drops HD/Amazon/zip', async () => {
    const { bistroBomFromQuote } = await import('@/lib/permanentBistro/bomFromQuote');
    const { poolableBistroPoLines } = await import('./purchaseOrder');
    const bom = bistroBomFromQuote({
      permanentBistro: { bistro: [{ footage: 40 }, { footage: 35 }, { footage: 25 }], poles: 2 },
    });
    const pooled = poolableBistroPoLines(bom!.lines);
    const bySku = Object.fromEntries(pooled.map((l) => [l.sku, l.qty]));
    expect(bySku).toEqual({
      '80324': 1,  // cord, 330 ft section covers 100 ft
      '80011': 53, // bulbs: ceil((100/2) * 1.06)
      '80002': 1,  // guide wire, 250 ft spool
      '93571': 6,  // eye screws: 2 per strand
      '80005': 6,  // quick links
      '80004': 6,  // looping grippers
      '80308': 3,  // male plugs: 1 per strand
      '80307': 3,  // female plugs
    });
    const pooledSkus = pooled.map((l) => l.sku);
    for (const manual of ['100010238', '100321247', 'B0F5M2S8VJ', '80305']) {
      expect(pooledSkus).not.toContain(manual);
    }
  });

  it('a poles-only bistro job pools NOTHING (all its needs are manual buys)', async () => {
    const { bistroBomFromQuote } = await import('@/lib/permanentBistro/bomFromQuote');
    const { poolableBistroPoLines } = await import('./purchaseOrder');
    const bom = bistroBomFromQuote({ permanentBistro: { bistro: [], poles: 3 } });
    expect(poolableBistroPoLines(bom!.lines)).toEqual([]);
  });
});
