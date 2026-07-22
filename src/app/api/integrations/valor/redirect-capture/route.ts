// #161 DIAGNOSTIC PROBE — Valor support (Fadil Cox, 2026-07-22) answered our
// card-on-file question: "Set the redirect_url key value to your webhook
// endpoint. This will allow for a server to server call upon payment
// completion that does contain the payment token." That's a DIFFERENT channel
// than the confirmation webhook (src/app/api/integrations/valor/webhook/route.ts)
// we already verify + act on — and we don't yet know:
//   (a) the S2S payload shape / field names,
//   (b) whether it's signed (Valor-Signature/Valor-Timestamp?),
//   (c) whether the customer's own BROWSER also follows redirect_url (vs
//       success_url) — if it does, a real customer could land on this API
//       endpoint mid-checkout.
// So this route is a SAFE DIAGNOSTIC PROBE ONLY: it is armed by setting
// VALOR_REDIRECT_CAPTURE_URL (see createHostedPageSale in
// src/lib/integrations/valor.ts, which points `redirect_url` here when that
// env var is set), NEVER logs field VALUES (key NAMES only — mirrors the
// #159/#609 key-dump convention in the webhook route above; read that route
// first), and STORES NOTHING (no supabase import, no DB reads or writes) until
// the channel's real shape + signing are confirmed against a live payment.
//
// GET  — the human-browser leg, if Valor's hosted page also follows
//        redirect_url for the customer (unconfirmed — see (c) above). Human
//        requests (GET, or any request whose Accept prefers text/html) always
//        get a 302: to the portal's confirming-payment page when an order ref
//        is recoverable, else to `/`. Never a raw JSON/error response — a real
//        customer's browser must never see this as a dead end.
// POST — the presumed S2S leg. Logs the diagnostic headline (see below) and
//        acknowledges 200 `{ ok: true }`. Never errors the caller.
//
// Order-ref → quote-id recovery reuses parseWebhookEvent's nested-shape-aware
// pick-list (same function the real webhook uses) but can ONLY resolve a quote
// id from the `bal_<quoteId>` balance-pay-link convention (the ref embeds the
// id directly — see the webhook route's balance branch). Deposit order refs are
// a random `q<hex>` (src/app/api/quotes/[id]/pay/route.ts) with NO embedded
// quote id; mapping those back needs the `valor_order_ref` DB lookup the real
// webhook performs, which this diagnostic probe deliberately never does (no
// supabase import, nothing stored). A deposit-flow redirect therefore falls
// back to `/` until we know more.
import { NextRequest, NextResponse } from 'next/server';
import { parseWebhookEvent } from '@/lib/integrations/valor';

export const runtime = 'nodejs';

// Card/token candidate field names (mirrors valor.ts parseWebhookEvent's
// vaultToken pick-list + Valor's documented `vtToken`, #161/#609) — presence
// only, NEVER the value, is logged.
const TOKEN_CANDIDATE_KEYS = [
  'token',
  'vtToken',
  'vt_token',
  'payment_token',
  'card_token',
  'vault_id',
  'payment_id',
];
// Order-ref candidate field names called out in the #161 diagnostic spec —
// presence only is logged (the actual recovery below reuses parseWebhookEvent's
// fuller pick-list, imported rather than duplicated).
const ORDER_REF_CANDIDATE_KEYS = ['invoicenumber', 'invoice_no', 'orderid'];

// The ONLY order-ref shape that embeds a quote id directly (no DB lookup) —
// exact match to the webhook route's balance-pay-link regex.
const BAL_ORDER_REF_RE = /^bal_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const MAX_KEYS = 200;
const MAX_DEPTH = 6;

type ParsedBody =
  | { kind: 'empty' }
  | { kind: 'json'; obj: Record<string, unknown> }
  | { kind: 'form'; obj: Record<string, string> }
  | { kind: 'opaque' };

// Parse the raw body ONCE: JSON first (regardless of declared content-type —
// Valor may mislabel it), then form-encoded, else treat it as opaque. Never
// throws — an unparseable body just yields `{ kind: 'opaque' }`.
function parseRawBody(rawBody: string, contentType: string | null): ParsedBody {
  const trimmed = rawBody.trim();
  if (!trimmed) return { kind: 'empty' };

  try {
    const j: unknown = JSON.parse(trimmed);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      return { kind: 'json', obj: j as Record<string, unknown> };
    }
  } catch {
    /* not JSON — fall through to form-encoded */
  }

  const looksFormEncoded =
    (contentType || '').toLowerCase().includes('form-urlencoded') || /^[^&=?]+=.*/.test(trimmed);
  if (looksFormEncoded) {
    try {
      const usp = new URLSearchParams(trimmed);
      const obj: Record<string, string> = {};
      let any = false;
      for (const [k, v] of usp.entries()) {
        obj[k] = v;
        any = true;
      }
      if (any) return { kind: 'form', obj };
    } catch {
      /* fall through to opaque */
    }
  }

  return { kind: 'opaque' };
}

// Dot-path key NAMES only, at any nesting depth — never values. Capped so a
// pathological payload can't blow up the log line.
function nestedKeyNames(value: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= MAX_KEYS || depth > MAX_DEPTH || value === null || typeof value !== 'object') {
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length > 0) nestedKeyNames(value[0], `${prefix}[]`, depth + 1, out);
    return out;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (out.length >= MAX_KEYS) break;
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    nestedKeyNames((value as Record<string, unknown>)[k], path, depth + 1, out);
  }
  return out;
}

// Boolean-only presence check for a candidate key set, at any nesting depth.
function hasKeyDeep(value: unknown, candidatesLower: Set<string>, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasKeyDeep(item, candidatesLower, depth + 1));
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (candidatesLower.has(k.toLowerCase())) return true;
    if (hasKeyDeep((value as Record<string, unknown>)[k], candidatesLower, depth + 1)) return true;
  }
  return false;
}

// Header NAMES only (never values — auth headers, signatures, etc. never get
// logged). Defensive: an unexpected `headers` shape must never break the probe.
function headerNames(headers: Headers): string[] {
  const names: string[] = [];
  try {
    headers.forEach((_v, k) => names.push(k));
  } catch {
    /* defensive only */
  }
  return names;
}

// Recover a quote id ONLY via the `bal_<quoteId>` convention — see the
// file-header note on why the deposit `q<hex>` ref can't be resolved here.
function recoverQuoteId(orderRef: string | null): string | null {
  if (!orderRef) return null;
  const m = BAL_ORDER_REF_RE.exec(orderRef);
  return m ? m[1]! : null;
}

async function handle(req: NextRequest, method: 'GET' | 'POST'): Promise<NextResponse> {
  let accept = '';
  try {
    accept = req.headers.get('accept') || '';
  } catch {
    /* defensive only */
  }
  // Human-browser leg: always GET, or any request that prefers HTML. Decided
  // BEFORE the risky parsing below so the catch-all can still redirect a real
  // customer instead of erroring them.
  const isHuman = method === 'GET' || accept.toLowerCase().includes('text/html');

  try {
    const rawBody = await req.text().catch(() => '');
    const contentType = req.headers.get('content-type');

    const queryObj: Record<string, string> = {};
    try {
      req.nextUrl.searchParams.forEach((v, k) => {
        queryObj[k] = v;
      });
    } catch {
      /* defensive only */
    }
    const hasQuery = Object.keys(queryObj).length > 0;

    const parsed = parseRawBody(rawBody, contentType);
    const bodyObj = parsed.kind === 'json' || parsed.kind === 'form' ? parsed.obj : null;

    // Diagnostics look at BOTH the URL query (a browser GET redirect likely
    // carries data there, not in a body) and whatever body we could parse —
    // we don't yet know which channel Valor actually uses.
    const candidateTokenKeys = new Set(TOKEN_CANDIDATE_KEYS.map((k) => k.toLowerCase()));
    const candidateOrderRefKeys = new Set(ORDER_REF_CANDIDATE_KEYS.map((k) => k.toLowerCase()));
    const hasTokenCandidate =
      (hasQuery && hasKeyDeep(queryObj, candidateTokenKeys)) || (!!bodyObj && hasKeyDeep(bodyObj, candidateTokenKeys));
    const hasOrderRefCandidate =
      (hasQuery && hasKeyDeep(queryObj, candidateOrderRefKeys)) ||
      (!!bodyObj && hasKeyDeep(bodyObj, candidateOrderRefKeys));

    const keys: string[] = [];
    if (hasQuery) for (const k of Object.keys(queryObj)) keys.push(`query.${k}`);
    if (bodyObj) nestedKeyNames(bodyObj, '', 0, keys);

    // ONE headline line — key NAMES + booleans only, NEVER values.
    console.log(
      `[valor/redirect-capture] hit: ${JSON.stringify({
        method,
        contentType,
        headers: headerNames(req.headers),
        hasTokenCandidate,
        hasOrderRefCandidate,
        parse: parsed.kind === 'opaque' ? 'parse-failed' : parsed.kind,
        keys,
      })}`,
    );

    // Recover the order ref the SAME way the real webhook does — reuse
    // parseWebhookEvent (not a re-implemented pick-list) against the body
    // first, then the URL query, then map it to a quote id via the `bal_`
    // convention only (recoverQuoteId).
    let orderRef: string | null = rawBody.trim() ? parseWebhookEvent(rawBody).orderRef : null;
    if (!orderRef && hasQuery) orderRef = parseWebhookEvent(JSON.stringify(queryObj)).orderRef;
    const quoteId = recoverQuoteId(orderRef);

    if (isHuman) {
      const target = quoteId ? `/portal/${quoteId}/approved?confirming=1` : '/';
      return NextResponse.redirect(new URL(target, req.nextUrl.origin), 302);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Belt-and-suspenders — this probe must NEVER error the caller. A thrown
    // exception here would otherwise 500 an S2S call (Valor might retry) or,
    // worse, strand a real customer's browser mid-checkout.
    console.error(
      '[valor/redirect-capture] unexpected error (still acking):',
      err instanceof Error ? err.message : 'unknown error',
    );
    if (isHuman) {
      return NextResponse.redirect(new URL('/', req.nextUrl.origin), 302);
    }
    return NextResponse.json({ ok: true });
  }
}

export async function GET(req: NextRequest) {
  return handle(req, 'GET');
}

export async function POST(req: NextRequest) {
  return handle(req, 'POST');
}
