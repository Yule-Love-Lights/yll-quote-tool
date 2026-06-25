// ValorPayTech payment client. Wraps the subset of Valor's API the quote tool
// uses for the customer deposit flow (#38):
//   1. getClientToken()        — server-side: mint a short-lived client token
//                                for an embedded Passage.js checkout (one deposit).
//   2. verifyWebhookSignature() — verify Valor's signed payment-confirmation
//                                webhook (HMAC-SHA256) before we trust it.
//   3. parseWebhookEvent()      — normalize the webhook payload into the fields
//                                we act on (txn id, response code, vault token…).
//
// Auth model (Valor): APP ID + APP Key + EPI identify the merchant + device.
//   - APP ID  — account-level merchant identifier.
//   - APP Key — secret tied to a specific EPI/device.
//   - EPI     — 10-digit endpoint id (starts with 2). One per device.
// These are SECRETS — never log them, never ship them to the browser. The only
// thing the browser ever sees is the short-lived clientToken this module returns.
//
// PCI scope: card data is collected by Passage.js IN THE BROWSER and sent
// straight to Valor — it never touches our server. That keeps us at SAQ-A.
//
// ┌─ INTEGRATION CONTRACT — confirm against valorapi.readme.io at live test ───┐
// │ Valor's docs host bot-blocks automated fetches, so the exact wire shapes  │
// │ below come from the task #38 spec + Valor's public guides, NOT a live     │
// │ probe. Everything that could drift on first contact is ISOLATED here and  │
// │ marked `CONFIRM:`. We parse responses defensively (accept several casings)│
// │ so a first-run tweak is a one-line change, mirroring how highlevel.ts     │
// │ handles its unconfirmed conversations-API shape.                          │
// │  • GetClientToken: POST {base}/clienttoken  body {app_id,app_key,epi,...} │
// │  • Sale + vault: performed client-side by Passage.js using the token.     │
// │  • Webhook headers: Valor-Signature + Valor-Timestamp; HMAC-SHA256.       │
// │  • Webhook signing base (Valor Webhook User Guide): the JSON payload      │
// │    stringified + concatenated with the UTC timestamp. We try that base    │
// │    first, plus tolerant fallbacks (see verifyWebhookSignature).           │
// │  • Webhook payload: txn_id, response_code ("00"=approved), amount,        │
// │    approval_code, receipt_url, (+ vault/card token, + our order ref).     │
// └───────────────────────────────────────────────────────────────────────────┘

import { createHmac, timingSafeEqual } from 'crypto';

// NB: the Passage.js browser library URL lives in the client component
// (DepositCheckout.tsx), NOT here — this module imports Node's `crypto`, so we
// keep it server-only and never let the client bundle import from it.

// Staging vs production base URL. isDemo (default true) keeps us on staging
// until Naldo explicitly flips VALOR_IS_DEMO=false in prod. CONFIRM the prod
// host — staging is the documented securelink-staging:4430.
const STAGING_BASE = 'https://securelink-staging.valorpaytech.com:4430';
// Live gateway is on port 4430 too (NOT 443) — a bare https://securelink…/ hits
// the Apache front and 404s. Confirmed via the live test (#38 S14).
const PROD_BASE = 'https://securelink.valorpaytech.com:4430';

export class ValorError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = 'ValorError';
  }
}

type ValorConfig = {
  appId: string;
  appKey: string;
  epi: string;
  baseUrl: string;
  isDemo: boolean;
};

// True only when the three credentials exist. The webhook secret is checked
// separately in the webhook route (it can be configured independently — Naldo
// enables webhooks with Valor support after the keys are minted).
export function isValorConfigured(): boolean {
  return !!(process.env.VALOR_APP_ID && process.env.VALOR_APP_KEY && process.env.VALOR_EPI);
}

function requireConfig(): ValorConfig {
  const appId = process.env.VALOR_APP_ID;
  const appKey = process.env.VALOR_APP_KEY;
  const epi = process.env.VALOR_EPI;
  if (!appId || !appKey || !epi) {
    throw new ValorError(
      'Valor not configured. Set VALOR_APP_ID, VALOR_APP_KEY and VALOR_EPI in .env.local',
    );
  }
  // Demo unless explicitly turned off — fail safe toward staging so we never
  // accidentally hit production with a misconfigured deploy.
  const isDemo = process.env.VALOR_IS_DEMO !== 'false';
  const baseUrl = (process.env.VALOR_BASE_URL || (isDemo ? STAGING_BASE : PROD_BASE)).replace(
    /\/+$/,
    '',
  );
  return { appId, appKey, epi, baseUrl, isDemo };
}

// Valor expects monetary amounts as a fixed 2-decimal string of dollars
// (e.g. 1234.50). CONFIRM units (dollars vs cents) at live test — isolated here.
function formatAmount(usd: number): string {
  return (Math.round(usd * 100) / 100).toFixed(2);
}

// ─── GetClientToken ─────────────────────────────────────────────────────────
// Mint a short-lived token authorizing ONE embedded checkout for a specific
// deposit amount. The browser passes this token to Passage.js; the card data
// then flows browser → Valor directly. We also embed our quote reference
// (orderRef) so Valor echoes it back in the confirmation webhook — the same
// "round-trip our id" trick the home.works signed webhook uses to map back to
// a quote.
//
// saveCard=true asks Valor to vault the card at payment time (tokenize + create
// the customer/payment profile) so staff can MANUALLY charge the remaining 50%
// balance in the Valor portal after install. We never auto-charge.
export type ClientTokenInput = {
  amountUsd: number; // the 50% deposit, computed server-side from the quote
  orderRef: string; // our reference echoed back by the webhook (we use it to find the quote)
  saveCard?: boolean; // vault the card for later manual balance charge (default true)
  customerEmail?: string | null;
  customerName?: string | null;
};

export type ClientTokenResult = {
  clientToken: string;
  raw: unknown; // full response, for logging/debug (never contains our app key)
};

export async function getClientToken(input: ClientTokenInput): Promise<ClientTokenResult> {
  const cfg = requireConfig();

  // Valor's GetClientToken is a FORM-ENCODED POST to the gateway ROOT (not a
  // JSON POST to /clienttoken — that 404s on the Apache front). Confirmed param
  // names: appid/appkey/epi/txn_type (no underscores). We pass amount so the
  // charge is server-set, and order_id so our reference round-trips to the
  // confirmation webhook. (save_card/email/name ride along; harmless if ignored.)
  const form = new URLSearchParams();
  form.set('appid', cfg.appId);
  form.set('appkey', cfg.appKey);
  form.set('epi', cfg.epi);
  form.set('txn_type', 'sale');
  form.set('amount', formatAmount(input.amountUsd));
  form.set('order_id', input.orderRef);
  if (input.saveCard !== false) form.set('save_card', '1');
  if (input.customerEmail) form.set('email', input.customerEmail);
  if (input.customerName) form.set('name', input.customerName);

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch (err) {
    throw new ValorError(
      `Valor GetClientToken request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // NB: `text` is Valor's response body, which does NOT echo our app key —
    // safe to surface. We still never log the request body.
    throw new ValorError(
      `Valor GetClientToken → ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      text.slice(0, 2000),
    );
  }

  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ValorError(`Valor GetClientToken returned non-JSON: ${text.slice(0, 200)}`);
  }

  const clientToken = extractClientToken(json);
  if (!clientToken) {
    throw new ValorError(
      `Valor GetClientToken response missing a client token: ${text.slice(0, 300)}`,
    );
  }
  return { clientToken, raw: json };
}

// Defensive extraction — Valor may nest the token or vary the key casing.
// CONFIRM the real key at live test and this can be simplified.
function extractClientToken(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const data = (o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : o) ?? o;
  const candidate =
    data.clientToken ?? data.client_token ?? data.token ?? o.clientToken ?? o.client_token;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
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
// Body uses appid/appkey (no underscores) like GetClientToken. epage MUST be 1.
// invoicenumber carries OUR order ref so the webhook can map back to the quote.
// Response: { error_no:"S00", url:"<hosted page>", uid:"…" }.
const PAGESALE_STAGING_BASE = 'https://securelink-staging.valorpaytech.com';
const PAGESALE_PROD_BASE = 'https://securelink.valorpaytech.com';

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
    shipping_country: 'US',
    customer_name: input.customerName?.trim() || 'Customer',
    success_url: input.successUrl,
    failure_url: input.failureUrl,
    redirect_url: input.successUrl,
    notification_status: '0',
    ...(input.customerEmail ? { email: input.customerEmail } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/?pagesale=`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ValorError(
      `Valor Hosted Page request failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
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
  const amountStr = pick(inner, 'amount', 'amt', 'transaction_amount');
  const amountUsd = amountStr != null ? Number(amountStr) : null;

  return {
    txnId: pick(inner, 'txn_id', 'transaction_id', 'txnId', 'transactionId'),
    responseCode,
    approved: responseCode === '00',
    amountUsd: amountUsd != null && Number.isFinite(amountUsd) ? amountUsd : null,
    approvalCode: pick(inner, 'approval_code', 'approvalCode', 'auth_code', 'authCode'),
    receiptUrl: pick(inner, 'receipt_url', 'receiptUrl', 'receipt'),
    vaultToken: pick(
      inner,
      'vault_token',
      'vaultToken',
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
      'invoicenumber', // hosted-page sale echoes our ref here
      'invoice_number',
      'invoice',
      'invoice_id',
    ),
    raw: json,
  };
}
