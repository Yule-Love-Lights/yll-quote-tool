import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the two IO seams emailSupplierPurchaseOrder touches: the HighLevel email
// send and the new Telegram ping. The pure tests below don't use either. Also
// mock the on-order ledger (P8) — recordOrder/markOrderSent/cancelOrder are the
// new insert-first-then-send seam.
const { sendEmail, hlConfigured, notifyTelegram, recordOrder, markOrderSent, cancelOrder } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({})),
  hlConfigured: { value: true },
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(),
  recordOrder: vi.fn<() => Promise<string | null>>(async () => 'order-1'),
  markOrderSent: vi.fn(async () => {}),
  cancelOrder: vi.fn(async () => 'cancelled' as const),
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail,
  isHighLevelConfigured: () => hlConfigured.value,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('./orders', () => ({ recordOrder, markOrderSent, cancelOrder }));

import { computePurchaseOrder, purchaseOrderSignature, emailSupplierPurchaseOrder } from './purchaseOrder';

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
});
