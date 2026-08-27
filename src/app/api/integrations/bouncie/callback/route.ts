// src/app/api/integrations/bouncie/callback/route.ts
// OAuth redirect target for the Bouncie grant (ledger row 403, phase 3a).
//
// Bouncie sends the operator's BROWSER here after they approve, with
// `?code=...`. We exchange that code for a token pair and store it encrypted,
// then send them somewhere human rather than leaving raw JSON on screen.
//
// DELIBERATELY OPERATOR-GATED, unlike the webhook. The webhook has to be public
// because Bouncie's servers call it with no session. This route is reached by a
// person clicking through a consent screen in their own browser, so it can and
// should sit behind the normal operator session — it is NOT in
// `PUBLIC_API_EXACT`. That means whoever completes the grant must be logged into
// the quote tool in the same browser, which is the correct requirement: storing
// a fleet-wide credential is not something an anonymous request should do.
//
// The authorization code is single-use in practice: re-running the authorize
// flow invalidates the previous one. So a failure here means going back to the
// consent screen, not retrying this URL.

import { NextRequest, NextResponse } from 'next/server';
import { exchangeCodeForTokens, isBouncieOAuthConfigured } from '@/lib/integrations/bouncieAuth';

export const runtime = 'nodejs';

/** Where to send the operator afterwards, with a readable outcome. */
function back(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL('/settings/accounts', req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const denied = req.nextUrl.searchParams.get('error');

  // The user pressed deny, or Bouncie refused. Not an error on our side.
  if (denied) return back(req, { bouncie: 'denied' });

  if (!code) return back(req, { bouncie: 'missing_code' });

  if (!isBouncieOAuthConfigured()) {
    console.error('[bouncie] callback hit but BOUNCIE_CLIENT_ID/SECRET/REDIRECT_URI are not all set');
    return back(req, { bouncie: 'not_configured' });
  }

  try {
    const account = await exchangeCodeForTokens(code);
    // The account email is not a secret and is worth logging: it is the only
    // record of WHOSE grant is now stored.
    console.info('[bouncie] stored a grant for', account);
    return back(req, { bouncie: 'connected', account });
  } catch (err) {
    // Never echo the error text into the redirect: it can carry fragments of a
    // token response.
    console.error('[bouncie] token exchange failed:', err instanceof Error ? err.message : String(err));
    return back(req, { bouncie: 'failed' });
  }
}
