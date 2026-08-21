'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DesignPortalVisibility } from '@/lib/designs';

type VisibilityKind = 'street' | 'satellite';
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function portalVisibilityPatch(
  kind: VisibilityKind,
  visible: boolean,
): Partial<DesignPortalVisibility> {
  return kind === 'street'
    ? { portalShowStreetView: visible }
    : { portalShowSatelliteView: visible };
}

export async function persistPortalImageVisibility(
  designId: string,
  patch: Partial<DesignPortalVisibility>,
  request: FetchLike = fetch,
): Promise<DesignPortalVisibility> {
  const response = await request(`/api/designs/${designId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error === 'string' ? body.error : 'Could not update customer portal images',
    );
  }
  if (
    typeof body?.portalShowStreetView !== 'boolean' ||
    typeof body.portalShowSatelliteView !== 'boolean'
  ) {
    throw new Error('Could not confirm customer portal image settings');
  }
  return {
    portalShowStreetView: body.portalShowStreetView,
    portalShowSatelliteView: body.portalShowSatelliteView,
  };
}

export function PortalImageVisibilityControls({
  designId,
  portalShowStreetView,
  portalShowSatelliteView,
  hasStreetImage,
  hasSatelliteImage,
}: DesignPortalVisibility & {
  designId: string;
  hasStreetImage: boolean;
  hasSatelliteImage: boolean;
}) {
  const router = useRouter();
  const [visibility, setVisibility] = useState({
    street: portalShowStreetView,
    satellite: portalShowSatelliteView,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    setVisibility({
      street: portalShowStreetView,
      satellite: portalShowSatelliteView,
    });
  }, [portalShowStreetView, portalShowSatelliteView]);

  async function setPortalVisibility(kind: VisibilityKind, visible: boolean) {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const previous = visibility;
    setVisibility({ ...previous, [kind]: visible });
    setBusy(true);
    setError(null);
    try {
      const saved = await persistPortalImageVisibility(
        designId,
        portalVisibilityPatch(kind, visible),
      );
      setVisibility({
        street: saved.portalShowStreetView,
        satellite: saved.portalShowSatelliteView,
      });
      router.refresh();
    } catch (err) {
      setVisibility(previous);
      setError(err instanceof Error ? err.message : 'Could not update customer portal images');
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  }

  return (
    <fieldset
      aria-busy={busy}
      className="bg-white border border-gray-200 rounded-lg p-4 mb-4"
    >
      <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500 px-1">
        Customer portal images
      </legend>
      <p className="text-sm text-gray-500 mb-3">
        Hide either view from the customer without deleting staff photos or measurements.
      </p>
      <div className="space-y-3">
        <label className={`flex items-start gap-3 ${hasStreetImage ? 'cursor-pointer' : 'text-gray-400'}`}>
          <input
            type="checkbox"
            checked={visibility.street}
            disabled={busy || !hasStreetImage}
            onChange={(event) => void setPortalVisibility('street', event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Show house design on customer portal
            </span>
            {!hasStreetImage && <span className="block text-xs">No house design image is stored.</span>}
          </span>
        </label>
        <label className={`flex items-start gap-3 ${hasSatelliteImage ? 'cursor-pointer' : 'text-gray-400'}`}>
          <input
            type="checkbox"
            checked={visibility.satellite}
            disabled={busy || !hasSatelliteImage}
            onChange={(event) => void setPortalVisibility('satellite', event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-emerald-700 focus:ring-emerald-600"
          />
          <span>
            <span className="block text-sm font-medium text-gray-800">
              Show satellite plan on customer portal
            </span>
            {!hasSatelliteImage && <span className="block text-xs">No satellite image is stored.</span>}
          </span>
        </label>
      </div>
      {busy && (
        <p role="status" aria-live="polite" className="text-xs text-gray-500 mt-3">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700 mt-3">
          {error}
        </p>
      )}
    </fieldset>
  );
}
