import { describe, it, expect } from 'vitest';
import { derivePackagesEvent, eventSuggestions, MAX_EVENT_SUGGESTIONS } from './packages';
import { calculateEventQuote } from './pricing';
import type { PortalLineItem } from '@/components/portal/types';
import type { LineItem, QuoteInputs } from '@/lib/pricing/pricingEngine';

// ── eventSuggestions (operates on engine LineItem[]) ────────────────────────

const roofline: LineItem = { label: "Santa's Roofline – 100ft (easy)", amount: 500, id: 'roofline-santas' };
const curtain: LineItem = { label: 'Curtain Lights – 2 strings', amount: 50 };
const spritzer: LineItem = { label: '24" Spritzer', amount: 55 };
const bush: LineItem = { label: 'Bush – 3 strings', amount: 75 };
const bistro: LineItem = { label: 'Bistro Lighting – 50ft', amount: 500 };

const keysOf = (lines: LineItem[]) => eventSuggestions({ lineItems: lines }).map((s) => s.key);

describe('eventSuggestions', () => {
  it('empty quote → suggests the popular easy adds (curtain, spritzers, wrapped greenery)', () => {
    expect(keysOf([])).toEqual(['curtain', 'spritzers', 'bushWraps']);
  });

  it('never suggests a category already on the quote', () => {
    expect(keysOf([curtain])).not.toContain('curtain');
    expect(keysOf([roofline])).not.toContain('roofline');
    expect(keysOf([spritzer])).not.toContain('spritzers');
    expect(keysOf([bush])).not.toContain('bushWraps');
    expect(keysOf([bistro])).not.toContain('bistro');
  });

  it('backyard bistro with NO front roofline → leads with the roofline (arrival wow)', () => {
    expect(keysOf([bistro])).toEqual(['roofline', 'curtain', 'spritzers']);
  });

  it('caps at a couple suggestions', () => {
    expect(eventSuggestions({ lineItems: [] }).length).toBeLessThanOrEqual(MAX_EVENT_SUGGESTIONS);
  });

  it('a full quote (all categories present) → no suggestions', () => {
    expect(keysOf([roofline, curtain, spritzer, bush, bistro])).toEqual([]);
  });

  it('every suggestion carries draft label + blurb copy', () => {
    for (const s of eventSuggestions({ lineItems: [] })) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
  });
});

// ── derivePackagesEvent (PortalPackage[] for the portal adapter) ─────────────

function baseInputs(): QuoteInputs {
  return {
    santasFootage: 0,
    santasDifficulty: 'easy',
    gingerbreadFootage: 0,
    gingerbreadDifficulty: 'easy',
    winterWonderlandFootage: 0,
    winterWonderlandDifficulty: 'easy',
    stakeLightingFootage: 0,
    stakeLightingDifficulty: 'easy',
    miniLightItems: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    takedown: 'included',
    rushFee: false,
  };
}
const pli = (id: string, price: number): PortalLineItem => ({ id, kind: 'roofline', label: id, detail: '', price });

describe('derivePackagesEvent', () => {
  it('bundles every line item into ONE "what\'s included" package (tax + 50% deposit)', () => {
    const result = calculateEventQuote(baseInputs());
    const pkgs = derivePackagesEvent([pli('a', 700), pli('b', 300)], result);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].includedItemIds).toEqual(['a', 'b']);
    expect(pkgs[0].recommended).toBe(true);
    // subtotal 1000 → +8.75% tax = 1087.50 → 50% deposit = 543.75
    expect(pkgs[0].total).toBeCloseTo(1087.5, 2);
    expect(pkgs[0].deposit).toBeCloseTo(543.75, 2);
  });

  it('no line items → no package', () => {
    expect(derivePackagesEvent([], calculateEventQuote(baseInputs()))).toEqual([]);
  });

  it('carries no rush/takedown (events have none)', () => {
    const result = calculateEventQuote(baseInputs());
    const pkgs = derivePackagesEvent([pli('a', 100)], result);
    // 100 → tax 8.75 → total 108.75 (no fees added)
    expect(pkgs[0].total).toBeCloseTo(108.75, 2);
  });

  it('names the package without a leading "Your" (belt-and-suspenders — #184 removed the heading\'s "Your " prepend entirely, so this is no longer load-bearing)', () => {
    const pkgs = derivePackagesEvent([pli('a', 100)], calculateEventQuote(baseInputs()));
    expect(pkgs[0].name).toBe('Event Lighting');
    expect(pkgs[0].name.toLowerCase().startsWith('your ')).toBe(false);
  });
});

// ── mutually-exclusive rooflines: don't bill the front twice ─────────────────
// The adapter surfaces BOTH roofline options (Santa's = front only; Gingerbread
// = front + ridge + sides) as toggleable portal line items when a quote has
// front + sides footage. Gingerbread already contains the front, so bundling
// Santa's too double-bills the front footage (and that inflated total freezes
// into the approval snapshot + Valor deposit). Holiday drops Santa's via
// excludeRooflineId; the event bundle must mirror that.
describe('derivePackagesEvent — roofline double-bill guard (#96 money)', () => {
  const santas = pli('roofline-santas', 800); // front only
  const gingerbread = pli('roofline-gingerbread', 1200); // front (800) + ridge/sides (400)
  const spritzer = pli('spritzer-0', 200); // a non-roofline line

  it('drops Santa\'s when Gingerbread is present, so the front is billed once', () => {
    const result = calculateEventQuote(baseInputs());
    const pkgs = derivePackagesEvent([santas, gingerbread, spritzer], result);
    expect(pkgs).toHaveLength(1);
    // Santa's excluded from the id list; bundle = Gingerbread + non-roofline items.
    expect(pkgs[0].includedItemIds).toEqual(['roofline-gingerbread', 'spritzer-0']);
    // subtotal 1400 (1200 + 200), NOT 2200 (which would double-bill the 800 front).
    // 1400 → +8.75% tax = 1522.50 → 50% deposit = 761.25.
    expect(pkgs[0].total).toBeCloseTo(1522.5, 2);
    expect(pkgs[0].deposit).toBeCloseTo(761.25, 2);
  });

  it('keeps Santa\'s when it is the only roofline (front-only event)', () => {
    const result = calculateEventQuote(baseInputs());
    const pkgs = derivePackagesEvent([santas, spritzer], result);
    expect(pkgs[0].includedItemIds).toEqual(['roofline-santas', 'spritzer-0']);
    // subtotal 1000 → +8.75% tax = 1087.50.
    expect(pkgs[0].total).toBeCloseTo(1087.5, 2);
  });

  it('keeps Gingerbread when it is the only roofline', () => {
    const result = calculateEventQuote(baseInputs());
    const pkgs = derivePackagesEvent([gingerbread, spritzer], result);
    expect(pkgs[0].includedItemIds).toEqual(['roofline-gingerbread', 'spritzer-0']);
    // subtotal 1400 → +8.75% tax = 1522.50.
    expect(pkgs[0].total).toBeCloseTo(1522.5, 2);
  });
});
