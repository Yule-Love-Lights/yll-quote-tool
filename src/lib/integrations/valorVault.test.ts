// #161 "both vaults" decision (2026-07-22) — unit tests for the valor-vault
// client. Response shapes are UNVERIFIED until the live probe (see the module
// header in ./valorVault.ts), so these pin the DEFENSIVE parsing contract:
// several candidate key names, flat or nested under `data`, string OR number
// ids. Also locks in the dedicated-vs-fallback auth vars, the never-throws
// orchestrator contract, the 15s per-call timeout, and that the app key value
// never appears in anything this module logs or returns.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addVaultCustomer,
  addPaymentProfileTxn,
  getPaymentProfile,
  registerCardInVault,
  isVaultRegisterEnabled,
} from './valorVault';

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
  delete process.env.VALOR_VAULT_REGISTER_ENABLED;
  delete process.env.VALOR_VAULT_APP_ID;
  delete process.env.VALOR_VAULT_APP_KEY;
  delete process.env.VALOR_APP_ID;
  delete process.env.VALOR_APP_KEY;
  delete process.env.VALOR_VAULT_BASE_URL;
});

afterEach(() => {
  process.env = OLD_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// ─── isVaultRegisterEnabled ─────────────────────────────────────────────────

describe('isVaultRegisterEnabled', () => {
  it('is false when the flag env var is unset', () => {
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
    expect(isVaultRegisterEnabled()).toBe(false);
  });

  it("is false for a truthy-looking-but-not-exact flag value ('1')", () => {
    process.env.VALOR_VAULT_REGISTER_ENABLED = '1';
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
    expect(isVaultRegisterEnabled()).toBe(false);
  });

  it('is false when the flag is on but no auth vars (dedicated or fallback) are configured', () => {
    process.env.VALOR_VAULT_REGISTER_ENABLED = 'true';
    expect(isVaultRegisterEnabled()).toBe(false);
  });

  it('is false when only one of the two resolved creds is present', () => {
    process.env.VALOR_VAULT_REGISTER_ENABLED = 'true';
    process.env.VALOR_APP_ID = 'app';
    expect(isVaultRegisterEnabled()).toBe(false);
  });

  it('is true when the flag is on and the DEDICATED vault creds are set', () => {
    process.env.VALOR_VAULT_REGISTER_ENABLED = 'true';
    process.env.VALOR_VAULT_APP_ID = 'vault-app';
    process.env.VALOR_VAULT_APP_KEY = 'vault-key';
    expect(isVaultRegisterEnabled()).toBe(true);
  });

  it('is true when the flag is on and it FALLS BACK to VALOR_APP_ID/KEY', () => {
    process.env.VALOR_VAULT_REGISTER_ENABLED = 'true';
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
    expect(isVaultRegisterEnabled()).toBe(true);
  });
});

// ─── addVaultCustomer — defensive id extraction ─────────────────────────────

describe('addVaultCustomer — defensive id extraction', () => {
  beforeEach(() => {
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
  });

  const cases: Array<[string, unknown, string]> = [
    ['vault_customer_id, flat', { vault_customer_id: 'vc-1' }, 'vc-1'],
    ['vault_id, flat', { vault_id: 'vc-2' }, 'vc-2'],
    ['customer_id, flat', { customer_id: 'vc-3' }, 'vc-3'],
    ['id, flat, string', { id: 'vc-4' }, 'vc-4'],
    ['id, flat, number', { id: 42 }, '42'],
    ['vault_customer_id, nested under data', { data: { vault_customer_id: 'vc-5' } }, 'vc-5'],
    ['id, nested under data, number', { data: { id: 7 } }, '7'],
    ['first match wins over a later candidate key', { vault_customer_id: 'vc-6', id: 'ignored' }, 'vc-6'],
  ];

  it.each(cases)('picks the id from: %s', async (_label, body, expectedId) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)));
    const result = await addVaultCustomer({ customerName: 'Jordan Smith', email: null, phone: null });
    expect(result.vaultCustomerId).toBe(expectedId);
  });

  it('splits the customer name on the LAST space (middle name stays with first_name)', async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        captured = JSON.parse(init.body);
        return jsonResponse(200, { vault_customer_id: 'vc-1' });
      }),
    );
    await addVaultCustomer({ customerName: 'Jordan Van Smith', email: 'j@example.com', phone: '5551234567' });
    expect(captured.first_name).toBe('Jordan Van');
    expect(captured.last_name).toBe('Smith');
    expect(captured.email).toBe('j@example.com');
    expect(captured.phone).toBe('5551234567');
  });

  it('uses the whole (single-word) name as first_name with no last_name', async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        captured = JSON.parse(init.body);
        return jsonResponse(200, { vault_customer_id: 'vc-1' });
      }),
    );
    await addVaultCustomer({ customerName: 'Cher', email: null, phone: null });
    expect(captured.first_name).toBe('Cher');
    expect(captured.last_name).toBe('');
  });

  it("falls back to 'Customer' when there is no name at all", async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        captured = JSON.parse(init.body);
        return jsonResponse(200, { vault_customer_id: 'vc-1' });
      }),
    );
    await addVaultCustomer({ customerName: null, email: null, phone: null });
    expect(captured.first_name).toBe('Customer');
    expect(captured.last_name).toBe('');
    expect(captured.email).toBeUndefined();
    expect(captured.phone).toBeUndefined();
  });

  it('throws a ValorError when the response carries no recognizable id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { unexpected: 'shape' })));
    await expect(addVaultCustomer({ customerName: 'A B', email: null, phone: null })).rejects.toThrow(
      /missing a vault customer id/,
    );
  });

  it('throws a ValorError with a truncated body on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, 'internal server error')));
    await expect(addVaultCustomer({ customerName: 'A B', email: null, phone: null })).rejects.toThrow(/500/);
  });
});

// ─── addPaymentProfileTxn ────────────────────────────────────────────────────

describe('addPaymentProfileTxn', () => {
  beforeEach(() => {
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
  });

  it('posts ref_txn_id to the vault-customer-scoped endpoint and picks payment_id when present', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: { body: string }) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(init.body);
        return jsonResponse(200, { payment_id: 'pp-1' });
      }),
    );
    const result = await addPaymentProfileTxn('vc-1', 'TXN-1');
    expect(capturedUrl).toContain('/api/valor-vault/addpaymentprofiletxn/vc-1');
    expect(capturedBody).toEqual({ ref_txn_id: 'TXN-1' });
    expect(result.paymentId).toBe('pp-1');
  });

  it('succeeds with no payment_id present (2xx alone is success)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
    const result = await addPaymentProfileTxn('vc-1', 'TXN-1');
    expect(result.paymentId).toBeUndefined();
  });

  it('throws a ValorError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, 'bad txn id')));
    await expect(addPaymentProfileTxn('vc-1', 'TXN-1')).rejects.toThrow(/400/);
  });
});

// ─── getPaymentProfile ───────────────────────────────────────────────────────

describe('getPaymentProfile', () => {
  it('GETs the vault-customer-scoped read-back endpoint', async () => {
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
    let capturedUrl = '';
    let capturedMethod = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: { method: string }) => {
        capturedUrl = String(url);
        capturedMethod = init.method;
        return jsonResponse(200, { profile: 'whatever-shape' });
      }),
    );
    const result = await getPaymentProfile('vc-1');
    expect(capturedMethod).toBe('GET');
    expect(capturedUrl).toContain('/api/valor-vault/getpaymentprofile/vc-1');
    expect(result).toEqual({ profile: 'whatever-shape' });
  });
});

// ─── auth headers — dedicated vars vs. fallback ─────────────────────────────

describe('vault auth headers', () => {
  it('uses the DEDICATED VALOR_VAULT_APP_ID/KEY vars when set', async () => {
    process.env.VALOR_VAULT_APP_ID = 'vault-app-id';
    process.env.VALOR_VAULT_APP_KEY = 'vault-app-key-secret';
    process.env.VALOR_APP_ID = 'legacy-app-id';
    process.env.VALOR_APP_KEY = 'legacy-app-key-secret';
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
        capturedHeaders = init.headers;
        return jsonResponse(200, { vault_customer_id: 'vc-1' });
      }),
    );
    await addVaultCustomer({ customerName: 'A B', email: null, phone: null });
    expect(capturedHeaders['Valor-App-ID']).toBe('vault-app-id');
    expect(capturedHeaders['Valor-App-Key']).toBe('vault-app-key-secret');
  });

  it('FALLS BACK to VALOR_APP_ID/KEY when the dedicated vars are absent', async () => {
    process.env.VALOR_APP_ID = 'legacy-app-id';
    process.env.VALOR_APP_KEY = 'legacy-app-key-secret';
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
        capturedHeaders = init.headers;
        return jsonResponse(200, { vault_customer_id: 'vc-1' });
      }),
    );
    await addVaultCustomer({ customerName: 'A B', email: null, phone: null });
    expect(capturedHeaders['Valor-App-ID']).toBe('legacy-app-id');
    expect(capturedHeaders['Valor-App-Key']).toBe('legacy-app-key-secret');
  });

  it('throws (never calls fetch) when neither dedicated nor fallback creds are configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(addVaultCustomer({ customerName: 'A B', email: null, phone: null })).rejects.toThrow(
      /not configured/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── registerCardInVault — the orchestrator ─────────────────────────────────

describe('registerCardInVault', () => {
  beforeEach(() => {
    process.env.VALOR_APP_ID = 'app';
    process.env.VALOR_APP_KEY = 'key';
  });

  it('happy path: addcustomer then addpaymentprofiletxn against the returned id', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/addcustomer')) return jsonResponse(200, { vault_customer_id: 'vc-1' });
        if (u.includes('/addpaymentprofiletxn/')) return jsonResponse(200, { payment_id: 'pp-1' });
        return jsonResponse(404, {});
      }),
    );

    const result = await registerCardInVault({
      customerName: 'Jordan Smith',
      email: 'jordan@example.com',
      phone: '5551234567',
      txnId: 'TXN-1',
    });

    expect(result).toEqual({ ok: true, vaultCustomerId: 'vc-1', paymentId: 'pp-1' });
    expect(calls[0]).toContain('/api/valor-vault/addcustomer');
    expect(calls[1]).toContain('/api/valor-vault/addpaymentprofiletxn/vc-1');
  });

  it('addcustomer failure → { ok:false, reason }, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, 'server error')));

    const result = await registerCardInVault({
      customerName: 'A B',
      email: null,
      phone: null,
      txnId: 'TXN-1',
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain('addcustomer failed');
  });

  it('addpaymentprofiletxn failure AFTER addcustomer success → { ok:false, reason }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('/addcustomer')) return jsonResponse(200, { vault_customer_id: 'vc-1' });
        return jsonResponse(400, 'txn not found');
      }),
    );

    const result = await registerCardInVault({
      customerName: 'A B',
      email: null,
      phone: null,
      txnId: 'TXN-1',
    });

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain('addpaymentprofiletxn failed');
  });

  it('resolves { ok:false } for a missing txnId without making any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await registerCardInVault({ customerName: 'A B', email: null, phone: null, txnId: '' });

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a hung request times out (15s) and resolves { ok:false } — never throws, never hangs', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own — only settles when the
    // AbortController's signal fires, mirroring googleMaps.test.ts's pattern.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );

    const resultPromise = registerCardInVault({
      customerName: 'A B',
      email: null,
      phone: null,
      txnId: 'TXN-1',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason.toLowerCase()).toContain('timed out');
  });
});

// ─── no secret leakage ───────────────────────────────────────────────────────

describe('no secret leakage', () => {
  it('the app key value never appears in console output or in a returned/thrown message', async () => {
    const SECRET_KEY_VALUE = 'super-secret-vault-app-key-value';
    process.env.VALOR_APP_ID = 'app-id';
    process.env.VALOR_APP_KEY = SECRET_KEY_VALUE;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Force every step to fail so every error/message path is exercised. The
    // mocked response body is a generic server error — it never echoes our
    // OWN credential, since the real risk is US logging the outgoing
    // appId/appKey, not the server's response happening to contain it.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, 'internal server error')));

    const result = await registerCardInVault({
      customerName: 'A B',
      email: null,
      phone: null,
      txnId: 'TXN-1',
    });

    const consoleText = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(' ');
    const resultText = JSON.stringify(result);

    expect(consoleText).not.toContain(SECRET_KEY_VALUE);
    expect(resultText).not.toContain(SECRET_KEY_VALUE);
  });
});
