// #51 — Pure selection logic for the portal satellite roof view. Given the
// traced roofline lines, returns the drawable line groups (in render order) for
// both the SVG overlay and the legend. A group is kept only when it has at least
// one polyline with >= 2 points, so a color never appears without a line on the
// image. Kept here (testable, no JSX) following the src/lib/portal/* convention.

import type { PortalSatelliteLine, PortalSatelliteLines } from '@/components/portal/types';

export type SatelliteLineGroup = {
  key: 'santas' | 'gingerbread' | 'c9';
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
): SatelliteLineGroup[] {
  if (!lines) return [];
  const groups: SatelliteLineGroup[] = [
    { key: 'santas', color: '#ef4444', label: 'Santa Roofline', lines: lines.santas ?? [] },
    { key: 'gingerbread', color: '#3b82f6', label: 'Gingerbread', lines: lines.gingerbread ?? [] },
    { key: 'c9', color: '#10b981', label: 'C9 roofline', lines: lines.c9 ?? [] },
  ];
  return groups
    .map((g) => ({ ...g, lines: (g.lines ?? []).filter(isDrawable) }))
    .filter((g) => g.lines.length > 0);
}
