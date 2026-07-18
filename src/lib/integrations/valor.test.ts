import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWebhookEvent, createHostedPageSale } from './valor';

// #159 (first real payment, 2026-07-17): Valor's E-Invoice confirmation webhook
// nests the transaction under `data` and echoes our order ref as `data.invoice_no`.
// parseWebhookEvent previously didn't check `invoice_no`, so a real deposit
// charged but came back hasOrderRef:false → the webhook ignored it and the quote
// never auto-booked. These pin the order-ref extraction from the real shape.
describe('parseWebhookEvent — order ref extraction', () => {
  it('picks the ref from the REAL nested shape data.invoice_no', () => {
    const body = JSON.stringify({
      event: 'transaction',
      data: { txn_id: 'TXN-REAL', response_code: '00', invoice_no: 'qaf7affe2379dfd8a' },
    });
    const ev = parseWebhookEvent(body);
    expect(ev.orderRef).toBe('qaf7affe2379dfd8a');
    expect(ev.txnId).toBe('TXN-REAL');
    expect(ev.approved).toBe(true);
  });

  it('still honors the legacy top-level / order_id shapes (no regression)', () => {
    expect(parseWebhookEvent(JSON.stringify({ order_id: 'qdeadbeef', response_code: '00' })).orderRef).toBe(
      'qdeadbeef',
    );
    expect(
      parseWebhookEvent(JSON.stringify({ data: { invoicenumber: 'qold', response_code: '00' } })).orderRef,
    ).toBe('qold');
  });

  it('a terminal/VT sale with no ref yields a null orderRef (correctly unmatched → ignored upstream)', () => {
    const ev = parseWebhookEvent(JSON.stringify({ data: { txn_id: 'T', response_code: '00' } }));
    expect(ev.orderRef).toBeNull();
    expect(ev.approved).toBe(true);
  });

  // #165: Valor reports the webhook amount in CENTS. Confirmed live 2026-07-17 —
  // a $5.44 deposit came back as data.amount "544" and booked at $544 (100×).
  it('converts the CENTS amount to dollars (data.amount "544" → 5.44)', () => {
    const ev = parseWebhookEvent(JSON.stringify({ data: { response_code: '00', amount: '544', invoice_no: 'qx' } }));
    expect(ev.amountUsd).toBe(5.44);
  });

  it('converts a whole-dollar cents amount (135000 → 1350) and null when absent', () => {
    expect(parseWebhookEvent(JSON.stringify({ data: { response_code: '00', amount: '135000' } })).amountUsd).toBe(1350);
    expect(parseWebhookEvent(JSON.stringify({ data: { response_code: '00' } })).amountUsd).toBeNull();
  });
});

// #161: the deposit hosted-page call charges EXACTLY the deposit (no surcharge)
// and round-trips our order ref. `save_card` was probed to vault the card but the
// hosted page does NOT honor it (live test 2026-07-17) — reverted, so it must be
// absent from the body (guards against it being re-added without a working path).
describe('createHostedPageSale — request body', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, VALOR_APP_ID: 'app', VALOR_APP_KEY: 'key', VALOR_EPI: 'epi', VALOR_IS_DEMO: 'true' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  it('charges EXACTLY the amount, round-trips the ref, and does NOT send save_card (#161 reverted)', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://valor/pay/abc', uid: 'u1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await createHostedPageSale({
      amountUsd: 489.38,
      orderRef: 'qaf7affe2379dfd8a',
      successUrl: 'https://app/success',
      failureUrl: 'https://app/fail',
    });

    expect(r.url).toBe('https://valor/pay/abc');
    // Money-safety flags: charge exactly the amount, our ref round-trips.
    expect(capturedBody.ignore_surcharge_calc).toBe(1);
    expect(capturedBody.surcharge).toBe(0);
    expect(capturedBody.invoicenumber).toBe('qaf7affe2379dfd8a');
    // save_card confirmed non-functional on the hosted page → not sent.
    expect(capturedBody.save_card).toBeUndefined();
  });
});
