import { describe, it, expect } from 'vitest';
import { GET } from './route';

// The pure function has its own suite (src/lib/qrRedirect.test.ts). This one
// covers the handler itself, which the pre-merge technical lens on PR #1186
// pointed out had zero coverage: the params shape, the status code, and the
// fact that an optional catch-all answers every path under /qr instead of
// 404ing the bare one.

const call = async (slug: string[] | undefined) =>
  GET(new Request('https://link.yulelovelights.com/qr'), {
    params: Promise.resolve({ slug }),
  });

describe('GET /qr/[[...slug]]', () => {
  it('302s a known code to the homepage with its campaign tag', async () => {
    const res = await call(['DjzJS9mzhTOm']);
    // 302 and not 301: a 301 is cached by scanner apps effectively forever and
    // would freeze the destination for everyone who already scanned.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://yulelovelights.com/');
    expect(location.searchParams.get('utm_campaign')).toBe('business_card');
    expect(location.searchParams.get('utm_content')).toBe('DjzJS9mzhTOm');
  });

  // A single [slug] segment 404s here, which made the module's own "never a
  // dead end" promise false on a path operatorGate advertises as public.
  it.each([
    ['a bare /qr', undefined],
    ['an empty segment list', [] as string[]],
    ['a deeper path', ['a', 'b']],
  ])('still redirects %s rather than 404ing', async (_label, slug) => {
    const res = await call(slug);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') as string);
    expect(location.origin + location.pathname).toBe('https://yulelovelights.com/');
    // Untagged: there is no printed code here to attribute, and inventing one
    // would put a fiction into the analytics this route exists to feed.
    expect(location.searchParams.has('utm_campaign')).toBe(false);
    expect(location.searchParams.has('utm_content')).toBe(false);
    // The scan is still counted as a QR scan.
    expect(location.searchParams.get('utm_source')).toBe('qr');
  });

  // Both headers were added because a claim in this file was false: the segment
  // config governs how Next RENDERS the route and emits no cache header at all,
  // so "never answered from a cache" only became true when the header did. A
  // claim with no test is how that happened in the first place, so both are
  // pinned here rather than described in a comment.
  it('tells every cache not to hold the redirect', async () => {
    const res = await call(['hbJhlsQLHpFv']);
    // Without this the destination is not repointable in practice, which is the
    // whole reason the status is 302 rather than 301.
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps the unbounded slug space out of search results', async () => {
    const res = await call(['hbJhlsQLHpFv']);
    const robots = res.headers.get('x-robots-tag') ?? '';
    expect(robots).toContain('noindex');
    expect(robots).toContain('nofollow');
  });

  it('never sends a scan off our own host', async () => {
    for (const slug of [['hbJhlsQLHpFv'], ['https://evil.test/'], ['../..'], undefined]) {
      const res = await call(slug);
      expect(new URL(res.headers.get('location') as string).host).toBe('yulelovelights.com');
    }
  });
});
