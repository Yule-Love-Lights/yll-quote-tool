// Tests for the #161 redirect-capture route. Covers: JSON + form body
// parsing, the names-only headline log (never values), malformed-body safety
// (still 200), the human-browser leg's friendly 200 page (#171e), the guarded
// token-persistence path (added once the channel was confirmed live
// 2026-07-22 — see route.ts), and the no-unconditional-supabase-construction
// guarantee.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';

// ── Supabase mock (hoisted) ──────────────────────────────────────────────
// Only the guarded-persistence tests below configure `sbRef.current` /
// inspect `getSupabaseServiceClient`'s call count; every other test in this
// file never authenticates, so the persistence path never reaches supabase
// at all and this mock sits idle for them.
const { sbRef, getSupabaseServiceClient } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getSupabaseServiceClient: vi.fn(() => sbRef.current),
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient,
  isSupabaseServiceConfigured: () => true,
}));

import { GET, POST } from './route';

function req(opts: {
  body?: string;
  headers?: Record<string, string>;
  url?: string;
}): NextRequest {
  const rawBody = opts.body ?? '';
  const url = new URL(opts.url ?? 'https://quote.example.com/api/integrations/valor/redirect-capture');
  return {
    text: async () => rawBody,
    headers: new Headers(opts.headers ?? {}),
    nextUrl: url,
  } as unknown as NextRequest;
}

// Fake Supabase query builder for the guarded-persistence tests: handles
//   read:   from().select().eq().single()             -> { data: quote, error }
//   write:  from().update().eq().is()                  -> { error } (awaited directly)
// Mirrors the shape of the real chain in route.ts's persistVaultToken.
function makeSb(
  quote: { id: string; valor_vault_token: string | null } | null,
  updateResult: { error: unknown } = { error: null },
) {
  const updateCalls: Array<{
    payload: Record<string, unknown>;
    eqCol?: string;
    eqVal?: unknown;
    isCol?: string;
    isVal?: unknown;
  }> = [];
  const builder: Record<string, unknown> = {
    from: () => builder,
    select: () => builder,
    eq: (col: string, val: unknown) => {
      if (updateCalls.length > 0) {
        const last = updateCalls[updateCalls.length - 1]!;
        last.eqCol = col;
        last.eqVal = val;
      }
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      updateCalls.push({ payload });
      return builder;
    },
    is: (col: string, val: unknown) => {
      if (updateCalls.length > 0) {
        const last = updateCalls[updateCalls.length - 1]!;
        last.isCol = col;
        last.isVal = val;
      }
      return Promise.resolve(updateResult);
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
  };
  return { builder, updateCalls };
}

// Finds the (single) log line containing `substr` among a console spy's
// captured calls — used by the guarded-persistence tests below to pick the
// ONE outcome line out of the (headline + outcome) log calls.
function findLogLine(spy: ReturnType<typeof vi.spyOn>, substr: string): string | undefined {
  return (spy.mock.calls as unknown[][])
    .map((c) => c[0])
    .find((l): l is string => typeof l === 'string' && l.includes(substr));
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  delete process.env.VALOR_REDIRECT_CAPTURE_SECRET;
  sbRef.current = null;
  getSupabaseServiceClient.mockClear();
});

describe('POST /api/integrations/valor/redirect-capture', () => {
  it('parses a JSON body with a nested token field, acks 200, and logs a names-only headline', async () => {
    const body = JSON.stringify({
      event: 'transaction',
      data: { txn_id: 'T1', response_code: '00', vtToken: 'SUPER-SECRET-TOKEN-VALUE' },
    });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toContain('[valor/redirect-capture] hit:');
    expect(line).toContain('"hasTokenCandidate":true');
    expect(line).toContain('data.vtToken');
    // Values must NEVER appear in the log line.
    expect(line).not.toContain('SUPER-SECRET-TOKEN-VALUE');
  });

  it('flags order-ref candidates present in the payload', async () => {
    const body = JSON.stringify({ invoicenumber: 'qsomeref', response_code: '00' });
    await POST(req({ body, headers: { 'content-type': 'application/json' } }));
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toContain('"hasOrderRefCandidate":true');
  });

  it('parses a form-encoded body', async () => {
    const body = 'txn_id=T2&response_code=00&vt_token=abc123';
    const res = await POST(
      req({ body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    expect(res.status).toBe(200);
    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toContain('"parse":"form"');
    expect(line).toContain('"hasTokenCandidate":true');
    expect(line).not.toContain('abc123');
  });

  it('a malformed (non-JSON, non-form) body still acks 200 and logs parse-failed + content-type only', async () => {
    const body = '\x00\x01 not json, not form, just noise ￿';
    const res = await POST(req({ body, headers: { 'content-type': 'application/octet-stream' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const line = logSpy.mock.calls[0]![0] as string;
    expect(line).toContain('"parse":"parse-failed"');
    expect(line).toContain('"contentType":"application/octet-stream"');
  });

  it('never errors the caller on a thrown parse path (still 200, opaque body)', async () => {
    // Even a body that superficially looks form-encoded but is garbage must
    // never surface as a 500 — the whole point of the probe is to never break
    // Valor's callback or a customer's browser.
    const res = await POST(req({ body: '===&&&===' }));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/integrations/valor/redirect-capture — human-browser leg (#171e)', () => {
  it('a GET (html Accept implied) gets a 200 friendly branded page, never a redirect', async () => {
    const res = await GET(req({}));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Payment received');
    expect(html).toContain('close this window');
  });

  it('the friendly page renders regardless of whether an order ref is present in the query', async () => {
    const res = await GET(
      req({ url: 'https://quote.example.com/api/integrations/valor/redirect-capture?invoicenumber=bal_11111111-2222-4333-8444-555555555555' }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Payment received');
  });

  it('a POST that prefers text/html (a browser-style Accept) is also treated as the human leg — 200 friendly page, not JSON', async () => {
    const body = JSON.stringify({ order_id: 'bal_33333333-4444-5555-9999-777777777777', response_code: '00' });
    const res = await POST(
      req({ body, headers: { 'content-type': 'application/json', accept: 'text/html,application/xhtml+xml' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Payment received');
  });

  it('a non-html POST (the real S2S leg) keeps the existing JSON ack byte-preserved', async () => {
    const res = await POST(
      req({ body: JSON.stringify({ response_code: '00' }), headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });
});

// #161 build-out (2026-07-22): the channel was confirmed live as an UNSIGNED
// S2S POST, so redirect-capture now guards a real persistence write behind a
// secret embedded in the capture URL (see valor.ts). These tests exercise
// that guard directly against the route handler, with supabase mocked.
describe('POST /api/integrations/valor/redirect-capture — guarded token persistence (#161)', () => {
  const AUTH_URL = 'https://quote.example.com/api/integrations/valor/redirect-capture?s=shh-secret';

  it('persists the token when authenticated, the order ref matches a quote, and no token is on file yet', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const { builder, updateCalls } = makeSb({ id: 'quote-1', valor_vault_token: null });
    sbRef.current = builder;

    const body = JSON.stringify({
      token: 'TOK-SUPER-SECRET-VALUE',
      invoicenumber: 'qref1',
      txnid: 'T1',
      uid: 'U1',
      approval_code: 'A1',
    });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' }, url: AUTH_URL }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getSupabaseServiceClient).toHaveBeenCalled();
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.payload).toEqual({ valor_vault_token: 'TOK-SUPER-SECRET-VALUE' });
    expect(updateCalls[0]!.eqCol).toBe('id');
    expect(updateCalls[0]!.eqVal).toBe('quote-1');
    expect(updateCalls[0]!.isCol).toBe('valor_vault_token');
    expect(updateCalls[0]!.isVal).toBeNull();

    const outcomeLine = findLogLine(logSpy, 'persisted');
    expect(outcomeLine).toBe('[valor/redirect-capture] token persisted for quote quote-1');

    // Token value + secret must NEVER appear in ANY console output.
    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('TOK-SUPER-SECRET-VALUE');
    expect(allOutput).not.toContain('shh-secret');
  });

  it('skips persistence when the quote already has a vault token on file (no update, no clobber)', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const { builder, updateCalls } = makeSb({ id: 'quote-2', valor_vault_token: 'EXISTING-TOKEN' });
    sbRef.current = builder;

    const body = JSON.stringify({ token: 'NEW-TOKEN', invoicenumber: 'qref2' });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' }, url: AUTH_URL }));

    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
    const outcomeLine = findLogLine(logSpy, 'already present');
    expect(outcomeLine).toBe('[valor/redirect-capture] token already present, skipped');
  });

  it('logs "no quote for order ref" and never updates when the lookup finds nothing', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const { builder, updateCalls } = makeSb(null);
    sbRef.current = builder;

    const body = JSON.stringify({ token: 'TOK', invoicenumber: 'qunknown' });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' }, url: AUTH_URL }));

    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(0);
    const outcomeLine = findLogLine(logSpy, 'no quote for order ref');
    expect(outcomeLine).toBe('[valor/redirect-capture] no quote for order ref');
  });

  it('a wrong `s` query param is log-only and never constructs a supabase client', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const body = JSON.stringify({ token: 'TOK', invoicenumber: 'qref3' });
    const res = await POST(
      req({
        body,
        headers: { 'content-type': 'application/json' },
        url: 'https://quote.example.com/api/integrations/valor/redirect-capture?s=WRONG-SECRET',
      }),
    );

    expect(res.status).toBe(200);
    expect(getSupabaseServiceClient).not.toHaveBeenCalled();
    const outcomeLine = findLogLine(logSpy, 'unauthenticated');
    expect(outcomeLine).toBe('[valor/redirect-capture] unauthenticated hit, log-only');
  });

  it('a missing `s` query param (secret armed) is log-only and never constructs a supabase client', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const body = JSON.stringify({ token: 'TOK', invoicenumber: 'qref4' });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' } })); // no `s` param

    expect(res.status).toBe(200);
    expect(getSupabaseServiceClient).not.toHaveBeenCalled();
    const outcomeLine = findLogLine(logSpy, 'unauthenticated');
    expect(outcomeLine).toBe('[valor/redirect-capture] unauthenticated hit, log-only');
  });

  it('secret env unset → log-only mode exactly as today, never constructs a supabase client', async () => {
    delete process.env.VALOR_REDIRECT_CAPTURE_SECRET;
    const body = JSON.stringify({ token: 'TOK', invoicenumber: 'qref5' });
    const res = await POST(
      req({
        body,
        headers: { 'content-type': 'application/json' },
        url: AUTH_URL, // even a well-formed `s` param is irrelevant when unarmed
      }),
    );

    expect(res.status).toBe(200);
    expect(getSupabaseServiceClient).not.toHaveBeenCalled();
    // No extra outcome line either — this is the SAME single headline log as
    // the original diagnostic-only probe (the "safe default").
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('a length-mismatched `s` param fails the constant-time compare safely (no throw) and is treated as unauthenticated', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'a-much-longer-secret-value-than-the-one-provided';
    const body = JSON.stringify({ token: 'TOK', invoicenumber: 'qref6' });
    const res = await POST(
      req({
        body,
        headers: { 'content-type': 'application/json' },
        url: 'https://quote.example.com/api/integrations/valor/redirect-capture?s=short',
      }),
    );

    expect(res.status).toBe(200);
    expect(getSupabaseServiceClient).not.toHaveBeenCalled();
    const outcomeLine = findLogLine(logSpy, 'unauthenticated');
    expect(outcomeLine).toBe('[valor/redirect-capture] unauthenticated hit, log-only');
  });

  it('a persistence failure (e.g. the update itself errors) is caught, logged without the token/secret, and still 200s', async () => {
    process.env.VALOR_REDIRECT_CAPTURE_SECRET = 'shh-secret';
    const { builder } = makeSb({ id: 'quote-7', valor_vault_token: null }, { error: { message: 'db is down' } });
    sbRef.current = builder;

    const body = JSON.stringify({ token: 'TOK-VALUE', invoicenumber: 'qref7' });
    const res = await POST(req({ body, headers: { 'content-type': 'application/json' }, url: AUTH_URL }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('persist failed: db is down'));

    const allOutput = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(allOutput).not.toContain('TOK-VALUE');
    expect(allOutput).not.toContain('shh-secret');
  });
});

describe('module hygiene', () => {
  it('has no unconditional top-level supabase import — the route only reads it inside the guarded persistence branch', () => {
    // Check top-level IMPORT statements only (not comments, and not the
    // `await import(...)` call inside persistVaultToken, which intentionally
    // does NOT start a line with the `import` keyword).
    const routePath = fileURLToPath(new URL('./route.ts', import.meta.url));
    const source = readFileSync(routePath, 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines.length).toBeGreaterThan(0); // sanity: the file does have imports
    expect(importLines.some((l) => /supabase/i.test(l))).toBe(false);
  });

  it('an unauthenticated hit never constructs a supabase client — the dynamic import is reached only inside the guard', async () => {
    // No VALOR_REDIRECT_CAPTURE_SECRET set — the default, un-armed state that
    // every OTHER test in this file (besides the guarded-persistence describe
    // above) runs under. Confirms the factory is genuinely never invoked, not
    // just untested, for the ordinary diagnostic-only path.
    const res = await POST(
      req({
        body: JSON.stringify({ event: 'transaction', data: { txn_id: 'T1', response_code: '00' } }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(getSupabaseServiceClient).not.toHaveBeenCalled();
  });
});
