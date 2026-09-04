// What the Rate history section SAYS and OFFERS — ledger row 506.
//
// Same reasoning as shiftPayPanelCopy.test.tsx: this is the only screen where
// somebody's real pay history gets entered, it decides what every future
// payment converts at, and a real browser cannot reach it without an admin
// password. Copy compiles, so the copy gets asserted.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

import type { CrewMemberRate } from '@/lib/crewMemberRates';
import { RateHistorySection } from './RateHistorySection';

function rate(over: Partial<CrewMemberRate> & { id: string }): CrewMemberRate {
  return {
    crewMemberId: 'crew-1',
    rateCentsPerHour: 1600,
    effectiveFrom: '2000-01-01',
    createdAt: '2026-09-04T00:00:00.000Z',
    createdBy: null,
    ...over,
  };
}

function render(rates: CrewMemberRate[], readable = true): string {
  return renderToStaticMarkup(
    <RateHistorySection
      crewMemberId="crew-1"
      crewName="Jason"
      rates={rates}
      readable={readable}
    />,
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2019;|&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Jason's real history, the first thing this screen has to be able to hold. */
const JASON = [
  rate({ id: 'r1', rateCentsPerHour: 1000, effectiveFrom: '2000-01-01' }),
  rate({ id: 'r2', rateCentsPerHour: 1300, effectiveFrom: '2026-08-12' }),
  rate({ id: 'r3', rateCentsPerHour: 1600, effectiveFrom: '2026-09-01' }),
];

describe('the history it shows', () => {
  it('lists every rate newest first, with the day it started', () => {
    const out = text(render(JASON));
    expect(out).toContain('$16.00/hr from 1 Sep 2026');
    expect(out).toContain('$13.00/hr from 12 Aug 2026');
    expect(out).toContain('$10.00/hr from 1 Jan 2000');
    // Newest first: September has to appear before August in the markup, or
    // the most relevant row is buried under history.
    const html = render(JASON);
    expect(html.indexOf('1 Sep 2026')).toBeLessThan(html.indexOf('12 Aug 2026'));
  });

  it('marks only the newest row as the current rate', () => {
    const html = render(JASON);
    expect(html.match(/current/g) ?? []).toHaveLength(1);
    // ...and it is the September one: the badge sits after that date.
    expect(html.indexOf('current')).toBeGreaterThan(html.indexOf('1 Sep 2026'));
    expect(html.indexOf('current')).toBeLessThan(html.indexOf('12 Aug 2026'));
  });

  it('formats the day WITHOUT dragging it through a timezone', () => {
    // effective_from is already an ET calendar day. Parsing it into a Date
    // and formatting that back is free to move it a day, which on a rate
    // boundary is a whole day of somebody's work at the wrong price.
    expect(text(render([rate({ id: 'r', effectiveFrom: '2026-09-01' })]))).toContain('1 Sep 2026');
  });
});

describe('what it refuses, and says', () => {
  it('will not offer to remove the only rate on record', () => {
    const html = render([rate({ id: 'only' })]);
    // COUNT the disabled controls, do not just look for the attribute. With
    // one rate there are two — the Add button (nothing typed yet) and the
    // Remove button — and asserting only that `disabled` appears somewhere
    // passes happily with the guard deleted, because Add is disabled either
    // way. A mutation probe caught exactly that.
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(2);
    // The explanation lives in a title attribute, so assert on the raw
    // markup: stripping tags would throw away the very thing being checked.
    expect(html).toContain('The only rate on record cannot be removed');
  });

  it('offers removal once there is more than one', () => {
    const html = render(JASON);
    // Three rates, three live Remove buttons: the only disabled control left
    // is the Add button, which needs a rate and a date typed first.
    expect((html.match(/disabled=""/g) ?? [])).toHaveLength(1);
    expect(text(html)).not.toContain('The only rate on record cannot be removed');
  });

  it('says plainly when nobody has a rate at all, rather than showing an empty list', () => {
    expect(text(render([]))).toContain("No rate on record, so none of Jason's hours can be paid yet");
  });

  it('hides everything when the read FAILED, rather than implying no rate exists', () => {
    // An empty history and an unreadable one look identical and mean opposite
    // things; every existing person was seeded a row by the migration, so
    // "no rates" after a failed read is the one answer that is certainly wrong.
    const out = text(render([], false));
    expect(out).toContain('could not be read');
    expect(out).not.toContain('No rate on record');
  });
});

describe('the promise it makes about recorded payments', () => {
  it('states that a past rate does not move money already recorded', () => {
    // This is the question anybody hesitating over a backdated date is
    // actually asking, and the answer is guaranteed by the per-line stamped
    // rate in shift_settlement_lines, not by hope.
    const out = text(render(JASON));
    expect(out).toContain('It does not change a payment already recorded');
    expect(out).toContain('those keep the rate they were paid at');
  });

  it('warns that adding a rate for an existing day REPLACES it, since the button says Add', () => {
    expect(text(render(JASON))).toContain('Adding a rate for a day that already has one replaces it');
  });
});
