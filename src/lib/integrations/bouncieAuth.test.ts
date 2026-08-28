// Bouncie OAuth — the rotation hazard is what these tests are really about.
//
// Refreshing CONSUMES the old refresh token. If we ever hand back an access
// token without having persisted its new refresh counterpart, the grant is gone
// and a human has to click through the consent screen again. Several of these
// tests exist only to pin that ordering.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { upsert, selectChain, getSupabaseServiceClient } = vi.hoisted(() => {
  const upsert = vi.fn(async (_row: Record<string, unknown>, _opts?: unknown) => ({
    error: null as { message: string } | null,
  }));
  const state: {
    row: Record<string, unknown> | null;
    rows: Record<string, unknown>[] | null;
    readError: { message: string } | null;
    /** Successive reads pop from here when set, for testing re-reads. */
    queue: Record<string, unknown>[][] | null;
  } = { row: null, rows: null, readError: null, queue: null };
  const selectChain = state;
  const getSupabaseServiceClient = vi.fn(() => ({
    from: () => ({
      upsert,
      select: () => ({
        eq: function () {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        returns: async () => ({
          data: state.queue?.length
            ? state.queue.shift()!
            : (state.rows ?? (state.row ? [state.row] : [])),
          error: state.readError,
        }),
      }),
    }),
  }));
  return { upsert, selectChain, getSupabaseServiceClient };
});

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));

import { encryptSecret, decryptSecret } from '@/lib/crypto/secretBox';
import {
  exchangeCodeForTokens,
  getAccessToken,
  bouncieFetch,
  isBouncieOAuthConfigured,
  BouncieAuthError,
} from './bouncieAuth';

const KEY = Buffer.alloc(32, 3).toString('base64');
const EMAIL = 'info@yulelovelights.com';

let fetchMock: ReturnType<typeof vi.fn>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ['TOKEN_ENCRYPTION_KEY', 'BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_REDIRECT_URI']) {
    saved[k] = process.env[k];
  }
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.BOUNCIE_CLIENT_ID = 'yll-hub';
  process.env.BOUNCIE_CLIENT_SECRET = 'client-secret';
  process.env.BOUNCIE_REDIRECT_URI = 'https://quote.yulelovelights.com/api/integrations/bouncie/callback';
  selectChain.row = null;
  selectChain.rows = null;
  selectChain.readError = null;
  selectChain.queue = null;
  upsert.mockClear();
  upsert.mockResolvedValue({ error: null });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tokenResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_type: 'Bearer',
      ...over,
    }),
  };
}

function storedRow(over: Record<string, unknown> = {}) {
  return {
    account_email: EMAIL,
    access_token_enc: encryptSecret('stored-access'),
    refresh_token_enc: encryptSecret('stored-refresh'),
    access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}

describe('configuration', () => {
  it('reports unconfigured when any piece is missing', () => {
    expect(isBouncieOAuthConfigured()).toBe(true);
    delete process.env.BOUNCIE_CLIENT_SECRET;
    expect(isBouncieOAuthConfigured()).toBe(false);
  });

  it('refuses to exchange when unconfigured', async () => {
    delete process.env.BOUNCIE_CLIENT_ID;
    await expect(exchangeCodeForTokens('code', EMAIL)).rejects.toThrow(BouncieAuthError);
  });
});

describe('exchanging the authorization code', () => {
  it('stores both tokens ENCRYPTED, never in the clear', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    await exchangeCodeForTokens('the-code', EMAIL);

    const row = upsert.mock.calls[0]![0] as Record<string, string>;
    expect(row.provider).toBe('bouncie');
    expect(row.account_email).toBe(EMAIL);
    // The whole point: the raw values must not appear anywhere in the row.
    expect(JSON.stringify(row)).not.toContain('access-1');
    expect(JSON.stringify(row)).not.toContain('refresh-1');
    expect(decryptSecret(row.access_token_enc)).toBe('access-1');
    expect(decryptSecret(row.refresh_token_enc)).toBe('refresh-1');
  });

  it('sends the documented body', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    await exchangeCodeForTokens('the-code', EMAIL);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'yll-hub' });
  });

  it('throws rather than storing a partial token response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'only-this' }) });
    await expect(exchangeCodeForTokens('c', EMAIL)).rejects.toThrow(/missing access_token/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not echo the response body in the error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: 'leaky-value' }) });
    await expect(exchangeCodeForTokens('c', EMAIL)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('leaky-value') }),
    );
  });

  it('surfaces a non-2xx from the token endpoint', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) });
    await expect(exchangeCodeForTokens('c', EMAIL)).rejects.toThrow(/returned 400/);
  });
});

describe('getAccessToken', () => {
  it('reuses a still-valid stored token without calling Bouncie', async () => {
    selectChain.row = storedRow();
    expect(await getAccessToken(EMAIL)).toBe('stored-access');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when there is no stored grant', async () => {
    selectChain.row = null;
    await expect(getAccessToken(EMAIL)).rejects.toThrow(/No Bouncie grant stored/);
  });

  it('refreshes when the stored token has expired', async () => {
    selectChain.row = storedRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }));
    expect(await getAccessToken(EMAIL)).toBe('access-2');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'stored-refresh' });
  });

  it('refreshes EARLY, before the token actually expires', async () => {
    // A token valid for another 30 seconds is not worth handing to a caller that
    // may take longer than that to use it.
    selectChain.row = storedRow({ access_token_expires_at: new Date(Date.now() + 30_000).toISOString() });
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'access-early' }));
    expect(await getAccessToken(EMAIL)).toBe('access-early');
  });

  // THE ROTATION HAZARD.
  it('PERSISTS the rotated refresh token before returning', async () => {
    selectChain.row = storedRow({ access_token_expires_at: new Date(Date.now() - 1).toISOString() });
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }));
    await getAccessToken(EMAIL);
    const row = upsert.mock.calls[0]![0] as Record<string, string>;
    expect(decryptSecret(row.refresh_token_enc)).toBe('refresh-2');
  });

  it('THROWS if the rotated pair cannot be saved, rather than returning a token whose refresh is already spent', async () => {
    selectChain.row = storedRow({ access_token_expires_at: new Date(Date.now() - 1).toISOString() });
    fetchMock.mockResolvedValueOnce(tokenResponse({ refresh_token: 'refresh-2' }));
    upsert.mockResolvedValueOnce({ error: { message: 'db down' } });
    await expect(getAccessToken(EMAIL)).rejects.toThrow(/Could not persist/);
  });

  it('demands re-authorization when the stored row has no refresh token', async () => {
    selectChain.row = storedRow({ refresh_token_enc: null, access_token_expires_at: null });
    await expect(getAccessToken(EMAIL)).rejects.toThrow(/re-authorization is required/);
  });

  it('treats an unparseable expiry as expired rather than trusting it', async () => {
    selectChain.row = storedRow({ access_token_expires_at: 'not-a-date' });
    fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'access-3' }));
    expect(await getAccessToken(EMAIL)).toBe('access-3');
  });
});

describe('bouncieFetch', () => {
  it('sends the bare token with NO Bearer prefix', async () => {
    // Bouncie's own FAQ names the Bearer prefix as a top cause of 401.
    selectChain.row = storedRow();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await bouncieFetch('/vehicles', { accountEmail: EMAIL });
    const [url, init] = fetchMock.mock.calls[0]! as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.bouncie.dev/v1/vehicles');
    expect(init.headers.Authorization).toBe('stored-access');
    expect(init.headers.Authorization).not.toMatch(/^Bearer/);
  });
});


describe('fixes from the S68 lens round', () => {
  it('refuses to spend the one-shot code when the encryption key is missing', async () => {
    // ADMIN lens: exchanging first and discovering afterwards that we cannot
    // encrypt would burn the authorization code for a purely local problem,
    // sending the operator back through the consent screen for nothing.
    delete process.env.TOKEN_ENCRYPTION_KEY;
    await expect(exchangeCodeForTokens('the-code', EMAIL)).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(fetchMock).not.toHaveBeenCalled(); // the code was never sent
  });

  it('reports a database read failure as an OUTAGE, not as "no grant stored"', async () => {
    // RECOVERY lens: those have opposite fixes. "No grant" tells the operator to
    // re-run the consent flow, which would invalidate a perfectly good grant.
    selectChain.readError = { message: 'connection reset' };
    await expect(getAccessToken(EMAIL)).rejects.toThrow(/Could not read the stored Bouncie grant/);
  });

  it('refuses to guess when more than one grant is stored', async () => {
    // TECHNICAL lens: .limit(1) with no ordering meant which Bouncie account we
    // acted as depended on the query plan. Acting as the wrong fleet is silent.
    selectChain.rows = [storedRow(), storedRow({ account_email: 'other@example.com' })];
    await expect(getAccessToken()).rejects.toThrow(/must name which account/);
  });

  it('still works with two grants when the caller names the account', async () => {
    selectChain.rows = [storedRow()];
    expect(await getAccessToken(EMAIL)).toBe('stored-access');
  });

  // THE ROTATION RACE.
  it('recovers when another caller won the refresh, instead of demanding re-authorization', async () => {
    // Both callers see an expired token and refresh with the SAME refresh token.
    // Bouncie honours the first and rejects the second. The grant is NOT lost —
    // the winner already stored a valid pair — so the loser re-reads and uses it.
    const expired = storedRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    const winner = storedRow({
      access_token_enc: encryptSecret('winner-access'),
      access_token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    selectChain.queue = [[expired], [winner]];
    fetchMock.mockRejectedValueOnce(new Error('400 invalid_grant'));
    expect(await getAccessToken(EMAIL)).toBe('winner-access');
  });

  it('still throws when the refresh failed AND no fresher token appeared', async () => {
    // Distinguishes a genuinely dead grant from a lost race: nothing newer
    // showed up on the re-read, so this really does need re-authorization.
    const expired = storedRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    selectChain.queue = [[expired], [expired]];
    fetchMock.mockRejectedValueOnce(new Error('400 invalid_grant'));
    await expect(getAccessToken(EMAIL)).rejects.toThrow(/invalid_grant/);
  });
});
