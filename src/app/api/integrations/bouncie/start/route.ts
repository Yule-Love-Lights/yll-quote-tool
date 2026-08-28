// src/app/api/integrations/bouncie/start/route.ts
// Begins the Bouncie OAuth grant (ledger row 403, phase 3a).
//
// WHY THIS ROUTE EXISTS AT ALL. The grant could be started by pasting Bouncie's
// authorize URL into a browser, and that is how it was done by hand the first
// time. But then nothing binds the callback to the person who started it: the
// callback would accept ANY authorization code presented by any logged-in
// operator's browser, including one an attacker obtained from their own Bouncie
// account and lured the operator into submitting.
//
// The consequence of that is not stolen credentials — the attacker never sees
// ours. It is worse in a quieter way: we would silently store, and then act as,
// the WRONG Bouncie account. The map would poll a fleet that is not ours and the
// only symptom would be a human noticing unfamiliar vehicles. Found by the S68
// security and technical lenses.
//
// So the flow starts here, where we mint a random `state`, keep it in an
// httpOnly cookie, and require the callback to present the same value back.
// Operator-gated like the callback: starting a fleet-wide grant is not something
// an anonymous request should be able to do.

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { isBouncieOAuthConfigured } from '@/lib/integrations/bouncieAuth';
import { isSecretBoxConfigured } from '@/lib/crypto/secretBox';
import { OAUTH_STATE_COOKIE, portalBaseUrl } from '@/lib/integrations/bouncieOAuthState';

export const runtime = 'nodejs';

const AUTHORIZE_URL = 'https://auth.bouncie.com/dialog/authorize';

export async function GET(_req: NextRequest) {
  const settings = new URL('/settings/bouncie', portalBaseUrl());

  if (!isBouncieOAuthConfigured()) {
    settings.searchParams.set('bouncie', 'not_configured');
    return NextResponse.redirect(settings);
  }
  // Refuse before sending anyone to a consent screen we could not act on. The
  // authorization code is one-shot, so finding out afterwards that we cannot
  // encrypt would waste the grant (S68 admin lens).
  if (!isSecretBoxConfigured()) {
    settings.searchParams.set('bouncie', 'no_encryption_key');
    return NextResponse.redirect(settings);
  }

  const state = randomBytes(32).toString('base64url');

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', process.env.BOUNCIE_CLIENT_ID!);
  authorize.searchParams.set('redirect_uri', process.env.BOUNCIE_REDIRECT_URI!);
  authorize.searchParams.set('state', state);

  const res = NextResponse.redirect(authorize);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax', // must survive the top-level redirect back from Bouncie
    path: '/api/integrations/bouncie',
    maxAge: 600, // ten minutes is plenty to click Approve
  });
  return res;
}
