// Server-side access to the global app settings (task #32). One config for the
// whole YLL business, stored as key→JSON rows in the `app_settings` table
// (service-role only). The editor + portal apply these so the customer sees what
// staff configured. See migrations/2026-06-16-app-settings.sql.

import { getSupabaseServiceClient } from './supabase';
import type { BulbColor, ToolDefaults } from './design/sceneTypes';
import { DEFAULT_COLORS } from '@/components/design/editor-core/colors';
import {
  DEFAULT_RENDER_SETTINGS,
  type RenderSettings,
} from '@/components/design/editor-core/renderSettings';

export type AppSettings = {
  colors: BulbColor[];
  defaults: ToolDefaults;
  render: RenderSettings;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  colors: DEFAULT_COLORS,
  defaults: {},
  render: DEFAULT_RENDER_SETTINGS,
};

// ── Validators (also used by the API route on write) ────────────────────────

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

export function isBulbColor(v: unknown): v is BulbColor {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    c.id.trim().length > 0 &&
    typeof c.label === 'string' &&
    isHex(c.hex) &&
    isHex(c.glow)
  );
}

// A palette must be a non-empty array of valid colors with unique ids. Returns
// the cleaned list, or null if invalid (caller falls back to defaults).
export function normalizeColors(v: unknown): BulbColor[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: BulbColor[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isBulbColor(raw)) return null;
    if (seen.has(raw.id)) continue; // drop dup ids
    seen.add(raw.id);
    out.push({
      id: raw.id,
      label: raw.label,
      hex: raw.hex,
      glow: raw.glow,
      ...(raw.builtin ? { builtin: true } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

// Sanitize a render-settings object to the known fields (extend as fields are
// added). Unknown/invalid fields are dropped; the caller merges over defaults.
export function sanitizeRender(v: unknown): Partial<RenderSettings> {
  if (!v || typeof v !== 'object') return {};
  const r = v as Record<string, unknown>;
  const out: Partial<RenderSettings> = {};
  if (typeof r.spritzerRayDensity === 'number' && Number.isFinite(r.spritzerRayDensity) && r.spritzerRayDensity > 0) {
    // Clamp to a sane editable range (matches the Settings slider).
    out.spritzerRayDensity = Math.min(1.5, Math.max(0.1, r.spritzerRayDensity));
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Ensure every built-in default color is present (matched by id). Built-ins can't
// be deleted (designs reference them), so a built-in absent from a stored palette
// is always one added to DEFAULT_COLORS *after* that palette was saved — surface it
// so new built-ins show up in Settings + the customer portal with no data migration.
// Never overrides an operator's recolored/renamed built-in; just appends the missing ones.
function withMissingBuiltins(colors: BulbColor[]): BulbColor[] {
  const have = new Set(colors.map((c) => c.id));
  const missing = DEFAULT_COLORS.filter((c) => !have.has(c.id));
  return missing.length > 0 ? [...colors, ...missing] : colors;
}

// Read all settings, merging stored values over the factory defaults so a
// missing key or unconfigured field never breaks a render.
export async function getAppSettings(): Promise<AppSettings> {
  const sb = getSupabaseServiceClient();
  if (!sb) return DEFAULT_APP_SETTINGS;
  const { data, error } = await sb.from('app_settings').select('key, value');
  if (error) {
    console.error('[appSettings] read failed:', error.message);
    return DEFAULT_APP_SETTINGS;
  }
  const map = new Map<string, unknown>((data ?? []).map((r) => [r.key as string, r.value]));
  return {
    colors: withMissingBuiltins(normalizeColors(map.get('colors')) ?? DEFAULT_COLORS),
    defaults: isPlainObject(map.get('defaults')) ? (map.get('defaults') as ToolDefaults) : {},
    render: { ...DEFAULT_RENDER_SETTINGS, ...sanitizeRender(map.get('render')) },
  };
}

// Upsert the provided keys (each independently). Pass only what's changing.
export async function putAppSettings(patch: {
  colors?: BulbColor[];
  defaults?: ToolDefaults;
  render?: Partial<RenderSettings>;
}): Promise<AppSettings> {
  const sb = getSupabaseServiceClient();
  if (!sb) return DEFAULT_APP_SETTINGS;

  const rows: { key: string; value: unknown }[] = [];
  if (patch.colors !== undefined) {
    const clean = normalizeColors(patch.colors);
    if (clean) rows.push({ key: 'colors', value: clean });
  }
  if (patch.defaults !== undefined && isPlainObject(patch.defaults)) {
    rows.push({ key: 'defaults', value: patch.defaults });
  }
  if (patch.render !== undefined) {
    // Merge over current stored render so a partial write keeps other fields.
    const cur = (await getAppSettings()).render;
    rows.push({ key: 'render', value: { ...cur, ...sanitizeRender(patch.render) } });
  }

  if (rows.length > 0) {
    const { error } = await sb.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) {
      console.error('[appSettings] write failed:', error.message);
      throw new Error(error.message);
    }
  }
  return getAppSettings();
}
