import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MinutesSince } from './MinutesSince';

// PostHog $exception, React error #418 (hydration mismatch), /admin/fleet,
// 2026-08-28 (session 01a047f6-0653-7ada-9d1d-78fdedfba43e). The old code
// computed `Date.now() - Date.parse(sinceIso)` inside useState's initializer,
// which Next runs once on the server (at the request's wall-clock time) and
// once again on the client during hydration (at the browser's wall-clock
// time). A few seconds apart is enough to cross a minute boundary and render
// different text on each side.
//
// This repo has no jsdom/hydrateRoot test setup, so the invariant this pins
// is the one that actually prevents the bug: the component's first-pass
// render (what SSR produces, and what hydration must match) cannot depend on
// Date.now() at all. Fails on the old code — a mocked clock crossing a
// minute boundary between two renders produces different markup ("0 min" vs
// "1 min"); passes on the new code, which renders null until mounted.

describe('MinutesSince (server/client render stability)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders identical markup regardless of when it is called', () => {
    const sinceIso = '2026-08-28T13:00:00.000Z';

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T13:00:29.000Z')); // 29s in: rounds to 0 min
    const first = renderToStaticMarkup(<MinutesSince sinceIso={sinceIso} />);

    vi.setSystemTime(new Date('2026-08-28T13:00:31.500Z')); // 31.5s in: rounds to 1 min
    const second = renderToStaticMarkup(<MinutesSince sinceIso={sinceIso} />);

    expect(first).toBe(second);
  });

  it('renders nothing before mount (matches what SSR produces)', () => {
    const html = renderToStaticMarkup(<MinutesSince sinceIso="2026-08-28T13:00:00.000Z" />);
    expect(html).toBe('');
  });
});
