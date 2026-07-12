import { NextRequest, NextResponse } from 'next/server';
import {
  saveTrainingHouse,
  listTrainingHouses,
  TrainingHousePayload,
} from '@/lib/training';
import type { LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection, GarlandDetection } from '@/lib/photoAnalysis';
import type { KnownNumbers, AiSnapshot } from '@/lib/training/knownVsAi';
import { isSupabaseConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
// #110 W5-005 (security, reopens #80-036): mirror the same allowed-value sets
// the scene-correction sanitizers use so the operator-submit path and the
// analyzer's model-output path enforce identical bounds on the few-shot corpus.
import { WREATH_SIZES, SPRITZER_SIZES, GARLAND_LENGTHS, TIERS } from '@/lib/design/sceneCorrections';

export const runtime = 'nodejs';
export const maxDuration = 60;

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
type Difficulty = 'easy' | 'medium' | 'hard';

// Upper bound on a training-house footage — generous enough for any real
// roofline, low enough that a crafted value can't poison a few-shot label.
const MAX_FOOTAGE = 100_000;
// Mirrors sceneCorrections.ts MAX_STRING_COUNT — the two few-shot write paths
// (operator-submit here, analyzer model-output separately) must agree.
const MAX_STRING_COUNT = 500;

function asFootage(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.min(MAX_FOOTAGE, Math.max(0, v));
}

function asDifficulty(v: unknown): Difficulty | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' && DIFFICULTIES.has(v) ? (v as Difficulty) : 'medium';
}

function isNormalizedBox(box: unknown): box is [number, number, number, number] {
  if (!Array.isArray(box) || box.length !== 4) return false;
  const [x, y, w, h] = box;
  return (
    [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    x >= 0 && x <= 1 && y >= 0 && y <= 1 &&
    w > 0 && h > 0 && x + w <= 1 + 1e-6 && y + h <= 1 + 1e-6
  );
}

function clampStringCount(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  return Math.min(MAX_STRING_COUNT, Math.max(1, Math.round(n)));
}

function sanitizeLines(lines: unknown): LineSegment[] {
  return Array.isArray(lines) ? (lines as LineSegment[]) : [];
}

function sanitizeMiniLightDetections(v: unknown): MiniLightDetection[] {
  if (!Array.isArray(v)) return [];
  const out: MiniLightDetection[] = [];
  for (const d of v as Partial<MiniLightDetection>[]) {
    if (!d || !isNormalizedBox(d.box)) continue;
    out.push({
      type: (['tree', 'bush', 'column', 'railing'] as const).includes(d.type as never) ? d.type! : 'bush',
      wrapStyle: (['canopy', 'trunk'] as const).includes(d.wrapStyle as never) ? d.wrapStyle! : 'canopy',
      stringCount: clampStringCount(d.stringCount),
      box: d.box as [number, number, number, number],
      label: typeof d.label === 'string' ? d.label.slice(0, 200) : '',
    });
  }
  return out;
}

function sanitizeWreathDetections(v: unknown): WreathDetection[] {
  if (!Array.isArray(v)) return [];
  const out: WreathDetection[] = [];
  for (const d of v as Partial<WreathDetection>[]) {
    if (!d || !isNormalizedBox(d.box)) continue;
    out.push({
      size: WREATH_SIZES.includes(d.size as never) ? d.size! : '36noble',
      tier: TIERS.includes(d.tier as never) ? d.tier! : 'bow',
      box: d.box as [number, number, number, number],
      label: typeof d.label === 'string' ? d.label.slice(0, 200) : '',
    });
  }
  return out;
}

function sanitizeSpritzerDetections(v: unknown): SpritzerDetection[] {
  if (!Array.isArray(v)) return [];
  const out: SpritzerDetection[] = [];
  for (const d of v as Partial<SpritzerDetection>[]) {
    if (!d || !isNormalizedBox(d.box)) continue;
    out.push({
      size: SPRITZER_SIZES.includes(d.size as never) ? d.size! : '24',
      box: d.box as [number, number, number, number],
      label: typeof d.label === 'string' ? d.label.slice(0, 200) : '',
    });
  }
  return out;
}

// #109 Phase 2 — the ground-truth counts (known) and the AI's own snapshot
// (aiSnapshot) are operator/client-submitted numbers that flow into the
// corpus-wide bias note, so they get the same drop-garbage treatment as the
// rest of this route: negative/NaN/non-finite → dropped, not clamped to 0
// (a dropped field is simply "the operator didn't tell us", which is exactly
// what compareKnownVsAi already treats an absent field as — clamping to 0
// would instead assert "the operator says zero", a different claim).
const MAX_KNOWN_COUNT = 10_000; // generous upper bound; blocks a crafted absurd value

function asNonNegNumber(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;
}

function sanitizeKnownNumbers(v: unknown): KnownNumbers | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  const out: KnownNumbers = {};
  for (const key of ['miniLights', 'wreaths', 'spritzers', 'garland'] as const) {
    const n = asNonNegNumber(obj[key], MAX_KNOWN_COUNT);
    if (n !== undefined) out[key] = n;
  }
  for (const key of ['santasFootage', 'gingerbreadFootage', 'wwFootage', 'stakeFootage'] as const) {
    const n = asNonNegNumber(obj[key], MAX_FOOTAGE);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// A partial/corrupt aiSnapshot teaches nothing reliable — the required
// fields (the big four counts + the two footages the analyzer actually
// returns) must ALL be present and valid, or the whole snapshot is dropped
// rather than persisting a snapshot with silently-zeroed fields.
function sanitizeAiSnapshot(v: unknown): AiSnapshot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  const miniLights = asNonNegNumber(obj.miniLights, MAX_KNOWN_COUNT);
  const wreaths = asNonNegNumber(obj.wreaths, MAX_KNOWN_COUNT);
  const spritzers = asNonNegNumber(obj.spritzers, MAX_KNOWN_COUNT);
  const garland = asNonNegNumber(obj.garland, MAX_KNOWN_COUNT);
  const santasFootage = asNonNegNumber(obj.santasFootage, MAX_FOOTAGE);
  const gingerbreadFootage = asNonNegNumber(obj.gingerbreadFootage, MAX_FOOTAGE);
  if ([miniLights, wreaths, spritzers, garland, santasFootage, gingerbreadFootage].some((n) => n === undefined)) {
    return undefined;
  }
  const wwFootage = asNonNegNumber(obj.wwFootage, MAX_FOOTAGE);
  const stakeFootage = asNonNegNumber(obj.stakeFootage, MAX_FOOTAGE);
  return {
    miniLights: miniLights!, wreaths: wreaths!, spritzers: spritzers!, garland: garland!,
    santasFootage: santasFootage!, gingerbreadFootage: gingerbreadFootage!,
    ...(wwFootage !== undefined ? { wwFootage } : {}),
    ...(stakeFootage !== undefined ? { stakeFootage } : {}),
  };
}

// Never trust a client-sent `misses` — saveTrainingHouse always recomputes it
// server-side from the sanitized known/aiSnapshot, so only known/aiSnapshot
// are extracted here.
function sanitizeOperatorKnownNumbers(v: unknown): { known?: KnownNumbers; aiSnapshot?: AiSnapshot } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const obj = v as Record<string, unknown>;
  const known = sanitizeKnownNumbers(obj.known);
  const aiSnapshot = sanitizeAiSnapshot(obj.aiSnapshot);
  if (!known && !aiSnapshot) return undefined;
  return { ...(known ? { known } : {}), ...(aiSnapshot ? { aiSnapshot } : {}) };
}

function sanitizeGarlandDetections(v: unknown): GarlandDetection[] {
  if (!Array.isArray(v)) return [];
  const out: GarlandDetection[] = [];
  for (const d of v as Partial<GarlandDetection>[]) {
    if (!d || !isNormalizedBox(d.box)) continue;
    out.push({
      length: GARLAND_LENGTHS.includes(d.length as never) ? d.length! : '9ft',
      tier: TIERS.includes(d.tier as never) ? d.tier! : 'bow',
      box: d.box as [number, number, number, number],
      label: typeof d.label === 'string' ? d.label.slice(0, 200) : '',
    });
  }
  return out;
}

// #110 W5-005/W5-018: clamp/coerce the operator-submitted body before it
// reaches saveTrainingHouse. Only the fields that feed the few-shot prompt
// verbatim (footage, difficulty, detection boxes/stringCounts) are bounded
// here; everything else (address/notes/etc.) is passed through unchanged —
// out of scope for this finding.
function sanitizeTrainingPayload(body: TrainingHousePayload): TrainingHousePayload {
  return {
    ...body,
    santasFootage: asFootage(body.santasFootage),
    santasDifficulty: asDifficulty(body.santasDifficulty),
    santasLines: sanitizeLines(body.santasLines),
    gingerbreadFootage: asFootage(body.gingerbreadFootage),
    gingerbreadDifficulty: asDifficulty(body.gingerbreadDifficulty),
    gingerbreadLines: sanitizeLines(body.gingerbreadLines),
    winterWonderlandFootage: asFootage(body.winterWonderlandFootage),
    winterWonderlandDifficulty: asDifficulty(body.winterWonderlandDifficulty),
    stakeLightingFootage: asFootage(body.stakeLightingFootage),
    stakeLightingDifficulty: asDifficulty(body.stakeLightingDifficulty),
    stakeLines: body.stakeLines ? sanitizeLines(body.stakeLines) : body.stakeLines,
    miniLightDetections: sanitizeMiniLightDetections(body.miniLightDetections),
    wreathDetections: body.wreathDetections ? sanitizeWreathDetections(body.wreathDetections) : body.wreathDetections,
    spritzerDetections: body.spritzerDetections ? sanitizeSpritzerDetections(body.spritzerDetections) : body.spritzerDetections,
    garlandDetections: body.garlandDetections ? sanitizeGarlandDetections(body.garlandDetections) : body.garlandDetections,
    operatorKnownNumbers: sanitizeOperatorKnownNumbers(body.operatorKnownNumbers),
  };
}

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Training data requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }
  const items = await listTrainingHouses(200);
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Training data requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }

  let body: TrainingHousePayload;
  try {
    body = (await req.json()) as TrainingHousePayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.photos || body.photos.length === 0) {
    return NextResponse.json({ error: 'At least one photo is required' }, { status: 400 });
  }

  const saved = await saveTrainingHouse(sanitizeTrainingPayload(body));
  if (!saved) {
    return NextResponse.json({ error: 'Failed to save training house — check server logs' }, { status: 500 });
  }
  // #109 Phase 2 — `misses` is only present when the save carried BOTH
  // ground truth and an AI snapshot; the page uses its presence to decide
  // whether to show the save-time readout.
  return NextResponse.json('misses' in saved ? { id: saved.id, misses: saved.misses } : { id: saved.id });
}
