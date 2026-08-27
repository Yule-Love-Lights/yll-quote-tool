// Row 427 — is this satellite-trace write an actual CHANGE, or the same lines
// coming back?
//
// Jason's ruling, 2026-08-27: the satellite trace must NOT be frozen after
// approval, because an ordinary re-Calculate on an approved quote re-persists
// the lines it already has and a blanket gate would break it. The premerge
// staff lens then showed the other half: the trace is hand-editable and the
// portal renders it, so staff can REDRAW or DELETE the roofline a customer
// approved and Calculate pushes that to their portal silently.
//
// Both are satisfied by asking a narrower question than "is this quote
// frozen?": is this write actually different? Identical lines pass untouched,
// so re-Calculate keeps working exactly as it does today; a redraw or a
// deletion is refused. Nothing else about the freeze changes.
//
// Compared with a tolerance rather than by JSON identity: coordinates are
// normalized 0-1 doubles that round-trip through JSON and jsonb, and a
// false INEQUALITY here is the failure Jason ruled against — it would refuse a
// re-Calculate that changed nothing. EPSILON is far below any edit a person
// can make by dragging a point (1e-6 of the image's width is a small fraction
// of one pixel) and far above any representation wobble.

import type { DesignSatelliteLines } from '@/lib/designs';

const EPSILON = 1e-6;

/** Every channel a trace can carry — holiday, permanent sides, and bistro. */
const CHANNELS = [
  'santas', 'gingerbread', 'c9', 'stake',
  'front', 'left', 'right', 'back', 'bistro',
] as const;

type Poly = number[][];

function asPolys(v: unknown): Poly[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return null;
  return v as Poly[];
}

function polysEqual(a: Poly[] | null, b: Poly[] | null): boolean {
  // A missing channel and an empty one both mean "nothing drawn here", so they
  // must compare equal — otherwise a client that omits a channel it never uses
  // would read as an edit on every save.
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const pa = Array.isArray(aa[i]) ? aa[i] : [];
    const pb = Array.isArray(bb[i]) ? bb[i] : [];
    if (pa.length !== pb.length) return false;
    for (let j = 0; j < pa.length; j++) {
      const ca = Array.isArray(pa[j]) ? (pa[j] as unknown as number[]) : null;
      const cb = Array.isArray(pb[j]) ? (pb[j] as unknown as number[]) : null;
      if (!ca || !cb || ca.length !== cb.length) {
        if (typeof pa[j] === 'number' && typeof pb[j] === 'number') {
          if (Math.abs((pa[j] as unknown as number) - (pb[j] as unknown as number)) > EPSILON) return false;
          continue;
        }
        return false;
      }
      for (let k = 0; k < ca.length; k++) {
        const na = ca[k];
        const nb = cb[k];
        if (typeof na !== 'number' || typeof nb !== 'number') {
          if (na !== nb) return false;
          continue;
        }
        if (Math.abs(na - nb) > EPSILON) return false;
      }
    }
  }
  return true;
}

/**
 * True when `next` draws the same trace as `stored` — so persisting it changes
 * nothing a customer could see.
 */
export function satelliteLinesEqual(
  stored: DesignSatelliteLines | null | undefined,
  next: DesignSatelliteLines | null | undefined,
): boolean {
  const s = (stored ?? {}) as Record<string, unknown>;
  const n = (next ?? {}) as Record<string, unknown>;
  return CHANNELS.every((c) => polysEqual(asPolys(s[c]), asPolys(n[c])));
}
