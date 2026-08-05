import { NextRequest, NextResponse } from 'next/server';
import {
  saveTrainingHouse,
  listTrainingHouses,
  TrainingHousePayload,
} from '@/lib/training';
import type { LineSegment, MiniLightDetection, WreathDetection, SpritzerDetection, GarlandDetection } from '@/lib/photoAnalysis';
import { isSupabaseConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { promoteArchiveProperty } from '@/lib/archiveQueue';
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

  let body: TrainingHousePayload & { archiveAddressKey?: unknown };
  try {
    body = (await req.json()) as TrainingHousePayload & { archiveAddressKey?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.photos || body.photos.length === 0) {
    return NextResponse.json({ error: 'At least one photo is required' }, { status: 400 });
  }

  // #167 slice 3. source is DERIVED from the archive key and overwrites whatever
  // the body carried — sanitizeTrainingPayload spreads the body, so trusting a
  // client-supplied source would let an archive trace label itself 'manual' and
  // land an overhead-satellite example in ground-photo few-shot.
  const archiveAddressKey =
    typeof body.archiveAddressKey === 'string' && body.archiveAddressKey.trim()
      ? body.archiveAddressKey.trim()
      : null;

  const saved = await saveTrainingHouse({
    ...sanitizeTrainingPayload(body),
    source: archiveAddressKey ? 'archive' : 'manual',
  });
  if (!saved) {
    return NextResponse.json({ error: 'Failed to save training house — check server logs' }, { status: 500 });
  }

  // The house is already saved, so a lost claim never fails the save — but it
  // is reported, because it means this trace is now an orphaned row nobody's
  // queue card points at, and the operator who just spent two minutes on it
  // deserves to know rather than being redirected as if it landed.
  if (archiveAddressKey) {
    const { promoted } = await promoteArchiveProperty(archiveAddressKey, saved.id);
    if (!promoted) return NextResponse.json({ id: saved.id, archiveAlreadyTraced: true });
  }

  return NextResponse.json({ id: saved.id });
}
