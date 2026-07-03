import { describe, it, expect } from 'vitest';
import { derivePackagesEvent, MAX_EVENT_SUGGESTIONS } from './packages';
import type { LineItem } from '@/lib/pricing/pricingEngine';

const roofline: LineItem = { label: "Santa's Roofline – 100ft (easy)", amount: 500, id: 'roofline-santas' };
const curtain: LineItem = { label: 'Curtain Lights – 2 strings', amount: 50 };
const spritzer: LineItem = { label: '24" Spritzer', amount: 55 };
const bush: LineItem = { label: 'Bush – 3 strings', amount: 75 };
const bistro: LineItem = { label: 'Bistro Lighting – 50ft', amount: 500 };

const keysOf = (lines: LineItem[]) => derivePackagesEvent({ lineItems: lines }).suggestions.map(s => s.key);

describe('derivePackagesEvent', () => {
  it('passes the line items through as the single included set', () => {
    const lines = [roofline, curtain];
    expect(derivePackagesEvent({ lineItems: lines }).includedItems).toBe(lines);
  });

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

  it('backyard bistro with NO front roofline → leads the suggestion with the roofline (arrival wow)', () => {
    const s = keysOf([bistro]);
    expect(s[0]).toBe('roofline');
    expect(s).toEqual(['roofline', 'curtain', 'spritzers']);
  });

  it('caps at a couple suggestions', () => {
    expect(derivePackagesEvent({ lineItems: [] }).suggestions.length).toBeLessThanOrEqual(MAX_EVENT_SUGGESTIONS);
  });

  it('a full quote (all categories present) → no suggestions', () => {
    expect(keysOf([roofline, curtain, spritzer, bush, bistro])).toEqual([]);
  });

  it('every suggestion carries draft label + blurb copy', () => {
    for (const s of derivePackagesEvent({ lineItems: [] }).suggestions) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
  });
});
