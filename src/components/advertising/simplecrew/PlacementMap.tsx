'use client';

// Leaflet map for the replica's Map View screens: placement pins over OSM
// tiles (no Google key in the client). Client-only; leaflet is imported
// dynamically because it touches `window` at module load.

import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

import { SC } from './ui';

export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  label?: string;
  status?: string;
};

const STATUS_COLOR: Record<string, string> = {
  accepted: SC.ok,
  rejected: SC.danger,
  pending: SC.primary,
  resubmitted: SC.gold,
  // A voided row is dead: never the green "this paid" pin, whatever status
  // history it carries (delta-verify HIGH on this PR's fix round — the chips
  // were fixed and the MAP was not).
  voided: '#9A958A',
};

export default function PlacementMap({
  markers,
  height = 320,
  onMarkerClick,
}: {
  markers: MapMarker[];
  height?: number | string;
  onMarkerClick?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !ref.current) return;

      if (!mapRef.current) {
        mapRef.current = L.map(ref.current, { zoomControl: false, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19,
        }).addTo(mapRef.current);
      }
      const map = mapRef.current;

      // Reset markers on every render pass.
      map.eachLayer((layer) => {
        if (layer instanceof L.Marker) map.removeLayer(layer);
      });

      const pts = markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng));
      for (const m of pts) {
        const color = STATUS_COLOR[m.status ?? 'pending'] ?? SC.primary;
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 24],
        });
        const marker = L.marker([m.lat, m.lng], { icon, title: m.label }).addTo(map);
        if (onMarkerClick) marker.on('click', () => onMarkerClick(m.id));
        if (m.label) marker.bindPopup(m.label);
      }

      if (pts.length === 1) {
        map.setView([pts[0].lat, pts[0].lng], 15);
      } else if (pts.length > 1) {
        map.fitBounds(L.latLngBounds(pts.map((m) => [m.lat, m.lng] as [number, number])), {
          padding: [36, 36],
          maxZoom: 16,
        });
      } else {
        map.setView([40.73, -73.42], 10); // Long Island default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [markers, onMarkerClick]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  return <div ref={ref} style={{ height, width: '100%' }} />;
}
