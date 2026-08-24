// SPIKE — can a vision model establish photo SCALE (pixels-per-foot) by
// finding a known-size object (front door, garage door, brick course, step
// riser) in a residential street photo, reliably enough to price bushes from?
//
// BACKGROUND: bush/tree sizing needs px-per-foot for the street photo. Today
// that comes from a staff-placed "yardstick" in the design editor, which has
// been measured as unreliable (all 41 rows in the corpus carry the untouched
// default realFeet=5, and one address yardsticked twice disagreed by 72%).
// This spike tests the door-anchor alternative BEFORE touching any prod code.
//
// THIS IS A THROWAWAY EXPERIMENT. It does not modify the analyzer prompt, does
// not wire into the app, and does not write to the database. It only reads
// training_examples (read-only) and calls the vision model.
//
// RUN:  npx tsx scripts/spikes/door-anchor-experiment.ts
// Creds are read from .env.local (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// ANTHROPIC_API_KEY), discovered by walking up from cwd (works from a git
// worktree, where .env.local lives in the parent checkout, same convention as
// scripts/spikes/ghl-conversations.ts). No secret values are ever printed.
//
// OUTPUT: scripts/spikes/door-anchor-results.json (every raw run + computed
// aggregates) and scripts/spikes/DOOR_ANCHOR_RESULTS.md (the human report).

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

// ── tiny .env.local loader (no dependency — mirrors ghl-conversations.ts) ──
function findEnvFile(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env.local');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) return null;
    dir = parent;
  }
}

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const envFile = findEnvFile();
if (!envFile) {
  console.error('No .env.local found walking up from cwd. Aborting.');
  process.exit(1);
}
const env = loadEnv(envFile);
// The Claude Code shell sets ANTHROPIC_API_KEY="" which overrides .env.local
// and silently makes the SDK think it's unconfigured — clear it first (the
// standing gotcha; see MEMORY.md "Empty ANTHROPIC_API_KEY gotcha").
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_BASE_URL;
for (const [k, v] of Object.entries(env)) process.env[k] = v;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not found in .env.local — cannot make live vision calls.');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found in .env.local.');
  process.exit(1);
}

// Imports that read process.env lazily (at call time, not module load) come
// after the env is loaded, so they see the real keys.
import { getSupabaseServiceClient } from '../../src/lib/supabase';
import { getClaudeClient } from '../../src/lib/claude';
import { downscaleImageForVision, extractJson } from '../../src/lib/photoAnalysis';
import type { DesignScene } from '../../src/lib/designs';

// ── config ──────────────────────────────────────────────────────────────
const RUNS_PER_PHOTO = 3;
const MODEL = 'claude-sonnet-4-6';
const CONCURRENCY = 4;

// Standard real-world sizes used to convert a reported pixel extent into
// pixels-per-foot. This conversion happens in CODE, never in the model's
// head — the model is only ever asked for pixel coordinates + an object
// identity, per the brief ("the model is good at locating a door in a photo
// and bad at estimating real-world distance").
const STANDARD_SIZES_IN = {
  front_door_height: 80,
  garage_door_single_width: 108,
  garage_door_double_width: 192,
  step_riser_height: 7,
  brick_course_height: 2.66,
} as const;

type AnchorObject = 'front_door' | 'garage_door' | 'window' | 'step_riser' | 'brick_course' | 'none';
type GarageWidth = 'single' | 'double' | null;

type ModelAnchorResult = {
  object: AnchorObject;
  garageDoorWidth: GarageWidth;
  bbox: [number, number, number, number]; // [x, y, w, h] in the image's own pixel space
  confidence: number;
};

type RunResult = {
  exampleId: string;
  address: string | null;
  runIndex: number;
  ok: boolean;
  error?: string;
  raw?: ModelAnchorResult;
  doorPpf: number | null; // pixels-per-foot derived from the reported anchor, or null if unusable
};

type ExampleRow = {
  id: string;
  address: string | null;
  street_photo_base64: string;
  street_media_type: string;
  street_w: number;
  street_h: number;
  final_scene: DesignScene;
  final_inputs: { santasFootage?: number } | null;
};

// ── reference A: roofline (staff-confirmed footage ÷ traced pixel length) ──
function polylinePixelLength(points: number[]): number {
  let total = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const dx = points[i + 2] - points[i];
    const dy = points[i + 3] - points[i + 1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

function rooflinePpf(scene: DesignScene, santasFootage: number | undefined): number | null {
  if (!santasFootage || santasFootage <= 0) return null;
  const items = Array.isArray(scene?.items) ? scene.items : [];
  let totalPx = 0;
  let found = false;
  for (const item of items) {
    const it = item as { kind?: string; surface?: string; photoId?: string | null; points?: number[] };
    if (it.kind !== 'strand') continue;
    if (it.surface !== 'santas-roofline') continue;
    if (it.photoId != null) continue; // base photo only — matches the street photo we're scoring
    if (!Array.isArray(it.points) || it.points.length < 4) continue;
    totalPx += polylinePixelLength(it.points);
    found = true;
  }
  if (!found || totalPx <= 0) return null;
  return totalPx / santasFootage;
}

// ── reference B: yardstick (the WEAK reference — the thing under suspicion) ─
function yardstickPpf(scene: DesignScene): number | null {
  const ys = Array.isArray(scene?.yardsticks) ? scene.yardsticks[0] : undefined;
  if (!ys || !ys.realFeet || ys.realFeet <= 0) return null;
  const measuredPx = ys.axis === 'height' ? ys.height : ys.width;
  if (!measuredPx || measuredPx <= 0) return null;
  return measuredPx / ys.realFeet;
}

// ── door-anchor ppf from a model's reported bbox ───────────────────────────
function anchorPpf(r: ModelAnchorResult): number | null {
  const [, , w, h] = r.bbox;
  if (!(w > 0) || !(h > 0)) return null;
  switch (r.object) {
    case 'front_door':
      return h / (STANDARD_SIZES_IN.front_door_height / 12);
    case 'garage_door': {
      if (r.garageDoorWidth === 'single') return w / (STANDARD_SIZES_IN.garage_door_single_width / 12);
      if (r.garageDoorWidth === 'double') return w / (STANDARD_SIZES_IN.garage_door_double_width / 12);
      return null; // ambiguous single/double — no standard size to anchor to
    }
    case 'step_riser':
      return h / (STANDARD_SIZES_IN.step_riser_height / 12);
    case 'brick_course':
      return h / (STANDARD_SIZES_IN.brick_course_height / 12);
    case 'window':
    case 'none':
    default:
      return null; // no standardized dimension for a generic window
  }
}

const PROMPT = `You are measuring a residential US front-elevation street photo. This image is {W}x{H} pixels, origin (0,0) at the top-left, x increasing right, y increasing down.

Identify ONE object in the photo that has a well-known, STANDARDIZED real-world size, to use as a scale reference. Preference order: front entry door > garage door > exterior brick coursing (one course + one mortar joint) > a single concrete/wood step riser (one step's rise, not the whole staircase). If none of these are clearly visible, or you are not confident which pixels belong to the object, say so — do not guess.

Do NOT estimate feet or inches. Report ONLY what you can see: which object, and its PIXEL location in THIS image. The bounding box:
- front_door: must span the visible door leaf top-to-bottom (head to sill/threshold), not the surrounding trim or a storm door if that reads as a separate frame.
- garage_door: must span the whole door LEFT to RIGHT (its full width). Also report whether it is a single-car or double-car door.
- brick_course: must span exactly ONE brick course including one mortar joint, top to bottom.
- step_riser: must span exactly ONE step's rise (the vertical face of one step), not the full staircase.

Respond with JSON only, no prose, matching exactly this shape:
{"object":"front_door"|"garage_door"|"window"|"step_riser"|"brick_course"|"none","garageDoorWidth":"single"|"double"|null,"bbox":[x,y,width,height],"confidence":0.0}

"window" and "none" mean no standardized-size anchor was usable in this photo. bbox is [0,0,0,0] when object is "none". confidence is 0-1, your own certainty the bbox tightly and correctly bounds the named object.`;

function buildPrompt(w: number, h: number): string {
  return PROMPT.replace('{W}', String(w)).replace('{H}', String(h));
}

function isValidModelAnchorResult(v: unknown): v is ModelAnchorResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const objects: AnchorObject[] = ['front_door', 'garage_door', 'window', 'step_riser', 'brick_course', 'none'];
  if (typeof o.object !== 'string' || !objects.includes(o.object as AnchorObject)) return false;
  if (o.garageDoorWidth !== 'single' && o.garageDoorWidth !== 'double' && o.garageDoorWidth !== null) return false;
  if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || !o.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) return false;
  return true;
}

async function runOneCall(
  client: ReturnType<typeof getClaudeClient>,
  photo: { base64: string; mediaType: string },
  w: number,
  h: number,
): Promise<ModelAnchorResult> {
  if (!client) throw new Error('Claude client not configured');
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: photo.mediaType as 'image/jpeg' | 'image/png' | 'image/webp', data: photo.base64 },
          },
          { type: 'text', text: buildPrompt(w, h) },
        ],
      },
    ],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('No text response from model');
  const parsed = extractJson(textBlock.text.trim());
  if (!isValidModelAnchorResult(parsed)) {
    throw new Error(`Model response failed schema validation: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed;
}

// Tiny concurrency-limited pool — this is a spike script, not prod code.
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function main() {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service client not configured');
  const claude = getClaudeClient();
  if (!claude) throw new Error('Claude client not configured');

  console.log('Querying training_examples (640x400 subset, read-only)...');
  const { data, error } = await sb
    .from('training_examples')
    .select('id, address, street_photo_base64, street_media_type, street_w, street_h, final_scene, final_inputs')
    .eq('street_w', 640)
    .eq('street_h', 400)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  const rows = (data ?? []) as ExampleRow[];
  console.log(`Fetched ${rows.length} rows (expected 26 per the pre-check).`);

  type Task = { row: ExampleRow; runIndex: number };
  const tasks: Task[] = [];
  for (const row of rows) {
    for (let i = 0; i < RUNS_PER_PHOTO; i++) tasks.push({ row, runIndex: i });
  }
  console.log(`Running ${tasks.length} vision calls (${rows.length} photos x ${RUNS_PER_PHOTO} runs), concurrency ${CONCURRENCY}...`);

  let completed = 0;
  const runResults: RunResult[] = await runPool(tasks, CONCURRENCY, async (task) => {
    const { row, runIndex } = task;
    try {
      const downscaled = await downscaleImageForVision(row.street_photo_base64, row.street_media_type);
      const raw = await runOneCall(claude, downscaled, row.street_w, row.street_h);
      const ppf = anchorPpf(raw);
      completed++;
      if (completed % 10 === 0) console.log(`  ...${completed}/${tasks.length} calls done`);
      return { exampleId: row.id, address: row.address, runIndex, ok: true, raw, doorPpf: ppf };
    } catch (err) {
      completed++;
      return { exampleId: row.id, address: row.address, runIndex, ok: false, error: (err as Error).message, doorPpf: null };
    }
  });

  // ── reference values, computed once per example (not per run) ──────────
  const refByExample = new Map<string, { rooflinePpf: number | null; yardstickPpf: number | null; santasFootage: number | undefined }>();
  for (const row of rows) {
    refByExample.set(row.id, {
      rooflinePpf: rooflinePpf(row.final_scene, row.final_inputs?.santasFootage),
      yardstickPpf: yardstickPpf(row.final_scene),
      santasFootage: row.final_inputs?.santasFootage,
    });
  }

  // ── aggregate: anchor-found rate by object type ─────────────────────────
  const objectCounts: Record<string, number> = {};
  let callFailures = 0;
  for (const r of runResults) {
    if (!r.ok) { callFailures++; continue; }
    const obj = r.raw!.object;
    objectCounts[obj] = (objectCounts[obj] ?? 0) + 1;
  }

  // ── aggregate: run-to-run variance per photo (front_door + garage_door only,
  //    since those are the only object types with a real doorPpf) ──────────
  type PhotoVariance = {
    exampleId: string;
    address: string | null;
    objectsPicked: AnchorObject[];
    agreesOnObject: boolean;
    ppfValues: number[]; // usable doorPpf values across the runs for this photo
    ppfMean: number | null;
    ppfStdev: number | null;
    ppfCv: number | null; // coefficient of variation = stdev/mean
  };
  const byExample = new Map<string, RunResult[]>();
  for (const r of runResults) {
    if (!byExample.has(r.exampleId)) byExample.set(r.exampleId, []);
    byExample.get(r.exampleId)!.push(r);
  }
  const photoVariances: PhotoVariance[] = [];
  for (const [exampleId, runs] of byExample) {
    const okRuns = runs.filter((r) => r.ok);
    const objectsPicked = okRuns.map((r) => r.raw!.object);
    const agreesOnObject = objectsPicked.length > 0 && objectsPicked.every((o) => o === objectsPicked[0]);
    const ppfValues = okRuns.map((r) => r.doorPpf).filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
    let ppfMean: number | null = null;
    let ppfStdev: number | null = null;
    let ppfCv: number | null = null;
    if (ppfValues.length >= 2) {
      ppfMean = ppfValues.reduce((a, b) => a + b, 0) / ppfValues.length;
      const variance = ppfValues.reduce((a, b) => a + (b - ppfMean!) ** 2, 0) / ppfValues.length;
      ppfStdev = Math.sqrt(variance);
      ppfCv = ppfMean > 0 ? ppfStdev / ppfMean : null;
    } else if (ppfValues.length === 1) {
      ppfMean = ppfValues[0];
    }
    photoVariances.push({ exampleId, address: runs[0]?.address ?? null, objectsPicked, agreesOnObject, ppfValues, ppfMean, ppfStdev, ppfCv });
  }

  // ── aggregate: door vs roofline / door vs yardstick ratios ─────────────
  type RatioRow = {
    exampleId: string;
    address: string | null;
    doorPpfMean: number | null;
    rooflinePpf: number | null;
    yardstickPpf: number | null;
    ratioVsRoofline: number | null;
    ratioVsYardstick: number | null;
  };
  const ratioRows: RatioRow[] = photoVariances.map((pv) => {
    const ref = refByExample.get(pv.exampleId);
    const rooflinePpfV = ref?.rooflinePpf ?? null;
    const yardstickPpfV = ref?.yardstickPpf ?? null;
    return {
      exampleId: pv.exampleId,
      address: pv.address,
      doorPpfMean: pv.ppfMean,
      rooflinePpf: rooflinePpfV,
      yardstickPpf: yardstickPpfV,
      ratioVsRoofline: pv.ppfMean && rooflinePpfV ? pv.ppfMean / rooflinePpfV : null,
      ratioVsYardstick: pv.ppfMean && yardstickPpfV ? pv.ppfMean / yardstickPpfV : null,
    };
  });

  // ── absurd-answer cases: cross-check the door anchor's ASSUMED size
  //    against an INDEPENDENT reference (roofline_ppf). If the door bbox
  //    height, converted via roofline_ppf instead of the door's own 80in
  //    assumption, implies a real height outside [5ft, 9ft], the detection
  //    is almost certainly wrong (a window, garage door, or bad bbox
  //    mislabeled as "front_door"). This does NOT use the door's own assumed
  //    80in — that would be circular. ────────────────────────────────────
  type AbsurdCase = { exampleId: string; address: string | null; runIndex: number; object: AnchorObject; bboxHeightPx: number; rooflinePpf: number; impliedHeightFt: number };
  const absurdCases: AbsurdCase[] = [];
  for (const r of runResults) {
    if (!r.ok || !r.raw) continue;
    if (r.raw.object !== 'front_door') continue;
    const ref = refByExample.get(r.exampleId);
    if (!ref?.rooflinePpf) continue;
    const bboxHeightPx = r.raw.bbox[3];
    if (!(bboxHeightPx > 0)) continue;
    const impliedHeightFt = bboxHeightPx / ref.rooflinePpf;
    if (impliedHeightFt < 5 || impliedHeightFt > 9) {
      absurdCases.push({ exampleId: r.exampleId, address: r.address, runIndex: r.runIndex, object: r.raw.object, bboxHeightPx, rooflinePpf: ref.rooflinePpf, impliedHeightFt });
    }
  }

  // ── write raw results ────────────────────────────────────────────────
  const outDir = join(process.cwd(), 'scripts', 'spikes');
  const rawOut = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    runsPerPhoto: RUNS_PER_PHOTO,
    totalCalls: tasks.length,
    callFailures,
    photosCount: rows.length,
    objectCounts,
    runResults: runResults.map((r) => ({ ...r })),
    referencesByExample: Array.from(refByExample.entries()).map(([id, ref]) => ({ exampleId: id, ...ref })),
    photoVariances,
    ratioRows,
    absurdCases,
  };
  writeFileSync(join(outDir, 'door-anchor-results.json'), JSON.stringify(rawOut, null, 2));
  console.log(`Wrote ${join(outDir, 'door-anchor-results.json')}`);

  // ── summary to stdout (the markdown report is written by hand from this
  //    same data, see DOOR_ANCHOR_RESULTS.md) ─────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log('Object counts:', objectCounts, `(${callFailures} call failures)`);
  const cvValues = photoVariances.map((p) => p.ppfCv).filter((v): v is number => v != null);
  console.log(`Photos with >=2 usable door_ppf runs: ${cvValues.length}/${rows.length}`);
  if (cvValues.length) {
    const meanCv = cvValues.reduce((a, b) => a + b, 0) / cvValues.length;
    console.log(`Mean CV (stdev/mean) of door_ppf across runs of the same photo: ${(meanCv * 100).toFixed(1)}%`);
    console.log(`Max CV: ${(Math.max(...cvValues) * 100).toFixed(1)}%`);
  }
  const agreeCount = photoVariances.filter((p) => p.agreesOnObject).length;
  console.log(`Photos where all runs picked the same object type: ${agreeCount}/${photoVariances.length}`);
  const ratios = ratioRows.map((r) => r.ratioVsRoofline).filter((v): v is number => v != null);
  console.log(`Door/roofline ratio usable on ${ratios.length}/${rows.length} photos`);
  if (ratios.length) {
    const meanR = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const stdevR = Math.sqrt(ratios.reduce((a, b) => a + (b - meanR) ** 2, 0) / ratios.length);
    console.log(`Door/roofline ratio: mean=${meanR.toFixed(3)} stdev=${stdevR.toFixed(3)} min=${Math.min(...ratios).toFixed(3)} max=${Math.max(...ratios).toFixed(3)}`);
  }
  console.log(`Absurd front_door cases (implied height <5ft or >9ft via independent roofline scale): ${absurdCases.length}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
