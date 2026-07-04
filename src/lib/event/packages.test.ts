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
});
