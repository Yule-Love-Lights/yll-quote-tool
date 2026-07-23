// Customer self-serve estimate — sample-home design data (ledger self-serve, S48).
//
// Ported from the "Self-Serve Front Door: Phase A" mockup Naldo approved. Each
// Long Island house style carries a stock daytime photo (public/estimate-samples/)
// and the hand-placed roofline / wreath / garland geometry the before/after hero
// draws its lights from, in the mockup's 960x640 overlay space.
//
// PLACEHOLDER ASSETS: the photos are the mockup's free-license stock houses; swap
// them for real Yule Love Lights homes (see the README in that folder). The roofline
// geometry is tuned to THESE photos — when real homes come in, either supply real
// designs (rendered the same way) or re-trace the geometry.

import { seedSceneFromAnalysis, sanitizeAnalysisSeed } from '@/lib/design/seedFromAnalysis';
import type { Scene, Yardstick } from '@/lib/design/sceneTypes';

/** Overlay coordinate space (matches the mockup + the traced geometry below). */
export const VW = 960;
export const VH = 640;

/** Light color schemes the swatches switch between (mockup parity). */
export const SCHEMES: Record<string, string[]> = {
  warm: ['#F5CC7A'],
  cool: ['#E8F1FA'],
  multi: ['#E0524D', '#58B368', '#F5CC7A', '#5B8DD9'],
  redwhite: ['#E0524D', '#F4ECD8'],
};

export type SchemeKey = keyof typeof SCHEMES;

/** A roofline run: [x1, y1, x2, y2] in overlay space. */
export type Run = [number, number, number, number];
/** A wreath: [cx, cy, r]. */
export type Wreath = [number, number, number];
/** A garland quad-bezier: [x1, y1, cx, cy, x2, y2]. */
export type Garland = [number, number, number, number, number, number];

export type SampleStyle = {
  key: string;
  label: string;
  photo: string;
  ft: number;
  corners: number;
  extras: number;
  runs: Run[];
  wreaths: Wreath[];
  garlands: Garland[];
};

export const SAMPLE_STYLES: SampleStyle[] = [
  {
    key: 'colonial', label: 'Colonial', photo: '/estimate-samples/home-colonial.jpg',
    ft: 146, corners: 7, extras: 3,
    runs: [[213, 218, 370, 115], [370, 115, 522, 222], [522, 222, 660, 272], [508, 266, 646, 266], [498, 352, 676, 350]],
    wreaths: [[525, 412, 12], [370, 175, 13]],
    garlands: [[498, 352, 587, 366, 676, 350], [504, 382, 525, 372, 546, 382], [263, 372, 368, 384, 473, 372]],
  },
  {
    key: 'cape', label: 'Cape Cod', photo: '/estimate-samples/home-cape.jpg',
    ft: 104, corners: 6, extras: 3,
    runs: [[75, 303, 322, 305], [585, 308, 878, 315], [75, 303, 337, 150], [620, 150, 878, 315], [338, 163, 470, 102], [470, 102, 608, 163], [408, 332, 475, 292], [475, 292, 542, 332]],
    wreaths: [[475, 385, 13], [472, 205, 12]],
    garlands: [[408, 332, 475, 348, 542, 332], [450, 358, 475, 348, 500, 358]],
  },
  {
    key: 'ranch', label: 'Ranch', photo: '/estimate-samples/home-ranch.jpg',
    ft: 138, corners: 7, extras: 2,
    runs: [[160, 258, 695, 248], [185, 258, 297, 207], [297, 207, 408, 255], [386, 297, 428, 250], [428, 250, 470, 297], [700, 247, 840, 235], [840, 235, 898, 290]],
    wreaths: [[428, 352, 13], [297, 240, 13]],
    garlands: [[750, 268, 793, 283, 836, 268], [400, 300, 428, 290, 456, 300]],
  },
  {
    key: 'hiranch', label: 'High Ranch', photo: '/estimate-samples/home-hiranch.jpg',
    ft: 132, corners: 6, extras: 3,
    runs: [[155, 137, 760, 148], [335, 118, 285, 262], [335, 118, 390, 250]],
    wreaths: [[335, 298, 13], [660, 205, 11]],
    garlands: [[420, 335, 490, 348, 560, 335], [585, 335, 657, 348, 730, 335]],
  },
  {
    key: 'split', label: 'Split-Level', photo: '/estimate-samples/home-split.jpg',
    ft: 158, corners: 7, extras: 3,
    runs: [[118, 200, 420, 198], [422, 262, 715, 275], [715, 275, 868, 290]],
    wreaths: [[468, 345, 12], [250, 250, 12]],
    garlands: [[430, 318, 495, 332, 560, 318], [725, 305, 795, 318, 865, 305]],
  },
  {
    key: 'victorian', label: 'Victorian', photo: '/estimate-samples/home-victorian.jpg',
    ft: 168, corners: 10, extras: 4,
    runs: [[548, 32, 491, 162], [548, 32, 612, 158], [410, 128, 328, 212], [410, 128, 468, 205], [300, 298, 660, 300]],
    wreaths: [[548, 232, 13], [410, 250, 11]],
    garlands: [[200, 432, 315, 444, 430, 432], [430, 432, 545, 444, 660, 432]],
  },
];

// The sample photos are normalized to exactly 960x640 (see public/estimate-samples),
// so the overlay geometry above maps 1:1 into the design's photo space.
export const SAMPLE_PHOTO_W = VW;
export const SAMPLE_PHOTO_H = VH;
// Evening dim so the strands read as glowing lights against the daytime photo.
const SAMPLE_BRIGHTNESS = 18;
// Pixels-per-foot for the sample render. Bulb SIZE and SPACING both scale with
// px/ft; deriving it from the fabricated footage came out ~5 px/ft (bulbs tiny +
// crammed). Fix it to a normal design density — the app's own default for a photo
// this size is ~14 (makeDefaultYardstick's 0.15·W over 10 ft); we run a touch
// denser so the strand reads clearly at the small embedded width.
const SAMPLE_YARDSTICK_PPF = 26;

/** A fixed-scale yardstick so every sample renders at a consistent, sensible bulb
 *  size regardless of how long its traced runs happen to be. */
function sampleYardstick(): Yardstick {
  const width = SAMPLE_PHOTO_W * 0.15; // mirrors makeDefaultYardstick's placement
  return {
    id: 'est-sample-yardstick',
    realFeet: width / SAMPLE_YARDSTICK_PPF,
    x: SAMPLE_PHOTO_W * 0.04,
    y: SAMPLE_PHOTO_H * 0.74,
    width,
    height: width * 0.45,
    axis: 'width',
  };
}

/**
 * Build a REAL design Scene for a sample style, so the before/after "with lights"
 * side renders through the same DesignCanvas engine as the customer's own house
 * and the portal — not a hand-drawn overlay. Seeds roofline strands from the
 * style's runs via the exact path staff use (seedSceneFromAnalysis), overrides the
 * footage-derived yardstick with a fixed sensible scale (so bulbs aren't tiny), and
 * dims to evening so the bulbs glow. Strands fall back to the first yardstick, so
 * replacing the array re-scales them.
 */
export function buildSampleScene(style: SampleStyle): Scene {
  const seed = sanitizeAnalysisSeed({
    lines: { santas: style.runs.map((r) => [[r[0] / VW, r[1] / VH], [r[2] / VW, r[3] / VH]]) },
    calibration: { santasFootage: style.ft },
  });
  const seeded = seedSceneFromAnalysis({ yardsticks: [], items: [], brightness: SAMPLE_BRIGHTNESS }, seed, SAMPLE_PHOTO_W, SAMPLE_PHOTO_H);
  return { ...seeded, yardsticks: [sampleYardstick()], brightness: SAMPLE_BRIGHTNESS };
}

/**
 * Map each swatch to real palette color ids (DesignCanvas colorOverride), so the
 * customer previews the actual products we'd install. Ids come from DEFAULT_COLORS.
 */
export const SCHEME_COLOR_IDS: Record<SchemeKey, string[]> = {
  warm: ['warm-white'],
  cool: ['cool-white'],
  multi: ['red', 'green', 'warm-white', 'blue'],
  redwhite: ['red', 'warm-white'],
};
