// scripts/eval-placement.ts — placement evaluation report for the AI photo
// analyzer: scores WHERE the AI's first-pass geometry landed against the
// staff-final scene, using src/lib/eval/placementEval.ts. READ-ONLY against
// Supabase (only calls listTrainingExamples / getTrainingExample) — never
// writes, updates, or deletes anything.
//
// RUN:
//   npx tsx scripts/eval-placement.ts
//   npx tsx scripts/eval-placement.ts --json out.json     # also write full results to a file
//   npx tsx scripts/eval-placement.ts --threshold 0.5      # override the primary IoU threshold
//
// ENV: needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
// (same as any other script in this directory — export them, or run via a
// wrapper that loads .env.local first; this script does not load dotenv
// itself, matching the other scripts/*.ts files in this repo).

import { listTrainingExamples, getTrainingExample, type TrainingExampleRow } from '../src/lib/trainingExamples';
import { sceneToFewShotPieces } from '../src/lib/design/sceneToFewShot';
import {
  scoreExample,
  scoreBoxes,
  IOU_MATCH_THRESHOLD,
  type ExampleScore,
  type DetectionPieces,
  type BoxScore,
  type PolylineScore,
} from '../src/lib/eval/placementEval';

// Secondary, stricter threshold reported alongside the primary one — cheap
// to compute (the corpus is small) and shows how sensitive the corpus-wide
// numbers are to the threshold choice.
const STRICT_IOU_THRESHOLD = 0.5;

const BOX_CATEGORIES = ['wreath', 'spritzer', 'garland', 'mini'] as const;
type BoxCategory = (typeof BOX_CATEGORIES)[number];
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
  strictBoxes: Record<BoxCategory, BoxScore>; // STRICT_IOU_THRESHOLD
};

function parseArgs(argv: string[]): { jsonPath: string | null; threshold: number } {
  let jsonPath: string | null = null;
  let threshold = IOU_MATCH_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') jsonPath = argv[++i] ?? null;
    else if (argv[i] === '--threshold') threshold = Number(argv[++i]);
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

function boxesOf(pieces: DetectionPieces, category: BoxCategory) {
  switch (category) {
    case 'wreath': return pieces.wreathDetections.map((d) => d.box);
    case 'spritzer': return pieces.spritzerDetections.map((d) => d.box);
    case 'garland': return pieces.garlandDetections.map((d) => d.box);
    case 'mini': return pieces.miniLightDetections.map((d) => d.box);
  }
}

async function loadResults(threshold: number): Promise<ExampleResult[]> {
  const list = await listTrainingExamples(200);
  const eligible = list.filter((r) => !r.excluded && r.has_analysis && r.street_w && r.street_h);
  const out: ExampleResult[] = [];
  for (const item of eligible) {
    const row = await getTrainingExample(item.id);
    if (!row || !row.street_w || !row.street_h) continue;
    const ai = aiPieces(row);
    if (!ai) continue;
    const staff = sceneToFewShotPieces(row.final_scene, row.street_w, row.street_h);
    const score = scoreExample(ai, staff, threshold);
    const strictBoxes = Object.fromEntries(
      BOX_CATEGORIES.map((c) => [c, scoreBoxes(boxesOf(ai, c), boxesOf(staff, c), STRICT_IOU_THRESHOLD)]),
    ) as Record<BoxCategory, BoxScore>;
    out.push({ id: row.id, address: row.address, score, strictBoxes });
  }
  // Deterministic order for a diffable per-example table — never created_at
  // or fetch order, which can drift between runs.
  out.sort((a, b) => (a.address ?? '').localeCompare(b.address ?? '') || a.id.localeCompare(b.id));
  return out;
}

// ---- corpus-wide aggregation ------------------------------------------

type BoxSummary = {
  category: BoxCategory;
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

function summarizeBoxCategory(results: ExampleResult[], category: BoxCategory): BoxSummary {
  let aiTotal = 0, staffTotal = 0, matchedTotal = 0, unmatchedAiTotal = 0, unmatchedStaffTotal = 0;
  let iouWeightedSum = 0, centroidWeightedSum = 0;
  let strictMatched = 0, strictAi = 0, strictStaff = 0;
  for (const r of results) {
    const s = r.score[category] as BoxScore;
    aiTotal += s.aiCount;
    staffTotal += s.staffCount;
    matchedTotal += s.matchedCount;
    unmatchedAiTotal += s.unmatchedAiCount;
    unmatchedStaffTotal += s.unmatchedStaffCount;
    if (s.meanIou !== null) iouWeightedSum += s.meanIou * s.matchedCount;
    if (s.meanCentroidDistance !== null) centroidWeightedSum += s.meanCentroidDistance * s.matchedCount;
    const strict = r.strictBoxes[category];
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
    meanCentroidDistance: matchedTotal > 0 ? centroidWeightedSum / matchedTotal : null,
    strictF1,
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
  const { jsonPath, threshold } = parseArgs(process.argv.slice(2));
  const results = await loadResults(threshold);

  console.log(`Placement eval — ${results.length} scored examples (excluded rows and rows missing an AI analysis or photo dims are skipped).`);
  console.log(`Primary IoU threshold: ${threshold}  |  Strict IoU threshold: ${STRICT_IOU_THRESHOLD}\n`);

  console.log('=== Box detections (wreath / spritzer / garland / mini) ===');
  const boxRows = BOX_CATEGORIES.map((c) => {
    const s = summarizeBoxCategory(results, c);
    return [
      s.category,
      String(s.aiTotal), String(s.staffTotal), String(s.matchedTotal),
      String(s.unmatchedAiTotal), String(s.unmatchedStaffTotal),
      fmt(round(s.precision)), fmt(round(s.recall)), fmt(round(s.f1)),
      fmt(round(s.meanIou)), fmt(round(s.meanCentroidDistance)),
      fmt(round(s.strictF1)),
    ];
  });
  printTable(
    ['category', 'aiN', 'staffN', 'matched', 'fp(ai)', 'fn(staff)', 'precision', 'recall', 'f1', 'meanIoU', 'meanCentroidDist', `f1@${STRICT_IOU_THRESHOLD}`],
    boxRows,
  );

  console.log('\n=== Roofline polylines (santas / gingerbread) ===');
  const polyRows = POLY_CATEGORIES.map((c) => {
    const s = summarizePolyCategory(results, c);
    return [
      s.category, String(s.examples), String(s.bothEmpty), String(s.aiEmptyOnly), String(s.staffEmptyOnly), String(s.bothNonEmpty),
      fmt(round(s.meanSymmetricChamfer)), fmt(round(s.meanLengthRatio)),
    ];
  });
  printTable(
    ['category', 'examples', 'bothEmpty', 'aiMissedAll', 'staffHadNone', 'bothNonEmpty', 'meanChamfer', 'meanLengthRatio'],
    polyRows,
  );

  console.log('\n=== Per-example (sorted by address) ===');
  const exampleRows = results.map((r) => [
    r.id.slice(0, 8),
    (r.address ?? '(no address)').slice(0, 40),
    fmt(round(r.score.santas.symmetricChamfer)),
    fmt(round(r.score.gingerbread.symmetricChamfer)),
    fmt(round(r.score.wreath.f1)),
    fmt(round(r.score.spritzer.f1)),
    fmt(round(r.score.garland.f1)),
    fmt(round(r.score.mini.f1)),
  ]);
  printTable(
    ['id', 'address', 'santasChamfer', 'gingerbreadChamfer', 'wreathF1', 'spritzerF1', 'garlandF1', 'miniF1'],
    exampleRows,
  );

  if (jsonPath) {
    const fs = await import('node:fs');
    const payload = {
      threshold, strictThreshold: STRICT_IOU_THRESHOLD, exampleCount: results.length,
      boxSummary: BOX_CATEGORIES.map((c) => summarizeBoxCategory(results, c)),
      polySummary: POLY_CATEGORIES.map((c) => summarizePolyCategory(results, c)),
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
