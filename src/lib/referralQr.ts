// Referral program growth feature (ledger #41 growth) — server-side QR code
// for a referral link. Generated entirely in Node via the `qrcode` package
// (pure computation, no browser canvas and no external QR service — a strict
// CSP blocks remote calls), so this can run in any server component.
//
// Returns a plain SVG string with width/height forced to 100% so the SAME
// markup fills whatever fixed-size box the caller wraps it in: small on the
// customer booked page ("or scan to share"), larger on the operator's
// CustomerReferralPanel for a printable yard-sign/door-hanger QR. The
// viewBox (untouched) keeps the code itself square and scannable at any size.
// Default margin (the library's standard quiet zone) is kept — shrinking it
// risks scan failures once printed small, which would defeat the feature.

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
