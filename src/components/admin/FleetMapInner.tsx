'use client';

// The actual Leaflet map. Loaded ONLY through FleetMap's next/dynamic wrapper
// with ssr:false — leaflet touches `window` at import time, so this module must
// never be evaluated on the server. The static import keeps the bundler's
// CommonJS interop on the well-trodden path (a dynamic import inside the
// effect hydrated flakily under Turbopack dev; measured 2026-08-28).
//
// Markers are circle markers on purpose: Leaflet's default icon images do not
// survive bundling, and a colored dot carries the signal state better anyway.
//
// Privacy note, deliberate: tile requests tell the tile server roughly which
// neighborhood is on screen (standard for any embedded map). No addresses, no
// identities, and nothing about customers is sent — the only markers are our
// own vehicles and the depot.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import type { FleetMapPin } from './FleetMap';

const LIVE_COLOR = '#15803d';
const STALE_COLOR = '#b45309';
const DEPOT_COLOR = '#6b7280';

export default function FleetMapInner({
  pins,
  depot,
}: {
  pins: FleetMapPin[];
  depot: { lat: number; lng: number };
}) {
  const ref = useRef<HTMLDivElement>(null);

  // The page auto-refreshes every 2 minutes, which hands this component a NEW
  // pins array each time even when nothing moved. Keying the effect on the
  // CONTENT keeps the map (and the operator's pan/zoom) alive across refreshes
  // that changed nothing, and rebuilds only on a real position/signal change.
  const pinsKey = JSON.stringify(pins);
  const depotKey = `${depot.lat},${depot.lng}`;

  useEffect(() => {
    if (!ref.current) return;
    let map: L.Map | null = null;
    try {
      map = L.map(ref.current, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      L.circleMarker([depot.lat, depot.lng], {
        radius: 6,
        color: DEPOT_COLOR,
        fillColor: DEPOT_COLOR,
        fillOpacity: 0.7,
      })
        .bindPopup('Depot')
        .addTo(map);

      const bounds: [number, number][] = [[depot.lat, depot.lng]];
      for (const p of pins) {
        const color = p.signal === 'live' ? LIVE_COLOR : STALE_COLOR;
        const marker = L.circleMarker([p.lat, p.lng], {
          radius: 9,
          color,
          fillColor: color,
          fillOpacity: 0.85,
        }).addTo(map);
        // Popup content built as DOM nodes, never an HTML string, so a vehicle
        // label can't inject markup.
        const el = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = p.label;
        const line = document.createElement('div');
        line.textContent =
          p.signal === 'live' ? `Live · seen ${p.seenLabel}` : `No signal since ${p.seenLabel}`;
        el.append(title, line);
        marker.bindPopup(el);
        bounds.push([p.lat, p.lng]);
      }

      if (bounds.length > 1) {
        map.fitBounds(L.latLngBounds(bounds).pad(0.3));
      } else {
        map.setView([depot.lat, depot.lng], 13);
      }
    } catch (err) {
      console.error('[FleetMap] map init failed:', err);
    }
    return () => {
      map?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pinsKey/depotKey
    // are the content of pins/depot; see the comment above the keys.
  }, [pinsKey, depotKey]);

  return (
    <div
      ref={ref}
      className="h-80 w-full rounded-lg border border-gray-200 mb-4"
      aria-label="Map of vehicle positions"
    />
  );
}
