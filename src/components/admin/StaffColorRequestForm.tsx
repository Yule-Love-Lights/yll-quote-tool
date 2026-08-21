'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CUSTOM_SCHEME_ID,
  DEFAULT_COLOR_SCHEME_ID,
  MAX_CUSTOM_PATTERN,
  isKnownColorSchemeId,
  sanitizeCustomPattern,
  type ColorScheme,
} from '@/lib/design/colorSchemes';

type StaffColorRequestFormProps = {
  quoteId: string;
  schemes: ColorScheme[];
  buildableColorIds: string[];
  colors: { id: string; label: string; hex: string }[];
  initialColorSchemeId?: string;
  initialCustomPattern?: string[];
};

export function resolveStaffColorState(
  initialColorSchemeId: string | undefined,
  initialCustomPattern: string[] | undefined,
  schemes: ColorScheme[],
  buildableColorIds: string[],
): { schemeId: string; pattern: string[] } {
  if (!initialColorSchemeId || !isKnownColorSchemeId(initialColorSchemeId, schemes)) {
    return { schemeId: DEFAULT_COLOR_SCHEME_ID, pattern: [] };
  }
  if (initialColorSchemeId === CUSTOM_SCHEME_ID) {
    const pattern = sanitizeCustomPattern(initialCustomPattern, buildableColorIds);
    return pattern.length > 0
      ? { schemeId: CUSTOM_SCHEME_ID, pattern }
      : { schemeId: DEFAULT_COLOR_SCHEME_ID, pattern: [] };
  }
  return { schemeId: initialColorSchemeId, pattern: [] };
}

export async function submitStaffColorRequest(
  quoteId: string,
  colorSchemeId: string,
  customPattern: string[],
  request: typeof fetch = fetch,
): Promise<{ label: string }> {
  const res = await request(`/api/quotes/${quoteId}/color-change-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ colorSchemeId, customPattern, onlyIfNoPending: true }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; label?: unknown };
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'Could not record the colour request');
  }
  return { label: typeof body.label === 'string' ? body.label : 'the selected colour' };
}

export function StaffColorRequestForm({
  quoteId,
  schemes,
  buildableColorIds,
  colors,
  initialColorSchemeId,
  initialCustomPattern,
}: StaffColorRequestFormProps) {
  const router = useRouter();
  const initial = resolveStaffColorState(
    initialColorSchemeId,
    initialCustomPattern,
    schemes,
    buildableColorIds,
  );
  const [colorSchemeId, setColorSchemeId] = useState(initial.schemeId);
  const [customPattern, setCustomPattern] = useState(initial.pattern);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const submitInFlight = useRef(false);
  const customActive = colorSchemeId === CUSTOM_SCHEME_ID;
  const colorCatalog = new Map(colors.map((color) => [color.id, color]));
  const colorDetails = (id: string) => colorCatalog.get(id) ?? { id, label: id, hex: '#9ca3af' };

  async function submit() {
    if (submitInFlight.current) return;
    submitInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await submitStaffColorRequest(quoteId, colorSchemeId, customPattern);
      setSavedLabel(result.label);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the colour request');
    } finally {
      submitInFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
        Record customer colour request
      </h2>
      <p className="text-sm text-gray-700 mb-3">
        If the customer tells you by phone or text, choose what they asked for here. This creates the
        same pending request as the customer portal. It does not change the booked order until staff
        applies it.
      </p>
      <label className="block text-xs font-medium text-gray-600 mb-1" htmlFor="staff-color-scheme">
        Requested colour
      </label>
      <select
        id="staff-color-scheme"
        value={colorSchemeId}
        onChange={(event) => {
          const next = event.target.value;
          setColorSchemeId(next);
          if (next !== CUSTOM_SCHEME_ID) setCustomPattern([]);
        }}
        disabled={busy || savedLabel != null}
        className="w-full max-w-sm border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100"
      >
        {schemes.map((scheme) => (
          <option key={scheme.id} value={scheme.id}>{scheme.label}</option>
        ))}
        <option value={CUSTOM_SCHEME_ID}>Build a custom pattern</option>
      </select>

      {customActive && (
        <div className="mt-3">
          <p className="text-xs text-gray-600 mb-2">
            Pattern order. Add the same colour more than once when the bulb sequence repeats it.
          </p>
          {customPattern.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {customPattern.map((id, index) => {
                const color = colorDetails(id);
                return (
                  <button
                    key={`${id}-${index}`}
                    type="button"
                    onClick={() => setCustomPattern((pattern) => pattern.filter((_, i) => i !== index))}
                    disabled={busy || savedLabel != null}
                    aria-label={`Remove ${color.label} at position ${index + 1}`}
                    className="inline-flex items-center gap-1.5 border border-gray-300 rounded-full px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    <span
                      aria-hidden
                      className="w-3 h-3 rounded-full ring-1 ring-gray-300"
                      style={{ background: color.hex }}
                    />
                    {index + 1}. {color.label} ×
                  </button>
                );
              })}
            </div>
          )}
          <label className="sr-only" htmlFor="staff-custom-color">Add a colour to the pattern</label>
          <select
            id="staff-custom-color"
            value=""
            onChange={(event) => {
              const id = event.target.value;
              if (id && customPattern.length < MAX_CUSTOM_PATTERN) {
                setCustomPattern((pattern) => [...pattern, id]);
              }
            }}
            disabled={busy || savedLabel != null || customPattern.length >= MAX_CUSTOM_PATTERN}
            className="w-full max-w-sm border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 disabled:bg-gray-100"
          >
            <option value="">Add a colour…</option>
            {buildableColorIds.map((id) => {
              const color = colorDetails(id);
              return <option key={id} value={id}>{color.label}</option>;
            })}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {customPattern.length}/{MAX_CUSTOM_PATTERN} colours
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || savedLabel != null || (customActive && customPattern.length === 0)}
        className="mt-4 bg-gray-900 text-white text-sm rounded px-3 py-2 disabled:opacity-50"
      >
        {busy ? 'Recording…' : savedLabel ? 'Request recorded' : 'Record colour request'}
      </button>
      {savedLabel && (
        <p role="status" className="text-xs text-green-700 mt-2">
          Recorded {savedLabel}. Loading the apply/dismiss controls…
        </p>
      )}
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
