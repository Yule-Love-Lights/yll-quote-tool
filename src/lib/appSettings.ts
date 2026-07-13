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
import {
  type ColorScheme,
  DEFAULT_COLOR_SCHEMES,
  DEFAULT_BUILDABLE_COLOR_IDS,
  DEFAULT_COLOR_SCHEME_ID,
} from './design/colorSchemes';
import { DEFAULT_PERMANENT_SWATCHES } from './design/permanentScenes';
// Event Lighting rate table (service_type 'event') — Settings-adjustable, the
// #101 pattern. sanitizeEventRates always yields a complete valid table.
import { sanitizeEventRates, DEFAULT_EVENT_RATES, type EventRates } from '@/lib/event/types';
// Permanent Bistro Lighting rate table (service_type 'permanent_bistro', #117)
// — same Settings-adjustable pattern; sanitizePermanentBistroRates always
// yields a complete valid table (mirrors sanitizeEventRates).
import {
  sanitizePermanentBistroRates,
  DEFAULT_PERMANENT_BISTRO_RATES,
  type PermanentBistroRates,
} from '@/lib/permanentBistro/types';
import {
  DEFAULT_PERMANENT_RATES,
  type PermanentRates,
  DEFAULT_PERMANENT_WARRANTY,
  type PermanentWarranty,
} from './permanent/types';
// Generic "Your Protection" warranty copy (WT-56/65/07) — the same Settings-
// editable + versioned + approval-frozen mechanism permanent's warranty
// pioneered, generalized for holiday/event/permanent-bistro (previously
// hardcoded in RiskReversal.tsx with no settings hook).
import {
  DEFAULT_HOLIDAY_WARRANTY,
  DEFAULT_EVENT_WARRANTY,
  DEFAULT_BISTRO_WARRANTY,
  type ServiceWarranty,
} from './warranty/types';

// Customer-facing portal settings (Settings → Customer Portal).
export type PortalSettings = {
  // Hide the September/October early-install discounts on the customer portal.
  // Turn on once the early-install season has passed (Sep/Oct/Nov) so customers
  // no longer see — or get — those discounts. Applies to all not-yet-approved
  // quotes; approved quotes keep the price they agreed to.
  hideEarlyInstallDiscounts: boolean;
};

// Customer-portal light-color swatches (#101) — the presets the customer picks
// from + the palette they can build a custom pattern from. Data-driven from
// app_settings so staff can rename/reorder/add/remove swatches without a deploy.
// Curated from the existing built-in palette (no new hex).
export type SwatchSettings = {
  schemes: ColorScheme[];
  buildableColorIds: string[];
};

// Caps so an errant/oversized Settings write can't bloat the row. Six bullets
// matches the six fixed icons in RiskReversalPermanent (PermanentWarranty +
// DEFAULT_PERMANENT_WARRANTY live in ./permanent/types so the client bundle can
// share them without pulling in this server-only module).
const WARRANTY_TEXT_MAX = 160;
const WARRANTY_BULLET_MAX = 500;
const WARRANTY_MAX_BULLETS = 6;
// WT-56/65/07 — the other three verticals' bullet caps, matching their fixed
// icon-slot count in RiskReversal.tsx (holiday/event: 5 icons; bistro: 4).
const HOLIDAY_WARRANTY_MAX_BULLETS = 5;
const EVENT_WARRANTY_MAX_BULLETS = 5;
const BISTRO_WARRANTY_MAX_BULLETS = 4;

export type AppSettings = {
  colors: BulbColor[];
  defaults: ToolDefaults;
  render: RenderSettings;
  portal: PortalSettings;
  swatches: SwatchSettings;
  // Event Lighting rates (adjustable in Settings → Quotes). The event pricing
  // engine reads these; DEFAULT_EVENT_RATES underneath so a missing key is safe.
  eventRates: EventRates;
  // Permanent Bistro Lighting rates (#117, adjustable in Settings → Quotes).
  // The permanentBistro pricing engine reads these; DEFAULT_PERMANENT_BISTRO_RATES
  // underneath so a missing key is safe.
  permanentBistroRates: PermanentBistroRates;
  // Permanent Lighting vertical (#88). The adjustable $/ft + minimum + maintenance
  // rate table (Settings → Quotes).
  permanentRates: PermanentRates;
  // Permanent Lighting "Your Protection" card copy (#88 P6b-2) — Settings-editable
  // + versioned; frozen into a permanent quote's approval snapshot.
  permanentWarranty: PermanentWarranty;
  // Holiday / Event / Permanent-Bistro "Your Protection" card copy (WT-56/65/07)
  // — the same Settings-editable + versioned + approval-frozen mechanism as
  // permanentWarranty above, generalized to the other three verticals.
  holidayWarranty: ServiceWarranty;
  eventWarranty: ServiceWarranty;
  bistroWarranty: ServiceWarranty;
  // Permanent Lighting portal color swatches (#88 P6b-4) — the permanent quote's
  // color presets + build-your-own palette, Settings-editable like the holiday
  // `swatches` (#101) but a separate list.
  permanentSwatches: SwatchSettings;
};

export const DEFAULT_PORTAL_SETTINGS: PortalSettings = {
  hideEarlyInstallDiscounts: false,
};

export const DEFAULT_SWATCH_SETTINGS: SwatchSettings = {
  schemes: DEFAULT_COLOR_SCHEMES,
  buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  colors: DEFAULT_COLORS,
  defaults: {},
  render: DEFAULT_RENDER_SETTINGS,
  portal: DEFAULT_PORTAL_SETTINGS,
  swatches: DEFAULT_SWATCH_SETTINGS,
  eventRates: DEFAULT_EVENT_RATES,
  permanentBistroRates: DEFAULT_PERMANENT_BISTRO_RATES,
  permanentRates: DEFAULT_PERMANENT_RATES,
  permanentWarranty: DEFAULT_PERMANENT_WARRANTY,
  holidayWarranty: DEFAULT_HOLIDAY_WARRANTY,
  eventWarranty: DEFAULT_EVENT_WARRANTY,
  bistroWarranty: DEFAULT_BISTRO_WARRANTY,
  permanentSwatches: DEFAULT_PERMANENT_SWATCHES,
};

// Sanitize a permanent-rates object to its known numeric fields. Each field must
// be a finite number ≥ 0 (a $0 maintenance price is valid = feature hidden);
// unknown/invalid fields are dropped, the caller merges over defaults.
export function sanitizePermanentRates(v: unknown): Partial<PermanentRates> {
  if (!v || typeof v !== 'object') return {};
  const r = v as Record<string, unknown>;
  const out: Partial<PermanentRates> = {};
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (ok(r.frontPerFt)) out.frontPerFt = r.frontPerFt;
  if (ok(r.sidesPerFt)) out.sidesPerFt = r.sidesPerFt;
  if (ok(r.backPerFt)) out.backPerFt = r.backPerFt;
  if (ok(r.minimumJobAmount)) out.minimumJobAmount = r.minimumJobAmount;
  if (ok(r.maintenancePrice)) out.maintenancePrice = r.maintenancePrice;
  return out;
}

// Sanitize a warranty-copy object to its known fields (#88 P6b-2, generalized
// WT-56/65/07). Strings are trimmed + capped; bullets keep their SLOT positions
// (a blank slot is a hidden bullet, its icon dropped with it), capped at
// maxBullets (each vertical's fixed icon-slot count). A valid stored `version`
// is preserved (the read path); putAppSettings recomputes it on write.
// Unknown/invalid fields are dropped — the caller merges over defaults.
function sanitizeWarrantyCopy(v: unknown, maxBullets: number): Partial<ServiceWarranty> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const out: Partial<ServiceWarranty> = {};
  if (typeof r.eyebrow === 'string') out.eyebrow = r.eyebrow.trim().slice(0, WARRANTY_TEXT_MAX);
  if (typeof r.heading === 'string') out.heading = r.heading.trim().slice(0, WARRANTY_TEXT_MAX);
  if (Array.isArray(r.bullets)) {
    out.bullets = r.bullets
      .slice(0, maxBullets)
      .map((b) => (typeof b === 'string' ? b.trim().slice(0, WARRANTY_BULLET_MAX) : ''));
  }
  if (typeof r.version === 'number' && Number.isFinite(r.version) && r.version >= 1) {
    out.version = Math.floor(r.version);
  }
  return out;
}

export function sanitizePermanentWarranty(v: unknown): Partial<PermanentWarranty> {
  return sanitizeWarrantyCopy(v, WARRANTY_MAX_BULLETS);
}
export function sanitizeHolidayWarranty(v: unknown): Partial<ServiceWarranty> {
  return sanitizeWarrantyCopy(v, HOLIDAY_WARRANTY_MAX_BULLETS);
}
export function sanitizeEventWarranty(v: unknown): Partial<ServiceWarranty> {
  return sanitizeWarrantyCopy(v, EVENT_WARRANTY_MAX_BULLETS);
}
export function sanitizeBistroWarranty(v: unknown): Partial<ServiceWarranty> {
  return sanitizeWarrantyCopy(v, BISTRO_WARRANTY_MAX_BULLETS);
}

// Whether two warranty records display the SAME copy (version-independent) — used
// by putAppSettings to decide when to bump the version. PermanentWarranty and
// ServiceWarranty are structurally identical, so this serves all four verticals.
function warrantyCopyEqual(a: ServiceWarranty, b: ServiceWarranty): boolean {
  return (
    a.eyebrow === b.eyebrow &&
    a.heading === b.heading &&
    a.bullets.length === b.bullets.length &&
    a.bullets.every((t, i) => t === b.bullets[i])
  );
}

// Merge a sanitized warranty patch over the current stored copy and RECOMPUTE
// the version: bump by 1 when the displayed copy changed, keep it otherwise. The
// patch's own `version` is discarded so a client can't freeze/forge it — the
// version is server-authoritative, which is what makes the approval-snapshot
// freeze trustworthy. Shared by all four verticals' putAppSettings patch blocks.
function bumpedWarranty(
  current: ServiceWarranty,
  patch: unknown,
  sanitize: (v: unknown) => Partial<ServiceWarranty>,
): ServiceWarranty {
  const sanitized = sanitize(patch);
  delete sanitized.version;
  const mergedCopy: ServiceWarranty = { ...current, ...sanitized, version: current.version };
  return {
    ...mergedCopy,
    version: warrantyCopyEqual(mergedCopy, current) ? current.version : current.version + 1,
  };
}

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

// Sanitize the customer-portal settings to the known boolean fields. Unknown/
// invalid fields are dropped; the caller merges over defaults.
export function sanitizePortal(v: unknown): Partial<PortalSettings> {
  if (!v || typeof v !== 'object') return {};
  const p = v as Record<string, unknown>;
  const out: Partial<PortalSettings> = {};
  if (typeof p.hideEarlyInstallDiscounts === 'boolean') {
    out.hideEarlyInstallDiscounts = p.hideEarlyInstallDiscounts;
  }
  return out;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ── Swatch settings (#101) ──────────────────────────────────────────────────

// Ensure the "as designed" scheme is present + first: it's the safe default
// (no recolor) the portal opens on, and getColorScheme falls back to it — a list
// without it could apply an unwanted override on load. Never removable in the UI.
function withAsDesignedFirst(schemes: ColorScheme[]): ColorScheme[] {
  const asDesigned =
    schemes.find((s) => s.id === DEFAULT_COLOR_SCHEME_ID) ??
    DEFAULT_COLOR_SCHEMES.find((s) => s.id === DEFAULT_COLOR_SCHEME_ID)!;
  return [asDesigned, ...schemes.filter((s) => s.id !== DEFAULT_COLOR_SCHEME_ID)];
}

// Normalize a stored/posted scheme list against the current palette. Drops junk
// entries + dup ids; a scheme's colorIds must be null ("as designed") or a
// non-empty list of ids that exist in the palette (curate-from-existing, #101).
// Returns null for a non-array (caller falls back to defaults); otherwise always
// returns a list with "as designed" pinned first. Unlike colors, MISSING built-in
// schemes are NOT re-added — removal is a first-class operator choice.
export function normalizeSchemes(v: unknown, validColorIds: Set<string>): ColorScheme[] | null {
  if (!Array.isArray(v)) return null;
  const out: ColorScheme[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!isPlainObject(raw)) continue;
    const id = raw.id;
    const label = raw.label;
    if (typeof id !== 'string' || id.trim() === '' || seen.has(id)) continue;
    if (typeof label !== 'string' || label.trim() === '') continue;
    let colorIds: string[] | null;
    if (raw.colorIds === null) {
      colorIds = null;
    } else if (Array.isArray(raw.colorIds)) {
      const ids = raw.colorIds.filter((c): c is string => typeof c === 'string' && validColorIds.has(c));
      if (ids.length === 0) continue; // a non-null pattern referencing no valid color is broken → drop
      colorIds = ids;
    } else {
      continue;
    }
    seen.add(id);
    out.push({ id, label, colorIds });
  }
  return withAsDesignedFirst(out);
}

// Normalize the build-your-own palette: real, non-black palette ids only, unique,
// in order. Returns null for a non-array (caller falls back to defaults).
export function normalizeBuildable(v: unknown, validColorIds: Set<string>): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (typeof c === 'string' && c !== 'black' && validColorIds.has(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

// Sanitize a posted swatches patch to its known fields, validating colorIds/
// buildable ids against the given palette. Unknown/invalid fields are dropped;
// the caller merges over current so a partial write keeps the other field.
export function sanitizeSwatches(v: unknown, validColorIds: Set<string>): Partial<SwatchSettings> {
  if (!isPlainObject(v)) return {};
  const out: Partial<SwatchSettings> = {};
  const schemes = normalizeSchemes(v.schemes, validColorIds);
  if (schemes) out.schemes = schemes;
  const buildable = normalizeBuildable(v.buildableColorIds, validColorIds);
  if (buildable) out.buildableColorIds = buildable;
  return out;
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

// Shape the raw key→value rows into the merged AppSettings (factory defaults
// underneath, stored values on top) — shared by getAppSettings and
// putAppSettings so both build the SAME snapshot from ONE row set (W2-025).
function settingsFromMap(map: Map<string, unknown>): AppSettings {
  const colors = withMissingBuiltins(normalizeColors(map.get('colors')) ?? DEFAULT_COLORS);
  // Schemes/buildable are validated against the LIVE palette so a stored scheme
  // referencing a since-removed color is cleaned, keeping swatches consistent.
  const validColorIds = new Set(colors.map((c) => c.id));
  const rawSwatches = map.get('swatches');
  const storedSchemes = normalizeSchemes(
    isPlainObject(rawSwatches) ? rawSwatches.schemes : undefined,
    validColorIds,
  );
  const storedBuildable = normalizeBuildable(
    isPlainObject(rawSwatches) ? rawSwatches.buildableColorIds : undefined,
    validColorIds,
  );
  // #88 P6b-4 — the permanent swatch list, same validation as holiday but its own key.
  const rawPermSwatches = map.get('permanentSwatches');
  const storedPermSchemes = normalizeSchemes(
    isPlainObject(rawPermSwatches) ? rawPermSwatches.schemes : undefined,
    validColorIds,
  );
  const storedPermBuildable = normalizeBuildable(
    isPlainObject(rawPermSwatches) ? rawPermSwatches.buildableColorIds : undefined,
    validColorIds,
  );
  return {
    colors,
    defaults: isPlainObject(map.get('defaults')) ? (map.get('defaults') as ToolDefaults) : {},
    render: { ...DEFAULT_RENDER_SETTINGS, ...sanitizeRender(map.get('render')) },
    portal: { ...DEFAULT_PORTAL_SETTINGS, ...sanitizePortal(map.get('portal')) },
    swatches: {
      schemes: storedSchemes ?? DEFAULT_SWATCH_SETTINGS.schemes,
      buildableColorIds: storedBuildable ?? DEFAULT_SWATCH_SETTINGS.buildableColorIds,
    },
    eventRates: sanitizeEventRates(map.get('eventRates')),
    permanentBistroRates: sanitizePermanentBistroRates(map.get('permanentBistroRates')),
    permanentRates: { ...DEFAULT_PERMANENT_RATES, ...sanitizePermanentRates(map.get('permanentRates')) },
    permanentWarranty: { ...DEFAULT_PERMANENT_WARRANTY, ...sanitizePermanentWarranty(map.get('permanentWarranty')) },
    holidayWarranty: { ...DEFAULT_HOLIDAY_WARRANTY, ...sanitizeHolidayWarranty(map.get('holidayWarranty')) },
    eventWarranty: { ...DEFAULT_EVENT_WARRANTY, ...sanitizeEventWarranty(map.get('eventWarranty')) },
    bistroWarranty: { ...DEFAULT_BISTRO_WARRANTY, ...sanitizeBistroWarranty(map.get('bistroWarranty')) },
    permanentSwatches: {
      schemes: storedPermSchemes ?? DEFAULT_PERMANENT_SWATCHES.schemes,
      buildableColorIds: storedPermBuildable ?? DEFAULT_PERMANENT_SWATCHES.buildableColorIds,
    },
  };
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
  return settingsFromMap(map);
}

// Upsert the provided keys (each independently). Pass only what's changing.
// W2-025: reads current settings ONCE (not once per patched key + a final
// read), applies every patch against that one snapshot, upserts, then returns
// the merged result directly — no re-read after the write.
export async function putAppSettings(patch: {
  colors?: BulbColor[];
  defaults?: ToolDefaults;
  render?: Partial<RenderSettings>;
  portal?: Partial<PortalSettings>;
  swatches?: Partial<SwatchSettings>;
  eventRates?: EventRates;
  permanentBistroRates?: PermanentBistroRates;
  permanentRates?: Partial<PermanentRates>;
  // Warranty copy patch (#88 P6b-2). Any `version` on the patch is IGNORED —
  // putAppSettings recomputes it (bumps when the copy actually changed).
  permanentWarranty?: Partial<PermanentWarranty>;
  // Holiday/event/bistro warranty copy patches (WT-56/65/07) — same
  // server-authoritative version-bump behavior as permanentWarranty above.
  holidayWarranty?: Partial<ServiceWarranty>;
  eventWarranty?: Partial<ServiceWarranty>;
  bistroWarranty?: Partial<ServiceWarranty>;
  // Permanent swatch list patch (#88 P6b-4) — same shape/validation as swatches.
  permanentSwatches?: Partial<SwatchSettings>;
}): Promise<AppSettings> {
  const sb = getSupabaseServiceClient();
  if (!sb) return DEFAULT_APP_SETTINGS;

  const { data, error: readError } = await sb.from('app_settings').select('key, value');
  if (readError) {
    console.error('[appSettings] read failed:', readError.message);
    return DEFAULT_APP_SETTINGS;
  }
  const map = new Map<string, unknown>((data ?? []).map((r) => [r.key as string, r.value]));
  const current = settingsFromMap(map);

  const rows: { key: string; value: unknown }[] = [];
  if (patch.colors !== undefined) {
    const clean = normalizeColors(patch.colors);
    if (clean) {
      rows.push({ key: 'colors', value: clean });
      map.set('colors', clean);
    }
  }
  if (patch.defaults !== undefined && isPlainObject(patch.defaults)) {
    rows.push({ key: 'defaults', value: patch.defaults });
    map.set('defaults', patch.defaults);
  }
  if (patch.render !== undefined) {
    // Merge over current stored render so a partial write keeps other fields.
    const value = { ...current.render, ...sanitizeRender(patch.render) };
    rows.push({ key: 'render', value });
    map.set('render', value);
  }
  if (patch.portal !== undefined) {
    // Merge over current stored portal so a partial write keeps other fields.
    const value = { ...current.portal, ...sanitizePortal(patch.portal) };
    rows.push({ key: 'portal', value });
    map.set('portal', value);
  }
  if (patch.swatches !== undefined) {
    // Validate against the live palette + merge over current so a partial write
    // (e.g. only buildableColorIds) keeps the other field.
    const validColorIds = new Set(current.colors.map((c) => c.id));
    const value = { ...current.swatches, ...sanitizeSwatches(patch.swatches, validColorIds) };
    rows.push({ key: 'swatches', value });
    map.set('swatches', value);
  }
  if (patch.permanentSwatches !== undefined) {
    // #88 P6b-4 — the permanent swatch list, same validation/merge as holiday.
    const validColorIds = new Set(current.colors.map((c) => c.id));
    const value = { ...current.permanentSwatches, ...sanitizeSwatches(patch.permanentSwatches, validColorIds) };
    rows.push({ key: 'permanentSwatches', value });
    map.set('permanentSwatches', value);
  }
  if (patch.eventRates !== undefined) {
    // Merge over the current stored rates + sanitize, so a partial write keeps
    // the other fields and any invalid number falls back to the default (never
    // a $0 rate that would trip the engine guardrail).
    const value = sanitizeEventRates({ ...current.eventRates, ...patch.eventRates });
    rows.push({ key: 'eventRates', value });
    map.set('eventRates', value);
  }

  if (patch.permanentBistroRates !== undefined) {
    // Merge over the current stored rates + sanitize, so a partial write keeps
    // the other fields and any invalid number falls back to the default (never
    // a $0 perFt/perPole that would trip the engine guardrail; `minimum` stays
    // a valid gate-off 0 rather than being promoted).
    const value = sanitizePermanentBistroRates({ ...current.permanentBistroRates, ...patch.permanentBistroRates });
    rows.push({ key: 'permanentBistroRates', value });
    map.set('permanentBistroRates', value);
  }

  if (patch.permanentRates !== undefined) {
    // Merge over current stored rates so a partial write (e.g. only frontPerFt)
    // keeps the other fields.
    const value = { ...current.permanentRates, ...sanitizePermanentRates(patch.permanentRates) };
    rows.push({ key: 'permanentRates', value });
    map.set('permanentRates', value);
  }

  // Warranty copy patches (#88 P6b-2, generalized WT-56/65/07) — each vertical's
  // version is independent, bumped only when THAT vertical's displayed copy
  // changes (see bumpedWarranty above).
  if (patch.permanentWarranty !== undefined) {
    const value = bumpedWarranty(current.permanentWarranty, patch.permanentWarranty, sanitizePermanentWarranty);
    rows.push({ key: 'permanentWarranty', value });
    map.set('permanentWarranty', value);
  }
  if (patch.holidayWarranty !== undefined) {
    const value = bumpedWarranty(current.holidayWarranty, patch.holidayWarranty, sanitizeHolidayWarranty);
    rows.push({ key: 'holidayWarranty', value });
    map.set('holidayWarranty', value);
  }
  if (patch.eventWarranty !== undefined) {
    const value = bumpedWarranty(current.eventWarranty, patch.eventWarranty, sanitizeEventWarranty);
    rows.push({ key: 'eventWarranty', value });
    map.set('eventWarranty', value);
  }
  if (patch.bistroWarranty !== undefined) {
    const value = bumpedWarranty(current.bistroWarranty, patch.bistroWarranty, sanitizeBistroWarranty);
    rows.push({ key: 'bistroWarranty', value });
    map.set('bistroWarranty', value);
  }

  if (rows.length > 0) {
    const { error } = await sb.from('app_settings').upsert(rows, { onConflict: 'key' });
    if (error) {
      console.error('[appSettings] write failed:', error.message);
      throw new Error(error.message);
    }
  }
  return settingsFromMap(map);
}
