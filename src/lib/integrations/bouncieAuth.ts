// src/lib/integrations/bouncieAuth.ts — Bouncie OAuth 2.0 (ledger row 403, phase 3a).
//
// WHAT THIS UNBLOCKS. The webhook receiver (phase 2) needs no authentication at
// all — Bouncie pushes to us. Everything after it needs to PULL: the live map
// reads `GET /v1/vehicles`, and the geofences are created through
// `POST /v1/locations` and `POST /v1/application-geozones`. All of that is
// OAuth-only. An API key exists in the developer portal and was MEASURED against
// `/v1/vehicles` on 2026-08-27: it returns 401, bare and with a Bearer prefix.
// So this module is the gate on every remaining phase.
//
// THE THREE TRAPS, all confirmed against the vendor spec:
//
//   1. NO `Bearer` PREFIX. REST calls send `Authorization: <access_token>`
//      verbatim, despite the token response saying `token_type: "Bearer"`.
//      Bouncie's own FAQ lists adding the prefix as a top cause of 401.
//
//   2. REFRESH TOKENS ROTATE. Refreshing consumes the old refresh token and
//      returns a new one, and an unused refresh token expires on its own. So a
//      refresh MUST persist the new pair before the caller uses it. Losing that
//      write means the next refresh fails and the whole grant has to be redone
//      by a human clicking through the consent screen again.
//
//   3. THE AUTH CODE IS SINGLE-GRANT. Re-running the authorize flow invalidates
//      the previous code. Exchanging is a one-shot operation.
//
// Tokens are stored encrypted (see `crypto/secretBox`) in `integration_tokens`,
// keyed by provider + account email.

import { encryptSecret, decryptSecret, isSecretBoxConfigured } from '@/lib/crypto/secretBox';
import { getSupabaseServiceClient } from '@/lib/supabase';

const TOKEN_URL = 'https://auth.bouncie.com/oauth/token';
export const BOUNCIE_API_BASE = 'https://api.bouncie.dev/v1';
const PROVIDER = 'bouncie';

/** Refresh this many seconds BEFORE the token actually expires. */
const EXPIRY_SKEW_SECONDS = 120;

export class BouncieAuthError extends Error {}

export function isBouncieOAuthConfigured(): boolean {
  return !!(process.env.BOUNCIE_CLIENT_ID && process.env.BOUNCIE_CLIENT_SECRET && process.env.BOUNCIE_REDIRECT_URI);
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
};

function parseTokenResponse(body: unknown): TokenResponse {
  const b = (body ?? {}) as Record<string, unknown>;
  const access = typeof b.access_token === 'string' ? b.access_token : '';
  const refresh = typeof b.refresh_token === 'string' ? b.refresh_token : '';
  const expires = typeof b.expires_in === 'number' ? b.expires_in : NaN;
  if (!access || !refresh || !Number.isFinite(expires)) {
    // Deliberately does not echo the body: a partial token response still
    // contains credentials.
    throw new BouncieAuthError('Token response was missing access_token, refresh_token or expires_in.');
  }
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: expires,
    scope: typeof b.scope === 'string' ? b.scope : undefined,
  };
}

async function postToken(payload: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new BouncieAuthError(`Bouncie token endpoint returned ${res.status}.`);
  }
  return parseTokenResponse(await res.json().catch(() => null));
}

/**
 * Persist a token pair. Called after both the initial exchange and every
 * refresh, because a rotated refresh token that is not written down is a grant
 * we have already lost.
 */
async function storeTokens(accountEmail: string, t: TokenResponse): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new BouncieAuthError('No Supabase service client; refusing to discard a rotated token.');
  const expiresAt = new Date(Date.now() + t.expires_in * 1000).toISOString();
  const { error } = await sb.from('integration_tokens').upsert(
    {
      provider: PROVIDER,
      account_email: accountEmail,
      access_token_enc: encryptSecret(t.access_token),
      refresh_token_enc: encryptSecret(t.refresh_token),
      access_token_expires_at: expiresAt,
      scope: t.scope ?? null,
    },
    { onConflict: 'provider,account_email' },
  );
  if (error) throw new BouncieAuthError(`Could not persist Bouncie tokens: ${error.message}`);
}

/**
 * Which Bouncie account a fresh token belongs to.
 *
 * The token response does not say, and we need it as the storage key. Asking
 * `/v1/user` is the only way to find out, and doing it here means the row is
 * keyed by the account that actually granted access rather than by a guess or a
 * hard-coded address that quietly becomes wrong when a second account is added.
 */
async function fetchAccountEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${BOUNCIE_API_BASE}/user`, {
    headers: { Authorization: accessToken, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new BouncieAuthError(`Could not read the Bouncie user (${res.status}).`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!email) throw new BouncieAuthError('Bouncie user response carried no email to key the grant by.');
  return email;
}

/**
 * Exchange an authorization code for the first token pair. One shot: running the
 * authorize flow again invalidates the code this was called with.
 *
 * Returns the account email the grant was stored under, so the caller can say
 * whose grant it just saved instead of reporting a bare success.
 */
export async function exchangeCodeForTokens(code: string, accountEmail?: string): Promise<string> {
  if (!isBouncieOAuthConfigured()) throw new BouncieAuthError('Bouncie OAuth is not configured.');
  // Check we can STORE before we SPEND. The authorization code is one-shot: the
  // moment it is exchanged, Bouncie considers it used. Discovering afterwards
  // that TOKEN_ENCRYPTION_KEY is missing would burn the code and force the
  // operator back through the consent screen for a purely local misconfiguration.
  // Found by the S68 admin lens.
  if (!isSecretBoxConfigured()) {
    throw new BouncieAuthError(
      'TOKEN_ENCRYPTION_KEY is not configured; refusing to spend the authorization code.',
    );
  }
  const tokens = await postToken({
    client_id: process.env.BOUNCIE_CLIENT_ID!,
    client_secret: process.env.BOUNCIE_CLIENT_SECRET!,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.BOUNCIE_REDIRECT_URI!,
  });
  const email = accountEmail ?? (await fetchAccountEmail(tokens.access_token));
  await storeTokens(email, tokens);
  return email;
}

type StoredRow = {
  account_email: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_token_expires_at: string | null;
};

async function loadRow(accountEmail?: string): Promise<StoredRow | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new BouncieAuthError('No Supabase service client; cannot read the stored grant.');
  let q = sb
    .from('integration_tokens')
    .select('account_email, access_token_enc, refresh_token_enc, access_token_expires_at')
    .eq('provider', PROVIDER)
    // Deterministic: newest grant wins. Without an order, `.limit(1)` returns
    // whichever row Postgres feels like, so a second stored grant would make
    // which account we act as depend on the query plan (S68 technical lens).
    .order('updated_at', { ascending: false });
  if (accountEmail) q = q.eq('account_email', accountEmail);

  // Two rather than one, so ambiguity is detectable instead of silently resolved.
  const { data, error } = await q.limit(2).returns<StoredRow[]>();

  // A read FAILURE is not the same as NO GRANT. Reporting a database outage as
  // "nobody has authorized yet" sends the operator to re-run the consent flow,
  // which is both useless and destructive — it invalidates the existing code
  // (S68 recovery lens).
  if (error) throw new BouncieAuthError(`Could not read the stored Bouncie grant: ${error.message}`);

  const rows = data ?? [];
  if (!accountEmail && rows.length > 1) {
    // Refusing beats guessing: acting as the wrong Bouncie account would poll
    // the wrong fleet, and nobody would notice except by spotting wrong vehicles.
    throw new BouncieAuthError(
      `${rows.length} Bouncie grants are stored; the caller must name which account to use.`,
    );
  }
  return rows[0] ?? null;
}

/** True when the stored access token is missing or close enough to expiry to replace. */
function needsRefresh(row: StoredRow): boolean {
  if (!row.access_token_enc || !row.access_token_expires_at) return true;
  const expiresAt = Date.parse(row.access_token_expires_at);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - EXPIRY_SKEW_SECONDS * 1000 <= Date.now();
}

/**
 * A usable access token, refreshing first if the stored one is spent.
 *
 * The refreshed pair is persisted BEFORE the token is returned. If that write
 * fails this throws rather than handing back a token whose refresh counterpart
 * has already been consumed on Bouncie's side and lost on ours.
 */
export async function getAccessToken(accountEmail?: string): Promise<string> {
  if (!isBouncieOAuthConfigured()) throw new BouncieAuthError('Bouncie OAuth is not configured.');
  const row = await loadRow(accountEmail);
  if (!row) throw new BouncieAuthError('No Bouncie grant stored. Someone must authorize the app first.');

  if (!needsRefresh(row)) return decryptSecret(row.access_token_enc!);

  if (!row.refresh_token_enc) {
    throw new BouncieAuthError('Stored Bouncie grant has no refresh token; re-authorization is required.');
  }
  let refreshed: TokenResponse;
  try {
    refreshed = await postToken({
      client_id: process.env.BOUNCIE_CLIENT_ID!,
      client_secret: process.env.BOUNCIE_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: decryptSecret(row.refresh_token_enc),
    });
  } catch (err) {
    // THE ROTATION RACE (S68 technical lens, HIGH). Two callers can both see an
    // expired token and both refresh with the SAME refresh token. Bouncie
    // consumes it for whichever arrives first and rejects the second.
    //
    // The grant is NOT lost when that happens: the winner has already persisted
    // a fresh, valid pair. So the loser re-reads rather than surfacing an error
    // that reads like "re-authorize" when nothing is actually wrong.
    const fresh = await loadRow(row.account_email);
    if (fresh && !needsRefresh(fresh)) return decryptSecret(fresh.access_token_enc!);
    throw err;
  }
  await storeTokens(row.account_email, refreshed);
  return refreshed.access_token;
}

/**
 * A Bouncie REST call with authentication handled.
 *
 * Note the header: the raw token, NO `Bearer` prefix. Trap 1 above.
 */
export async function bouncieFetch(
  path: string,
  init?: { method?: string; body?: unknown; accountEmail?: string },
): Promise<Response> {
  const token = await getAccessToken(init?.accountEmail);
  return fetch(`${BOUNCIE_API_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
