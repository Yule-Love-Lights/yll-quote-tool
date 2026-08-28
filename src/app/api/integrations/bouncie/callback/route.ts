// src/app/api/integrations/bouncie/callback/route.ts
// OAuth redirect target for the Bouncie grant (ledger row 403, phase 3a).
//
// Bouncie sends the operator's BROWSER here after they approve, with `?code=`
// and the `state` we issued at `/api/integrations/bouncie/start`. We check the
// state, exchange the code for a token pair, store it encrypted, and send them
// back to Settings with a readable outcome.
//
// DELIBERATELY OPERATOR-GATED, unlike the webhook. The webhook must be public
// because Bouncie's servers call it with no session. This route is reached by a
// person in their own browser, so it sits behind the normal operator session and
// is NOT in `PUBLIC_API_EXACT`. Storing a fleet-wide credential should not be
// something an anonymous request can do.
//
// AN OPERATOR SESSION IS NOT ENOUGH ON ITS OWN, which is why `state` exists. A
// session proves who is asking; it does not prove the authorization code belongs
// to the flow they started. Without the check, an attacker could hand a
// logged-in operator a code from the attacker's OWN Bouncie account and we would
// store it and then act as that account — polling a fleet that is not ours, with
// no symptom except somebody noticing unfamiliar vehicles.
//
// The authorization code is single-use in practice, so a failure here means
// starting again from `/start`, not retrying this URL.

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, isBouncieOAuthConfigured } from '@/lib/integrations/bouncieAuth';
import { OAUTH_STATE_COOKIE, portalBaseUrl, stateMatches } from '@/lib/integrations/bouncieOAuthState';

export const runtime = 'nodejs';

/**
 * Send the operator back to Settings with an outcome it can render.
 *
 * Only ever a fixed, short status word — never a token, a code, an account
 * email, or an error body. Redirect URLs land in browser history and server
 * access logs, so anything put here is effectively published.
 */
function back(status: string): NextResponse {
  const url = new URL('/settings/bouncie', portalBaseUrl());
  url.searchParams.set('bouncie', status);
  const res = NextResponse.redirect(url);
  // The state is spent either way: success, failure, or a forged attempt.
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const denied = req.nextUrl.searchParams.get('error');
  const state = req.nextUrl.searchParams.get('state');
  const expected = req.cookies.get(OAUTH_STATE_COOKIE)?.value;

  // The user pressed deny, or Bouncie refused. Not an error on our side.
  if (denied) return back('denied');

  if (!stateMatches(state, expected)) {
    console.warn('[bouncie] callback rejected: state did not match the issued value');
    return back('bad_state');
  }

  if (!code) return back('missing_code');

  if (!isBouncieOAuthConfigured()) {
    console.error('[bouncie] callback hit but BOUNCIE_CLIENT_ID/SECRET/REDIRECT_URI are not all set');
    return back('not_configured');
  }

  try {
    const account = await exchangeCodeForTokens(code);
    // Logged, not redirected: the account is the only record of WHOSE grant is
    // now stored, and a server log is the right place for it. A query string is
    // not — see `back` above.
    console.info('[bouncie] stored a grant for', account);
    return back('connected');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[bouncie] token exchange failed:', message);
    // Distinguish the one failure with a completely different fix. Everything
    // else is "look at the logs"; this one is "set an environment variable",
    // and the operator can act on it without help.
    if (/TOKEN_ENCRYPTION_KEY/.test(message)) return back('no_encryption_key');
    // A 401 from auth.bouncie.com means OUR app credentials were rejected —
    // wrong BOUNCIE_CLIENT_SECRET (the classic: the API key pasted where the
    // client secret goes; both sit behind SHOW buttons on the same portal
    // page). That has one specific fix, so it gets its own status instead of
    // hiding inside "failed". Diagnosed live on 2026-08-27, three 401s in a
    // row before the logs named it.
    if (/returned 401/.test(message)) return back('bad_credentials');
    // Bouncie answered with a server error, or did not answer at all. Neither
    // is anything the operator can fix; both are "wait and try again". The
    // staff lens replayed exactly this: a non-401 failure used to fall through
    // to "read the server log", which is not an instruction a non-developer
    // can act on.
    if (/returned 5\d\d/.test(message)) return back('bouncie_down');
    if (err instanceof TypeError || /fetch failed|network/i.test(message)) return back('bouncie_unreachable');
    return back('failed');
  }
}
