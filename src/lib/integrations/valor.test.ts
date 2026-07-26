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

  // #161: Valor's Webhook User Guide documents the TRANSACTION event's card
  // token as `vtToken` — a name the pick-list never included (the #159
  // invoice_no class). The webhook route already persists event.vaultToken →
  // quotes.valor_vault_token, so catching the documented name may be the whole
  // card-on-file capture story.
  it('picks the vault token from the DOCUMENTED shape data.vtToken', () => {
    const ev = parseWebhookEvent(
      JSON.stringify({
        event: 'TRANSACTION',
        data: { txn_id: 'T', response_code: '00', vtToken: 'A1C7CA96D0D3C6276A37324F3477DFD2588D9384' },
      }),
    );
    expect(ev.vaultToken).toBe('A1C7CA96D0D3C6276A37324F3477DFD2588D9384');
  });

  it('still honors the legacy vault_token / token names (no regression)', () => {
    expect(
      parseWebhookEvent(JSON.stringify({ data: { response_code: '00', vault_token: 'legacy1' } })).vaultToken,
    ).toBe('legacy1');
    expect(parseWebhookEvent(JSON.stringify({ data: { response_code: '00', token: 'legacy2' } })).vaultToken).toBe(
      'legacy2',
    );
    expect(parseWebhookEvent(JSON.stringify({ data: { response_code: '00' } })).vaultToken).toBeNull();
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

// #161 (2026-07-22, Valor support Fadil Cox): the hosted page's card-on-file
// answer is a redirect_url S2S callback, not save_card. This is PROBED behind
// VALOR_REDIRECT_CAPTURE_URL — when set, ONLY redirect_url points at the
// diagnostic route; success_url (what the customer's browser actually uses to
// return from checkout) must stay untouched.
describe('createHostedPageSale — redirect_url capture (#161)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, VALOR_APP_ID: 'app', VALOR_APP_KEY: 'key', VALOR_EPI: 'epi', VALOR_IS_DEMO: 'true' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
  });

  async function captureBody(): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ url: 'https://valor/pay/abc', uid: 'u1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await createHostedPageSale({
      amountUsd: 100,
      orderRef: 'qtest',
      successUrl: 'https://app/success',
      failureUrl: 'https://app/fail',
    });
    return capturedBody;
  }

  it('points redirect_url at VALOR_REDIRECT_CAPTURE_URL when set, leaving success_url unchanged', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture';
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/api/integrations/valor/redirect-capture');
    expect(body.success_url).toBe('https://app/success');
  });

  it('falls back to successUrl for redirect_url when the capture env var is unset (current/original behavior)', async () => {
    delete process.env.VALOR_REDIRECT_CAPTURE_URL;
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/success');
    expect(body.success_url).toBe('https://app/success');
  });

  it('falls back to successUrl when the capture env var is set but blank', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = '   ';
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/success');
  });

  // #161 build-out (2026-07-22): the channel was confirmed live as an UNSIGNED
  // S2S POST, so we self-authenticate it with a secret embedded in the URL we
  // hand Valor — Valor echoes redirect_url verbatim, so anything appended here
  // round-trips back to redirect-capture on the callback.
  it('appends the secret as an `s` query param when VALOR_REDIRECT_CAPTURE_SECRET is set', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture';
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'sekrit-value';
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/api/integrations/valor/redirect-capture?s=sekrit-value');
    expect(body.success_url).toBe('https://app/success');
  });

  it('handles a capture URL that already has a query string', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture?foo=bar';
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'sekrit-value';
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/api/integrations/valor/redirect-capture?foo=bar&s=sekrit-value');
  });

  it('leaves the bare capture URL unchanged when the secret env var is unset (current behavior)', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture';
    delete process.env.VALOR_REDIRECT_CAPTURE_SECRET;
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/api/integrations/valor/redirect-capture');
  });

  it('leaves the bare capture URL unchanged when the secret env var is set but blank', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture';
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = '   ';
    const body = await captureBody();
    expect(body.redirect_url).toBe('https://app/api/integrations/valor/redirect-capture');
  });

  it('URL-encodes a secret containing reserved characters', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_URL = 'https://app/api/integrations/valor/redirect-capture';
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'a&b=c d';
    const body = await captureBody();
    expect(body.redirect_url).toBe(
      `https://app/api/integrations/valor/redirect-capture?s=${encodeURIComponent('a&b=c d')}`,
    );
  });
});
