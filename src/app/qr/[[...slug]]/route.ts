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
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  // A printed code is one path segment. A bare /qr carries no code and a deeper
  // path is not a code we ever printed, so both redirect untagged rather than
  // guessing - the scan still lands, the analytics stay honest.
  const code = slug?.length === 1 ? slug[0] : undefined;
  // 302, deliberately. See qrRedirect.ts: a 301 would be cached by scanner apps
  // for the lifetime of the device and freeze the destination permanently.
  const res = NextResponse.redirect(buildQrDestination(code), 302);
  // `dynamic = 'force-dynamic'` governs how Next RENDERS this route; on its own
  // it emits NO cache header at all (measured on a running server). A comment
  // here previously claimed it meant "never answered from a cache", which was
  // not true - this header is what makes that claim true, and it is what keeps
  // the destination genuinely repointable, the whole reason the status is 302.
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  // The slug space is unbounded and sits on a brand subdomain, so without this
  // every scanned code is a crawlable URL that can be indexed. Raised by the
  // admin lens on this PR.
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}
