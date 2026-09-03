// Public landing point for every QR code Yule Love Lights has ever printed.
//
// The codes on the van decal and the business cards all point at
// https://link.yulelovelights.com/qr/<slug>, a subdomain that used to be served
// by a GoHighLevel account a former agency opened and that no longer has the
// custom domain attached (it resolves to the SiteGround marketing site, which
// has no /qr/ route and 404s every code). Pointing that subdomain at this app is
// what brings the printed material back to life; this route is what answers it.
//
// OPTIONAL CATCH-ALL, deliberately. A single [slug] segment 404s on a bare /qr
// and on a deeper /qr/a/b, which made the module's "never a dead end" promise
// false for part of its own namespace while operatorGate advertised that exact
// namespace as public - a gate open onto a 404. [[...slug]] answers every path
// under /qr, so the promise and the allowlist now describe the same surface.
//
// All of the reasoning - why it never 404s, why the redirect is 302 and not 301,
// and why the business card no longer lands on /get-a-quote/ - lives with the
// logic in src/lib/qrRedirect.ts, which is where the tests are. Allowlisted for
// signed-out access in src/lib/auth/operatorGate.ts in this same change: without
// that the gate serves the operator login shell to a homeowner holding a
// business card, which looks exactly like the outage we are fixing.

import { NextResponse } from 'next/server';
import { buildQrDestination } from '@/lib/qrRedirect';

export const runtime = 'nodejs';
// Never let a scan be answered from a cache: the destination is meant to be
// repointable at any time, and a cached response would outlive the change.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  // A printed code is one path segment. A bare /qr carries no code and a deeper
  // path is not a code we ever printed, so both redirect untagged rather than
  // guessing - the scan still lands, the analytics stay honest.
  const code = slug?.length === 1 ? slug[0] : undefined;
  // 302, deliberately. See qrRedirect.ts: a 301 would be cached by scanner apps
  // for the lifetime of the device and freeze the destination permanently.
  return NextResponse.redirect(buildQrDestination(code), 302);
}
