// scripts/eval-placement.ts — placement evaluation report for the AI photo
// analyzer: scores WHERE the AI's first-pass geometry landed against the
// staff-final scene, using src/lib/eval/placementEval.ts. READ-ONLY against
// Supabase (only calls listTrainingExamples / getTrainingExample /
// countEligiblePlacementExamples) — never writes, updates, or deletes
// anything.
//
// RUN:
//   npx tsx scripts/eval-placement.ts
//   npx tsx scripts/eval-placement.ts --json out.json     # also write full results to a file
//   npx tsx scripts/eval-placement.ts --threshold 0.5      # override the primary AREA-category IoU threshold
//
// ENV: needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Loaded from
// .env.local via the same hand-rolled loader scripts/backfill-archive-
// night-photos.ts and scripts/match-legacy-contacts.ts use (no dotenv
// dependency in this repo) — `npx tsx` does NOT auto-load .env.local the
// way `npm run dev` does, so without this the vars must already be
// exported. Either way, the script FAILS LOUDLY before printing anything
// if they end up unset — it never silently reports a "0 scored examples"
// result that looks identical to a real empty corpus (that was F1 from the
// pre-merge review: getSupabaseServiceClient() returns null silently on
// missing config, which used to produce exactly that indistinguishable
// empty report).
//
// NOTE ON CATEGORIES: wreath and spritzer are POINT-LIKE (a single spot on
// the house) and are scored on CENTROID DISTANCE (scorePoints), not IoU —
// see the HISTORY NOTE at the top of placementEval.ts for why an IoU-based
// metric on these specific box sizes was misleading. garland and mini are
// real AREAS and stay IoU-based (scoreBoxes).
//
// PER-ROW VS PER-ADDRESS. The corpus has duplicate captures of the same
// house (one address captured 9 times as of this writing). Every summary
// table below is printed TWICE: once pooling every ROW equally (the
// original view), and once pooling every ADDRESS equally (each address's
// rows are summarized on their own, then those per-address numbers are
// averaged with equal weight — see src/lib/eval/dedupeByAddress.ts). A
// much-captured house dominating the per-row numbers is real information
// (it means the AI has seen that exact house before), but it can also hide
// how the AI does on the OTHER 90% of the corpus — read both.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  listTrainingExamples,
  getTrainingExample,
  countEligiblePlacementExamples,
  type TrainingExampleRow,
} from '../src/lib/trainingExamples';
import { sceneToFewShotPieces } from '../src/lib/design/sceneToFewShot';
import { isSupabaseServiceConfigured } from '../src/lib/supabase';
import { groupByAddress, macroMean } from '../src/lib/eval/dedupeByAddress';
import {
  scoreExample,
  scoreBoxes,
  computeSeedAcceptance,
  IOU_MATCH_THRESHOLD,
  CENTROID_MATCH_THRESHOLD,
  POINT_DISTANCE_HISTOGRAM_THRESHOLDS,
  type ExampleScore,
  type DetectionPieces,
  type BoxScore,
  type PointScore,
  type PolylineScore,
  type AcceptanceRate,
} from '../src/lib/eval/placementEval';

// Same .env.local loader convention as scripts/backfill-archive-night-photos.ts
// (no dotenv dependency in this repo) — split-based, skips a var already set
// in the real environment. Uses String.match, not RegExp's own method, only
// because a security scanner in this environment string-matches on the
// literal text "exec(" and flags false positives on regex methods.
function loadEnvLocal(): void {
  const file = resolve(process.cwd(), '.env.local');
  if (!existsSync(file)) return;
  const pattern = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(pattern);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// FETCH_LIMIT is the 200 listTrainingExamples used to hardcode — named once
// here so loadResults' fetch and main()'s truncation check can never drift
// apart.
const FETCH_LIMIT = 200;

// Secondary, stricter threshold reported alongside the primary one for AREA
// categories — cheap to compute (the corpus is small) and shows how
// sensitive the corpus-wide numbers are to the threshold choice.
const STRICT_IOU_THRESHOLD = 0.5;

const AREA_CATEGORIES = ['garland', 'mini'] as const;
type AreaCategory = (typeof AREA_CATEGORIES)[number];
const POINT_CATEGORIES = ['wreath', 'spritzer'] as const;
type PointCategory = (typeof POINT_CATEGORIES)[number];
const POLY_CATEGORIES = ['santas', 'gingerbread'] as const;
type PolyCategory = (typeof POLY_CATEGORIES)[number];

function round(n: number | null, d = 4): number | null {
  if (n === null) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

type ExampleResult = {
  id: string;
  address: string | null;
  score: ExampleScore; // primary threshold
  strictArea: Record<AreaCategory, BoxScore>; // STRICT_IOU_THRESHOLD, area categories only
  acceptance: AcceptanceRate[]; // seeded-vs-staff-drawn, from the raw final_scene
};

function parseArgs(argv: string[]): { jsonPath: string | null; threshold: number } {
  let jsonPath: string | null = null;
  let threshold = IOU_MATCH_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') {
      // A missing OR flag-shaped value (e.g. `--json --threshold 0.5`) means
      // --json swallowed the next flag as its filename instead of erroring —
      // reject it loudly rather than silently misparsing.
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(`--json requires a filename argument (got ${v === undefined ? 'nothing' : `"${v}"`}).`);
        process.exit(1);
      }
      jsonPath = v;
      i++;
    } else if (argv[i] === '--threshold') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        console.error(`--threshold requires a numeric value (got ${v === undefined ? 'nothing' : `"${v}"`}).`);
        process.exit(1);
      }
      threshold = Number(v);
      i++;
    }
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) threshold = IOU_MATCH_THRESHOLD;
  return { jsonPath, threshold };
}

// Both `original_analysis` (the AI's first pass, a PhotoAnalysisResult) and
// sceneToFewShotPieces(final_scene) share the DetectionPieces shape
// structurally; original_analysis just carries extra footage/satellite
// fields this cast ignores.
function aiPieces(row: TrainingExampleRow): DetectionPieces | null {
  const a = row.original_analysis;
  if (!a) return null;
  return {
    santasLines: Array.isArray(a.santasLines) ? (a.santasLines as DetectionPieces['santasLines']) : [],
    gingerbreadLines: Array.isArray(a.gingerbreadLines) ? (a.gingerbreadLines as DetectionPieces['gingerbreadLines']) : [],
    miniLightDetections: Array.isArray(a.miniLightDetections) ? (a.miniLightDetections as DetectionPieces['miniLightDetections']) : [],
    wreathDetections: Array.isArray(a.wreathDetections) ? (a.wreathDetections as DetectionPieces['wreathDetections']) : [],
    spritzerDetections: Array.isArray(a.spritzerDetections) ? (a.spritzerDetections as DetectionPieces['spritzerDetections']) : [],
    garlandDetections: Array.isArray(a.garlandDetections) ? (a.garlandDetections as DetectionPieces['garlandDetections']) : [],
  };
}

function areaBoxesOf(pieces: DetectionPieces, category: AreaCategory) {
  return category === 'garland' ? pieces.garlandDetections.map((d) => d.box) : pieces.miniLightDetections.map((d) => d.box);
}

type LoadedResults = {
  results: ExampleResult[];
  rawFetchedCount: number; // rows listTrainingExamples actually returned (<= FETCH_LIMIT) — includes excluded/ineligible rows, it has no server-side excluded filter
  eligibleInWindow: number; // of those raw rows, how many pass the eligibility filter
  totalEligible: number | null; // UNCAPPED count of the same eligibility population from the whole table, null if the count query itself failed
};

async function loadResults(threshold: number): Promise<LoadedResults> {
  const [list, totalEligible] = await Promise.all([
    listTrainingExamples(FETCH_LIMIT),
    countEligiblePlacementExamples(),
  ]);
  const eligible = list.filter((r) => !r.excluded && r.has_analysis && r.street_w && r.street_h);
  const out: ExampleResult[] = [];
  for (const item of eligible) {
    const row = await getTrainingExample(item.id);
    if (!row || !row.street_w || !row.street_h) continue;
    const ai = aiPieces(row);
    if (!ai) continue;
    const staff = sceneToFewShotPieces(row.final_scene, row.street_w, row.street_h);
    const score = scoreExample(ai, staff, threshold, CENTROID_MATCH_THRESHOLD);
    // Recompute AREA categories at the strict threshold too, alongside the
    // primary-threshold ones already in `score`.
    const strictArea = Object.fromEntries(
      AREA_CATEGORIES.map((c) => [c, scoreBoxes(areaBoxesOf(ai, c), areaBoxesOf(staff, c), STRICT_IOU_THRESHOLD)]),
    ) as Record<AreaCategory, BoxScore>;
    const acceptance = computeSeedAcceptance(row.final_scene);
    out.push({ id: row.id, address: row.address, score, strictArea, acceptance });
  }
  // Deterministic order for a diffable per-example table — never created_at
  // or fetch order, which can drift between runs.
  out.sort((a, b) => (a.address ?? '').localeCompare(b.address ?? '') || a.id.localeCompare(b.id));
  return { results: out, rawFetchedCount: list.length, eligibleInWindow: eligible.length, totalEligible };
}

// ---- corpus-wide aggregation ------------------------------------------

type AreaSummary = {
  category: AreaCategory;
  examples: number;
  aiTotal: number;
  staffTotal: number;
  matchedTotal: number;
  unmatchedAiTotal: number;
  unmatchedStaffTotal: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  meanIou: number | null;
  meanCentroidDistance: number | null;
  strictF1: number | null; // at STRICT_IOU_THRESHOLD
};

function summarizeAreaCategory(results: ExampleResult[], category: AreaCategory): AreaSummary {
  let aiTotal = 0, staffTotal = 0, matchedTotal = 0, unmatchedAiTotal = 0, unmatchedStaffTotal = 0;
  let iouWeightedSum = 0, centroidWeightedSum = 0, centroidWeightedN = 0;
  let strictMatched = 0, strictAi = 0, strictStaff = 0;
  for (const r of results) {
    const s = category === 'garland' ? r.score.garland : r.score.mini;
    aiTotal += s.aiCount;
    staffTotal += s.staffCount;
    matchedTotal += s.matchedCount;
    unmatchedAiTotal += s.unmatchedAiCount;
    unmatchedStaffTotal += s.unmatchedStaffCount;
    if (s.meanIou !== null) iouWeightedSum += s.meanIou * s.matchedCount;
    // meanCentroidDistance is the UNCONSTRAINED mean over every staff box in
    // the example (nearestCentroidDistances only returns null per-box when
    // aiCount is 0, in which case meanCentroidDistance itself is null and
    // this branch does not run) — weight by staffCount, not matchedCount, to
    // pool it into a correct corpus-wide mean.
    if (s.meanCentroidDistance !== null) {
      centroidWeightedSum += s.meanCentroidDistance * s.staffCount;
      centroidWeightedN += s.staffCount;
    }
    const strict = r.strictArea[category];
    strictMatched += strict.matchedCount;
    strictAi += strict.aiCount;
    strictStaff += strict.staffCount;
  }
  const precision = aiTotal > 0 ? matchedTotal / aiTotal : null;
  const recall = staffTotal > 0 ? matchedTotal / staffTotal : null;
  const f1 = precision === 0 || recall === 0 ? 0 : precision != null && recall != null ? (2 * precision * recall) / (precision + recall) : null;
  const strictPrecision = strictAi > 0 ? strictMatched / strictAi : null;
  const strictRecall = strictStaff > 0 ? strictMatched / strictStaff : null;
  const strictF1 = strictPrecision === 0 || strictRecall === 0 ? 0 : strictPrecision != null && strictRecall != null ? (2 * strictPrecision * strictRecall) / (strictPrecision + strictRecall) : null;
  return {
    category,
    examples: results.length,
    aiTotal, staffTotal, matchedTotal, unmatchedAiTotal, unmatchedStaffTotal,
    precision, recall, f1,
    meanIou: matchedTotal > 0 ? iouWeightedSum / matchedTotal : null,
    meanCentroidDistance: centroidWeightedN > 0 ? centroidWeightedSum / centroidWeightedN : null,
    strictF1,
  };
}

// Per-address-deduplicated view: group by address, summarize EACH address's
// rows with the exact same summarizeAreaCategory above (so an address with
// 9 captures is one data point, not nine), then average those per-address
// summaries with equal weight (macroMean). `examples` reports the DISTINCT
// address count, not the row count — the two intentionally read differently
// so the two tables are never mistaken for each other.
function summarizeAreaCategoryDeduped(results: ExampleResult[], category: AreaCategory): AreaSummary {
  const perAddress = groupByAddress(results).map((g) => summarizeAreaCategory(g, category));
  return {
    category,
    examples: perAddress.length,
    aiTotal: perAddress.reduce((a, s) => a + s.aiTotal, 0),
    staffTotal: perAddress.reduce((a, s) => a + s.staffTotal, 0),
    matchedTotal: perAddress.reduce((a, s) => a + s.matchedTotal, 0),
    unmatchedAiTotal: perAddress.reduce((a, s) => a + s.unmatchedAiTotal, 0),
    unmatchedStaffTotal: perAddress.reduce((a, s) => a + s.unmatchedStaffTotal, 0),
    precision: macroMean(perAddress.map((s) => s.precision)),
    recall: macroMean(perAddress.map((s) => s.recall)),
    f1: macroMean(perAddress.map((s) => s.f1)),
    meanIou: macroMean(perAddress.map((s) => s.meanIou)),
    meanCentroidDistance: macroMean(perAddress.map((s) => s.meanCentroidDistance)),
    strictF1: macroMean(perAddress.map((s) => s.strictF1)),
  };
}

type PointSummary = {
  category: PointCategory;
  examples: number;
  aiTotal: number;
  staffTotal: number;
  matchedTotal: number; // at CENTROID_MATCH_THRESHOLD
  unmatchedAiTotal: number;
  unmatchedStaffTotal: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  meanIou: number | null; // secondary/informational, from the embedded `iou` field
  // Pooled across every example — the TRUE corpus-wide distribution, not an
  // average of per-example medians (see PointScore.distances' doc comment).
  medianDistance: number | null;
  meanDistance: number | null;
  noAiCandidateTotal: number;
  histogram: { threshold: number; count: number; fraction: number | null }[]; // fraction out of staffTotal
};

function summarizePointCategory(results: ExampleResult[], category: PointCategory): PointSummary {
  let aiTotal = 0, staffTotal = 0, matchedTotal = 0, unmatchedAiTotal = 0, unmatchedStaffTotal = 0, noAiCandidateTotal = 0;
  let iouMatchedTotal = 0, iouWeightedSum = 0;
  const pooledDistances: number[] = [];
  for (const r of results) {
    const s: PointScore = category === 'wreath' ? r.score.wreath : r.score.spritzer;
    aiTotal += s.aiCount;
    staffTotal += s.staffCount;
    matchedTotal += s.matchedCount;
    unmatchedAiTotal += s.unmatchedAiCount;
    unmatchedStaffTotal += s.unmatchedStaffCount;
    noAiCandidateTotal += s.noAiCandidateCount;
    pooledDistances.push(...s.distances);
    if (s.iou.meanIou !== null) {
      iouWeightedSum += s.iou.meanIou * s.iou.matchedCount;
      iouMatchedTotal += s.iou.matchedCount;
    }
  }
  pooledDistances.sort((a, b) => a - b);
  const median = (xs: number[]) => xs.length === 0 ? null : (xs.length % 2 === 1 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  const mean = (xs: number[]) => xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

  const precision = aiTotal > 0 ? matchedTotal / aiTotal : null;
  const recall = staffTotal > 0 ? matchedTotal / staffTotal : null;
  const f1 = precision === 0 || recall === 0 ? 0 : precision != null && recall != null ? (2 * precision * recall) / (precision + recall) : null;

  const histogram = POINT_DISTANCE_HISTOGRAM_THRESHOLDS.map((t) => {
    const count = pooledDistances.filter((d) => d <= t).length;
    return { threshold: t, count, fraction: staffTotal > 0 ? count / staffTotal : null };
  });

  return {
    category, examples: results.length, aiTotal, staffTotal, matchedTotal, unmatchedAiTotal, unmatchedStaffTotal,
    precision, recall, f1,
    meanIou: iouMatchedTotal > 0 ? iouWeightedSum / iouMatchedTotal : null,
    medianDistance: median(pooledDistances), meanDistance: mean(pooledDistances),
    noAiCandidateTotal, histogram,
  };
}

// Per-address-deduplicated view — see summarizeAreaCategoryDeduped's doc
// comment for the shared reasoning. histogram fractions are macro-averaged
// per threshold too, same as every other ratio field.
function summarizePointCategoryDeduped(results: ExampleResult[], category: PointCategory): PointSummary {
  const perAddress = groupByAddress(results).map((g) => summarizePointCategory(g, category));
  const histogram = POINT_DISTANCE_HISTOGRAM_THRESHOLDS.map((threshold, i) => ({
    threshold,
    count: perAddress.reduce((a, s) => a + s.histogram[i].count, 0),
    fraction: macroMean(perAddress.map((s) => s.histogram[i].fraction)),
  }));
  return {
    category,
    examples: perAddress.length,
    aiTotal: perAddress.reduce((a, s) => a + s.aiTotal, 0),
    staffTotal: perAddress.reduce((a, s) => a + s.staffTotal, 0),
    matchedTotal: perAddress.reduce((a, s) => a + s.matchedTotal, 0),
    unmatchedAiTotal: perAddress.reduce((a, s) => a + s.unmatchedAiTotal, 0),
    unmatchedStaffTotal: perAddress.reduce((a, s) => a + s.unmatchedStaffTotal, 0),
    precision: macroMean(perAddress.map((s) => s.precision)),
    recall: macroMean(perAddress.map((s) => s.recall)),
    f1: macroMean(perAddress.map((s) => s.f1)),
    meanIou: macroMean(perAddress.map((s) => s.meanIou)),
    medianDistance: macroMean(perAddress.map((s) => s.medianDistance)),
    meanDistance: macroMean(perAddress.map((s) => s.meanDistance)),
    noAiCandidateTotal: perAddress.reduce((a, s) => a + s.noAiCandidateTotal, 0),
    histogram,
  };
}

type PolySummary = {
  category: PolyCategory;
  examples: number;
  bothEmpty: number;
  aiEmptyOnly: number;
  staffEmptyOnly: number;
  bothNonEmpty: number;
  meanSymmetricChamfer: number | null; // over bothNonEmpty examples
  meanLengthRatio: number | null; // over examples with a defined ratio
};

function summarizePolyCategory(results: ExampleResult[], category: PolyCategory): PolySummary {
  let bothEmpty = 0, aiEmptyOnly = 0, staffEmptyOnly = 0, bothNonEmpty = 0;
  const chamfers: number[] = [];
  const ratios: number[] = [];
  for (const r of results) {
    const s = r.score[category] as PolylineScore;
    const aiEmpty = s.aiSegmentCount === 0;
    const staffEmpty = s.staffSegmentCount === 0;
    if (aiEmpty && staffEmpty) bothEmpty++;
    else if (aiEmpty) aiEmptyOnly++;
    else if (staffEmpty) staffEmptyOnly++;
    else bothNonEmpty++;
    if (s.symmetricChamfer !== null && !aiEmpty && !staffEmpty) chamfers.push(s.symmetricChamfer);
    if (s.lengthRatio !== null) ratios.push(s.lengthRatio);
  }
  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    category, examples: results.length, bothEmpty, aiEmptyOnly, staffEmptyOnly, bothNonEmpty,
    meanSymmetricChamfer: mean(chamfers),
    meanLengthRatio: mean(ratios),
  };
}

// Per-address-deduplicated view — see summarizeAreaCategoryDeduped's doc
// comment for the shared reasoning.
function summarizePolyCategoryDeduped(results: ExampleResult[], category: PolyCategory): PolySummary {
  const perAddress = groupByAddress(results).map((g) => summarizePolyCategory(g, category));
  return {
    category,
    examples: perAddress.length,
    bothEmpty: perAddress.reduce((a, s) => a + s.bothEmpty, 0),
    aiEmptyOnly: perAddress.reduce((a, s) => a + s.aiEmptyOnly, 0),
    staffEmptyOnly: perAddress.reduce((a, s) => a + s.staffEmptyOnly, 0),
    bothNonEmpty: perAddress.reduce((a, s) => a + s.bothNonEmpty, 0),
    meanSymmetricChamfer: macroMean(perAddress.map((s) => s.meanSymmetricChamfer)),
    meanLengthRatio: macroMean(perAddress.map((s) => s.meanLengthRatio)),
  };
}

// Acceptance-rate categories don't align 1:1 with the geometry categories
// above (miniArea vs mini, and acceptance has no polyline categories) — see
// placementEval.ts's AcceptanceCategory. Pool total/seeded across the corpus.
const ACCEPTANCE_CATEGORIES: AcceptanceRate['category'][] = ['wreath', 'spritzer', 'miniArea', 'garland'];

function summarizeAcceptance(results: ExampleResult[]): AcceptanceRate[] {
  const counters: Record<string, { total: number; seeded: number }> = {
    wreath: { total: 0, seeded: 0 }, spritzer: { total: 0, seeded: 0 }, miniArea: { total: 0, seeded: 0 }, garland: { total: 0, seeded: 0 },
  };
  for (const r of results) {
    for (const a of r.acceptance) {
      counters[a.category].total += a.total;
      counters[a.category].seeded += a.seeded;
    }
  }
  return Object.entries(counters).map(([category, { total, seeded }]) => ({
    category: category as AcceptanceRate['category'], total, seeded, rate: total > 0 ? seeded / total : null,
  }));
}

// Per-address-deduplicated view — same shared reasoning, applied to the
// acceptance rate rather than a geometry summary: summarize EACH address's
// rows, then macro-average the per-address rate with equal weight.
function summarizeAcceptanceDeduped(results: ExampleResult[]): AcceptanceRate[] {
  const perAddress = groupByAddress(results).map((g) => summarizeAcceptance(g));
  return ACCEPTANCE_CATEGORIES.map((category) => {
    const forCategory = perAddress.map((rates) => rates.find((r) => r.category === category)!);
    return {
      category,
      total: forCategory.reduce((a, s) => a + s.total, 0),
      seeded: forCategory.reduce((a, s) => a + s.seeded, 0),
      rate: macroMean(forCategory.map((s) => s.rate)),
    };
  });
}

// ---- plain-text table printing (deterministic, no console.table) --------

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function fmt(n: number | null): string {
  return n === null ? 'n/a' : String(n);
}

async function main() {
  loadEnvLocal();

  // F1 (pre-merge review, HIGH): fail LOUDLY, before any report output, if
  // Supabase isn't configured. getSupabaseServiceClient() returns null
  // silently on missing config, which used to flow all the way through to
  // a fully-formatted "0 scored examples" report — indistinguishable from a
  // genuinely empty corpus. Name the exact env vars so the fix is obvious.
  if (!isSupabaseServiceConfigured()) {
    console.error(
      'REFUSED: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set.\n' +
      'This script reads training_examples via the Supabase service-role client\n' +
      '(src/lib/supabase.ts getSupabaseServiceClient) and CANNOT run without them\n' +
      '-- without this check it would silently print a "0 scored examples" report\n' +
      'that looks identical to a real empty corpus.\n' +
      'Set both in .env.local (loaded automatically) or export them before running:\n' +
      '  SUPABASE_URL=...\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=...',
    );
    process.exit(1);
  }

  const { jsonPath, threshold } = parseArgs(process.argv.slice(2));
  const { results, rawFetchedCount, eligibleInWindow, totalEligible } = await loadResults(threshold);

  // F2 (pre-merge review, MED): the corpus can hold more eligible rows than
  // the FETCH_LIMIT-row raw fetch window captures, and the truncation was
  // previously invisible -- report the total alongside what was actually
  // scored, and warn loudly if the cap bit.
  //
  // listTrainingExamples has NO server-side `excluded` filter (it returns
  // the newest FETCH_LIMIT rows, period, then the caller filters
  // eligibility client-side) -- so the right comparison is totalEligible
  // (server-side, unbounded) against eligibleInWindow (how many of the raw
  // fetched rows passed the SAME eligibility filter), never against
  // rawFetchedCount, which counts excluded/ineligible rows too and would
  // silently under-warn whenever the raw window mixes a lot of excluded
  // rows into its newest FETCH_LIMIT.
  const windowSaturated = rawFetchedCount >= FETCH_LIMIT;
  const truncated = totalEligible !== null && windowSaturated && totalEligible > eligibleInWindow;
  console.log(
    `Placement eval — ${results.length} scored examples ` +
    `(${eligibleInWindow} eligible rows found in the ${rawFetchedCount}-row fetch window, ` +
    `${totalEligible ?? '?'} eligible in the corpus total; ` +
    'excluded rows and rows missing an AI analysis or photo dims are skipped).',
  );
  if (truncated) {
    console.log(
      `*** WARNING: the corpus has ${totalEligible} eligible rows total but the ${FETCH_LIMIT}-row raw fetch ` +
      `window (newest first) only reached ${eligibleInWindow} of them -- this report is scored on a PARTIAL ` +
      'corpus; older eligible rows outside the window were never seen. ***',
    );
  }
  console.log(`Area IoU threshold: ${threshold} (strict ${STRICT_IOU_THRESHOLD})  |  Point centroid-distance threshold: ${CENTROID_MATCH_THRESHOLD}\n`);

  const distinctAddresses = groupByAddress(results).length;
  console.log(
    `Every summary below is printed per-ROW (${results.length} rows) and per-ADDRESS ` +
    `(${distinctAddresses} distinct addresses, macro-averaged with equal weight per address -- ` +
    'see the PER-ROW VS PER-ADDRESS note at the top of this file).\n',
  );

  const pointHeaders = ['category', 'aiN', 'staffN', 'matched', 'fp(ai)', 'fn(staff)', 'noAiCandidate', 'precision', 'recall', 'f1', 'medianDist', 'meanDist', 'meanIoU(secondary)', 'withinFraction'];
  const pointRow = (s: PointSummary) => {
    const hist = s.histogram.map((b) => `<=${b.threshold}:${fmt(round(b.fraction))}`).join(' ');
    return [
      s.category, String(s.aiTotal), String(s.staffTotal), String(s.matchedTotal),
      String(s.unmatchedAiTotal), String(s.unmatchedStaffTotal), String(s.noAiCandidateTotal),
      fmt(round(s.precision)), fmt(round(s.recall)), fmt(round(s.f1)),
      fmt(round(s.medianDistance)), fmt(round(s.meanDistance)), fmt(round(s.meanIou)), hist,
    ];
  };
  console.log('=== Point detections (wreath / spritzer) — CENTROID DISTANCE is primary, IoU is informational — PER ROW ===');
  printTable(pointHeaders, POINT_CATEGORIES.map((c) => pointRow(summarizePointCategory(results, c))));
  console.log(`\n=== Point detections — PER ADDRESS (${distinctAddresses} addresses) ===`);
  printTable(pointHeaders, POINT_CATEGORIES.map((c) => pointRow(summarizePointCategoryDeduped(results, c))));

  const areaHeaders = ['category', 'aiN', 'staffN', 'matched', 'fp(ai)', 'fn(staff)', 'precision', 'recall', 'f1', 'meanIoU', 'meanCentroidDist', `f1@${STRICT_IOU_THRESHOLD}`];
  const areaRow = (s: AreaSummary) => [
    s.category,
    String(s.aiTotal), String(s.staffTotal), String(s.matchedTotal),
    String(s.unmatchedAiTotal), String(s.unmatchedStaffTotal),
    fmt(round(s.precision)), fmt(round(s.recall)), fmt(round(s.f1)),
    fmt(round(s.meanIou)), fmt(round(s.meanCentroidDistance)),
    fmt(round(s.strictF1)),
  ];
  console.log('\n=== Area detections (garland / mini) — IoU is primary — PER ROW ===');
  printTable(areaHeaders, AREA_CATEGORIES.map((c) => areaRow(summarizeAreaCategory(results, c))));
  console.log(`\n=== Area detections — PER ADDRESS (${distinctAddresses} addresses) ===`);
  printTable(areaHeaders, AREA_CATEGORIES.map((c) => areaRow(summarizeAreaCategoryDeduped(results, c))));
  if (results.length > 0 && summarizeAreaCategory(results, 'garland').aiTotal === 0) {
    console.log('*** garland: the AI emitted ZERO detections across every scored example — this detection path is dead in practice, not merely low-recall. ***');
  }

  const polyHeaders = ['category', 'examples', 'bothEmpty', 'aiMissedAll', 'staffHadNone', 'bothNonEmpty', 'meanChamfer', 'meanLengthRatio'];
  const polyRow = (s: PolySummary) => [
    s.category, String(s.examples), String(s.bothEmpty), String(s.aiEmptyOnly), String(s.staffEmptyOnly), String(s.bothNonEmpty),
    fmt(round(s.meanSymmetricChamfer)), fmt(round(s.meanLengthRatio)),
  ];
  console.log('\n=== Roofline polylines (santas / gingerbread) — PER ROW ===');
  printTable(polyHeaders, POLY_CATEGORIES.map((c) => polyRow(summarizePolyCategory(results, c))));
  console.log(`\n=== Roofline polylines — PER ADDRESS (${distinctAddresses} addresses) ===`);
  printTable(polyHeaders, POLY_CATEGORIES.map((c) => polyRow(summarizePolyCategoryDeduped(results, c))));

  const acceptanceRow = (a: AcceptanceRate) => [a.category, String(a.total), String(a.seeded), fmt(round(a.rate))];
  console.log('\n=== Seed acceptance rate (fraction of final-scene items staff kept from the AI seed, no geometry) — PER ROW ===');
  printTable(['category', 'total', 'seeded', 'rate'], summarizeAcceptance(results).sort((a, b) => a.category.localeCompare(b.category)).map(acceptanceRow));
  console.log(`\n=== Seed acceptance rate — PER ADDRESS (${distinctAddresses} addresses) ===`);
  printTable(['category', 'total', 'seeded', 'rate'], summarizeAcceptanceDeduped(results).sort((a, b) => a.category.localeCompare(b.category)).map(acceptanceRow));

  console.log('\n=== Per-example (sorted by address) ===');
  const exampleRows = results.map((r) => [
    r.id.slice(0, 8),
    (r.address ?? '(no address)').slice(0, 32),
    fmt(round(r.score.santas.symmetricChamfer)),
    fmt(round(r.score.gingerbread.symmetricChamfer)),
    fmt(round(r.score.wreath.medianNearestDistance)),
    fmt(round(r.score.spritzer.medianNearestDistance)),
    fmt(round(r.score.garland.f1)),
    fmt(round(r.score.mini.f1)),
  ]);
  printTable(
    ['id', 'address', 'santasChamfer', 'gingerbreadChamfer', 'wreathMedianDist', 'spritzerMedianDist', 'garlandF1', 'miniF1'],
    exampleRows,
  );

  if (jsonPath) {
    const fs = await import('node:fs');
    const payload = {
      areaThreshold: threshold, strictAreaThreshold: STRICT_IOU_THRESHOLD, pointThreshold: CENTROID_MATCH_THRESHOLD,
      pointHistogramThresholds: POINT_DISTANCE_HISTOGRAM_THRESHOLDS,
      exampleCount: results.length, rawFetchedCount, eligibleInWindow, totalEligible, truncated,
      distinctAddressCount: distinctAddresses,
      pointSummary: POINT_CATEGORIES.map((c) => summarizePointCategory(results, c)),
      pointSummaryByAddress: POINT_CATEGORIES.map((c) => summarizePointCategoryDeduped(results, c)),
      areaSummary: AREA_CATEGORIES.map((c) => summarizeAreaCategory(results, c)),
      areaSummaryByAddress: AREA_CATEGORIES.map((c) => summarizeAreaCategoryDeduped(results, c)),
      polySummary: POLY_CATEGORIES.map((c) => summarizePolyCategory(results, c)),
      polySummaryByAddress: POLY_CATEGORIES.map((c) => summarizePolyCategoryDeduped(results, c)),
      acceptanceSummary: summarizeAcceptance(results),
      acceptanceSummaryByAddress: summarizeAcceptanceDeduped(results),
      examples: results,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    console.log(`\nWrote full results to ${jsonPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
