import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the two IO seams emailSupplierPurchaseOrder touches: the HighLevel email
// send and the new Telegram ping. The pure tests below don't use either.
const { sendEmail, hlConfigured, notifyTelegram } = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({})),
  hlConfigured: { value: true },
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail,
  isHighLevelConfigured: () => hlConfigured.value,
}));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));

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

describe('emailSupplierPurchaseOrder — Telegram ping (#82 follow-up)', () => {
  const PO = {
    lines: [
      { sku: '1001', name: 'C9 Warm White', needed: 100, onHand: 12, order: 88 },
      { sku: '1042', name: 'Green clips', needed: 250, onHand: 0, order: 250 },
    ],
    jobCount: 6,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hlConfigured.value = true;
    process.env.THUNDER_ORDER_CONTACT_ID = 'supplier-1';
  });
  afterEach(() => {
    delete process.env.THUNDER_ORDER_CONTACT_ID;
  });

  it('pings the group with the ordered items after a successful send', async () => {
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026');
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
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026');
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifyTelegram).not.toHaveBeenCalled();
  });

  it('does NOT ping when the email send throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const res = await emailSupplierPurchaseOrder(PO, 'Jun 28, 2026');
    expect(res.ok).toBe(false);
    expect(notifyTelegram).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
