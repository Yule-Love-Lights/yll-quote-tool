// What the pay panel SAYS, not what it computes — ledger row 506.
//
// The arithmetic has its own tests (shiftPayAllocation.test.ts). This file
// exists because of the standing rule in AGENTS.md: a guard and the copy that
// NARRATES it are one change, and copy COMPILES, so tsc and 10,000 passing
// tests all wave a false sentence straight through. The specific sentence at
// risk here is the one this PR had to change: the panel used to say hours are
// worked out "at $16.00/hr", naming the person's current rate. The moment a
// payment reaches back across a raise that is false, and it is false in the
// direction that matters — it names the HIGHER rate over hours earned at the
// lower one.
//
// Rendered with renderToStaticMarkup, the same instrument my-hours/page.test
// uses, because this repo has no screen-test infrastructure and a real
// browser cannot reach this page without an admin password.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

import { ShiftPayPanel, type PayableShift } from './ShiftPayPanel';

const H = 3600;

function shift(over: Partial<PayableShift> & { id: string }): PayableShift {
  return {
    clockInAt: '2026-08-21T13:00:00.000Z',
    paidSeconds: 4 * H,
    unpaidSeconds: 4 * H,
    needsReview: false,
    rateCentsPerHour: 1300,
    ...over,
  };
}

function render(payable: PayableShift[]): string {
  return renderToStaticMarkup(
    <ShiftPayPanel crewMemberId="crew-1" crewName="Jason" payable={payable} />,
  );
}

/** The markup carries `&#x27;` and `&#39;`-style entities; normalise so an
 * assertion can be written the way the sentence reads. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2019;|&rsquo;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

describe('the pay panel names a rate honestly', () => {
  it('names the single rate when every unpaid hour is worth the same', () => {
    const out = text(render([shift({ id: 'a' }), shift({ id: 'b' })]));
    // 8h at $13.00 is $104.00.
    expect(out).toContain('worth $104.00 at $13.00/hr');
    expect(out).toContain('worked out from it at $13.00/hr');
    expect(out).not.toContain('each day’s own rate');
  });

  it('STOPS naming one rate as soon as the hours span a raise', () => {
    const out = text(
      render([
        shift({ id: 'aug', rateCentsPerHour: 1300 }),
        shift({ id: 'sep', clockInAt: '2026-09-02T13:00:00.000Z', rateCentsPerHour: 1600 }),
      ]),
    );
    // The whole point: 4h at $13.00 plus 4h at $16.00 is $116.00, and there
    // is no single "/hr" figure that describes it.
    expect(out).toContain('worth $116.00 at each day’s own rate');
    expect(out).toContain('worked out from it at each day’s own rate');
    // The old sentence, in either of its forms, must be gone.
    expect(out).not.toContain('at $16.00/hr');
    expect(out).not.toContain('at $13.00/hr');
  });

  it('shows the per-day rate on each row ONLY when the rates differ', () => {
    // Scoped to the shift LIST on purpose. A whole-markup check would match
    // the header's own "at $13.00/hr" and pass while the rows were empty —
    // it did exactly that on the first attempt.
    const rows = (html: string) => text(html.slice(html.indexOf('<ul'), html.indexOf('</ul>')));

    // One rate: the figure is already in the header and the helper text, so
    // repeating it on every row is noise.
    expect(rows(render([shift({ id: 'a' }), shift({ id: 'b' })]))).not.toContain('/hr');

    const two = rows(
      render([
        shift({ id: 'aug', rateCentsPerHour: 1300 }),
        shift({ id: 'sep', clockInAt: '2026-09-02T13:00:00.000Z', rateCentsPerHour: 1600 }),
      ]),
    );
    // Several rates: the rows are now the ONLY place an admin can see which
    // hours are worth what, because the header has stopped naming a figure.
    expect(two).toContain('$13.00/hr');
    expect(two).toContain('$16.00/hr');
  });
});

describe('a day with no rate on record', () => {
  const withGap = [
    shift({ id: 'no-rate', rateCentsPerHour: 0 }),
    shift({ id: 'ok', clockInAt: '2026-09-02T13:00:00.000Z', rateCentsPerHour: 1600 }),
  ];

  it('says so on the row, and says why no payment reaches it', () => {
    const out = text(render(withGap));
    expect(out).toContain('no rate for this day');
    expect(out).toContain('4h 00m of this falls on a day with no hourly rate on record');
    // The remedy has to be NAMED and has to exist: Rate history is a real
    // section on this same page.
    expect(out).toContain('Add the rate for that day under Rate history');
  });

  it('leaves those hours OUT of what the money is worth, so the ceiling is honest', () => {
    // Only the September shift can be converted: 4h at $16.00.
    expect(text(render(withGap))).toContain('worth $64.00 at $16.00/hr');
  });

  it('still counts them as unpaid, because they are', () => {
    // 8h unpaid across 2 shifts — the rateless hours are owed, they simply
    // cannot be settled yet. Dropping them from this total would read as the
    // person having been paid.
    expect(text(render(withGap))).toContain('8h 00m unpaid across 2 shifts');
  });

  it('does not imply per-day rates exist when NONE do', () => {
    // Every shift rateless. "worth $0.00 at each day's own rate" names a
    // per-day rate over a zero figure, when the truth is that no rate is on
    // record at all (staff lens on PR #1214).
    const out = text(
      render([shift({ id: 'a', rateCentsPerHour: 0 }), shift({ id: 'b', rateCentsPerHour: 0 })]),
    );
    expect(out).toContain('worth $0.00 with no hourly rate on record');
    expect(out).not.toContain('each day’s own rate');
  });

  it('pluralises when several days have no rate', () => {
    const out = text(
      render([
        shift({ id: 'x', rateCentsPerHour: 0 }),
        shift({ id: 'y', clockInAt: '2026-08-22T13:00:00.000Z', rateCentsPerHour: 0 }),
      ]),
    );
    expect(out).toContain('falls on 2 days with no hourly rate on record');
    expect(out).toContain('Add the rate for those days under Rate history');
  });
});
