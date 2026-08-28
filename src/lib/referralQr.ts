// Referral program growth feature (ledger #41 growth): QR code for a
// referral link. Pure computation, via the `qrcode` package's isomorphic
// `toString(link, { type: 'svg' })`, no browser canvas and no external QR
// service (a strict CSP blocks remote calls), so this runs in any server
// component, and also client-side (naldo/referral-link-preview, PIECE 6):
// the qrcode package ships a proper "browser" field in its own
// package.json, so a client bundle resolves the same call to its
// browser-safe build automatically, no separate client-only copy needed.
// ReferralLinkForm.tsx calls this directly once it has a real referral link
// from the API response, since that link is never known at server-render
// time on that page (see that file's own header for why).
//
// Returns a plain SVG string with width/height forced to 100% so the SAME
// markup fills whatever fixed-size box the caller wraps it in: small on the
// customer booked page ("or scan to share"), larger on the operator's
// CustomerReferralPanel for a printable yard-sign/door-hanger QR. The
// viewBox (untouched) keeps the code itself square and scannable at any size.
// Default margin (the library's standard quiet zone) is kept, since
// shrinking it risks scan failures once printed small, which would defeat
// the feature.

import QRCode from 'qrcode';

/**
 * Build an inline QR-code SVG string encoding `link`. Fail-open: returns null
 * on any generation error so the surrounding link/copy/share UI still renders
 * with no QR shown rather than throwing.
 */
export async function referralQrSvg(link: string): Promise<string | null> {
  if (!link) return null;
  try {
    const svg = await QRCode.toString(link, { type: 'svg' });
    return svg.replace('<svg ', '<svg width="100%" height="100%" ');
  } catch (err) {
    console.error('[referralQr] generation failed:', err);
    return null;
  }
}
