'use client';

// Client-side access to the global app settings (#32). Memoizes one GET
// /api/settings per page load (the editor reads colors + defaults through the
// storage seam AND the shell applies render settings — sharing one fetch).
// Invalidate after saving on /settings so a later editor/portal mount re-reads.

import { setPalette, DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import { setRenderSettings, DEFAULT_RENDER_SETTINGS } from '@/components/design/editor-core/renderSettings';
// colorSchemes is client-safe (no server imports) — used for the swatches fallback.
import { DEFAULT_COLOR_SCHEMES, DEFAULT_BUILDABLE_COLOR_IDS } from './design/colorSchemes';
// permanent/types is client-safe (zero imports) — the permanent-rates fallback.
import { DEFAULT_PERMANENT_RATES } from './permanent/types';
// Type only — never import a runtime value from appSettings here (it pulls the
// server-only Supabase client into the browser bundle).
import type { AppSettings } from './appSettings';

const FALLBACK: AppSettings = {
  colors: DEFAULT_COLORS,
  defaults: {},
  render: DEFAULT_RENDER_SETTINGS,
  // Inlined (this client file must not import appSettings' server runtime). The
  // portal + swatch settings are read server-side on the portal page, not from
  // this cache, so these fallback values are type-satisfaction only.
  portal: { hideEarlyInstallDiscounts: false },
  swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
  permanentRates: DEFAULT_PERMANENT_RATES,
  permanentEnabled: false,
  eventEnabled: false,
};

let cache: Promise<AppSettings> | null = null;

export function fetchAppSettings(): Promise<AppSettings> {
  if (!cache) {
    cache = fetch('/api/settings')
      .then((r) => (r.ok ? (r.json() as Promise<AppSettings>) : FALLBACK))
      .catch(() => FALLBACK);
  }
  return cache;
}

// Apply the fetched palette + render settings to the editor-core globals so the
// next render reflects them. Safe to call repeatedly (idempotent per fetch).
export async function applyAppSettings(): Promise<void> {
  const s = await fetchAppSettings();
  if (Array.isArray(s.colors) && s.colors.length > 0) setPalette(s.colors);
  setRenderSettings(s.render);
}

export function invalidateAppSettings(): void {
  cache = null;
}
