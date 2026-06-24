import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyWebhookSignature, parseWebhookEvent } from './valor';

const SECRET = 'whsec_test_abc123';

function sign(base: string, encoding: 'hex' | 'base64' = 'hex'): string {
  return createHmac('sha256', SECRET).update(base, 'utf8').digest(encoding);
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ txn_id: 'T1', response_code: '00', amount: '1350.00' });

  it('accepts a valid hex signature over `${timestamp}.${body}`', () => {
    const ts = nowTs();
    const sig = sign(`${ts}.${body}`, 'hex');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET })).toBe(true);
  });

  it('accepts a valid base64 signature', () => {
    const ts = nowTs();
    const sig = sign(`${ts}.${body}`, 'base64');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET })).toBe(true);
  });

  it('accepts a raw-body-only signature when no timestamp is sent', () => {
    const sig = sign(body, 'hex');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: null, secret: SECRET })).toBe(true);
  });

  it('tolerates a `sha256=` prefix', () => {
    const ts = nowTs();
    const sig = `sha256=${sign(`${ts}.${body}`, 'hex')}`;
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET })).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    const ts = nowTs();
    const sig = createHmac('sha256', 'wrong-secret').update(`${ts}.${body}`).digest('hex');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const ts = nowTs();
    const sig = sign(`${ts}.${body}`, 'hex');
    const tampered = body.replace('1350.00', '1.00');
    expect(verifyWebhookSignature({ rawBody: tampered, signature: sig, timestamp: ts, secret: SECRET })).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature({ rawBody: body, signature: null, timestamp: nowTs(), secret: SECRET })).toBe(false);
  });

  it('rejects a stale timestamp outside the replay window', () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const sig = sign(`${oldTs}.${body}`, 'hex');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: oldTs, secret: SECRET })).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    const sig = sign(body, 'hex');
    expect(verifyWebhookSignature({ rawBody: body, signature: sig, timestamp: null, secret: '' })).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('parses an approved ("00") transaction with all fields', () => {
    const ev = parseWebhookEvent(
      JSON.stringify({
        txn_id: 'TXN-123',
        response_code: '00',
        amount: '1350.00',
        approval_code: 'AUTH99',
        receipt_url: 'https://valor/receipt/123',
        vault_token: 'vault_abc',
        order_id: 'qdeadbeef',
      }),
    );
    expect(ev.approved).toBe(true);
    expect(ev.txnId).toBe('TXN-123');
    expect(ev.responseCode).toBe('00');
    expect(ev.amountUsd).toBe(1350);
    expect(ev.approvalCode).toBe('AUTH99');
    expect(ev.receiptUrl).toBe('https://valor/receipt/123');
    expect(ev.vaultToken).toBe('vault_abc');
    expect(ev.orderRef).toBe('qdeadbeef');
  });

  it('marks a non-"00" response code as not approved', () => {
    const ev = parseWebhookEvent(JSON.stringify({ txn_id: 'T', response_code: '05' }));
    expect(ev.approved).toBe(false);
    expect(ev.responseCode).toBe('05');
  });

  it('reads fields nested under `data`', () => {
    const ev = parseWebhookEvent(
      JSON.stringify({ data: { transaction_id: 'T9', response_code: '00', orderId: 'qX' } }),
    );
    expect(ev.approved).toBe(true);
    expect(ev.txnId).toBe('T9');
    expect(ev.orderRef).toBe('qX');
  });

  it('accepts alias key casings (amt, auth_code, cardToken)', () => {
    const ev = parseWebhookEvent(
      JSON.stringify({ transactionId: 'T', responseCode: '00', amt: '42.5', authCode: 'A1', cardToken: 'ct_1', invoice: 'qY' }),
    );
    expect(ev.amountUsd).toBe(42.5);
    expect(ev.approvalCode).toBe('A1');
    expect(ev.vaultToken).toBe('ct_1');
    expect(ev.orderRef).toBe('qY');
  });

  it('does not throw on malformed JSON', () => {
    const ev = parseWebhookEvent('not json{');
    expect(ev.approved).toBe(false);
    expect(ev.txnId).toBeNull();
    expect(ev.orderRef).toBeNull();
  });
});
