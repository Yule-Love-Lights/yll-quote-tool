// Valor VAULT client (#161 "both vaults" decision, 2026-07-22). Separate from
// the existing card-on-file token we already save on every deposit
// (quotes.valor_vault_token, captured via the redirect_url capture route — see
// src/app/api/integrations/valor/redirect-capture/route.ts). Jason ALSO wants
// each card registered into VALOR'S OWN Vault product, so it:
//   - shows up on Valor's own merchant dashboard,
//   - is chargeable from their Virtual Terminal,
//   - survives independent of our tool / database.
//
// Valor support's confirmed path (2026-07-22): create a vault customer, then
// attach the card from a past sale's transaction id — no separate card-capture
// step, since the card already lives on file at Valor from the deposit sale.
//   1. addVaultCustomer()      — POST …/api/valor-vault/addcustomer
//   2. addPaymentProfileTxn()  — POST …/api/valor-vault/addpaymentprofiletxn/{vaultCustomerId}
//   3. getPaymentProfile()     — GET  …/api/valor-vault/getpaymentprofile/{vaultCustomerId}
//                                (read-back helper; not called by the webhook —
//                                exported for a future reuse/charge test)
//   4. registerCardInVault()   — the one orchestrator the webhook calls: (1) then
//                                (2), never throws, always resolves ok:true/false.
//
// ┌─ INTEGRATION CONTRACT — UNVERIFIED until the live probe ───────────────────┐
// │ These endpoint paths + response shapes come from Valor's valor-vault API   │
// │ docs, NOT a live probe (same caveat as valor.ts's Hosted Page contract).   │
// │ Everything that could drift on first contact is parsed DEFENSIVELY (accept│
// │ several key names / casings / nesting) so a first-run tweak is a one-line  │
// │ change — mirrors createHostedPageSale + parseWebhookEvent in ./valor.ts.   │
// │  • addcustomer            → a vault customer id, under `data` or flat,     │
// │    key name one of vault_customer_id | vault_id | customer_id | id.        │
// │  • addpaymentprofiletxn   → 2xx = success; a `payment_id` MAY be present.   │
// │  • getpaymentprofile      → shape unknown; exposed raw for the caller.     │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Auth model: same APP ID / APP Key family as valor.ts, but the vault product
// may (support hasn't confirmed) use its OWN dedicated credentials — hence the
// dedicated VALOR_VAULT_APP_ID/KEY vars with a fallback to the existing
// VALOR_APP_ID/KEY. These are SECRETS — never logged, never shipped to the
// browser. Errors below carry a message + status + a TRUNCATED response body
// only — never headers, never the credentials.

import { ValorError } from './valor';

const VAULT_DEFAULT_BASE_URL = 'https://demo.valorpaytech.com'; // the only documented host; prod URL is an open Valor-support question
const VAULT_TIMEOUT_MS = 15_000; // mirrors valor.ts's HOSTED_PAGE_TIMEOUT_MS pattern (AbortController), per call

function vaultBaseUrl(): string {
  return (process.env.VALOR_VAULT_BASE_URL?.trim() || VAULT_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

// Dedicated vault creds first, falling back to the existing Hosted Page creds —
// support has not confirmed whether they're the same, so the fallback covers
// the likely case while the dedicated vars allow an explicit override.
function vaultAuthHeaders(): { appId: string | undefined; appKey: string | undefined } {
  const appId = process.env.VALOR_VAULT_APP_ID?.trim() || process.env.VALOR_APP_ID?.trim() || undefined;
  const appKey = process.env.VALOR_VAULT_APP_KEY?.trim() || process.env.VALOR_APP_KEY?.trim() || undefined;
  return { appId, appKey };
}

// Armed only when explicitly enabled AND the resolved (dedicated-or-fallback)
// auth vars are both present. Operator-armed (see the webhook hook's #161 note
// on why it still fires for is_test quotes once armed).
export function isVaultRegisterEnabled(): boolean {
  if (process.env.VALOR_VAULT_REGISTER_ENABLED !== 'true') return false;
  const { appId, appKey } = vaultAuthHeaders();
  return !!(appId && appKey);
}

// Low-level POST/GET against the valor-vault surface. Hard 15s timeout via
// AbortController per call. Never logs — throws a ValorError whose message +
// truncated body the caller may log, but never the appId/appKey.
async function vaultFetch(
  path: string,
  opts: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
): Promise<unknown> {
  const { appId, appKey } = vaultAuthHeaders();
  if (!appId || !appKey) {
    throw new ValorError(
      'Valor Vault not configured. Set VALOR_VAULT_APP_ID/VALOR_VAULT_APP_KEY (or VALOR_APP_ID/VALOR_APP_KEY)',
    );
  }
  const base = vaultBaseUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Valor-App-ID': appId,
        'Valor-App-Key': appKey,
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ValorError(`Valor Vault request to ${path} timed out after ${VAULT_TIMEOUT_MS}ms`);
    }
    throw new ValorError(
      `Valor Vault request to ${path} failed: ${err instanceof Error ? err.message : 'network error'}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ValorError(
      `Valor Vault ${path} → ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      text.slice(0, 2000),
    );
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValorError(`Valor Vault ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// Split a quote's customer_name on the LAST space: everything before → first
// name (so a middle name stays with the first name), the final token → last
// name. No space (or no name at all) → the whole name is the first name, with
// a 'Customer' fallback when there's nothing to split at all.
function splitCustomerName(name: string | null | undefined): { firstName: string; lastName: string } {
  const trimmed = name?.trim();
  if (!trimmed) return { firstName: 'Customer', lastName: '' };
  const idx = trimmed.lastIndexOf(' ');
  if (idx === -1) return { firstName: trimmed, lastName: '' };
  const firstName = trimmed.slice(0, idx).trim();
  const lastName = trimmed.slice(idx + 1).trim();
  return { firstName: firstName || 'Customer', lastName };
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// Defensive extraction shared by both endpoints below: the docs don't confirm
// whether the id/payment_id lands flat or nested under `data`, or which of the
// several plausible key names is used — so try `data` first, then the flat
// object, across the whole candidate list.
function pickField(json: unknown, keys: string[]): string | null {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : null;
  for (const source of [data, o]) {
    if (!source) continue;
    for (const key of keys) {
      const picked = pickString(source[key]);
      if (picked) return picked;
    }
  }
  return null;
}

export type AddVaultCustomerInput = {
  customerName: string | null;
  email: string | null;
  phone: string | null;
};

export type AddVaultCustomerResult = { vaultCustomerId: string; raw: unknown };

// POST {base}/api/valor-vault/addcustomer
export async function addVaultCustomer(input: AddVaultCustomerInput): Promise<AddVaultCustomerResult> {
  const { firstName, lastName } = splitCustomerName(input.customerName);
  const body: Record<string, unknown> = {
    first_name: firstName,
    last_name: lastName,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
  };
  const json = await vaultFetch('/api/valor-vault/addcustomer', { method: 'POST', body });
  const vaultCustomerId = pickField(json, ['vault_customer_id', 'vault_id', 'customer_id', 'id']);
  if (!vaultCustomerId) {
    throw new ValorError(`Valor Vault addcustomer response missing a vault customer id`);
  }
  return { vaultCustomerId, raw: json };
}

export type AddPaymentProfileTxnResult = { paymentId?: string; raw: unknown };

// POST {base}/api/valor-vault/addpaymentprofiletxn/{vaultCustomerId}
// Attaches the card from a PAST sale (by its transaction id) to the vault
// customer — Valor support's confirmed no-separate-card-capture path (#161).
export async function addPaymentProfileTxn(
  vaultCustomerId: string,
  txnId: string,
): Promise<AddPaymentProfileTxnResult> {
  const json = await vaultFetch(`/api/valor-vault/addpaymentprofiletxn/${encodeURIComponent(vaultCustomerId)}`, {
    method: 'POST',
    body: { ref_txn_id: txnId },
  });
  const paymentId = pickField(json, ['payment_id']);
  return { paymentId: paymentId ?? undefined, raw: json };
}

// GET {base}/api/valor-vault/getpaymentprofile/{vaultCustomerId} — read-back
// helper for the future reuse/charge test. NOT called by the webhook hook.
export async function getPaymentProfile(vaultCustomerId: string): Promise<unknown> {
  return vaultFetch(`/api/valor-vault/getpaymentprofile/${encodeURIComponent(vaultCustomerId)}`, { method: 'GET' });
}

function vaultErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown Valor Vault error';
}

export type RegisterCardInVaultInput = {
  customerName: string | null;
  email: string | null;
  phone: string | null;
  txnId: string;
};

export type RegisterCardInVaultResult =
  | { ok: true; vaultCustomerId: string; paymentId?: string }
  | { ok: false; reason: string };

// The one orchestrator the webhook calls: addVaultCustomer, then
// addPaymentProfileTxn against the id it returned. NEVER throws — any failure
// at either step resolves { ok:false, reason } with a message only (no
// secrets, no card data), so a vault hiccup can never break the payment
// webhook that calls this.
export async function registerCardInVault(input: RegisterCardInVaultInput): Promise<RegisterCardInVaultResult> {
  if (!input.txnId) return { ok: false, reason: 'missing txnId' };

  let vaultCustomerId: string;
  try {
    const customer = await addVaultCustomer({
      customerName: input.customerName,
      email: input.email,
      phone: input.phone,
    });
    vaultCustomerId = customer.vaultCustomerId;
  } catch (err) {
    return { ok: false, reason: `addcustomer failed: ${vaultErrorMessage(err)}` };
  }

  try {
    const attached = await addPaymentProfileTxn(vaultCustomerId, input.txnId);
    return { ok: true, vaultCustomerId, paymentId: attached.paymentId };
  } catch (err) {
    return { ok: false, reason: `addpaymentprofiletxn failed: ${vaultErrorMessage(err)}` };
  }
}
