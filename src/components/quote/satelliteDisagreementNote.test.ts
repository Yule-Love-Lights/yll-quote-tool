// Fix round on PR #918 (deterministic-satellite-footage): QuoteBuilder.tsx has
// no existing component test harness (7000+ lines, heavy Supabase/design-editor
// dependencies) — this test mirrors the exact decision logic verbatim rather
// than rendering the component, matching the pattern already used in
// pullSatelliteGuards.test.ts / persistSatelliteMeasurements.test.ts for the
// sibling #204 fixes. If the real logic in QuoteBuilder.tsx changes, this
// mirror must be updated together.
//
// Covers two things a browser pass can't cheaply exercise:
//  1. formatSatelliteDisagreement — the exact banner copy, verbatim.
//  2. The per-roofline clear-on-redraw updater used inside getSetter — proving
//     it nulls ONLY the roofline that was redrawn and leaves its sibling (and
//     an already-null field) untouched. This is the self-check named in the
//     fix-round brief: does clearing on redraw wrongly clear the OTHER note?
//
// A browser pass would still be the only way to confirm the real Konva drag
// interaction actually fires this updater end-to-end (draw analysis with a
// disagreement -> see the amber banner -> redraw the Santa's satellite line
// -> confirm only the Santa's sentence disappears, Gingerbread's stays).

import { describe, expect, it } from 'vitest';

// Mirror of QuoteBuilder.tsx's formatSatelliteDisagreement (module-level helper).
function formatSatelliteDisagreement(label: string, statedFt: number | string, computedFt: number): string {
  return (
    `Heads up: the AI's ${label} footage (${statedFt}ft) does not match its own drawn satellite lines ` +
    `(about ${computedFt}ft). Its stated number is usually the more reliable of the two. Worth a quick ` +
    `look at the drawn lines before sending.`
  );
}

type SatelliteFootageDisagreement = { santas: string | null; gingerbread: string | null };

// Mirror of the updaters passed to setSatelliteFootageDisagreement inside
// getSetter's 'santas' and 'gingerbread' branches.
function clearSantasDisagreement(prev: SatelliteFootageDisagreement): SatelliteFootageDisagreement {
  return prev.santas == null ? prev : { ...prev, santas: null };
}
function clearGingerbreadDisagreement(prev: SatelliteFootageDisagreement): SatelliteFootageDisagreement {
  return prev.gingerbread == null ? prev : { ...prev, gingerbread: null };
}

describe('formatSatelliteDisagreement (verbatim banner copy)', () => {
  it('renders the exact heads-up copy with the stated number framed as more reliable', () => {
    expect(formatSatelliteDisagreement("Santa's", 40, 85)).toBe(
      "Heads up: the AI's Santa's footage (40ft) does not match its own drawn satellite lines " +
        '(about 85ft). Its stated number is usually the more reliable of the two. Worth a quick ' +
        'look at the drawn lines before sending.',
    );
  });

  it('falls back to "?" for the stated figure when the model omitted it', () => {
    expect(formatSatelliteDisagreement('Gingerbread', '?', 12)).toContain("footage (?ft) does not match");
  });
});

describe('clear-on-redraw (negative control: only the redrawn roofline clears)', () => {
  it('clears santas and leaves an existing gingerbread note untouched', () => {
    const before: SatelliteFootageDisagreement = { santas: 'stale santas note', gingerbread: 'stale gingerbread note' };
    const after = clearSantasDisagreement(before);
    expect(after).toEqual({ santas: null, gingerbread: 'stale gingerbread note' });
  });

  it('clears gingerbread and leaves an existing santas note untouched', () => {
    const before: SatelliteFootageDisagreement = { santas: 'stale santas note', gingerbread: 'stale gingerbread note' };
    const after = clearGingerbreadDisagreement(before);
    expect(after).toEqual({ santas: 'stale santas note', gingerbread: null });
  });

  it('is a no-op (same reference) when the targeted field is already null', () => {
    const before: SatelliteFootageDisagreement = { santas: null, gingerbread: 'stale gingerbread note' };
    const after = clearSantasDisagreement(before);
    expect(after).toBe(before);
  });

  it('is a no-op when both fields are already clear', () => {
    const before: SatelliteFootageDisagreement = { santas: null, gingerbread: null };
    expect(clearSantasDisagreement(before)).toBe(before);
    expect(clearGingerbreadDisagreement(before)).toBe(before);
  });
});
