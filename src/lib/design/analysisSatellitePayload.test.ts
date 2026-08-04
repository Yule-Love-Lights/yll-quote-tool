import { describe, it, expect } from 'vitest';
import { hasSatellitePayload } from './analysisSatellitePayload';

describe('hasSatellitePayload (#190)', () => {
  it('is true for a satellite-full response (address lookup: base64 + fpp)', () => {
    expect(hasSatellitePayload({ satelliteBase64: 'abc', satelliteFeetPerPixel: 0.0521 })).toBe(true);
  });

  it('is true when only satelliteFeetPerPixel is present (no image field on this payload)', () => {
    expect(hasSatellitePayload({ satelliteFeetPerPixel: 0.0521 })).toBe(true);
  });

  it('is true when only satelliteBase64 is present (no scale field on this payload)', () => {
    expect(hasSatellitePayload({ satelliteBase64: 'abc' })).toBe(true);
  });

  it('is false for a street-only analyze-photo response, even with fields absent entirely', () => {
    expect(hasSatellitePayload({})).toBe(false);
  });

  it('is false for a street-only response with explicit nulls (the real analyze-photo shape)', () => {
    expect(hasSatellitePayload({ satelliteBase64: null, satelliteFeetPerPixel: null })).toBe(false);
  });

  it('does NOT get fooled by hallucinated satellite LINES — the predicate only looks at base64/fpp, never line content', () => {
    // This is the core #190 regression: the caller (applyAnalysisResult) must
    // never pass line-array truthiness into this decision. Modeling it here
    // as "the function signature has no lines param at all" — a street-only
    // result with model-hallucinated satelliteSantasLines still can't make
    // this predicate true because there's nothing for it to read.
    const streetOnlyWithHallucinatedLines = { satelliteBase64: null, satelliteFeetPerPixel: null };
    expect(hasSatellitePayload(streetOnlyWithHallucinatedLines)).toBe(false);
  });
});
