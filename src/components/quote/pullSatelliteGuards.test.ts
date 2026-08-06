// #204 review round (PR #702): two client-side glue fixes in QuoteBuilder's
// applyPulledSatellite. QuoteBuilder.tsx has no existing component test
// harness (4000+ lines, heavy Supabase/design-editor dependencies) — these
// tests mirror the exact decision logic verbatim rather than rendering the
// component, matching the pattern already used in
// src/lib/design/analysisSatellitePayload.test.ts for the sibling #204 fixes.
// If the real logic in QuoteBuilder.tsx changes, these mirrors must be
// updated together.

import { describe, it, expect } from 'vitest';

type PermanentSide = 'front' | 'left' | 'right' | 'back';
type LineArrays = {
  santas: unknown[];
  gingerbread: unknown[];
  c9: unknown[];
  stake: unknown[];
  bistro: unknown[];
  permanentSides: Record<PermanentSide, unknown[]>;
};

const EMPTY_LINES: LineArrays = {
  santas: [],
  gingerbread: [],
  c9: [],
  stake: [],
  bistro: [],
  permanentSides: { front: [], left: [], right: [], back: [] },
};

// Mirrors applyPulledSatellite's `hasAnyLines` check.
function hasAnyLines(s: LineArrays): boolean {
  return (
    s.santas.length > 0 ||
    s.gingerbread.length > 0 ||
    s.c9.length > 0 ||
    s.stake.length > 0 ||
    s.bistro.length > 0 ||
    (['front', 'left', 'right', 'back'] as const).some((side) => s.permanentSides[side].length > 0)
  );
}

// Mirrors applyPulledSatellite's confirm-gated apply: any line drawn ->
// window.confirm; decline -> return unapplied with nothing touched; accept
// (or nothing was drawn) -> apply, clearing every line array first.
function confirmAndApply(
  lines: LineArrays,
  confirmFn: () => boolean,
): { applied: boolean; linesAfter: LineArrays } {
  if (hasAnyLines(lines)) {
    if (!confirmFn()) return { applied: false, linesAfter: lines };
    return { applied: true, linesAfter: EMPTY_LINES };
  }
  return { applied: true, linesAfter: lines };
}

describe('applyPulledSatellite — gap 1 (HIGH money): re-pull with lines present', () => {
  it('a fresh quote with nothing drawn never prompts, and applies silently', () => {
    let confirmCalled = false;
    const result = confirmAndApply(EMPTY_LINES, () => {
      confirmCalled = true;
      return true;
    });
    expect(confirmCalled).toBe(false);
    expect(result.applied).toBe(true);
    expect(result.linesAfter).toEqual(EMPTY_LINES);
  });

  it('detects a non-empty array independently for EACH satellite line type (santas/gingerbread/C9/stake/bistro/permanentSat)', () => {
    expect(hasAnyLines({ ...EMPTY_LINES, santas: [{}] })).toBe(true);
    expect(hasAnyLines({ ...EMPTY_LINES, gingerbread: [{}] })).toBe(true);
    expect(hasAnyLines({ ...EMPTY_LINES, c9: [{}] })).toBe(true);
    expect(hasAnyLines({ ...EMPTY_LINES, stake: [{}] })).toBe(true);
    expect(hasAnyLines({ ...EMPTY_LINES, bistro: [{}] })).toBe(true);
    expect(
      hasAnyLines({ ...EMPTY_LINES, permanentSides: { front: [], left: [{}], right: [], back: [] } }),
    ).toBe(true);
  });

  it('cancel on the replace-confirm is a total no-op — applied:false, lines untouched (same reference)', () => {
    const lines: LineArrays = { ...EMPTY_LINES, santas: [{ ft: 40 }] };
    const result = confirmAndApply(lines, () => false);
    expect(result.applied).toBe(false);
    expect(result.linesAfter).toBe(lines); // reference-equal — nothing cleared
  });

  it('confirm on the replace-confirm clears EVERY line array before applying, preventing stale-lines-x-new-scale', () => {
    const lines: LineArrays = {
      santas: [{ ft: 40 }],
      gingerbread: [{ ft: 20 }],
      c9: [{ ft: 10 }],
      stake: [{ ft: 5 }],
      bistro: [{ ft: 15 }],
      permanentSides: { front: [{ ft: 30 }], left: [{ ft: 25 }], right: [], back: [] },
    };
    const result = confirmAndApply(lines, () => true);
    expect(result.applied).toBe(true);
    expect(result.linesAfter).toEqual(EMPTY_LINES);
  });
});

describe('applyPulledSatellite — gap 3 (MED staff/portal): persist to an EXISTING design directly', () => {
  // Mirrors applyPulledSatellite's designIdRef.current branch (itself mirrors
  // handleSatelliteSelect's identical branch): push directly when a design
  // already exists; park (and stamp the pull address) only when it doesn't.
  function routeSatelliteContext(
    designId: string | null,
    satCtx: { satelliteBase64: string; satelliteMediaType: string; satelliteFeetPerPixel: number | null },
    pulledForAddress: string,
    pending: Record<string, unknown> | null,
  ): { pushedTo: string | null; parked: Record<string, unknown> | null; stampedAddress: string | null } {
    if (designId) {
      return { pushedTo: designId, parked: pending, stampedAddress: null };
    }
    return {
      pushedTo: null,
      parked: { ...(pending ?? {}), ...satCtx },
      stampedAddress: pulledForAddress,
    };
  }

  it('a design already exists (reopened quote, or a photo was already analyzed this session) — pushes directly, nothing parked', () => {
    const satCtx = { satelliteBase64: 'sat-b64', satelliteMediaType: 'image/png', satelliteFeetPerPixel: 0.05 };
    const result = routeSatelliteContext('design-123', satCtx, '123 Main St', null);
    expect(result.pushedTo).toBe('design-123');
    expect(result.parked).toBeNull();
  });

  it('no design yet — parks the context and stamps the pull address (existing #204 behavior, unchanged)', () => {
    const satCtx = { satelliteBase64: 'sat-b64', satelliteMediaType: 'image/png', satelliteFeetPerPixel: 0.05 };
    const result = routeSatelliteContext(null, satCtx, '123 Main St', null);
    expect(result.pushedTo).toBeNull();
    expect(result.parked).toEqual(satCtx);
    expect(result.stampedAddress).toBe('123 Main St');
  });

  it('no design yet, something already parked (e.g. an earlier manual satellite upload) — merges rather than clobbers', () => {
    const satCtx = { satelliteBase64: 'sat-b64-new', satelliteMediaType: 'image/png', satelliteFeetPerPixel: 0.05 };
    const result = routeSatelliteContext(null, satCtx, '123 Main St', { analysis: { notes: 'x' } });
    expect(result.parked).toEqual({ analysis: { notes: 'x' }, ...satCtx });
  });
});
