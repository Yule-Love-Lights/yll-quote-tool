// Tests for the #161 redirect-capture diagnostic probe. Covers: JSON + form
// body parsing, the names-only headline log (never values), malformed-body
// safety (still 200), order-ref → quote-id recovery via the `bal_<quoteId>`
// convention (302), and the no-supabase-import guarantee (nothing is stored).
//
// NOTE (deviation from the build brief): the brief's test list asked for a
// "GET with recoverable dep_<uuid> order ref". There is NO `dep_` prefix
// anywhere in this codebase — grepped clean. The only order-ref convention
// that embeds a quote id directly (no DB lookup) is the balance pay-link's
// `bal_<quoteId>` (src/app/api/integrations/valor/webhook/route.ts,
// src/app/api/quotes/[id]/pay-balance/route.ts). Deposit order refs are a
// random `q<hex>` (src/app/api/quotes/[id]/pay/route.ts) with no embedded id;
// recovering THOSE needs the `valor_order_ref` DB lookup the real webhook
// does, which this diagnostic probe intentionally never performs (no supabase
// import — see the last test below). So this test exercises `bal_<uuid>`
// instead of the brief's `dep_<uuid>`, matching the route's real behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextRequest } from 'next/server';

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

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
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

describe('GET /api/integrations/valor/redirect-capture — human-browser leg', () => {
  it('redirects to the portal approved page when a bal_<uuid> order ref is recoverable via the query string', async () => {
    const uuid = '11111111-2222-4333-8444-555555555555';
    const res = await GET(
      req({ url: `https://quote.example.com/api/integrations/valor/redirect-capture?invoicenumber=bal_${uuid}` }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://quote.example.com/portal/${uuid}/approved?confirming=1`);
  });

  it('redirects to the portal approved page when a bal_<uuid> order ref is recoverable via a JSON body', async () => {
    const uuid = '22222222-3333-4444-8888-666666666666';
    const body = JSON.stringify({ data: { invoice_no: `bal_${uuid}`, response_code: '00' } });
    const res = await GET(req({ body, headers: { 'content-type': 'application/json' } }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://quote.example.com/portal/${uuid}/approved?confirming=1`);
  });

  it('redirects to / when no order ref is recoverable', async () => {
    const res = await GET(req({}));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://quote.example.com/');
  });

  it('redirects to / for an unrecoverable (non-bal_) order ref, e.g. a deposit q<hex> ref (no DB lookup performed)', async () => {
    const res = await GET(
      req({ url: 'https://quote.example.com/api/integrations/valor/redirect-capture?invoicenumber=qaf7affe2379dfd8a' }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://quote.example.com/');
  });

  it('a POST that prefers text/html (a browser-style Accept) is also treated as the human leg', async () => {
    const uuid = '33333333-4444-5555-9999-777777777777';
    const body = JSON.stringify({ order_id: `bal_${uuid}`, response_code: '00' });
    const res = await POST(
      req({ body, headers: { 'content-type': 'application/json', accept: 'text/html,application/xhtml+xml' } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://quote.example.com/portal/${uuid}/approved?confirming=1`);
  });
});

describe('module hygiene', () => {
  it('never imports supabase — this diagnostic probe stores nothing', () => {
    // Check IMPORT statements only (not comments — the route header + inline
    // comments legitimately explain WHY supabase is deliberately not imported).
    const routePath = fileURLToPath(new URL('./route.ts', import.meta.url));
    const source = readFileSync(routePath, 'utf8');
    const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(importLines.length).toBeGreaterThan(0); // sanity: the file does have imports
    expect(importLines.some((l) => /supabase/i.test(l))).toBe(false);
  });
});
