// src/lib/inventory/clipRules.test.ts
import { describe, it, expect } from 'vitest';
import { projectClips, DEFAULT_CLIP_PER_FT } from './clipRules';

describe('projectClips', () => {
  it('qty = feet × 1 clip/ft by default, with the bound sku', () => {
    expect(projectClips('gutter', 10, { gutter: { sku: '14147' } })).toEqual({ sku: '14147', qty: 10 });
  });

  it('honors a per-feature perFt override', () => {
    expect(projectClips('ridge', 10, { ridge: { sku: '14159', perFt: 1.5 } })).toEqual({ sku: '14159', qty: 15 });
  });

  it('rounds partial feet UP (you never under-order clips)', () => {
    expect(projectClips('gutter', 9.1, { gutter: { sku: '14147' } })).toEqual({ sku: '14147', qty: 10 });
  });

  it('metal → null (magnetic wire, no clip — flagged for staff)', () => {
    expect(projectClips('metal', 10, { metal: { sku: 'x' } })).toBeNull();
  });

  it('zero / negative feet → null', () => {
    expect(projectClips('gutter', 0, { gutter: { sku: 'x' } })).toBeNull();
    expect(projectClips('gutter', -3, {})).toBeNull();
  });

  it('unset / nullish feature → null', () => {
    expect(projectClips(null, 10, {})).toBeNull();
    expect(projectClips(undefined, 10, {})).toBeNull();
  });

  it('feature with no rule still counts qty but sku is null (shows as unbound)', () => {
    expect(projectClips('peak', 10, {})).toEqual({ sku: null, qty: 10 });
  });

  it('rule present without a sku → null sku, qty from perFt', () => {
    expect(projectClips('peak', 10, { peak: { perFt: 2 } })).toEqual({ sku: null, qty: 20 });
  });

  it('a non-positive perFt falls back to the default', () => {
    expect(DEFAULT_CLIP_PER_FT).toBe(1);
    expect(projectClips('gutter', 5, { gutter: { sku: 'x', perFt: 0 } })).toEqual({ sku: 'x', qty: 5 });
  });
});
