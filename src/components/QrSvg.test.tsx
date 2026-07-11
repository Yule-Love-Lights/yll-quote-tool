// Ledger #41 growth feature 2 — smoke coverage for the shared QR display.
// The svg prop is always OUR OWN server-generated markup (src/lib/referralQr.ts),
// never user input, so this is a plain render-and-contains check.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QrSvg } from './QrSvg';

const SAMPLE_SVG = '<svg width="100%" height="100%" viewBox="0 0 41 41"><path d="M0 0h1v1H0z" /></svg>';

describe('QrSvg', () => {
  it('renders the given SVG markup inside a sized white box', () => {
    const html = renderToStaticMarkup(<QrSvg svg={SAMPLE_SVG} />);
    expect(html).toContain('<svg');
    expect(html).toContain('bg-white');
    expect(html).toContain('w-16 h-16'); // default size
  });

  it('accepts a custom size class (e.g. larger for a printable panel)', () => {
    const html = renderToStaticMarkup(<QrSvg svg={SAMPLE_SVG} className="w-32 h-32" />);
    expect(html).toContain('w-32 h-32');
  });
});
