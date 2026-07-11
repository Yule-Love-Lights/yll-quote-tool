// #51 — Pure selection logic for the portal satellite roof view. Given the
// traced roofline lines, returns the drawable line groups (in render order) for
// both the SVG overlay and the legend. A group is kept only when it has at least
// one polyline with >= 2 points, so a color never appears without a line on the
// image. Kept here (testable, no JSX) following the src/lib/portal/* convention.

import type { PortalSatelliteLine, PortalSatelliteLines } from '@/components/portal/types';

export type SatelliteLineGroup = {
  key: 'santas' | 'gingerbread' | 'c9' | 'stake' | 'front' | 'left' | 'right' | 'back' | 'bistro';
  color: string;
  label: string;
  lines: PortalSatelliteLine[];
};

// A polyline is only drawable when it has at least two points.
function isDrawable(line: PortalSatelliteLine): boolean {
  return Array.isArray(line?.points) && line.points.length >= 2;
}

export function selectDrawableLineGroups(
  lines: PortalSatelliteLines | null | undefined,
  allowedKeys?: SatelliteLineGroup['key'][],
  labelOverrides?: Partial<Record<SatelliteLineGroup['key'], string>>,
): SatelliteLineGroup[] {
  if (!lines) return [];
  const groups: SatelliteLineGroup[] = [
    { key: 'santas', color: '#ef4444', label: labelOverrides?.santas ?? 'Santa Roofline', lines: lines.santas ?? [] },
    { key: 'gingerbread', color: '#3b82f6', label: labelOverrides?.gingerbread ?? 'Gingerbread', lines: lines.gingerbread ?? [] },
    // The c9 satellite draw bills as Winter Wonderland (QuoteBuilder syncs it into
    // winterWonderlandFootage, holiday-only) — label it as the product, not the bulb.
    { key: 'c9', color: '#10b981', label: labelOverrides?.c9 ?? 'Winter Wonderland', lines: lines.c9 ?? [] },
    { key: 'stake', color: '#a855f7', label: labelOverrides?.stake ?? 'Stake Lighting', lines: lines.stake ?? [] },
    // Permanent Lighting (#88 / S23) — the four house sides, each its own color.
    { key: 'front', color: '#ef4444', label: labelOverrides?.front ?? 'Front of House', lines: lines.front ?? [] },
    { key: 'left', color: '#3b82f6', label: labelOverrides?.left ?? 'Left Side', lines: lines.left ?? [] },
    { key: 'right', color: '#f59e0b', label: labelOverrides?.right ?? 'Right Side', lines: lines.right ?? [] },
    { key: 'back', color: '#a855f7', label: labelOverrides?.back ?? 'Back of House', lines: lines.back ?? [] },
    // Permanent Bistro Lighting (#117) — freeform runs traced on the satellite
    // view, own channel/color (teal, matching the bistro admin badge).
    { key: 'bistro', color: '#14b8a6', label: labelOverrides?.bistro ?? 'Bistro Lights', lines: lines.bistro ?? [] },
  ];
  const allowedSet = allowedKeys ? new Set(allowedKeys) : null;
  return groups
    .filter((g) => !allowedSet || allowedSet.has(g.key))
    .map((g) => ({ ...g, lines: (g.lines ?? []).filter(isDrawable) }))
    .filter((g) => g.lines.length > 0);
}

// The permanent satellite trace uses its OWN four side channels (#88 / S23): the
// operator draws front/left/right/back on the satellite and those persist + draw
// on the portal. Any side with no drawn line is hidden by selectDrawableLineGroups,
// so passing all four is safe — only what was traced shows. (Replaced the earlier
// approach of reusing the holiday santas/gingerbread channels for permanent.)
export const PERMANENT_SIDE_SATELLITE_KEYS: SatelliteLineGroup['key'][] = [
  'front',
  'left',
  'right',
  'back',
];
