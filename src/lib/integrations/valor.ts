// ValorPayTech payment client. Wraps the subset of Valor's API the quote tool
// uses for the customer deposit flow (#38) — the HOSTED-PAGE surface:
//   1. createHostedPageSale()   — ask Valor for a hosted payment page (ePage)
//                                and redirect the customer there; the card is
//                                collected on Valor's own page (SAQ-A).
//   2. verifyWebhookSignature() — verify Valor's signed payment-confirmation
//                                webhook (HMAC-SHA256) before we trust it.
//   3. parseWebhookEvent()      — normalize the webhook payload into the fields
//                                we act on (txn id, response code, vault token…).
// (The earlier Passage.js embedded-token path — getClientToken — was removed
//  once the flow moved to the hosted page; see git history if it's ever revived.)
//
// Auth model (Valor): APP ID + APP Key + EPI identify the merchant + device.
//   - APP ID  — account-level merchant identifier.
//   - APP Key — secret tied to a specific EPI/device.
//   - EPI     — 10-digit endpoint id (starts with 2). One per device.
// These are SECRETS — never log them, never ship them to the browser.
//
// PCI scope: card data is collected on Valor's HOSTED page and sent straight to
// Valor — it never touches our server. That keeps us at SAQ-A.
//
// ┌─ INTEGRATION CONTRACT — confirm against valorapi.readme.io at live test ───┐
// │ Valor's docs host bot-blocks automated fetches, so the exact wire shapes  │
// │ below come from the task #38 spec + Valor's public guides, NOT a live     │
// │ probe. Everything that could drift on first contact is ISOLATED here and  │
// │ marked `CONFIRM:`. We parse responses defensively (accept several casings)│
// │ so a first-run tweak is a one-line change, mirroring how highlevel.ts     │
// │ handles its unconfirmed conversations-API shape.                          │
// │  • Hosted Page Sale: POST {host}/?pagesale= body {appid,appkey,epi,...}.  │
// │  • Webhook headers: Valor-Signature + Valor-Timestamp; HMAC-SHA256.       │
// │  • Webhook signing base (Valor Webhook User Guide): the JSON payload      │
// │    stringified + concatenated with the UTC timestamp. We try that base    │
// │    first, plus tolerant fallbacks (see verifyWebhookSignature).           │
// │  • Webhook payload: txn_id, response_code ("00"=approved), amount,        │
// │    approval_code, receipt_url, (+ vault/card token, + our order ref).     │
// └───────────────────────────────────────────────────────────────────────────┘

import { createHmac, timingSafeEqual } from 'crypto';

// NB: card data is collected on Valor's HOSTED page (SAQ-A) — it never touches
// our server. This module imports Node's `crypto` (webhook HMAC), so it stays
// server-only and the client bundle must never import from it.

export class ValorError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'ValorError';
  }
}

// True only when the three credentials exist. The webhook secret is checked
// separately in the webhook route (it can be configured independently — Naldo
// enables webhooks with Valor support after the keys are minted).
export function isValorConfigured(): boolean {
  return !!(process.env.VALOR_APP_ID && process.env.VALOR_APP_KEY && process.env.VALOR_EPI);
}

// ─── Hosted Page Sale (ePage) ───────────────────────────────────────────────
// The chosen integration (#38): instead of embedding card fields, we ask Valor
// for a HOSTED payment page and redirect the customer there. The card is
// collected on Valor's own page — it NEVER touches our server (SAQ-A), no token
// handoff, no Passage.js. Valor returns the customer to success_url/failure_url
// and fires the confirmation webhook (which is what actually books the quote).
//
// Endpoint (confirmed from the Hosted Page Sale docs): POST a JSON body to
//   {host}/?pagesale=         on the DEFAULT https port (:443) — NOT :4430.
// Body uses appid/appkey (no underscores). epage MUST be 1. invoicenumber carries
// OUR order ref so the webhook can map back to the quote.
// Response: { error_no:"S00", url:"<hosted page>", uid:"…" }.
const PAGESALE_STAGING_BASE = 'https://securelink-staging.valorpaytech.com';
const PAGESALE_PROD_BASE = 'https://securelink.valorpaytech.com';

// Hard ceiling on the outbound Valor call (mirrors googleMaps.ts #80-018). This
// fetch is awaited inline in the customer-facing /pay + /pay-balance routes, so a
// hung Valor gateway would otherwise pin the customer's Pay click and bill
// serverless duration until the platform kills the function.
const HOSTED_PAGE_TIMEOUT_MS = 10_000;

export type HostedPageInput = {
  amountUsd: number; // the 50% deposit, computed server-side from the snapshot
  orderRef: string; // our reference → invoicenumber → echoed by the webhook
  successUrl: string; // Valor redirects here after a successful payment
  failureUrl: string; // …and here on failure/cancel
  customerName?: string | null;
  customerEmail?: string | null;
  orderDescription?: string;
};

export type HostedPageResult = {
  url: string; // the Valor-hosted payment page to redirect the customer to
  uid: string | null;
  raw: unknown;
};

export async function createHostedPageSale(input: HostedPageInput): Promise<HostedPageResult> {
  const appId = process.env.VALOR_APP_ID;
  const appKey = process.env.VALOR_APP_KEY;
  const epi = process.env.VALOR_EPI;
  if (!appId || !appKey || !epi) {
    throw new ValorError('Valor not configured. Set VALOR_APP_ID, VALOR_APP_KEY and VALOR_EPI');
  }
  const isDemo = process.env.VALOR_IS_DEMO !== 'false';
  const base = (
    process.env.VALOR_PAGESALE_BASE_URL || (isDemo ? PAGESALE_STAGING_BASE : PAGESALE_PROD_BASE)
  ).replace(/\/+$/, '');
  // #161 (2026-07-22): armed only when set — see the comment above
  // `shipping_country` below for the full context on why this exists. When a
  // capture URL is set we ALSO read VALOR_REDIRECT_CAPTURE_SECRET and, if set,
  // append it as a `s` query param — this channel is UNSIGNED (confirmed live,
  // see below), so the secret embedded in the URL we hand Valor is how we
  // self-authenticate the callback. The secret itself is NEVER logged.
  const redirectCaptureUrlBase = process.env.VALOR_REDIRECT_CAPTURE_URL?.trim() || null;
  const redirectCaptureSecret = process.env.VALOR_REDIRECT_CAPTURE_SECRET?.trim() || null;
  const redirectCaptureUrl =
    redirectCaptureUrlBase && redirectCaptureSecret
      ? `${redirectCaptureUrlBase}${redirectCaptureUrlBase.includes('?') ? '&' : '?'}s=${encodeURIComponent(redirectCaptureSecret)}`
      : redirectCaptureUrlBase;

  const body: Record<string, unknown> = {
    appid: appId,
    appkey: appKey,
    epi,
    txn_type: 'sale',
    amount: Math.round(input.amountUsd * 100) / 100, // dollars, 2dp (e.g. 551.91)
    invoicenumber: input.orderRef,
    orderdescription: (input.orderDescription || 'Yule Love Lights deposit').slice(0, 50),
    epage: 1, // hosted-page mode — must always be 1
    surcharge: 0,
    tax: 0,
    // 1 = charge EXACTLY `amount`; do NOT let Valor re-apply the merchant
    // portal's surcharge/tax on top. Our deposit already includes tax, so 0
    // (the default, "calculate fee from portal") double-charged tax + added a
    // card-difference surcharge — the customer must pay the deposit we showed.
    ignore_surcharge_calc: 1,
    // #161: `save_card: 1` was PROBED here to vault the card at deposit (for the
    // future #83 balance auto-charge) — but a live test (2026-07-17) confirmed
    // the HOSTED-PAGE product does NOT honor it: the card never landed in the
    // Valor Vault and the webhook returned no token. Reverted (a dead param).
    // Card-on-file needs a different path (the correct hosted-page param per
    // Valor support, or the separate valor-vault REST profile API) — see #161
    // in the ledger + docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md §1.
    // ▶ 2026-07-22 (Valor support, Fadil Cox): "Set the redirect_url key value
    // to your webhook endpoint. This will allow for a server to server call
    // upon payment completion that does contain the payment token." — i.e. the
    // hosted page vaults/echoes the token via a redirect_url S2S callback, NOT
    // via save_card.
    // ▶ CONFIRMED LIVE 2026-07-22: Valor's hosted page makes an UNSIGNED
    // server-to-server JSON POST to whatever redirect_url we send, with FLAT
    // payload keys — `token`, `invoicenumber` (echoes our order ref), `txnid`,
    // `uid`, `approval_code` are present. There is no signature header on this
    // channel (unlike the confirmation webhook), so redirect-capture
    // self-authenticates it via a secret embedded in the URL (see
    // VALOR_REDIRECT_CAPTURE_SECRET above) rather than trusting the call
    // outright. We still don't know whether the customer's own BROWSER also
    // follows redirect_url (vs success_url) — if it does, a customer could land
    // on our API endpoint mid-checkout, which is why the route still answers
    // every human leg with a 200 minimal branded "payment received" page
    // (#171e), never a redirect or a raw JSON/error response. Only when
    // VALOR_REDIRECT_CAPTURE_URL is set does redirect_url point at our capture
    // route (src/app/api/integrations/valor/redirect-capture/route.ts) instead
    // of success_url. See #161 in the ledger.
    shipping_country: 'US',
    customer_name: input.customerName?.trim() || 'Customer',
    success_url: input.successUrl,
    failure_url: input.failureUrl,
    redirect_url: redirectCaptureUrl || input.successUrl,
    notification_status: '0',
    ...(input.customerEmail ? { email: input.customerEmail } : {}),
  };

  // Hard timeout via AbortController (mirrors googleMaps.ts). On timeout we throw
  // a clear ValorError — the message never carries the request body, so the
  // appid/appkey secrets can't leak into logs. The existing catch in /pay +
  // /pay-balance maps a ValorError to a friendly 502, so a hung gateway fails fast.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOSTED_PAGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/?pagesale=`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ValorError(`Valor Hosted Page request timed out after ${HOSTED_PAGE_TIMEOUT_MS}ms`);
    }
    throw new ValorError(
      `Valor Hosted Page request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ValorError(
      `Valor Hosted Page → ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      text.slice(0, 2000),
    );
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ValorError(`Valor Hosted Page returned non-JSON: ${text.slice(0, 200)}`);
  }

  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const data = (o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : o) ?? o;
  const pageUrl =
    pickString(data.url) ??
    pickString(o.url) ??
    pickString(data.redirect_url) ??
    pickString(data.paymentUrl);
  if (!pageUrl) {
    // Body carries error_no/error_code when it fails — surface it (no secrets).
    throw new ValorError(`Valor Hosted Page response missing url: ${text.slice(0, 300)}`);
  }
  return { url: pageUrl, uid: pickString(data.uid) ?? pickString(o.uid), raw: json };
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ─── Webhook signature verification ─────────────────────────────────────────
// Valor signs each webhook with HMAC-SHA256 using the Secret Key generated when
// "Authentication" is enabled in Settings → WebHook. Headers:
//   Valor-Signature  — hex (or base64) HMAC digest
//   Valor-Timestamp  — UTC timestamp; bound the replay window
//
// We MUST verify before acting — an unverified webhook handler is an
// "anyone can mark any quote paid" hole. Per Valor's Webhook User Guide the
// signed value is the JSON payload concatenated with the UTC timestamp, so we
// try `${body}${ts}` FIRST, then a few tolerant fallbacks (reverse order,
// Stripe-style `${ts}.${body}`, body-only) and accept if any matches in
// constant time — so a first-contact convention mismatch can't block launch.
// CONFIRM the exact base + encoding at the live staging test, then drop extras.
export type WebhookVerifyInput = {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  secret: string;
  toleranceSec?: number; // default 300s replay window
};

export function verifyWebhookSignature(input: WebhookVerifyInput): boolean {
  const { rawBody, signature, timestamp, secret } = input;
  if (!signature || !secret) return false;

  // Replay protection — reject stale timestamps when one is provided AND it
  // parses as a numeric epoch. Valor docs say "UTC timestamp" without fixing
  // the units, so we accept seconds OR milliseconds; a non-numeric (e.g. ISO)
  // timestamp skips the window check rather than false-reject — the HMAC still
  // binds the timestamp into the signature either way.
  if (timestamp) {
    const raw = Number(timestamp);
    const tol = input.toleranceSec ?? 300;
    if (Number.isFinite(raw) && raw > 0) {
      const tsSec = raw > 1e12 ? raw / 1000 : raw; // ms → s when clearly ms
      const skew = Math.abs(Date.now() / 1000 - tsSec);
      if (skew > tol) return false;
    }
  }

  // Candidate signing bases (Valor's documented `payload + timestamp` first).
  const bases = timestamp
    ? [`${rawBody}${timestamp}`, `${timestamp}${rawBody}`, `${timestamp}.${rawBody}`, rawBody]
    : [rawBody];
  for (const base of bases) {
    const hmac = createHmac('sha256', secret).update(base, 'utf8').digest();
    if (signatureMatches(signature, hmac)) return true;
  }
  return false;
}

// Constant-time compare of the provided signature (hex or base64) against a
// computed digest. Length-mismatched buffers fail before timingSafeEqual
// (which throws on unequal lengths).
function signatureMatches(provided: string, computed: Buffer): boolean {
  const cleaned = provided.trim().replace(/^sha256=/i, '');
  for (const enc of ['hex', 'base64'] as const) {
    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(cleaned, enc);
    } catch {
      continue;
    }
    if (providedBuf.length === computed.length && timingSafeEqual(providedBuf, computed)) {
      return true;
    }
  }
  return false;
}

// ─── Webhook payload parsing ────────────────────────────────────────────────
// Normalize Valor's confirmation payload into the fields we persist + act on.
// Tolerant of key casing / nesting (CONFIRM exact names at live test).
export type ValorWebhookEvent = {
  txnId: string | null;
  responseCode: string | null; // "00" = approved
  approved: boolean;
  amountUsd: number | null;
  approvalCode: string | null;
  receiptUrl: string | null;
  vaultToken: string | null; // card-on-file token for later manual balance charge
  orderRef: string | null; // our quote reference, round-tripped
  raw: unknown;
};

function pick(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

export function parseWebhookEvent(rawBody: string): ValorWebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    json = {};
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  // Some gateways nest the transaction under `data`/`transaction`.
  const inner =
    o.data && typeof o.data === 'object'
      ? (o.data as Record<string, unknown>)
      : o.transaction && typeof o.transaction === 'object'
        ? (o.transaction as Record<string, unknown>)
        : o;

  const responseCode = pick(inner, 'response_code', 'responseCode', 'rcode');
  // Valor's confirmation webhook reports the amount in CENTS (minor units) —
  // CONFIRMED live 2026-07-17: a $5.44 deposit came back as data.amount "544",
  // which booked the quote at $544 (a 100× over-record + a "$544" customer SMS).
  // createHostedPageSale SENDS dollars (amount: 5.44); the webhook ECHOES cents.
  // Convert to dollars here so every consumer works in dollars — the deposit
  // stamp (recordedDeposit), the deposit-shortfall check, and the balance
  // underpayment (WT-15) all compare event.amountUsd against dollar amounts.
  const amountCentsStr = pick(inner, 'amount', 'amt', 'transaction_amount');
  const amountCents = amountCentsStr != null ? Number(amountCentsStr) : null;
  const amountUsd = amountCents != null && Number.isFinite(amountCents) ? amountCents / 100 : null;

  return {
    txnId: pick(inner, 'txn_id', 'transaction_id', 'txnId', 'transactionId'),
    responseCode,
    approved: responseCode === '00',
    amountUsd,
    approvalCode: pick(inner, 'approval_code', 'approvalCode', 'auth_code', 'authCode'),
    receiptUrl: pick(inner, 'receipt_url', 'receiptUrl', 'receipt'),
    vaultToken: pick(
      inner,
      'vault_token',
      'vaultToken',
      // #161 — Valor's OWN Webhook User Guide documents the TRANSACTION event's
      // card token as `vtToken` (e.g. "vtToken": "A1C7CA96…"), a name this
      // pick-list never included — the same missing-field class as #159's
      // `invoice_no`. `/?saleToken`'s token is described as "received from
      // sale", i.e. exactly this sale-echoed token, so catching it here may be
      // the whole card-on-file story: the webhook already stores
      // event.vaultToken → quotes.valor_vault_token when present.
      'vtToken',
      'vt_token',
      'card_token',
      'cardToken',
      'token',
      'customer_token',
    ),
    orderRef: pick(
      inner,
      'order_id',
      'orderId',
      'order_ref',
      'orderRef',
      // ✅ CONFIRMED live (#159, first real payment 2026-07-17): Valor's
      // E-Invoice confirmation webhook echoes our `invoicenumber` back as
      // `data.invoice_no` — NOT `invoicenumber`/`invoice_number`. Its absence
      // from this list is why a real hosted-page deposit charged but never
      // auto-booked (hasOrderRef:false → the webhook ignored a payment it owned).
      // Captured via the #159 diagnostic key-name log on the no-order-ref branch.
      'invoice_no',
      'invoicenumber', // hosted-page docs said our ref echoes here (kept as a fallback)
      'invoice_number',
      'invoice',
      'invoice_id',
    ),
    raw: json,
  };
}
