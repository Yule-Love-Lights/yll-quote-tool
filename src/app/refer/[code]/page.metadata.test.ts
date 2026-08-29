// Link-preview metadata for the referral landing page.
//
// This page exists to be TEXTED between neighbours, so the preview card is the
// first thing the friend sees. Before the S72 wrap review it had none: the
// route inherited the root layout's metadata, and a live fetch of
// quote.yulelovelights.com/refer/<code> served exactly two meta tags — a
// generic title and "Operator console for Yule Love Lights — quoting, customer
// portal, and dashboard". A homeowner's first impression of the offer was a
// description of our internal admin tool, or nothing at all.
//
// These tests are the guardrail: a regression here is invisible in the browser
// (the page still renders fine) and only shows up in someone's messages app.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getReferralByCode = vi.fn();

vi.mock('@/lib/referrals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/referrals')>()),
  getReferralByCode: (code: string) => getReferralByCode(code),
}));

import { generateMetadata } from './page';

const params = (code: string) => Promise.resolve({ code });

beforeEach(() => {
  getReferralByCode.mockReset();
});

describe('refer/[code] link preview', () => {
  it('never inherits the operator-console description', async () => {
    getReferralByCode.mockResolvedValue({ name: 'Dana Whitfield', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    expect(meta.description).toBeTruthy();
    expect(meta.description).not.toContain('Operator console');
    expect(meta.description).not.toContain('dashboard');
    expect(meta.openGraph?.description).toBe(meta.description);
  });

  it('greets the friend with the referrer FIRST name only, never their full name', async () => {
    getReferralByCode.mockResolvedValue({ name: 'Dana Whitfield', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    const blob = JSON.stringify(meta);
    expect(meta.title).toBe("Dana thinks you'd love this");
    expect(blob).not.toContain('Whitfield');
  });

  it('carries an absolute 1200x630 card image on both Open Graph and Twitter', async () => {
    getReferralByCode.mockResolvedValue({ name: 'Dana Whitfield', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    const images = meta.openGraph?.images as Array<{ url: string; width: number; height: number; alt: string }>;
    expect(images).toHaveLength(1);
    // Absolute, not root-relative: every scraper that matters refuses a
    // relative og:image.
    expect(images[0].url).toMatch(/^https?:\/\/.+\/refer-share-card\.jpg$/);
    expect(images[0].width).toBe(1200);
    expect(images[0].height).toBe(630);
    expect(images[0].alt).toBeTruthy();
    // Next's resolved Twitter metadata is a discriminated union; `card` and
    // `images` only exist on the narrowed variants, so name the shape.
    const tw = meta.twitter as { card?: string; images?: string[] } | null;
    expect(tw?.card).toBe('summary_large_image');
    // The test NAME promises both surfaces carry the card image, so assert it
    // on both rather than checking og and taking twitter on trust.
    expect(tw?.images?.[0]).toBe(images[0].url);
  });

  it('points canonical + og:url at this referral code', async () => {
    getReferralByCode.mockResolvedValue({ name: 'Dana Whitfield', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    expect(meta.alternates?.canonical).toMatch(/\/refer\/AB12CD34$/);
    expect(meta.openGraph?.url).toMatch(/\/refer\/AB12CD34$/);
  });

  it('capitalizes a lowercase first name, the live bug this fix exists for', async () => {
    // Production rendered "david thinks you'd love this" before this fix, and
    // 31 of the 52 customers holding a code today have a lowercase first name.
    getReferralByCode.mockResolvedValue({ name: 'david', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    expect(meta.title).toBe("David thinks you'd love this");
  });

  it('calms an ALL-CAPS name without wrecking an intentionally mixed-case one', async () => {
    getReferralByCode.mockResolvedValue({ name: 'DAVID SMITH', customerId: 'c1', photoOptout: false });
    await expect(generateMetadata({ params: params('AB12CD34') })).resolves.toMatchObject({
      title: "David thinks you'd love this",
    });
    // McKenzie is neither all-upper nor all-lower, so it must pass through
    // untouched: blanket-lowercasing the tail would wreck it.
    getReferralByCode.mockResolvedValue({ name: 'McKenzie Todd', customerId: 'c1', photoOptout: false });
    await expect(generateMetadata({ params: params('AB12CD34') })).resolves.toMatchObject({
      title: "McKenzie thinks you'd love this",
    });
  });

  it('is kept out of search: the URL embeds a personal code', async () => {
    getReferralByCode.mockResolvedValue({ name: 'Dana Whitfield', customerId: 'c1', photoOptout: false });
    const meta = await generateMetadata({ params: params('AB12CD34') });
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it('still returns a usable card when the code is unknown', async () => {
    getReferralByCode.mockResolvedValue(null);
    const meta = await generateMetadata({ params: params('NOPE0000') });
    expect(meta.title).toBe('A neighbor sent you this');
    expect((meta.openGraph?.images as Array<{ url: string }>)[0].url).toContain('/refer-share-card.jpg');
  });

  it('still returns a usable card when the lookup THROWS', async () => {
    // A database blip must not take out the whole response: the page's own
    // notFound() owns the bad-code case, metadata must never be the thing
    // that 500s it.
    getReferralByCode.mockRejectedValue(new Error('supabase down'));
    await expect(generateMetadata({ params: params('AB12CD34') })).resolves.toMatchObject({
      title: 'A neighbor sent you this',
    });
  });
});
