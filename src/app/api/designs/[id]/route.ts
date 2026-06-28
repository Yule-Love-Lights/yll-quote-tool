// Per-design endpoints (design-tool integration, Path B — task #27).
//
//   GET /api/designs/[id] — load a design (scene + signed base-photo URL).
//   PUT /api/designs/[id] — update the scene (autosave), link the design to a
//                            quote, and/or store the staff's final satellite
//                            measurement lines ({ scene?, quoteId?,
//                            satelliteLines? } — #8 Stage A).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import {
  getDesignWithPhoto,
  updateDesignScene,
  linkDesignToQuote,
  updateDesignSatelliteLines,
  isValidDesignId,
  type DesignScene,
  type DesignSatelliteLines,
} from '@/lib/designs';

export const runtime = 'nodejs';

function notConfigured() {
  return NextResponse.json(
    { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
    { status: 503 },
  );
}

function isSceneShape(v: unknown): v is DesignScene {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as Record<string, unknown>).items) &&
    Array.isArray((v as Record<string, unknown>).yardsticks)
  );
}

function isSatelliteLinesShape(v: unknown): v is DesignSatelliteLines {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  // `stake` (Stake Lighting) is OPTIONAL — kept tolerant so designs/clients
  // saved before Stake Lighting (no stake key) still validate; only its type is
  // checked when present.
  return (
    Array.isArray(o.santas) &&
    Array.isArray(o.gingerbread) &&
    Array.isArray(o.c9) &&
    (o.stake === undefined || Array.isArray(o.stake))
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }
  try {
    const design = await getDesignWithPhoto(id);
    if (!design) return NextResponse.json({ error: 'Design not found' }, { status: 404 });
    return NextResponse.json({ design });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Lookup failed';
    console.error('GET /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) return notConfigured();
  const { id } = await params;
  if (!isValidDesignId(id)) {
    return NextResponse.json({ error: 'Invalid design id' }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { scene, quoteId, satelliteLines } = body;
  if (scene === undefined && quoteId === undefined && satelliteLines === undefined) {
    return NextResponse.json(
      { error: 'Nothing to update (provide scene, quoteId, and/or satelliteLines)' },
      { status: 400 },
    );
  }
  if (scene !== undefined && !isSceneShape(scene)) {
    return NextResponse.json({ error: 'scene must be an object with items[] and yardsticks[]' }, { status: 400 });
  }
  if (quoteId !== undefined && !isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
  }
  if (satelliteLines !== undefined && !isSatelliteLinesShape(satelliteLines)) {
    return NextResponse.json(
      { error: 'satelliteLines must be an object with santas[]/gingerbread[]/c9[] (and optional stake[]) line arrays' },
      { status: 400 },
    );
  }

  try {
    if (scene !== undefined) {
      const ok = await updateDesignScene(id, scene as DesignScene);
      if (!ok) return NextResponse.json({ error: 'Failed to save scene' }, { status: 500 });
    }
    if (quoteId !== undefined) {
      const ok = await linkDesignToQuote(id, quoteId as string);
      if (!ok) {
        return NextResponse.json(
          { error: 'Failed to link design to quote (it may already have a design)' },
          { status: 409 },
        );
      }
    }
    if (satelliteLines !== undefined) {
      const ok = await updateDesignSatelliteLines(id, satelliteLines as DesignSatelliteLines);
      if (!ok) return NextResponse.json({ error: 'Failed to save satellite lines' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed';
    console.error('PUT /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
