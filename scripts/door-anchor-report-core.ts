/**
 * scripts/door-anchor-report-core.ts -- pure, IO-free helpers for
 * scripts/door-anchor-report.ts. Split out so the bucketing/stats logic is
 * testable without a Supabase connection (mirrors this repo's pattern of
 * Konva-free / IO-free pure helpers with colocated tests).
 *
 * No side effects, no imports beyond the standard library -- safe to import
 * from a test file.
 */

export type Bucket = 'comparable' | 'no_seed_analysis' | 'no_door_anchor' | 'no_yardstick';

/**
 * Parses a feet-per-pixel scale value (doorAnchorFtPerPx or the yardstick's
 * inverted ft/px). These are ONLY meaningful when strictly positive -- a
 * JSON `null` (the normal "no door anchor found" value) must NOT collapse
 * to 0 via `Number(null) === 0`, and a zero or negative scale is equally
 * nonsensical. Anything else (undefined, non-numeric, non-finite, <= 0)
 * is treated as "not present".
 */
export function parseFtPerPx(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** General numeric coercion for fields where 0 is a legitimate value (e.g. doorAnchorConfidence). */
export function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export interface ClassifyInput {
  hasAnalysis: boolean;
  /** Already parsed via parseFtPerPx -- null means "not present or meaningless". */
  doorAnchorFtPerPx: number | null;
  /** Already parsed -- null means "not present or meaningless". */
  yardstickFtPerPx: number | null;
}

export interface ClassifyResult {
  bucket: Bucket;
  ratio: number | null; // doorAnchor / yardstick
  pctDisagree: number | null; // |doorAnchor - yardstick| / yardstick
}

/** Buckets a design row and computes the comparison stats for the 'comparable' bucket. */
export function classifyRow(input: ClassifyInput): ClassifyResult {
  const { hasAnalysis, doorAnchorFtPerPx, yardstickFtPerPx } = input;

  let bucket: Bucket;
  if (!hasAnalysis) bucket = 'no_seed_analysis';
  else if (doorAnchorFtPerPx == null) bucket = 'no_door_anchor';
  else if (yardstickFtPerPx == null) bucket = 'no_yardstick';
  else bucket = 'comparable';

  const ratio = bucket === 'comparable' ? doorAnchorFtPerPx! / yardstickFtPerPx! : null;
  const pctDisagree =
    bucket === 'comparable' ? Math.abs(doorAnchorFtPerPx! - yardstickFtPerPx!) / yardstickFtPerPx! : null;

  return { bucket, ratio, pctDisagree };
}
