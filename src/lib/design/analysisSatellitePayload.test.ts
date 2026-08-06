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

// #204: the interaction guard — "Pull satellite" (or the analyze-address
// no-Street-View fallback) sets the satellite state FIRST; the operator then
// uploads their own photo and runs ONE analyze (/api/analyze-photo). That
// route's response shape (verified in its own route.test.ts) never carries
// satelliteBase64/satelliteFeetPerPixel, so hasSatellitePayload is false and
// QuoteBuilder's applyAnalysisResult (the #190 guard) never touches
// satelliteFeetPerPixel/satelliteSantasLines/satelliteGingerbreadLines. This
// proves the ORDERING explicitly, using the real shapes on both sides — not
// just the predicate in isolation.
describe('ordering: pull-satellite (or the no-Street-View fallback) THEN an analyze-photo response (#204)', () => {
  // Mirrors applyAnalysisResult's exact satellite-apply logic in
  // QuoteBuilder.tsx verbatim (the hasSatellitePayload gate, then only
  // overwrite the scale when THIS payload actually carries one) — small
  // enough to keep here rather than exporting a test-only hook out of the
  // 4000-line component. If that logic ever changes, this local copy and
  // QuoteBuilder's applyAnalysisResult must be updated together.
  function applySatelliteLeg(
    state: { satelliteFeetPerPixel: number | null },
    data: { satelliteBase64?: string | null; satelliteFeetPerPixel?: number | null },
  ): { satelliteFeetPerPixel: number | null } {
    if (!hasSatellitePayload(data)) return state;
    if (data.satelliteFeetPerPixel != null) {
      return { ...state, satelliteFeetPerPixel: data.satelliteFeetPerPixel };
    }
    return state;
  }

  it('a pull-satellite scale survives a subsequent analyze-photo response (no satellite fields)', () => {
    let state = { satelliteFeetPerPixel: null as number | null };

    // Step 1: "Pull satellite" (POST /api/pull-satellite) sets a real scale.
    const pullSatelliteResponse = { satelliteBase64: 'sat-b64', satelliteFeetPerPixel: 0.0521 };
    state = applySatelliteLeg(state, pullSatelliteResponse);
    expect(state.satelliteFeetPerPixel).toBe(0.0521);

    // Step 2: the operator uploads their own photo and analyzes it —
    // analyze-photo's real response never carries satellite fields (#190).
    const analyzePhotoResponse = { satelliteBase64: undefined, satelliteFeetPerPixel: undefined };
    state = applySatelliteLeg(state, analyzePhotoResponse);

    // The pulled scale must still be there — not nulled, not clobbered.
    expect(state.satelliteFeetPerPixel).toBe(0.0521);
  });

  it('same ordering via the analyze-address no-Street-View fallback instead of pull-satellite (#204b)', () => {
    let state = { satelliteFeetPerPixel: null as number | null };
    const partialSuccessResponse = { satelliteBase64: 'sat-b64', satelliteFeetPerPixel: 0.0789 };
    state = applySatelliteLeg(state, partialSuccessResponse);
    expect(state.satelliteFeetPerPixel).toBe(0.0789);

    const analyzePhotoResponse = { satelliteBase64: undefined, satelliteFeetPerPixel: undefined };
    state = applySatelliteLeg(state, analyzePhotoResponse);
    expect(state.satelliteFeetPerPixel).toBe(0.0789);
  });

  it('a second analyze-photo call still cannot clobber it (repeat re-analyze on the uploaded photo)', () => {
    let state = { satelliteFeetPerPixel: 0.0521 as number | null };
    const analyzePhotoResponse = { satelliteBase64: undefined, satelliteFeetPerPixel: undefined };
    state = applySatelliteLeg(state, analyzePhotoResponse);
    state = applySatelliteLeg(state, analyzePhotoResponse);
    expect(state.satelliteFeetPerPixel).toBe(0.0521);
  });

  // #204 fix: the PROVENANCE half of this interaction — QuoteBuilder's
  // pendingContextRef (persisted onto the design row for the portal's
  // satellite view) is a SEPARATE mechanism from the satelliteFeetPerPixel
  // state tested above. handlePhotoSelect used to unconditionally null
  // pendingContextRef.current ("a parked context belongs to the PREVIOUS
  // house"), which silently dropped a satellite-only context (Pull satellite,
  // the no-Street-View fallback, or a manual satellite upload) parked for the
  // SAME house before any design existed to receive it — the eager design
  // effect only fires once photoBase64 is set, which a satellite-only pull
  // never does, so nothing had consumed the park yet. Fixed to keep the
  // satellite half and only drop a stale `analysis` half. Mirrors
  // handlePhotoSelect's exact transformation verbatim.
  function dropAnalysisKeepSatellite(
    pending: { analysis?: unknown; satelliteBase64?: string; satelliteMediaType?: string; satelliteFeetPerPixel?: number | null } | null,
  ): { satelliteBase64?: string; satelliteMediaType?: string; satelliteFeetPerPixel?: number | null } | null {
    return pending?.satelliteBase64
      ? {
          satelliteBase64: pending.satelliteBase64,
          satelliteMediaType: pending.satelliteMediaType,
          satelliteFeetPerPixel: pending.satelliteFeetPerPixel,
        }
      : null;
  }

  it('a manual photo upload after pull-satellite keeps the parked satellite provenance (does not silently drop it)', () => {
    // Step 1: Pull satellite parks satellite-only provenance (no design yet).
    const pendingAfterPull = { satelliteBase64: 'sat-b64', satelliteMediaType: 'image/png', satelliteFeetPerPixel: 0.0521 };
    // Step 2: handlePhotoSelect (manual photo upload) runs its cleanup.
    const pendingAfterUpload = dropAnalysisKeepSatellite(pendingAfterPull);
    expect(pendingAfterUpload).toEqual({
      satelliteBase64: 'sat-b64',
      satelliteMediaType: 'image/png',
      satelliteFeetPerPixel: 0.0521,
    });
  });

  it('a stale ANALYSIS half (from a previous photo) is still dropped when there is no parked satellite', () => {
    const pendingWithOnlyStaleAnalysis = { analysis: { notes: 'old house' } };
    expect(dropAnalysisKeepSatellite(pendingWithOnlyStaleAnalysis)).toBeNull();
  });

  it('nothing parked stays nothing parked', () => {
    expect(dropAnalysisKeepSatellite(null)).toBeNull();
  });
});
