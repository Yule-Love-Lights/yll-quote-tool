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
// deletion is refused.
//
// FIRST CUT WAS WRONG, and the mistake is worth keeping written down. It
// treated each channel as `number[][][]` — an array of polylines of points.
// The real shape is an array of SEGMENTS, `{ points, label, feature?, id? }[]`
// (see DesignSatelliteLines). Every point-level comparison silently fell
// through the `Array.isArray` branch, so the function compared nothing but the
// NUMBER of lines per channel: dragging a point, or inserting one into an
// existing line, both reported "identical" and would have sailed through the
// freeze. Worse, the tests were written against the same wrong shape, so they
// passed. A premerge lens found it by running the real shape through the real
// function rather than reading either.
//
// Compared with a tolerance rather than by JSON identity: coordinates are
// normalized 0-1 doubles that round-trip through JSON and jsonb, and a false
// INEQUALITY here is the failure Jason ruled against — it would refuse a
// re-Calculate that changed nothing. EPSILON is far below any edit a person can
// make by dragging a point and far above any representation wobble.

import type { DesignSatelliteLines } from '@/lib/designs';

const EPSILON = 1e-6;

/** Every channel a trace can carry — holiday, permanent sides, and bistro. */
const CHANNELS = [
  'santas', 'gingerbread', 'c9', 'stake',
  'front', 'left', 'right', 'back', 'bistro',
] as const;

type Segment = { points?: unknown; label?: unknown };

function asSegments(v: unknown): Segment[] {
  // A missing channel and an empty one both mean "nothing drawn here", so both
  // normalize to []. Otherwise a client that omits a channel it never uses
  // would read as an edit on every save.
  return Array.isArray(v) ? (v as Segment[]) : [];
}

function pointsEqual(a: unknown, b: unknown): boolean {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const pa = aa[i];
    const pb = bb[i];
    if (!Array.isArray(pa) || !Array.isArray(pb)) {
      // Not the expected [x, y] pair — fall back to strict inequality rather
      // than declaring two shapes we do not understand to be the same.
      if (pa !== pb) return false;
      continue;
    }
    if (pa.length !== pb.length) return false;
    for (let k = 0; k < pa.length; k++) {
      const na = pa[k];
      const nb = pb[k];
      if (typeof na !== 'number' || typeof nb !== 'number' || Number.isNaN(na) || Number.isNaN(nb)) {
        if (na !== nb) return false;
        continue;
      }
      if (Math.abs(na - nb) > EPSILON) return false;
    }
  }
  return true;
}

function segmentsEqual(a: unknown, b: unknown): boolean {
  const aa = asSegments(a);
  const bb = asSegments(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const sa = aa[i] ?? {};
    const sb = bb[i] ?? {};
    // `label` is compared because the portal renders it (selectDrawableLineGroups
    // groups and titles by it) — renaming a run changes what the customer sees.
    // `feature` and `id` are deliberately NOT compared: neither reaches the
    // portal drawing, and an id that changes on a rebuild while the geometry is
    // identical must not read as an edit (that would be the false inequality
    // this whole approach exists to avoid).
    if ((sa.label ?? null) !== (sb.label ?? null)) return false;
    if (!pointsEqual(sa.points, sb.points)) return false;
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
  return CHANNELS.every((c) => segmentsEqual(s[c], n[c]));
}
