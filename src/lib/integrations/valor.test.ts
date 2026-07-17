import { describe, it, expect } from 'vitest';
import { parseWebhookEvent } from './valor';

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
});
