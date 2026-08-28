// The OAuth callback's outcome mapping — every status the settings page can
// render must actually be producible, and each failure shape must land on the
// message with ITS fix. Built from a real night: three 401s in a row showed a
// generic "failed" before the mapping existed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { exchangeCodeForTokens } = vi.hoisted(() => ({
  exchangeCodeForTokens: vi.fn(async (_code: string) => 'info@yulelovelights.com'),
}));

vi.mock('@/lib/integrations/bouncieAuth', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/bouncieAuth')>()),
  exchangeCodeForTokens,
}));

import { GET } from './route';
import { BouncieAuthError } from '@/lib/integrations/bouncieAuth';

const STATE = 'state-value-abc';
const saved: Record<string, string | undefined> = {};

function makeReq(params: Record<string, string>, cookieState?: string): NextRequest {
  const url = new URL('https://quote.yulelovelights.com/api/integrations/bouncie/callback');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return {
    nextUrl: url,
    cookies: { get: (name: string) => (name === 'bouncie_oauth_state' && cookieState ? { value: cookieState } : undefined) },
  } as unknown as NextRequest;
}

/** The status the redirect carries — the only thing the operator ever sees. */
function statusOf(res: Response): string | null {
  const loc = res.headers.get('location');
  return loc ? new URL(loc).searchParams.get('bouncie') : null;
}

beforeEach(() => {
  for (const k of ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_REDIRECT_URI']) {
    saved[k] = process.env[k];
    process.env[k] = 'set';
  }
  exchangeCodeForTokens.mockClear();
  exchangeCodeForTokens.mockResolvedValue('info@yulelovelights.com');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('the happy path', () => {
  it('lands on Settings -> Bouncie with connected', async () => {
    const res = await GET(makeReq({ code: 'c', state: STATE }, STATE));
    expect(res.headers.get('location')).toContain('/settings/bouncie');
    expect(statusOf(res)).toBe('connected');
  });
});

describe('each failure shape gets ITS message', () => {
  it('a 401 from the token endpoint -> bad_credentials (the wrong-secret paste)', async () => {
    exchangeCodeForTokens.mockRejectedValue(new BouncieAuthError('Bouncie token endpoint returned 401.'));
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE }, STATE)))).toBe('bad_credentials');
  });

  it('a 5xx -> bouncie_down (their outage, wait and retry)', async () => {
    exchangeCodeForTokens.mockRejectedValue(new BouncieAuthError('Bouncie token endpoint returned 503.'));
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE }, STATE)))).toBe('bouncie_down');
  });

  it('a network failure -> bouncie_unreachable', async () => {
    exchangeCodeForTokens.mockRejectedValue(new TypeError('fetch failed'));
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE }, STATE)))).toBe('bouncie_unreachable');
  });

  it('a missing encryption key -> no_encryption_key, before the code is spent', async () => {
    exchangeCodeForTokens.mockRejectedValue(
      new BouncieAuthError('TOKEN_ENCRYPTION_KEY is not configured; refusing to spend the authorization code.'),
    );
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE }, STATE)))).toBe('no_encryption_key');
  });

  it('anything else -> failed, the honest fallback', async () => {
    exchangeCodeForTokens.mockRejectedValue(new BouncieAuthError('something new'));
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE }, STATE)))).toBe('failed');
  });
});

describe('the gate before any exchange', () => {
  it('denied consent -> denied, nothing exchanged', async () => {
    expect(statusOf(await GET(makeReq({ error: 'access_denied' })))).toBe('denied');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('a state mismatch -> bad_state, nothing exchanged (the CSRF check)', async () => {
    expect(statusOf(await GET(makeReq({ code: 'c', state: 'forged' }, STATE)))).toBe('bad_state');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });

  it('a missing cookie -> bad_state, nothing exchanged', async () => {
    expect(statusOf(await GET(makeReq({ code: 'c', state: STATE })))).toBe('bad_state');
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
  });
});
