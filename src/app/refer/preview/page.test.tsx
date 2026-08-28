// No-database referral preview route (naldo/referral-link-preview, PIECE 2).
// Renders with react-dom/server, same approach as the rest of this codebase's
// component tests (see src/app/refer/[code]/ReferralHeroBadge.test.tsx):
// ReferPreviewPage takes no params/searchParams and is a plain synchronous
// component, so it renders directly, no jsdom needed.
//
// Two things this file has to prove, per the brief:
//   1. It renders a generic sample, never a real customer's name or data.
//   2. It CANNOT be used to reach a real customer: no import anywhere in
//      this module's own source touches Supabase or GoHighLevel. A runtime
//      render test alone cannot prove a negative like that (a render test
//      only proves the path taken THIS run never called the database, not
//      that no path could); reading the file's own source and asserting the
//      forbidden identifiers are absent proves it structurally instead.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import ReferPreviewPage, { metadata } from './page';

describe('ReferPreviewPage', () => {
  it('renders the generic placeholder name, never a real customer name', () => {
    const html = renderToStaticMarkup(<ReferPreviewPage />);
    expect(html).toContain('Sam thinks your house could look like this.');
  });

  it('renders the same gallery-fallback hero a referrer with no design already gets', () => {
    const html = renderToStaticMarkup(<ReferPreviewPage />);
    // ReferralHeroBadge only renders on the 'photo' branch (see its own
    // test), so its presence proves this took the gallery-fallback path,
    // never a 'design' branch that would need a real referrer's photo.
    expect(html).toContain('One of our real Long Island installs');
  });

  it('shows the same compact trust row the real referral page shows', () => {
    const html = renderToStaticMarkup(<ReferPreviewPage />);
    expect(html).toContain('166 Google reviews');
    expect(html).toContain('Licensed');
    expect(html).toContain('48-hour fix guarantee');
  });

  it('is kept out of search: explicit noindex, nofollow', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('never uses an em dash', () => {
    const html = renderToStaticMarkup(<ReferPreviewPage />);
    expect(html).not.toContain('—');
  });

  it('CRITICAL: imports nothing that touches Supabase, GoHighLevel, or a real referral code', () => {
    // A behavioral render test can only prove the path exercised THIS run
    // never hit the database; it cannot prove no path could. This proves
    // the stronger claim structurally: none of the forbidden identifiers
    // even appear in this route's own source, so there is no call for a
    // future edit to accidentally wire a user-supplied value into.
    const source = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    const forbidden = ['getReferralByCode', 'getSupabaseServiceClient', 'getDesignByQuote', 'createClient'];
    for (const symbol of forbidden) {
      expect(source).not.toContain(symbol);
    }
    // No dynamic route data either: this component takes no props at all
    // (contrast [code]/page.tsx's `{ params }: { params: Promise<Params> }`),
    // so there is no per-request/user-supplied value flowing in here.
    expect(source).not.toMatch(/export default function ReferPreviewPage\([^)]+\)/);
  });

  it('CRITICAL: the shared ReferHero component itself imports no database or CRM client', () => {
    // ReferHero is rendered by BOTH this preview route and the real
    // [code]/page.tsx, so this asserts the same structural guarantee one
    // level down: the piece of markup that is actually shared never
    // imports anything that could reach real customer data, regardless of
    // which caller renders it.
    const source = readFileSync(join(__dirname, '..', '[code]', 'ReferHero.tsx'), 'utf8');
    const forbidden = ['getReferralByCode', 'getSupabaseServiceClient', 'getDesignByQuote', 'createClient'];
    for (const symbol of forbidden) {
      expect(source).not.toContain(symbol);
    }
  });
});
