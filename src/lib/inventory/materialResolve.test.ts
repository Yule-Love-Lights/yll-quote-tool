// Tests for materialResolve.ts — turning a crew member's plain-English material
// lines into real inventory SKUs (text-ops bot Phase 2). Fixtures use realistic
// YLL catalog data: '20009-SPK' C9 Warm White, '14147' C9 Clips White (a
// multi-pack "Clips" SKU — the plural is the real retail name, not a test
// contrivance), 'MINI-100' Mini Lights White.

import { describe, it, expect } from 'vitest';
import { resolveMaterialLines } from './materialResolve';

const C9_WARM: { sku: string; name: string } = { sku: '20009-SPK', name: 'C9 Warm White' };
const MINI: { sku: string; name: string } = { sku: 'MINI-100', name: 'Mini Lights White' };

describe('resolveMaterialLines', () => {
  it('empty lines returns empty resolved/unresolved', () => {
    expect(resolveMaterialLines([], [], [])).toEqual({ resolved: [], unresolved: [] });
  });

  // ── tier 1: exact sku ────────────────────────────────────────────────────

  it('exact sku match against the catalog (case and whitespace insensitive)', () => {
    const res = resolveMaterialLines(
      [{ item: '  20009-spk  ', qty: 2 }],
      [],
      [C9_WARM, MINI],
    );
    expect(res).toEqual({
      resolved: [{ sku: '20009-SPK', name: 'C9 Warm White', qty: 2, matchedOn: 'catalog' }],
      unresolved: [],
    });
  });

  it('exact sku match against jobMaterials before the catalog is even consulted', () => {
    const res = resolveMaterialLines(
      [{ item: 'MINI-100', qty: 1 }],
      [MINI],
      [C9_WARM], // catalog doesn't even carry MINI-100 — proves job was checked first
    );
    expect(res).toEqual({
      resolved: [{ sku: 'MINI-100', name: 'Mini Lights White', qty: 1, matchedOn: 'job' }],
      unresolved: [],
    });
  });

  // ── tier 2: exact name ───────────────────────────────────────────────────

  it('exact name match against the catalog (case insensitive)', () => {
    const res = resolveMaterialLines(
      [{ item: 'c9 warm white', qty: 3 }],
      [],
      [C9_WARM, MINI],
    );
    expect(res).toEqual({
      resolved: [{ sku: '20009-SPK', name: 'C9 Warm White', qty: 3, matchedOn: 'catalog' }],
      unresolved: [],
    });
  });

  it("job's own materials WIN over a catalog row with the same exact name", () => {
    // Deliberately different skus for the same descriptive name so the assertion
    // proves PRIORITY (job first, catalog never even wins), not just "the only sku".
    const jobRow = { sku: 'JOB-C9-1', name: 'C9 Warm White' };
    const catalogRow = { sku: '20009-SPK', name: 'C9 Warm White' };
    const res = resolveMaterialLines([{ item: 'C9 Warm White', qty: 5 }], [jobRow], [catalogRow]);
    expect(res).toEqual({
      resolved: [{ sku: 'JOB-C9-1', name: 'C9 Warm White', qty: 5, matchedOn: 'job' }],
      unresolved: [],
    });
  });

  // ── tier 3: normalized-token subset ─────────────────────────────────────

  it('"2 boxes of C9 warm white" resolves via token subset with noise words (and the qty digit) stripped', () => {
    const res = resolveMaterialLines(
      [{ item: '2 boxes of C9 warm white', qty: 2 }],
      [],
      [C9_WARM, MINI],
    );
    expect(res).toEqual({
      resolved: [{ sku: '20009-SPK', name: 'C9 Warm White', qty: 2, matchedOn: 'catalog' }],
      unresolved: [],
    });
  });

  it('"clips" resolves to the one clip sku on the job — catalog is never consulted', () => {
    const jobClip = { sku: '14147', name: 'C9 Clips White' };
    const catalog = [
      { sku: '14147', name: 'C9 Clips White' },
      { sku: '14148', name: 'C9 Clips Green' }, // would be ambiguous if we ever looked here
    ];
    const res = resolveMaterialLines(
      [{ item: 'clips', qty: 30 }],
      [jobClip, C9_WARM],
      catalog,
    );
    expect(res).toEqual({
      resolved: [{ sku: '14147', name: 'C9 Clips White', qty: 30, matchedOn: 'job' }],
      unresolved: [],
    });
  });

  it('the SAME phrase is AMBIGUOUS against a catalog holding several clip products when the job has no match', () => {
    const res = resolveMaterialLines(
      [{ item: 'clips', qty: 30 }],
      [C9_WARM], // no clip product on this job
      [
        { sku: '14147', name: 'C9 Clips White' },
        { sku: '14148', name: 'C9 Clips Green' },
      ],
    );
    expect(res).toEqual({
      resolved: [],
      unresolved: [{ item: 'clips', qty: 30, reason: 'ambiguous' }],
    });
  });

  it('tied token-subset candidates that share ONE sku still resolve (not ambiguous)', () => {
    // Same sku listed twice (e.g. a duplicate catalog row) must not read as two
    // distinct products.
    const res = resolveMaterialLines(
      [{ item: 'C9 Clips White', qty: 10 }],
      [],
      [
        { sku: '14147', name: 'C9 Clips White' },
        { sku: '14147', name: 'C9 Clips White (dup row)' },
      ],
    );
    expect(res).toEqual({
      resolved: [{ sku: '14147', name: 'C9 Clips White', qty: 10, matchedOn: 'catalog' }],
      unresolved: [],
    });
  });

  // ── refusal cases ────────────────────────────────────────────────────────

  it('an unknown phrase is no-match', () => {
    const res = resolveMaterialLines(
      [{ item: 'purple sparkle unicorn lights', qty: 1 }],
      [C9_WARM],
      [C9_WARM, MINI],
    );
    expect(res).toEqual({
      resolved: [],
      unresolved: [{ item: 'purple sparkle unicorn lights', qty: 1, reason: 'no-match' }],
    });
  });

  it('a phrase that is entirely noise words is no-match', () => {
    const res = resolveMaterialLines(
      [{ item: 'a box of the some', qty: 1 }],
      [C9_WARM],
      [C9_WARM, MINI],
    );
    expect(res).toEqual({
      resolved: [],
      unresolved: [{ item: 'a box of the some', qty: 1, reason: 'no-match' }],
    });
  });

  it('never picks the "closest" match — refuses instead of guessing on a two-way tie', () => {
    const res = resolveMaterialLines(
      [{ item: 'white lights', qty: 4 }],
      [],
      [
        { sku: '20009-SPK', name: 'C9 White Lights' },
        { sku: 'MINI-100', name: 'Mini White Lights' },
      ],
    );
    expect(res).toEqual({
      resolved: [],
      unresolved: [{ item: 'white lights', qty: 4, reason: 'ambiguous' }],
    });
  });

  // ── aggregation ──────────────────────────────────────────────────────────

  it('duplicate resolved skus are summed, keeping the FIRST matchedOn', () => {
    const jobClip = { sku: '14147', name: 'C9 Clips White' };
    const res = resolveMaterialLines(
      [
        { item: '14147', qty: 10 }, // resolves via job (tier 1 exact sku)
        { item: 'clips', qty: 20 }, // also resolves to 14147, but via job token-subset
      ],
      [jobClip],
      [{ sku: '14147', name: 'C9 Clips White' }],
    );
    expect(res).toEqual({
      resolved: [{ sku: '14147', name: 'C9 Clips White', qty: 30, matchedOn: 'job' }],
      unresolved: [],
    });
  });

  it('resolved and unresolved entries keep input order across mixed lines', () => {
    const res = resolveMaterialLines(
      [
        { item: 'MINI-100', qty: 1 },
        { item: 'nonsense item', qty: 1 },
        { item: '20009-SPK', qty: 2 },
      ],
      [],
      [MINI, C9_WARM],
    );
    expect(res.resolved.map((r) => r.sku)).toEqual(['MINI-100', '20009-SPK']);
    expect(res.unresolved.map((u) => u.item)).toEqual(['nonsense item']);
  });

  // ── quantity flooring ────────────────────────────────────────────────────

  it('floors a fractional, negative, or non-finite qty to a non-negative integer', () => {
    const res = resolveMaterialLines(
      [
        { item: 'MINI-100', qty: 3.9 },
        { item: '20009-SPK', qty: -5 },
      ],
      [],
      [MINI, C9_WARM],
    );
    expect(res.resolved).toEqual([
      { sku: 'MINI-100', name: 'Mini Lights White', qty: 3, matchedOn: 'catalog' },
      { sku: '20009-SPK', name: 'C9 Warm White', qty: 0, matchedOn: 'catalog' },
    ]);
  });

  it('a resolved qty of 0 still resolves normally (caller decides what to do with it)', () => {
    const res = resolveMaterialLines([{ item: 'MINI-100', qty: 0 }], [], [MINI]);
    expect(res).toEqual({
      resolved: [{ sku: 'MINI-100', name: 'Mini Lights White', qty: 0, matchedOn: 'catalog' }],
      unresolved: [],
    });
  });

  it('a non-finite qty on an unresolved line floors to 0 too', () => {
    const res = resolveMaterialLines([{ item: 'nonsense', qty: Number.NaN }], [], []);
    expect(res).toEqual({ resolved: [], unresolved: [{ item: 'nonsense', qty: 0, reason: 'no-match' }] });
  });
});
