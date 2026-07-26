import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAutoChargeEnabled, chargeBalanceOnFile } from './valorBalance';

const ENV = 'VALOR_AUTO_CHARGE_ENABLED';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isAutoChargeEnabled', () => {
  it('is false by default (no Valor capability confirmed)', () => {
    expect(isAutoChargeEnabled()).toBe(false);
  });

  it('is true for truthy flag values', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' on ']) {
      process.env[ENV] = v;
      expect(isAutoChargeEnabled()).toBe(true);
    }
  });
});

// Secrets that must NEVER leak into a returned message or a console call.
const SECRET_TOKEN = 'vault-tok-SECRET-123';
const SECRET_APPKEY = 'appkey-SECRET-456';

function assertNoSecrets(haystack: string) {
  expect(haystack).not.toContain(SECRET_TOKEN);
  expect(haystack).not.toContain(SECRET_APPKEY);
}

describe('chargeBalanceOnFile — gating (unchanged semantics)', () => {
  it('reports not-enabled when the flag is off — makes no charge', async () => {
    const r = await chargeBalanceOnFile({ vaultToken: 'tok', amountUsd: 500, orderRef: 'q1' });
    expect(r).toMatchObject({ ok: false, reason: 'not-enabled' });
  });

  it('reports no-card when enabled but the quote has no saved token', async () => {
    process.env[ENV] = 'true';
    const r = await chargeBalanceOnFile({ vaultToken: null, amountUsd: 500, orderRef: 'q1' });
    expect(r).toMatchObject({ ok: false, reason: 'no-card' });
  });

  it('reports error when enabled + token present but Valor creds are missing', async () => {
    process.env[ENV] = 'true';
    delete process.env.VALOR_APP_ID;
    delete process.env.VALOR_APP_KEY;
    delete process.env.VALOR_EPI;
    const r = await chargeBalanceOnFile({ vaultToken: 'tok', amountUsd: 500, orderRef: 'q1' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('error');
      expect(r.message).toMatch(/not configured/i);
    }
  });
});

describe('chargeBalanceOnFile — POST /?saleToken (proven live 2026-07-22)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      VALOR_AUTO_CHARGE_ENABLED: 'true',
      VALOR_APP_ID: 'app',
      VALOR_APP_KEY: SECRET_APPKEY,
      VALOR_EPI: 'epi',
      VALOR_IS_DEMO: 'true',
    };
  });
  afterEach(() => {
    process.env = OLD_ENV;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init: { body: string }) => Promise<unknown> | unknown) {
    const fetchMock = vi.fn(async (url: unknown, init: { body: string }) => handler(String(url), init));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('posts to the staging saleToken endpoint with the proven body shape', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            error_no: 'S00',
            error_code: '00',
            msg: 'APPROVED',
            approval_code: 'AUTH1',
            txnid: 987654,
            rrn: 'RRN1',
            amount: 25.0,
          }),
      };
    });

    const r = await chargeBalanceOnFile({ vaultToken: SECRET_TOKEN, amountUsd: 25, orderRef: 'bal_q1' });

    expect(capturedUrl).toBe('https://securelink-staging.valorpaytech.com/?saleToken');
    expect(capturedBody).toMatchObject({
      appid: 'app',
      appkey: SECRET_APPKEY,
      epi: 'epi',
      txn_type: 'sale',
      amount: 25,
      surcharge: 0,
      ignore_surcharge_calc: 1,
      surchargeIndicator: 1,
      token: SECRET_TOKEN,
      shipping_country: 'US',
      invoicenumber: 'bal_q1',
      orderdescription: 'YLL balance collection',
    });
    expect(r).toMatchObject({ ok: true, chargedUsd: 25, txnId: '987654', approvalCode: 'AUTH1', receiptUrl: null });
  });

  it('rounds amountUsd to dollars-2dp (the proven pagesale/saleToken convention)', async () => {
    let capturedBody: Record<string, unknown> = {};
    stubFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ error_no: 'S00' }) };
    });
    await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 551.916, orderRef: 'q' });
    expect(capturedBody.amount).toBe(551.92);
  });

  it('defaults surchargeIndicator to 1 (proven live for our cash-discount EPI) and honors an env override', async () => {
    let capturedBody: Record<string, unknown> = {};
    stubFetch(async (_url, init) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ error_no: 'S00' }) };
    });
    await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 10, orderRef: 'q' });
    expect(capturedBody.surchargeIndicator).toBe(1);

    process.env.VALOR_SURCHARGE_INDICATOR = '0';
    await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 10, orderRef: 'q' });
    expect(capturedBody.surchargeIndicator).toBe(0);
  });

  it('S00 flat response → ok with chargedUsd/txnId/approvalCode parsed and receiptUrl null (no key observed live)', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          error_no: 'S00',
          error_code: '00',
          msg: 'APPROVED',
          approval_code: 'A1B2',
          txnid: 'TXN-1',
          rrn: 'RRN-1',
          amount: 100.0,
          netamt: 100.0,
          card_brand: 'VISA',
          token: 'echoed-token',
        }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 100, orderRef: 'q' });
    expect(r).toEqual({ ok: true, chargedUsd: 100, txnId: 'TXN-1', approvalCode: 'A1B2', receiptUrl: null, raw: expect.any(Object) });
  });

  it('S00 with a STRING amount ("1.00") parses to a number', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error_no: 'S00', txnid: 'T2', amount: '1.00' }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 1, orderRef: 'q' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.chargedUsd).toBe(1);
  });

  it('parses a data-nested S00 response (defensive fallback; flat is the proven shape)', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ data: { error_no: 'S00', txnid: 'T3', amount: 42.5, approval_code: 'AA', receipt_url: 'https://r' } }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 42.5, orderRef: 'q' });
    expect(r).toMatchObject({ ok: true, chargedUsd: 42.5, txnId: 'T3', approvalCode: 'AA', receiptUrl: 'https://r' });
  });

  it('non-S00 (E98/V3 EPI-profile-mismatch shape) → declined with the codes in the message', async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error_no: 'E98', error_code: 'V3', msg: 'EPI host processor info not found' }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 10, orderRef: 'q' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('declined');
      expect(r.message).toContain('E98');
      expect(r.message).toContain('V3');
      expect(r.message).toContain('EPI host processor info not found');
    }
  });

  it('HTTP 400 (D12 shipping-country-mandatory shape) → error', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error_no: 'D12', msg: 'SHIPPING COUNTRY MANDATORY' }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: 't', amountUsd: 10, orderRef: 'q' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('error');
      expect(r.message).toContain('400');
      expect(r.message).toContain('D12');
    }
  });

  it('a timeout → error with a message telling the caller NOT to auto-retry', async () => {
    const fetchMock = vi.fn(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    const p = chargeBalanceOnFile({ vaultToken: 't', amountUsd: 10, orderRef: 'q' });
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    vi.useRealTimers();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('error');
      expect(r.message).toMatch(/timed out/i);
      expect(r.message).toMatch(/not.*auto-retry|do not auto-retry/i);
    }
  });

  it('never includes the vault token or app key in any returned message or console output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error_no: 'E98', error_code: 'V3', msg: 'nope', token: SECRET_TOKEN }),
    }));
    const r = await chargeBalanceOnFile({ vaultToken: SECRET_TOKEN, amountUsd: 10, orderRef: 'q' });
    expect(r.ok).toBe(false);
    if (!r.ok) assertNoSecrets(r.message ?? '');
    for (const spy of [logSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) assertNoSecrets(call.map(String).join(' '));
    }
  });
});
