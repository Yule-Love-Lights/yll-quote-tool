// Adapter between the vision pipeline (Claude photo analysis) and the
// render engine. Two jobs:
//   1. Sanitize numeric coords — every x/y must be a finite number in [0,1]
//      before it reaches sharp's SVG rasterizer. Protects against malformed
//      vision output and against crafted POST bodies (see REVIEW H3).
//   2. Map `PhotoAnalysisResult` → `RenderVisionInput`, plumbing c9Lines
//      through when the analyzer supplies them so Phase 5 Winter Wonderland
//      runs don't silently get dropped (see REVIEW H6).
//
// Callers that already have a trusted `RenderVisionInput` (e.g. tests)
// should still run `coerceVision` before passing to `runRender`, because
// the compositor assumes coords are pre-clamped.

import type {
  PhotoAnalysisResult,
  LineSegment,
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '@/lib/photoAnalysis';
import type { RenderVisionInput } from './types';

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function coerceLines(raw: unknown): LineSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: LineSegment[] = [];
  for (const seg of raw) {
    if (!seg || typeof seg !== 'object') continue;
    const s = seg as { points?: unknown; label?: unknown };
    if (!Array.isArray(s.points)) continue;
    const clean: [number, number][] = [];
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = clamp01(p[0]);
      const y = clamp01(p[1]);
      clean.push([x, y]);
    }
    if (clean.length < 2) continue;
    out.push({ points: clean, label: typeof s.label === 'string' ? s.label : '' });
  }
  return out;
}

function coerceBox(raw: unknown): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const [x, y, w, h] = raw;
  const cx = clamp01(x);
  const cy = clamp01(y);
  const cw = clamp01(w);
  const ch = clamp01(h);
  if (cw <= 0 || ch <= 0) return null;
  return [cx, cy, cw, ch];
}

function coerceMiniLights(raw: unknown): MiniLightDetection[] {
  if (!Array.isArray(raw)) return [];
  const out: MiniLightDetection[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Partial<MiniLightDetection> & { box?: unknown };
    const box = coerceBox(r.box);
    if (!box) continue;
    out.push({
      type: (r.type === 'tree' || r.type === 'bush' || r.type === 'column') ? r.type : 'bush',
      wrapStyle: r.wrapStyle === 'trunk' ? 'trunk' : 'canopy',
      stringCount: Number.isFinite(r.stringCount as number) ? Math.max(1, Math.floor(r.stringCount as number)) : 1,
      box,
      label: typeof r.label === 'string' ? r.label : '',
    });
  }
  return out;
}

function coerceWreaths(raw: unknown): WreathDetection[] {
  if (!Array.isArray(raw)) return [];
  const out: WreathDetection[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Partial<WreathDetection> & { box?: unknown };
    const box = coerceBox(r.box);
    if (!box) continue;
    out.push({
      size: r.size ?? '30noble',
      tier: r.tier ?? 'labor',
      box,
      label: typeof r.label === 'string' ? r.label : '',
    });
  }
  return out;
}

function coerceSpritzers(raw: unknown): SpritzerDetection[] {
  if (!Array.isArray(raw)) return [];
  const out: SpritzerDetection[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Partial<SpritzerDetection> & { box?: unknown };
    const box = coerceBox(r.box);
    if (!box) continue;
    out.push({
      size: r.size ?? '24',
      box,
      label: typeof r.label === 'string' ? r.label : '',
    });
  }
  return out;
}

function coerceGarland(raw: unknown): GarlandDetection[] {
  if (!Array.isArray(raw)) return [];
  const out: GarlandDetection[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Partial<GarlandDetection> & { box?: unknown };
    const box = coerceBox(r.box);
    if (!box) continue;
    out.push({
      length: r.length ?? '9ft',
      tier: r.tier ?? 'labor',
      box,
      label: typeof r.label === 'string' ? r.label : '',
    });
  }
  return out;
}

// Takes anything-shaped vision data from an untrusted source (request body,
// old cached analysis, etc.) and returns a safe `RenderVisionInput` with
// all coords in [0,1]. Never throws — bad segments are silently dropped.
export function coerceVision(raw: unknown): RenderVisionInput {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    santasLines: coerceLines(v.santasLines),
    gingerbreadLines: coerceLines(v.gingerbreadLines),
    c9Lines: coerceLines(v.c9Lines),
    miniLights: coerceMiniLights(v.miniLights),
    wreaths: coerceWreaths(v.wreaths),
    spritzers: coerceSpritzers(v.spritzers),
    garland: coerceGarland(v.garland),
  };
}

// Build RenderVisionInput from a trusted PhotoAnalysisResult. Use this
// from the quote page / admin smoke-test / anywhere we have analyzer output.
// Plumbs c9Lines through when the analyzer ever starts producing them —
// today they fall back to []. Phase 5 will maintain a separate c9Lines
// state and pass it through the `extra` arg.
export function toRenderVisionInput(
  analysis: PhotoAnalysisResult,
  extra?: { c9Lines?: LineSegment[] },
): RenderVisionInput {
  return coerceVision({
    santasLines: analysis.santasLines,
    gingerbreadLines: analysis.gingerbreadLines,
    c9Lines: extra?.c9Lines ?? [],
    miniLights: analysis.miniLightDetections,
    wreaths: analysis.wreathDetections,
    spritzers: analysis.spritzerDetections,
    garland: analysis.garlandDetections,
  });
}
