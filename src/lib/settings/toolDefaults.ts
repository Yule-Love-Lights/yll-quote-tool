// Per-type SEED defaults (#32 Phase 2) — the values a NEW item is created with
// in the design editor (default spacing, size, color, etc.). Distinct from the
// global RENDER settings (renderSettings.ts, Phase 1): seed defaults only affect
// newly-placed items, not existing ones.
//
// The editor already CONSUMES these: editor.ts loads getDefaults() at init and
// applyDefaultsForCurrentType() copies the per-type fields into the active tool.
// This module is the app-level config that drives the /settings UI + seeds it
// with the factory values; persistence rides app_settings.defaults via
// /api/settings. Mirrors the design tool's settings.ts data model (values kept
// in lockstep) but it is NOT a byte-identical core file — no relay.

import type { ToolDefaults } from '@/lib/design/sceneTypes';

// Factory defaults — the per-type starting values (mirror the design tool's
// FACTORY_DEFAULTS / DEFAULT_TOOL_DEFAULTS). Also the target of "Reset".
export const DEFAULT_TOOL_DEFAULTS: ToolDefaults = {
  c9: { spacingIn: 12, drawingStyle: 'strand', colorPattern: ['warm-white'] },
  mini: { spacingIn: 6, drawingStyle: 'strand', colorPattern: ['warm-white'] },
  permanent: {
    spacingIn: 8,
    drawingStyle: 'strand',
    colorPattern: ['warm-white'],
    beamLengthFt: 4,
    beamWidthFt: 1.7,
    distanceToSurfaceFt: 0,
    opacity: 1,
    showCoverage: false,
    showBeam: true,
  },
  bistro: { spacingIn: 12, drawingStyle: 'strand', colorPattern: ['warm-white'], sagFactor: 0.1 },
  wreath: { sizeIn: 36, withLights: true, withBow: true, colorPattern: ['warm-white'] },
  bow: { sizeIn: 24 },
  garland: { sizeIn: 12, withLights: true, drawingStyle: 'strand' },
  spritzer: { sizeIn: 24, colorPattern: ['warm-white'] },
  text: { fontFamily: 'Oswald', colorPattern: ['black'], outline: false },
  custom: { autoHalo: false },
  pole: { heightIn: 120, baseType: 'cube' },
};

// One editable field within a type's section. Rendering is data-driven off `kind`
// (see SettingsField). Adding a tunable = adding a FieldSpec entry below.
export type FieldSpec =
  | { key: string; label: string; kind: 'spacing'; options: number[]; unit?: string }
  | { key: string; label: string; kind: 'style'; options: string[] }
  | { key: string; label: string; kind: 'color-pattern' }
  | { key: string; label: string; kind: 'number'; min: number; max: number; step: number; unit?: string }
  | { key: string; label: string; kind: 'bool' }
  | { key: string; label: string; kind: 'font'; options: string[] };

export type SectionSpec = { key: string; label: string; fields: FieldSpec[] };

const SPACINGS_BY_TYPE: Record<string, number[]> = {
  c9: [6, 9, 12, 15, 18, 24, 36],
  mini: [4, 6, 9, 12, 18],
  permanent: [8], // #88: perm pucks ship 8" on-center only (BOM already assumes 8").
  bistro: [9, 12, 15, 18, 24, 36],
};

const DRAWING_STYLES = ['strand', 'trace', 'single'];
const FONT_OPTIONS = ['Bebas Neue', 'Oswald', 'Pacifico', 'Inter'];

export const SECTIONS: SectionSpec[] = [
  {
    key: 'c9',
    label: 'C9 Lights',
    fields: [
      { key: 'spacingIn', label: 'Default spacing', kind: 'spacing', options: SPACINGS_BY_TYPE.c9, unit: '"' },
      { key: 'drawingStyle', label: 'Default drawing style', kind: 'style', options: DRAWING_STYLES },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
    ],
  },
  {
    key: 'mini',
    label: 'Mini Lights',
    fields: [
      { key: 'spacingIn', label: 'Default spacing', kind: 'spacing', options: SPACINGS_BY_TYPE.mini, unit: '"' },
      { key: 'drawingStyle', label: 'Default drawing style', kind: 'style', options: DRAWING_STYLES },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
    ],
  },
  {
    key: 'permanent',
    label: 'Permanent Lights',
    fields: [
      { key: 'spacingIn', label: 'Default spacing', kind: 'spacing', options: SPACINGS_BY_TYPE.permanent, unit: '"' },
      { key: 'drawingStyle', label: 'Default drawing style', kind: 'style', options: DRAWING_STYLES },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
      { key: 'beamLengthFt', label: 'Default beam length', kind: 'number', min: 0.5, max: 20, step: 0.1, unit: ' ft' },
      { key: 'beamWidthFt', label: 'Default beam width', kind: 'number', min: 0.2, max: 6, step: 0.1, unit: ' ft' },
      { key: 'distanceToSurfaceFt', label: 'Default distance to surface', kind: 'number', min: 0, max: 5, step: 0.1, unit: ' ft' },
      { key: 'opacity', label: 'Default opacity', kind: 'number', min: 0.1, max: 1, step: 0.01 },
      { key: 'showBeam', label: 'Show light beam by default', kind: 'bool' },
      { key: 'showCoverage', label: 'Show floor coverage by default', kind: 'bool' },
    ],
  },
  {
    key: 'bistro',
    label: 'Bistro Lights',
    fields: [
      { key: 'spacingIn', label: 'Default spacing', kind: 'spacing', options: SPACINGS_BY_TYPE.bistro, unit: '"' },
      { key: 'drawingStyle', label: 'Default drawing style', kind: 'style', options: DRAWING_STYLES },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
      { key: 'sagFactor', label: 'Default sag', kind: 'number', min: 0, max: 0.25, step: 0.005 },
    ],
  },
  {
    key: 'wreath',
    label: 'Wreaths',
    fields: [
      { key: 'sizeIn', label: 'Default size', kind: 'spacing', options: [24, 36, 48, 60], unit: '"' },
      { key: 'withLights', label: 'With lights by default', kind: 'bool' },
      { key: 'withBow', label: 'Include bow by default', kind: 'bool' },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
    ],
  },
  {
    key: 'bow',
    label: 'Bows',
    fields: [{ key: 'sizeIn', label: 'Default size', kind: 'spacing', options: [12, 18, 24, 36, 48], unit: '"' }],
  },
  {
    key: 'garland',
    label: 'Garland',
    fields: [
      { key: 'sizeIn', label: 'Default size', kind: 'spacing', options: [6, 9, 12, 18, 24], unit: '"' },
      { key: 'withLights', label: 'With lights by default', kind: 'bool' },
      { key: 'drawingStyle', label: 'Default drawing style', kind: 'style', options: DRAWING_STYLES },
    ],
  },
  {
    key: 'spritzer',
    label: 'Spritzers',
    fields: [
      { key: 'sizeIn', label: 'Default size', kind: 'spacing', options: [16, 24, 36, 48], unit: '"' },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
    ],
  },
  {
    key: 'text',
    label: 'Text',
    fields: [
      { key: 'fontFamily', label: 'Default font', kind: 'font', options: FONT_OPTIONS },
      { key: 'colorPattern', label: 'Default color', kind: 'color-pattern' },
      { key: 'outline', label: 'Outline by default', kind: 'bool' },
    ],
  },
  {
    key: 'custom',
    label: 'Custom uploads',
    fields: [{ key: 'autoHalo', label: 'Glow by default', kind: 'bool' }],
  },
  {
    key: 'pole',
    label: 'Poles',
    fields: [
      { key: 'heightIn', label: 'Default height', kind: 'spacing', options: [96, 120, 144, 180], unit: '"' },
      { key: 'baseType', label: 'Default base type', kind: 'style', options: ['none', 'cube', 'barrel'] },
    ],
  },
];

// Which sections each /settings tab shows (the design tool's 6-tab grouping,
// minus Palette which is its own Phase-1 tab). Custom shows only the autoHalo
// toggle in Phase 2; the upload library lands in Phase 3.
export type DefaultsTabSpec = { id: string; label: string; sectionKeys: string[] };
export const DEFAULTS_TABS: DefaultsTabSpec[] = [
  { id: 'lights', label: 'Lights', sectionKeys: ['c9', 'mini', 'permanent', 'bistro'] },
  { id: 'decor', label: 'Decor', sectionKeys: ['wreath', 'bow', 'garland', 'spritzer'] },
  { id: 'text', label: 'Text', sectionKeys: ['text'] },
  { id: 'poles', label: 'Poles', sectionKeys: ['pole'] },
  { id: 'custom', label: 'Custom', sectionKeys: ['custom'] },
];

export function sectionByKey(key: string): SectionSpec | undefined {
  return SECTIONS.find((s) => s.key === key);
}

// Merge stored defaults over the factory ones (per type, shallow per field), so
// a newly-added factory field auto-appears and unset types still have values.
// Unknown stored types are preserved (forward-compat).
export function mergeToolDefaults(stored: ToolDefaults | null | undefined): ToolDefaults {
  const out: ToolDefaults = {};
  for (const [type, factory] of Object.entries(DEFAULT_TOOL_DEFAULTS)) {
    const s = stored?.[type];
    out[type] = s && typeof s === 'object' ? { ...factory, ...s } : { ...factory };
  }
  if (stored) {
    for (const [type, val] of Object.entries(stored)) {
      if (!(type in out) && val && typeof val === 'object') out[type] = { ...val };
    }
  }
  return out;
}
