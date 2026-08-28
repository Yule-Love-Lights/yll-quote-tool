// Row 431: /estimate is a deliberately indexable landing page (S48/#624), but it
// shipped without a canonical URL, so ?embed=1 and any campaign or referral
// parameter could index as a separate thin duplicate of the same page. These pin
// the canonical to the bare standalone URL for every variant, and pin that the
// embed variant stays noindex (the older guard these sit next to).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The page's default export pulls the whole interactive client flow (and, through
// it, the Konva canvas). generateMetadata needs none of that, so stub the child.
vi.mock('./EstimateFlow', () => ({ EstimateFlow: () => null }));

import { generateMetadata } from './page';

const ORIGINAL = process.env.PORTAL_BASE_URL;

beforeEach(() => {
  delete process.env.PORTAL_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PORTAL_BASE_URL;
  else process.env.PORTAL_BASE_URL = ORIGINAL;
});

const meta = (embed?: string) => generateMetadata({ searchParams: Promise.resolve({ embed }) });

describe('/estimate metadata', () => {
  it('canonicalises the standalone page to the bare /estimate URL', async () => {
    const m = await meta();
    expect(m.alternates?.canonical).toBe('https://quote.yulelovelights.com/estimate');
  });

  it('points the ?embed=1 variant at the SAME canonical, so the iframe copy cannot rank as a duplicate', async () => {
    const m = await meta('1');
    expect(m.alternates?.canonical).toBe('https://quote.yulelovelights.com/estimate');
  });

  it('honours PORTAL_BASE_URL and strips its trailing slashes', async () => {
    process.env.PORTAL_BASE_URL = 'https://staging.example.com//';
    const m = await meta();
    expect(m.alternates?.canonical).toBe('https://staging.example.com/estimate');
  });

  it('keeps the standalone page indexable and the embed variant out of the index', async () => {
    expect(await meta().then((m) => m.robots)).toEqual({ index: true, follow: true });
    expect(await meta('1').then((m) => m.robots)).toEqual({ index: false, follow: false });
  });
});
