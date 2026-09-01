// The Schedule page's two-column layout (Naldo, 2026-08-31). Node-env static
// render, the same idiom as OperatorNav.test.tsx: no jsdom here, so this pass
// sees the first paint. That is exactly the state the ET-midnight finding was
// about, which is why it is testable at all.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { ScheduleWithFleet, shouldShowFleet } from './ScheduleWithFleet';

const FLEET = <p>Vehicles now, live</p>;

describe('shouldShowFleet', () => {
  // Naldo's call, 2026-08-31: the map is always live, so pairing it with next
  // Tuesday's jobs would put this minute's van positions under a future day's
  // heading.
  it('shows the vans on today', () => {
    expect(shouldShowFleet('2026-08-31', '2026-08-31')).toBe(true);
  });

  it('hides them on any other day, past or future', () => {
    expect(shouldShowFleet('2026-09-15', '2026-08-31')).toBe(false);
    expect(shouldShowFleet('2026-01-01', '2026-08-31')).toBe(false);
  });
});

describe('ScheduleWithFleet', () => {
  it('shows the fleet column when the day is today', () => {
    const html = renderToStaticMarkup(
      <ScheduleWithFleet crew={[]} fleet={FLEET} todayKey="2026-08-31" />,
    );
    expect(html).toContain('Vehicles now, live');
    expect(html).not.toContain('The vans are hidden on other days');
  });

  it('seeds the schedule from the SERVER day, not the browser clock', () => {
    // The premerge staff lens's LOW: this component seeded from a
    // server-computed day while ScheduleDay seeded from the browser, so a page
    // rendered just before ET midnight and hydrated just after could show
    // today's jobs beside a fleet column insisting it was not today. Both now
    // start from this one string. A far-past date is used precisely because
    // the browser clock can never coincidentally equal it.
    const html = renderToStaticMarkup(
      <ScheduleWithFleet crew={[]} fleet={FLEET} todayKey="2020-01-02" />,
    );
    // The date input is ScheduleDay's, and its value proves which clock won.
    expect(html).toContain('value="2020-01-02"');
    // And the two agree: the column still counts this as "today", because the
    // page was served on that day.
    expect(html).toContain('Vehicles now, live');
  });

  it('lays the two columns out side by side from lg, stacked below it', () => {
    const html = renderToStaticMarkup(
      <ScheduleWithFleet crew={[]} fleet={FLEET} todayKey="2026-08-31" />,
    );
    expect(html).toContain('lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]');
  });
});
