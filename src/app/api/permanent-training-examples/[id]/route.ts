// Per-example endpoints (#141 — mirrors /api/training-examples/[id]).
//
//   GET    /api/permanent-training-examples/[id] — full example (photos +
//                                                  geometry) for the review page.
//   PATCH  /api/permanent-training-examples/[id] — { excluded?, notes? } and/or
//                                                  a WT-37 correction:
//                                                  { finalSatelliteLines?,
//                                                    finalStreetRuns?,
//                                                    finalInputs? }.
//   DELETE /api/permanent-training-examples/[id]
//
// WT-37: the AI's actual taught ground truth is final_satellite_lines /
// final_street_runs (see fewShot.ts's buildPermanentFewShotMessages) —
// final_inputs is context-only for a human reviewer, never fed to the model
// (mirrors trainingExamples.ts's comment on that field). All three are
// existing jsonb columns already written at capture time — no migration
// needed, this just adds a validated write path for staff corrections.
// Persistence for the correction fields is inlined here (getSupabaseServiceClient
// directly, same pattern as other routes e.g. quotes/[id]/route.ts) because
// src/lib/permanent/trainingExamples.ts is out of scope for this change.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import {
  getPermanentTrainingExample,
  updatePermanentTrainingExample,
  deletePermanentTrainingExample,
  type PermanentTrainingExampleInputs,
} from '@/lib/permanent/trainingExamples';
import type { PermanentSatelliteLines, PermanentStreetRun } from '@/lib/permanent/photoAnalysis';
import { coerceRoofFeature, type LineSegment } from '@/lib/photoAnalysis';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const SATELLITE_SIDES = ['front', 'left', 'right', 'back'] as const;
const STREET_SIDES = new Set(['front', 'left', 'right']);
const MAX_LABEL_LEN = 200;
const MAX_LINES_PER_SIDE = 40;
const MAX_POINTS_PER_LINE = 60;
const MAX_STREET_RUNS = 120;

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

function sanitizeLabel(v: string): string {
  return v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, MAX_LABEL_LEN);
}

function isUnitNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Clamps each coordinate into 0-1 (mirrors normalizeLines' tolerance) rather
// than rejecting a slightly-out-of-range point — staff-entered corrections
// shouldn't fail over a rounding edge case. Structurally invalid input (wrong
// shape, non-finite numbers, too few points) returns null so the caller can
// reject the whole patch instead of silently saving a corrupt line.
function sanitizePoints(v: unknown): [number, number][] | null {
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_POINTS_PER_LINE) return null;
  const out: [number, number][] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2 || !isUnitNum(p[0]) || !isUnitNum(p[1])) return null;
    out.push([Math.max(0, Math.min(1, p[0])), Math.max(0, Math.min(1, p[1]))]);
  }
  return out;
}

function sanitizeLine(v: unknown): LineSegment | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const points = sanitizePoints(o.points);
  if (!points) return null;
  if (typeof o.label !== 'string') return null;
  const label = sanitizeLabel(o.label);
  const feature = coerceRoofFeature(o.feature);
  return feature ? { points, label, feature } : { points, label };
}

function sanitizeSatelliteLines(v: unknown): PermanentSatelliteLines | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = { front: [], left: [], right: [], back: [] } as PermanentSatelliteLines;
  for (const side of SATELLITE_SIDES) {
    const arr = o[side];
    if (arr === undefined) continue; // side omitted — keep it empty, not an error
    if (!Array.isArray(arr) || arr.length > MAX_LINES_PER_SIDE) return null;
    const lines: LineSegment[] = [];
    for (const l of arr) {
      const sl = sanitizeLine(l);
      if (!sl) return null; // one malformed line rejects the whole patch (fail loud, not silently lossy)
      lines.push(sl);
    }
    out[side] = lines;
  }
  return out;
}

function sanitizeStreetRuns(v: unknown): PermanentStreetRun[] | null {
  if (!Array.isArray(v) || v.length > MAX_STREET_RUNS) return null;
  const out: PermanentStreetRun[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    if (typeof o.side !== 'string' || !STREET_SIDES.has(o.side)) return null;
    const points = sanitizePoints(o.points);
    if (!points) return null;
    if (typeof o.label !== 'string') return null;
    out.push({ side: o.side as PermanentStreetRun['side'], points, label: sanitizeLabel(o.label) });
  }
  return out;
}

function asNonNegNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// finalInputs is context-only (not fed to the AI few-shot — see the header
// comment), but the client always sends a FULL object (mirrors holiday's
// TrainingExampleInputs edit — the whole snapshot rewritten, not a partial
// patch), so every required footage/corners field must be present and valid.
function sanitizeFinalInputs(v: unknown): PermanentTrainingExampleInputs | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const frontFootage = asNonNegNum(o.frontFootage);
  const leftFootage = asNonNegNum(o.leftFootage);
  const rightFootage = asNonNegNum(o.rightFootage);
  const backFootage = asNonNegNum(o.backFootage);
  const frontCorners = asNonNegNum(o.frontCorners);
  const leftCorners = asNonNegNum(o.leftCorners);
  const rightCorners = asNonNegNum(o.rightCorners);
  const backCorners = asNonNegNum(o.backCorners);
  if (
    frontFootage === null || leftFootage === null || rightFootage === null || backFootage === null ||
    frontCorners === null || leftCorners === null || rightCorners === null || backCorners === null
  ) {
    return null;
  }
  const out: PermanentTrainingExampleInputs = {
    frontFootage, leftFootage, rightFootage, backFootage,
    frontCorners, leftCorners, rightCorners, backCorners,
  };
  if (o.extensions && typeof o.extensions === 'object') {
    const e = o.extensions as Record<string, unknown>;
    const e3 = asNonNegNum(e.e3);
    const e5 = asNonNegNum(e.e5);
    const e10 = asNonNegNum(e.e10);
    const e25 = asNonNegNum(e.e25);
    if (e3 !== null && e5 !== null && e10 !== null && e25 !== null) out.extensions = { e3, e5, e10, e25 };
  }
  const splittersNeeded = asNonNegNum(o.splittersNeeded);
  if (splittersNeeded !== null) out.splittersNeeded = splittersNeeded;
  return out;
}

async function persistPermanentCorrections(
  id: string,
  patch: {
    finalSatelliteLines?: PermanentSatelliteLines;
    finalStreetRuns?: PermanentStreetRun[];
    finalInputs?: PermanentTrainingExampleInputs;
  },
): Promise<boolean> {
  const sb = getSupabaseServiceClient();
  if (!sb) return false;
  const row: Record<string, unknown> = {};
  if (patch.finalSatelliteLines) row.final_satellite_lines = patch.finalSatelliteLines;
  if (patch.finalStreetRuns) row.final_street_runs = patch.finalStreetRuns;
  if (patch.finalInputs) row.final_inputs = patch.finalInputs;
  if (!Object.keys(row).length) return true;
  const { error } = await sb.from('permanent_training_examples').update(row).eq('id', id);
  if (error) {
    console.error('persistPermanentCorrections error:', error);
    return false;
  }
  return true;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const example = await getPermanentTrainingExample(id);
  if (!example) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ example });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const patch: { excluded?: boolean; notes?: string | null } = {};
  if (typeof body.excluded === 'boolean') patch.excluded = body.excluded;
  if (body.notes === null || typeof body.notes === 'string') patch.notes = body.notes as string | null;

  // WT-37 correction fields — validated + persisted only when present.
  const correction: {
    finalSatelliteLines?: PermanentSatelliteLines;
    finalStreetRuns?: PermanentStreetRun[];
    finalInputs?: PermanentTrainingExampleInputs;
  } = {};
  if (body.finalSatelliteLines !== undefined) {
    const lines = sanitizeSatelliteLines(body.finalSatelliteLines);
    if (!lines) {
      return NextResponse.json(
        { error: 'finalSatelliteLines must have front/left/right/back arrays of {points (>=2 pairs), label}' },
        { status: 400 },
      );
    }
    correction.finalSatelliteLines = lines;
  }
  if (body.finalStreetRuns !== undefined) {
    const runs = sanitizeStreetRuns(body.finalStreetRuns);
    if (!runs) {
      return NextResponse.json(
        { error: 'finalStreetRuns must be an array of {side: front|left|right, points (>=2 pairs), label}' },
        { status: 400 },
      );
    }
    correction.finalStreetRuns = runs;
  }
  if (body.finalInputs !== undefined) {
    const inputs = sanitizeFinalInputs(body.finalInputs);
    if (!inputs) {
      return NextResponse.json(
        { error: 'finalInputs must include non-negative front/left/right/back footage and corners' },
        { status: 400 },
      );
    }
    correction.finalInputs = inputs;
  }

  const hasSimple = patch.excluded !== undefined || patch.notes !== undefined;
  const hasCorrection =
    correction.finalSatelliteLines !== undefined ||
    correction.finalStreetRuns !== undefined ||
    correction.finalInputs !== undefined;

  if (!hasSimple && !hasCorrection) {
    return NextResponse.json(
      { error: 'Nothing to update (provide excluded/notes and/or finalSatelliteLines/finalStreetRuns/finalInputs)' },
      { status: 400 },
    );
  }

  if (hasSimple) {
    const ok = await updatePermanentTrainingExample(id, patch);
    if (!ok) return NextResponse.json({ error: 'Update failed' }, { status: 500 });
  }
  if (hasCorrection) {
    const ok = await persistPermanentCorrections(id, correction);
    if (!ok) return NextResponse.json({ error: 'Correction failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const ok = await deletePermanentTrainingExample(id);
  if (!ok) return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
