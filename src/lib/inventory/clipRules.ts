// src/lib/inventory/clipRules.ts
// Pure clip-rules engine (#82 Slice 2b). Maps a roofline run's PHYSICAL feature
// (the new `roofFeature` scene attribute) + its footage + the stored `clipRules`
// config → the clip material line { sku, qty }.
//
//   qty  = ceil(feet × clipsPerFt)         clipsPerFt = rule.perFt or DEFAULT (1/ft)
//   sku  = rule.sku, or null if unbound    (a null sku still counts so the view
//                                            can surface "N clips, no SKU bound")
//
// 'metal' roofs use magnetic socket wire → NO clip (flagged for staff in the UI),
// so they return null. Unset feature or non-positive feet also return null.
//
// Footage itself is computed by the caller (materialsProjection) from the scene
// geometry; this module is feature/config math only — no scene, no Supabase.

import type { RoofFeature } from '@/lib/design/sceneTypes';
import type { ClipRules } from './bindings';

// C9 clips sit one per foot (12" spacing) unless a feature's rule overrides perFt.
export const DEFAULT_CLIP_PER_FT = 1;

export type ClipProjection = { sku: string | null; qty: number };

export function projectClips(
  feature: RoofFeature | null | undefined,
  feet: number,
  rules: ClipRules,
): ClipProjection | null {
  if (!feature || feature === 'metal') return null; // metal = magnetic wire, no clip
  if (!(feet > 0)) return null;

  // WT-24: an explicit stored perFt (including 0 — "this feature takes no
  // clips") is honored as-is; only a genuinely UNSET / non-finite value falls
  // back to the default. The old `perFtRaw > 0` check coerced a real 0 back to
  // 1/ft, silently over-ordering clips for any feature an operator zeroed out.
  const rule = rules?.[feature];
  const perFt =
    rule && typeof rule.perFt === 'number' && Number.isFinite(rule.perFt)
      ? rule.perFt
      : DEFAULT_CLIP_PER_FT;
  const qty = Math.ceil(feet * perFt);
  if (qty <= 0) return null;

  const sku = rule && typeof rule.sku === 'string' && rule.sku ? rule.sku : null;
  return { sku, qty };
}
