// Shared types for the render engine. Kept isolated from photoAnalysis /
// pricing types on purpose — the render engine reads vision output but never
// writes back to it. If the vision schema changes, only this file's
// `RenderVisionInput` adapter needs to update.

import type {
  LineSegment,
  MiniLightDetection,
  WreathDetection,
  SpritzerDetection,
  GarlandDetection,
} from '@/lib/photoAnalysis';

export type RenderStyle = 'warm-white' | 'multi' | 'red-green';

// 'pro'    → gemini-3-pro-image-preview        (photoreal, ~$0.13/call, customer-ready)
// 'flash2' → gemini-3.1-flash-image-preview    (Nano Banana 2, ~$0.067/call, middle tier)
// 'flash'  → gemini-2.5-flash-image            (lower fidelity, ~$0.04/call, free daily quota)
// Iterate cheap on flash, dial up to flash2 for previews, ship finals on pro.
export type RenderModel = 'pro' | 'flash2' | 'flash';

export type RenderStatus =
  | 'pending'       // row created, work not yet started
  | 'rendering'     // compositor + Gemini call in flight
  | 'ready'         // Gemini returned, awaiting internal approval
  | 'approved'      // Jason/Naldo approved, customer URL activates
  | 'rejected'      // kicked back; note + reason attached
  | 'failed';       // error during pipeline (see error_message)

// Subset of vision data the render engine actually consumes. Intentionally
// narrower than PhotoAnalysisResult — we don't need footage totals or
// difficulty labels for rendering, just geometry.
export type RenderVisionInput = {
  santasLines: LineSegment[];       // gutter polylines (normalized 0-1)
  gingerbreadLines: LineSegment[];  // ridge polylines
  c9Lines?: LineSegment[];          // optional dedicated Winter Wonderland C9 runs
  miniLights: MiniLightDetection[]; // bushes, trees, columns with wrap style
  wreaths: WreathDetection[];       // circular placements with size
  spritzers: SpritzerDetection[];   // decorative accents
  garland: GarlandDetection[];      // linear garland runs
};

export type RenderRequest = {
  quoteId?: string;
  photoBase64: string;              // the daytime source photo
  photoMediaType: string;           // image/jpeg or image/png
  vision: RenderVisionInput;
  style: RenderStyle;
  model?: RenderModel;              // defaults to RENDER_MODEL env var, then 'pro'
  notes?: string;
};

// Matches the Supabase `renders` table row shape (snake_case).
export type StoredRender = {
  id: string;
  quote_id: string | null;
  version: number;
  style: RenderStyle;
  model: RenderModel;
  status: RenderStatus;
  photo_hash: string;
  vision_hash: string;
  cache_key: string;
  source_path: string | null;
  composite_path: string | null;
  mask_path: string | null;
  final_path: string | null;
  ssim_score: number | null;
  gemini_ms: number | null;
  gemini_cost_usd: number | null;
  error_message: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// Lightweight list item for the admin gallery — skips storage paths because
// the UI fetches signed URLs on demand, and we want the LIST endpoint to
// return fast even when there are hundreds of renders.
export type RenderListItem = {
  id: string;
  quote_id: string | null;
  version: number;
  style: RenderStyle;
  model: RenderModel;
  status: RenderStatus;
  ssim_score: number | null;
  gemini_cost_usd: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
};

// Output of the compositor. Buffers are PNG bytes, ready to upload to
// Supabase storage OR pass as reference images to Gemini.
export type CompositeResult = {
  composite: Buffer;   // daytime-photo-looking dawn scene with bulbs placed
  mask: Buffer;        // white-on-black PNG, same dims — tells Gemini where lights are
  width: number;
  height: number;
  placedBulbs: number; // diagnostic — how many bulb sprites we stamped
};

// Sprite manifest — one entry per bulb variant (warm-white C9, multi, etc.).
// Phase 1 ships with a single warm-white C9 sprite set.
export type SpriteKey = 'c9-warm-white' | 'c9-multi' | 'mini-warm-white' | 'wreath-warm-white';

export type SpriteManifest = Record<SpriteKey, {
  path: string;          // filesystem path relative to sprites dir
  diameterPx: number;    // default render size at 1000px-wide source
}>;
