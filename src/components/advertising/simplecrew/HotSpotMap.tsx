'use client';

// The whole-island map where Naldo marks WHERE TO GO and WHERE NOT TO
// (2026-09-01). Deliberately built in the app rather than as an artifact:
// an artifact's sandbox blocks external hosts, so it cannot load map tiles,
// and a map of Long Island drawn from embedded geometry is neither pannable
// nor small. Here Leaflet and OpenStreetMap tiles are already in use by the
// placement map, so panning and zooming the real island is free.
//
// Tap the map to drop a spot. A spot is a point, or a point with a radius
// when it means a whole area, which is far easier to place from a phone
// than tracing an outline.

import { useCallback, useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';

import { SC } from './ui';

type Mark = {
  id: string;
  kind: 'hotspot' | 'avoid';
  label: string;
  note: string | null;
  lat: number;
  lng: number;
  radiusM: number | null;
  active: boolean;
  createdAt: string;
};

type Pending = { lat: number; lng: number };

// The island, from the city line out to Montauk, so the first view is the
// whole territory rather than wherever the crew happened to work last.
const ISLAND_CENTER: [number, number] = [40.79, -73.13];
const ISLAND_ZOOM = 9;

const COLOR = { hotspot: SC.ok, avoid: SC.danger } as const;

export default function HotSpotMap() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const layerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);

  const [marks, setMarks] = useState<Mark[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pending, setPending] = useState<Pending | null>(null);
  const [kind, setKind] = useState<'hotspot' | 'avoid'>('hotspot');
  const [label, setLabel] = useState('');
  const [radius, setRadius] = useState('');

  // Reload by bumping a counter rather than calling an async function from
  // inside the effect: the fetch lives in the effect, the same shape the
  // sibling screens use, so no state is set synchronously during render.
  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/advertising/map-marks');
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load the map spots.');
          return;
        }
        setMarks(((await res.json()) as { marks: Mark[] }).marks);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load the map spots.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Build the map once. Leaflet is imported lazily because it touches window.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled || !ref.current || mapRef.current) return;
      leafletRef.current = L;
      const map = L.map(ref.current, { attributionControl: true }).setView(ISLAND_CENTER, ISLAND_ZOOM);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      layerRef.current = L.layerGroup().addTo(map);
      map.on('click', (evt: import('leaflet').LeafletMouseEvent) => {
        setPending({ lat: evt.latlng.lat, lng: evt.latlng.lng });
        setLabel('');
        setRadius('');
      });
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Redraw the pins whenever the list or the pending tap changes.
  useEffect(() => {
    const L = leafletRef.current;
    const layer = layerRef.current;
    if (!L || !layer) return;
    layer.clearLayers();

    for (const m of marks) {
      if (!m.active) continue;
      const color = COLOR[m.kind];
      if (m.radiusM) {
        L.circle([m.lat, m.lng], {
          radius: m.radiusM,
          color,
          fillColor: color,
          fillOpacity: 0.15,
          weight: 2,
        })
          .bindPopup(popupText(m))
          .addTo(layer);
      }
      L.circleMarker([m.lat, m.lng], {
        radius: 7,
        color: '#FFFFFF',
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindPopup(popupText(m))
        .addTo(layer);
    }

    if (pending) {
      L.circleMarker([pending.lat, pending.lng], {
        radius: 9,
        color: SC.text,
        weight: 2,
        dashArray: '3 3',
        fillColor: SC.gold,
        fillOpacity: 0.9,
      }).addTo(layer);
    }
  }, [marks, pending]);

  const save = useCallback(async () => {
    if (!pending) return;
    const name = label.trim();
    if (!name) return;
    const radiusM = radius.trim() ? Number(radius.trim()) : null;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/advertising/map-marks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, label: name, lat: pending.lat, lng: pending.lng, radiusM }),
      });
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(payload?.error ?? 'Could not save that spot.');
        return;
      }
      setNotice(`${kind === 'hotspot' ? 'Hot spot' : 'Avoid area'} saved: ${name}`);
      setPending(null);
      setLabel('');
      setRadius('');
      load();
    } catch {
      setError('Could not save that spot.');
    } finally {
      setBusy(false);
    }
  }, [pending, label, radius, kind, load]);

  const retire = useCallback(
    async (m: Mark) => {
      if (!window.confirm(`Remove "${m.label}" from the crew's map? The record that it was tried is kept.`)) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/advertising/map-marks?id=${encodeURIComponent(m.id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? 'Could not remove that spot.');
          return;
        }
        setNotice(`Removed ${m.label}.`);
        load();
      } catch {
        setError('Could not remove that spot.');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const live = marks.filter((m) => m.active);
  const hotspots = live.filter((m) => m.kind === 'hotspot');
  const avoids = live.filter((m) => m.kind === 'avoid');

  return (
    <div className="pb-6">
      <p className="px-5 pb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        Where to go, where not to
      </p>
      <p className="px-5 pb-3 text-sm" style={{ color: SC.muted }}>
        Tap anywhere on the island to drop a spot. Give it a name the crew will understand. Add a radius when
        you mean a whole area rather than one corner.
      </p>

      {error && (
        <p className="mx-5 mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="mx-5 mb-3 rounded-xl px-4 py-3 text-sm" style={{ background: '#EAF3E7', color: SC.text }}>
          {notice}
        </p>
      )}

      <div className="mx-4 overflow-hidden rounded-2xl border" style={{ borderColor: '#DCD4BE' }}>
        <div ref={ref} style={{ height: '58svh', minHeight: 320, width: '100%' }} />
      </div>

      {pending && (
        <div className="mx-4 mt-3 rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-base font-semibold" style={{ color: SC.text }}>
            New spot at {pending.lat.toFixed(5)}, {pending.lng.toFixed(5)}
          </p>

          <div className="mt-3 flex gap-2">
            {(['hotspot', 'avoid'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className="min-h-[44px] flex-1 rounded-full px-4 text-base font-semibold"
                style={{
                  background: kind === k ? (k === 'hotspot' ? SC.ok : SC.danger) : '#EDE6D4',
                  color: kind === k ? '#F4EFE6' : SC.text,
                }}
              >
                {k === 'hotspot' ? 'Send them here' : 'Keep them out'}
              </button>
            ))}
          </div>

          <label className="mt-3 flex flex-col gap-1">
            <span className="text-sm font-semibold" style={{ color: SC.text }}>
              Name
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Route 110 and Conklin, north-east corner"
              className="min-h-[48px] rounded-xl px-3 text-base"
              style={{ background: '#F7F3E8', color: SC.text }}
            />
          </label>

          <label className="mt-3 flex flex-col gap-1">
            <span className="text-sm font-semibold" style={{ color: SC.text }}>
              Radius in metres (optional)
            </span>
            <input
              value={radius}
              onChange={(e) => setRadius(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder="Leave empty for a single spot"
              className="min-h-[48px] rounded-xl px-3 text-base"
              style={{ background: '#F7F3E8', color: SC.text }}
            />
          </label>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy || !label.trim()}
              onClick={() => void save()}
              className="min-h-[52px] flex-1 rounded-full px-6 text-lg font-semibold shadow-sm disabled:opacity-40"
              style={{ background: SC.primaryDeep, color: '#F4EFE6' }}
            >
              {busy ? 'Saving…' : 'Save this spot'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPending(null)}
              className="min-h-[52px] rounded-full px-6 text-lg font-semibold disabled:opacity-40"
              style={{ background: '#EDE6D4', color: SC.text }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <MarkList title="Send them here" marks={hotspots} loaded={loaded} onRetire={retire} busy={busy} />
      <MarkList title="Keep them out" marks={avoids} loaded={loaded} onRetire={retire} busy={busy} />
    </div>
  );
}

function popupText(m: Mark): string {
  const where = m.radiusM ? `${m.label} · within ${m.radiusM}m` : m.label;
  return m.kind === 'hotspot' ? `Go: ${where}` : `Avoid: ${where}`;
}

function MarkList({
  title,
  marks,
  loaded,
  busy,
  onRetire,
}: {
  title: string;
  marks: Mark[];
  loaded: boolean;
  busy: boolean;
  onRetire: (m: Mark) => void;
}) {
  return (
    <div className="mt-5 px-4">
      <p className="pb-1 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        {title} · {marks.length}
      </p>
      {loaded && marks.length === 0 && (
        <p className="py-2 text-sm" style={{ color: SC.muted }}>
          Nothing marked yet.
        </p>
      )}
      {marks.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-3 border-b py-2" style={{ borderColor: '#F1EBDB' }}>
          <span>
            <span className="block text-base" style={{ color: SC.text }}>
              {m.label}
            </span>
            <span className="block text-xs" style={{ color: SC.muted }}>
              {m.lat.toFixed(4)}, {m.lng.toFixed(4)}
              {m.radiusM ? ` · ${m.radiusM}m around` : ''}
            </span>
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onRetire(m)}
            className="rounded-full border px-4 py-2 text-sm disabled:opacity-40"
            style={{ borderColor: '#DCD4BE', color: SC.muted }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
