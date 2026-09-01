'use client';

// The fleet map (Naldo, 2026-08-28: "I just want a physical map here").
// This wrapper exists so the server component page can render a map without
// ever evaluating leaflet on the server: next/dynamic with ssr:false defers
// the real map (FleetMapInner) to the browser. The placeholder keeps the
// layout stable while the chunk loads.

import dynamic from 'next/dynamic';

export type FleetMapPin = {
  id: string;
  label: string;
  lat: number;
  lng: number;
  signal: 'live' | 'stale';
  /** Already formatted for display, e.g. "7:09 AM". */
  seenLabel: string;
};

const FleetMapInner = dynamic(() => import('./FleetMapInner'), {
  ssr: false,
  loading: () => (
    <div
      className="h-80 w-full rounded-lg border border-gray-200 mb-4 flex items-center justify-center text-sm text-gray-400"
      aria-label="Map of vehicle positions"
    >
      Loading map
    </div>
  ),
});

export function FleetMap(props: { pins: FleetMapPin[]; depot: { lat: number; lng: number } }) {
  return <FleetMapInner {...props} />;
}
