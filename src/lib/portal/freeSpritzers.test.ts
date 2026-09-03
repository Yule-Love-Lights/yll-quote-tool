import { describe, it, expect } from 'vitest';
import {
  summarizeFreeSpritzers,
  labelPromisesFreeSpritzers,
  summarizeSelectedFreeSpritzers,
} from './freeSpritzers';

// Every label quoted here is a REAL label pulled from prod on 2026-09-03, not
// an invented fixture. The measured shape of the data is what this module
// exists to read, so the tests are anchored to it.

describe('summarizeFreeSpritzers — the shape prod actually uses', () => {
  it('reads the count out of a PAID package label, which is where 94 of 96 live lines keep it', () => {
    expect(summarizeFreeSpritzers(["Santa's Roofline Display Package · 6 FREE Spritzers!"])).toEqual({
      present: true,
      count: 6,
    });
  });

  it('reads a standalone $0 line label too (the 3 quotes that do it the tidy way)', () => {
    expect(summarizeFreeSpritzers(['2 Free Spritzers'])).toEqual({ present: true, count: 2 });
  });

  it('reads the "FREE Spritzers x4" ordering as well as "4 FREE Spritzers"', () => {
    expect(summarizeFreeSpritzers(["Santa's Roofline Display Package · FREE Spritzers ×4"])).toEqual({
      present: true,
      count: 4,
    });
    expect(summarizeFreeSpritzers(['Gingerbread Display Package · Trees · Free Spritzers ×4'])).toEqual({
      present: true,
      count: 4,
    });
  });

  it('survives the "Sprtizers" transposition that is live on quote 1146', () => {
    expect(summarizeFreeSpritzers(['Free 48" Wreath Upgrade & 2 FREE Sprtizers'])).toEqual({
      present: true,
      count: 2,
    });
  });

  it('counts only the spritzers when a label bundles another gift with them', () => {
    // The 48" wreath upgrade in that same label must not add to the spritzer count.
    const result = summarizeFreeSpritzers(['Free 48" Wreath Upgrade & 2 FREE Sprtizers']);
    expect(result.count).toBe(2);
  });

  it('does not confuse PAID spritzers on the same line with the free ones', () => {
    // Quote 1156: two spritzers charged, two given. Only the gift is counted.
    expect(
      summarizeFreeSpritzers([
        'Santa\'s Roofline Display Package · Bushes · 16" LED Spritzers ×2 · 2 FREE Spritzers!',
      ]),
    ).toEqual({ present: true, count: 2 });
  });

  it('sums across several lines of a multi-property quote', () => {
    // Quote 1109 carries one line per address.
    expect(
      summarizeFreeSpritzers([
        "[391 15th St] Santa's Roofline Display Package · 2 FREE Spritzers!",
        '[95 Avenue B] Santa\'s Roofline Display Package · 36" Noble Wreath (No-Decorations) · 4 FREE Spritzers!',
      ]),
    ).toEqual({ present: true, count: 6 });
  });
});

describe('summarizeFreeSpritzers — refusing to invent a number', () => {
  it('reports the promise with no count when the number sits before the word free (quote 1123)', () => {
    // "6 Free For Staying With Us!" states a number the patterns cannot safely
    // attach to the spritzers, so the portal says free spritzers are included
    // and states no figure.
    expect(
      summarizeFreeSpritzers([
        '32” LED Spritzers ×5 · 32” LED Spritzers - 6 Free For Staying With Us! · Santa\'s Roofline Display Package · Front Trees · Tree',
      ]),
    ).toEqual({ present: true, count: null });
  });

  it('treats a stated zero as unreadable rather than announcing zero free spritzers', () => {
    expect(summarizeFreeSpritzers(['0 FREE Spritzers'])).toEqual({ present: true, count: null });
  });
});

describe('summarizeFreeSpritzers — numbers that belong to something else', () => {
  // All three found by the pre-merge review round on PR #1192.

  it('does not read another item’s quantity as the spritzer count', () => {
    // The 2 belongs to the wreath. Before the fix this reported "2 spritzers".
    expect(
      summarizeFreeSpritzers(['Santa\'s Package · 24" Noble Wreath ×2 Free Spritzers!']),
    ).toEqual({ present: true, count: null });
  });

  it('does not read a year as the spritzer count', () => {
    // Before the fix this told a homeowner "2026 spritzers are on us".
    expect(summarizeFreeSpritzers(['October 2026 Free Spritzers Promo'])).toEqual({
      present: true,
      count: null,
    });
  });

  it('discards an implausible count rather than stating it', () => {
    expect(summarizeFreeSpritzers(['99 FREE Spritzers'])).toEqual({ present: true, count: null });
  });

  it('reads the count on the app’s own referral line, which puts a size in the middle', () => {
    // src/components/quote/QuoteBuilder.tsx writes this exact label. Before the
    // fix the count was unreadable on a value the code already knows.
    expect(summarizeFreeSpritzers(['2 Free 16" Spritzers (referral)'])).toEqual({
      present: true,
      count: 2,
    });
  });

  it('reads a spelled-out size too', () => {
    expect(summarizeFreeSpritzers(['2 Free 16 inch Spritzers'])).toEqual({ present: true, count: 2 });
  });
});

describe('summarizeFreeSpritzers — quotes with no gift', () => {
  it('returns nothing for an ordinary paid quote', () => {
    expect(
      summarizeFreeSpritzers([
        "Santa's Roofline Display Package",
        '16" LED Spritzers ×3',
        '24" Noble Wreath (No-Decorations) ×4',
      ]),
    ).toEqual({ present: false, count: null });
  });

  it('does not fire when something OTHER than spritzers is free (quote 1205)', () => {
    expect(
      summarizeFreeSpritzers([
        'Gingerbread Display Package · Columns & Railings (Both Columns for free this year!) ×2',
      ]),
    ).toEqual({ present: false, count: null });
  });

  it('does not fire on a free gutter-clearing offer with no spritzers (quote 1124)', () => {
    expect(
      summarizeFreeSpritzers([
        "Santa's Roofline Display Package · Takedown, Included · 🎄October Install – Save 10%! · Clear Gutters, Bright Holidays – FREE with October Installs!",
      ]),
    ).toEqual({ present: false, count: null });
  });

  it('does not turn a paid spritzer line into a gift because "free" appears far away in the same label', () => {
    // Proximity guard: the free thing is 60+ characters from the spritzers.
    const label =
      'Columns & Railings for free this year, plus bushes, plus trees, plus ground lighting · 16" LED Spritzers ×2';
    expect(labelPromisesFreeSpritzers(label)).toBe(false);
    expect(summarizeFreeSpritzers([label])).toEqual({ present: false, count: null });
  });

  it('handles an empty or junk label list without throwing', () => {
    expect(summarizeFreeSpritzers([])).toEqual({ present: false, count: null });
    expect(summarizeFreeSpritzers([''])).toEqual({ present: false, count: null });
    expect(summarizeFreeSpritzers([undefined as unknown as string])).toEqual({ present: false, count: null });
  });
});

describe('summarizeSelectedFreeSpritzers — the promise follows the selection', () => {
  // The PR #1192 admin lens found the promise was computed over EVERY label, so
  // a customer could toggle off the package carrying the gift and still be told
  // the spritzers were coming. These pin the fix.
  const items = [
    { id: 'a', label: "Santa's Roofline Display Package · 6 FREE Spritzers!" },
    { id: 'b', label: '24" Noble Wreath (No-Decorations) ×4' },
    { id: 'c', label: 'Ground Lighting' },
  ];

  it('promises the spritzers while the line carrying them is selected', () => {
    expect(summarizeSelectedFreeSpritzers(items, new Set(['a', 'b']))).toEqual({
      present: true,
      count: 6,
    });
  });

  it('drops the promise entirely when that line is toggled off', () => {
    expect(summarizeSelectedFreeSpritzers(items, new Set(['b', 'c']))).toEqual({
      present: false,
      count: null,
    });
  });

  it('promises nothing when the customer has selected nothing', () => {
    expect(summarizeSelectedFreeSpritzers(items, new Set())).toEqual({ present: false, count: null });
  });

  it('sums only the selected gift lines on a multi-line quote', () => {
    const multi = [
      { id: 'x', label: "[391 15th St] Santa's Roofline Display Package · 2 FREE Spritzers!" },
      { id: 'y', label: "[95 Avenue B] Santa's Roofline Display Package · 4 FREE Spritzers!" },
    ];
    expect(summarizeSelectedFreeSpritzers(multi, new Set(['x', 'y']))).toEqual({
      present: true,
      count: 6,
    });
    expect(summarizeSelectedFreeSpritzers(multi, new Set(['y']))).toEqual({ present: true, count: 4 });
  });

  it('handles an empty item list', () => {
    expect(summarizeSelectedFreeSpritzers([], new Set(['a']))).toEqual({ present: false, count: null });
  });
});

describe('labelPromisesFreeSpritzers — reused across calls', () => {
  it('gives the same answer on a repeated call (no leaked regex lastIndex)', () => {
    const label = "Santa's Roofline Display Package · 6 FREE Spritzers!";
    expect(labelPromisesFreeSpritzers(label)).toBe(true);
    expect(labelPromisesFreeSpritzers(label)).toBe(true);
    expect(summarizeFreeSpritzers([label, label])).toEqual({ present: true, count: 12 });
  });
});
