// Balance auto-charge (ledger #83). The "Charge remaining balance" operator
// action collects an invoice's balance by charging the card saved at deposit
// (quotes.valor_vault_token) via Valor's Tokenized Sale API
// (POST {securelink…}/?saleToken), auth'd with the appid/appkey/epi we already
// hold. See docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md for the contract.
//
// CONFIRMED LIVE 2026-07-22 (scripts/valor-token-reuse-test.ts — a real $1 test
// charge, approved + voided): POST {base}/?saleToken with appid/appkey/epi +
// txn_type 'sale' + amount (dollars, 2dp) + surcharge 0 + ignore_surcharge_calc 1
// + shipping_country 'US' (mandatory — 400 D12 "SHIPPING COUNTRY MANDATORY"
// without it) + surchargeIndicator (mandatory for our cash-discount EPI — E98/V3
// "EPI host processor info not found" without it) + token → HTTP 200 FLAT JSON
// { error_no:"S00", error_code:"00", msg:"APPROVED", approval_code, txnid, rrn,
// amount, netamt, card_brand, token, … } — no receipt_url key was observed, no
// nested `data` wrapper. Still gated behind VALOR_AUTO_CHARGE_ENABLED (flip in
// Vercel ONLY once the ledger's remaining go-live checklist passes — same
// discipline as the #38 deposit go-live): flipping the flag is what turns this
// from "wired" to "live", not this file.

export type ChargeBalanceInput = {
  vaultToken: string | null; // quotes.valor_vault_token — the card on file
  amountUsd: number; // the invoice balance to collect
  orderRef: string; // our reference, round-tripped by the webhook (→ invoicenumber)
  taxUsd?: number;
  customerName?: string | null;
  customerEmail?: string | null;
};

export type ChargeBalanceResult =
  // chargedUsd = the amount Valor ACTUALLY captured (parse from the S00 response),
  // NOT the requested amount. null when Valor returns no amount. The caller MUST
  // refuse to settle when it's null or short of the balance (a partial auth would
  // otherwise under-bill + mark the invoice paid-in-full) — mirrors the balance
  // webhook's short-settle guard.
  | { ok: true; chargedUsd: number | null; txnId: string | null; approvalCode: string | null; receiptUrl: string | null; raw: unknown }
  | { ok: false; reason: 'not-enabled' | 'no-card' | 'declined' | 'error'; message?: string };

// Single flag gate. OFF by default — flip in Vercel ONLY after the remaining
// go-live checklist in the handoff doc passes (same discipline as the #38
// deposit go-live). Tolerant parsing like valor.ts / valorVault.ts.
export function isAutoChargeEnabled(): boolean {
  const v = process.env.VALOR_AUTO_CHARGE_ENABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

// Same base-resolution createHostedPageSale uses (valor.ts) — mirrored rather
// than imported since valor.ts doesn't export its constants. `?saleToken` is a
// DIFFERENT query surface than `?pagesale=` but lives on the same host + the
// same VALOR_PAGESALE_BASE_URL / VALOR_IS_DEMO override knobs.
const TOKEN_SALE_STAGING_BASE = 'https://securelink-staging.valorpaytech.com';
const TOKEN_SALE_PROD_BASE = 'https://securelink.valorpaytech.com';

// Hard ceiling on the outbound Valor call (mirrors valor.ts's
// HOSTED_PAGE_TIMEOUT_MS pattern). Longer than the hosted-page's 10s because
// this is an operator-triggered server action (no customer waiting on a redirect),
// and the proof harness's live test needed the room. A timeout is AMBIGUOUS — the
// charge may have landed at Valor even though we never saw the response — so
// callers must NOT auto-retry on it; a human should check Valor first.
const TOKEN_SALE_TIMEOUT_MS = 30_000;

function pickStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Best-effort human-readable error detail from a Valor response body — never
// includes the request (so it can never carry the token/appkey secrets).
function describeError(flat: Record<string, unknown>): string {
  const codePart = [pickStr(flat.error_no), pickStr(flat.error_code)].filter(Boolean).join('/');
  const descPart = pickStr(flat.msg) ?? pickStr(flat.desc);
  if (codePart && descPart) return `${codePart}: ${descPart}`;
  if (codePart) return codePart;
  if (descPart) return descPart;
  return 'no error detail in response';
}

/**
 * Charge an invoice's balance against the card on file via Valor's Tokenized
 * Sale API. Returns:
 *   - not-enabled — the flag is off (the default).
 *   - no-card     — enabled but the quote has no saved vault token.
 *   - declined    — Valor responded but did not approve (error_no !== 'S00').
 *   - error       — not configured, network/timeout, or a non-JSON/HTTP-error
 *                   response. A TIMEOUT is ambiguous (message says so) — the
 *                   caller must not blindly retry.
 *   - ok:true     — approved; chargedUsd is the CAPTURED amount (not the
 *                   requested one) so the caller can reject a partial auth.
 * The caller treats any non-ok result as "not collected" and leaves the invoice
 * awaiting_payment for manual / pay-link follow-up.
 */
export async function chargeBalanceOnFile(input: ChargeBalanceInput): Promise<ChargeBalanceResult> {
  if (!isAutoChargeEnabled()) return { ok: false, reason: 'not-enabled' };
  if (!input.vaultToken) return { ok: false, reason: 'no-card' };

  const appId = process.env.VALOR_APP_ID;
  const appKey = process.env.VALOR_APP_KEY;
  const epi = process.env.VALOR_EPI;
  if (!appId || !appKey || !epi) {
    return {
      ok: false,
      reason: 'error',
      message: 'Valor not configured. Set VALOR_APP_ID, VALOR_APP_KEY and VALOR_EPI',
    };
  }

  const isDemo = process.env.VALOR_IS_DEMO !== 'false';
  const base = (
    process.env.VALOR_PAGESALE_BASE_URL || (isDemo ? TOKEN_SALE_STAGING_BASE : TOKEN_SALE_PROD_BASE)
  ).replace(/\/+$/, '');

  // Proven live 2026-07-22 (scripts/valor-token-reuse-test.ts, round 2, Fadil
  // Cox/Valor support): our EPI has a cash-discount profile (not traditional),
  // and surchargeIndicator must point at the profile that EXISTS on the EPI or
  // Valor 400s E98/V3 "EPI host processor info not found". 1 is the value
  // proven live for our EPI; env-tunable in case a future EPI swap needs 0.
  const surchargeIndicator = Number(process.env.VALOR_SURCHARGE_INDICATOR ?? '1');

  const body: Record<string, unknown> = {
    appid: appId,
    appkey: appKey,
    epi,
    txn_type: 'sale',
    amount: Math.round(input.amountUsd * 100) / 100, // dollars, 2dp — the proven pagesale/saleToken convention
    surcharge: 0,
    ignore_surcharge_calc: 1, // charge EXACTLY `amount` — no portal fee math on top
    surchargeIndicator,
    token: input.vaultToken,
    // Mandatory — proven live 400 D12 "SHIPPING COUNTRY MANDATORY" without it
    // (same required field the ?pagesale deposit body sends).
    shipping_country: 'US',
    invoicenumber: input.orderRef,
    orderdescription: 'YLL balance collection'.slice(0, 50),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_SALE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/?saleToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      // AMBIGUOUS — Valor may have received + processed the charge before the
      // timeout fired; we just never saw the response. Callers must NOT
      // auto-retry on this (a blind retry could double-charge); a human should
      // check Valor's portal for the txn before firing again.
      return {
        ok: false,
        reason: 'error',
        message: 'Valor balance charge timed out — check Valor before retrying (do not auto-retry)',
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: `Valor balance charge request failed: ${err instanceof Error ? err.message : 'network error'}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    return {
      ok: false,
      reason: 'error',
      message: `Valor balance charge returned non-JSON (HTTP ${res.status})`.slice(0, 200),
    };
  }

  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  // Flat is what's PROVEN live (2026-07-22, no `data` wrapper observed); tolerate
  // a data-nested shape too, mirroring createHostedPageSale's defensive-parsing
  // house style in case Valor's other endpoints/environments nest differently.
  const flat = (o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : o) as Record<
    string,
    unknown
  >;

  if (!res.ok) {
    return {
      ok: false,
      reason: 'error',
      message: `Valor balance charge → HTTP ${res.status}: ${describeError(flat)}`.slice(0, 200),
    };
  }

  const errorNo = pickStr(flat.error_no);
  if (errorNo === 'S00') {
    return {
      ok: true,
      chargedUsd: parseAmount(flat.amount),
      txnId: pickStr(flat.txnid),
      approvalCode: pickStr(flat.approval_code),
      receiptUrl: pickStr(flat.receipt_url),
      raw: json,
    };
  }

  return { ok: false, reason: 'declined', message: describeError(flat).slice(0, 200) };
}
