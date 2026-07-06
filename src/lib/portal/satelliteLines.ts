// #51 — Pure selection logic for the portal satellite roof view. Given the
// traced roofline lines, returns the drawable line groups (in render order) for
// both the SVG overlay and the legend. A group is kept only when it has at least
// one polyline with >= 2 points, so a color never appears without a line on the
// image. Kept here (testable, no JSX) following the src/lib/portal/* convention.

import type { PortalSatelliteLine, PortalSatelliteLines } from '@/components/portal/types';

export type SatelliteLineGroup = {
  key: 'santas' | 'gingerbread' | 'c9' | 'stake';
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
    { key: 'c9', color: '#10b981', label: labelOverrides?.c9 ?? 'C9 roofline', lines: lines.c9 ?? [] },
    { key: 'stake', color: '#a855f7', label: labelOverrides?.stake ?? 'Stake Lighting', lines: lines.stake ?? [] },
  ];
  const allowedSet = allowedKeys ? new Set(allowedKeys) : null;
  return groups
    .filter((g) => !allowedSet || allowedSet.has(g.key))
    .map((g) => ({ ...g, lines: (g.lines ?? []).filter(isDrawable) }))
    .filter((g) => g.lines.length > 0);
}

// Permanent Lighting (#88) fix: the satellite trace data (santas/gingerbread/
// c9/stake) is captured once during the HOLIDAY roofline flow and is
// INDEPENDENT of which permanent strands the customer actually bought — so on
// a permanent quote the raw groups can show a roofline that was never
// installed (e.g. a front-only permanent job still drawing the holiday
// "Gingerbread" ridge/sides line). This maps the permanent line items that
// are actually BILLED on the quote to the satellite group(s) that correspond
// to the same surface, so the customer only ever sees lines for what they're
// getting. 'permanent-back' has no satellite equivalent (no group to show).
// Pure + holiday/event untouched (only called for serviceType === 'permanent').
export function permanentAllowedSatelliteKeys(
  lineItemIds: string[],
): SatelliteLineGroup['key'][] {
  const idSet = new Set(lineItemIds);
  const keys: SatelliteLineGroup['key'][] = [];
  if (idSet.has('permanent-front')) keys.push('santas');
  if (idSet.has('permanent-sides')) keys.push('gingerbread');
  return keys;
}
