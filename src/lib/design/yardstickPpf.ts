// Shared axis-aware "pixels-per-foot from the scene's first yardstick" helper
// (#110 W5-001 / W5-020). Both the seed path (seedFromAnalysis.ts, AI
// detections → scene items) and the inverse path (sceneToFewShot.ts, a
// staff-final scene → few-shot training example) need the exact same
// calibration math; before this extraction they were two near-identical
// copies and had already drifted — the seed path was axis-aware
// (ys.axis === 'height' ? ys.height : ys.width), the inverse path always
// used width, silently mis-sizing wreath/spritzer boxes in captured training
// examples whenever staff calibrated with a vertical (height-axis) reference.
// One shared, tested helper closes that drift for good.
//
// Client-safe pure module (imports only sceneTypes) — importable from both a
// server route and a client editor/training page.

import type { Scene, Yardstick } from './sceneTypes';

// Plausibility bounds for a derived pixels-per-foot — outside this range the
// calibration inputs are garbage (degenerate line, absurd footage). Matches
// seedFromAnalysis.ts's existing MIN_PPF/MAX_PPF.
const MIN_PPF = 2;
const MAX_PPF = 500;

// The measured pixel extent for a yardstick's `realFeet`: its HEIGHT when the
// operator calibrated with a vertical reference (downspout/column/garage-door
// height), else its WIDTH (also the default for legacy data with no `axis`).
function yardstickMeasuredPx(ys: Yardstick): number {
  return ys.axis === 'height' ? ys.height : ys.width;
}

// Pixels-per-foot from the scene's FIRST yardstick (the editor's "first
// yardstick is the default" convention), axis-aware. Null when there's no
// yardstick, the measured extent/realFeet are non-finite or <=0, or the
// derived ppf falls outside the plausible [MIN_PPF, MAX_PPF] range.
export function firstYardstickPpf(scene: Scene | null | undefined): number | null {
  const ys: Yardstick[] = Array.isArray(scene?.yardsticks) ? scene.yardsticks : [];
  const first = ys[0];
  if (!first) return null;
  if (!Number.isFinite(first.realFeet) || first.realFeet <= 0) return null;
  const measured = yardstickMeasuredPx(first);
  if (!Number.isFinite(measured) || measured <= 0) return null;
  const ppf = measured / first.realFeet;
  return ppf >= MIN_PPF && ppf <= MAX_PPF ? ppf : null;
}
