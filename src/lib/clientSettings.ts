'use client';

// Client-side access to the global app settings (#32). Memoizes one GET
// /api/settings per page load (the editor reads colors + defaults through the
// storage seam AND the shell applies render settings — sharing one fetch).
// Invalidate after saving on /settings so a later editor/portal mount re-reads.

import { setPalette, DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import { setRenderSettings, DEFAULT_RENDER_SETTINGS } from '@/components/design/editor-core/renderSettings';
// Type only — never import a runtime value from appSettings here (it pulls the
// server-only Supabase client into the browser bundle).
import type { AppSettings } from './appSettings';

const FALLBACK: AppSettings = {
  colors: DEFAULT_COLORS,
  defaults: {},
  render: DEFAULT_RENDER_SETTINGS,
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
