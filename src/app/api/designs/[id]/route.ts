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
  updateDesignSceneGuarded,
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
  // Every channel is checked ONLY when present (type-tolerant): holiday sends
  // santas/gingerbread/c9; permanent (#88/S23) sends front/left/right/back;
  // permanent bistro (#117) sends bistro; a client from before any of these
  // still validates. At least one line channel must be an array so a truly
  // empty/garbage body is still rejected.
  const optArr = (x: unknown) => x === undefined || Array.isArray(x);
  const channels = [o.santas, o.gingerbread, o.c9, o.stake, o.front, o.left, o.right, o.back, o.bistro];
  return channels.every(optArr) && channels.some((c) => Array.isArray(c));
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

  const { scene, quoteId, satelliteLines, version } = body;
  if (scene === undefined && quoteId === undefined && satelliteLines === undefined) {
    return NextResponse.json(
      { error: 'Nothing to update (provide scene, quoteId, and/or satelliteLines)' },
      { status: 400 },
    );
  }
  if (scene !== undefined && !isSceneShape(scene)) {
    return NextResponse.json({ error: 'scene must be an object with items[] and yardsticks[]' }, { status: 400 });
  }
  // Ledger row 260: version is the compare-and-swap precondition for `scene`
  // — omitted/null means the caller doesn't know it (an old cached bundle, or
  // a design never previously read) and updateDesignSceneGuarded adopts
  // rather than rejecting the request outright. Only checked when `scene` is
  // present — quoteId-only / satelliteLines-only PUTs touch different columns
  // and never race the scene guard.
  if (scene !== undefined && version !== undefined && version !== null && !(typeof version === 'number' && Number.isInteger(version))) {
    return NextResponse.json({ error: 'version must be an integer or null' }, { status: 400 });
  }
  if (quoteId !== undefined && !isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
  }
  if (satelliteLines !== undefined && !isSatelliteLinesShape(satelliteLines)) {
    return NextResponse.json(
      { error: 'satelliteLines must be an object with line arrays for at least one channel (santas/gingerbread/c9/stake, front/left/right/back, or bistro)' },
      { status: 400 },
    );
  }

  try {
    let newVersion: number | undefined;
    if (scene !== undefined) {
      const outcome = await updateDesignSceneGuarded(id, scene as DesignScene, version as number | null | undefined);
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') {
          // Distinguishable body (`conflict: true`) so the editor can tell
          // this apart from an ordinary save failure and block-and-offer-
          // reload instead of silently retrying the same stale overwrite.
          return NextResponse.json(
            { error: 'This design changed elsewhere — reload to see the latest version', conflict: true },
            { status: 409 },
          );
        }
        return NextResponse.json({ error: 'Failed to save scene' }, { status: 500 });
      }
      newVersion = outcome.version;
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
    return NextResponse.json({ ok: true, ...(newVersion !== undefined ? { version: newVersion } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed';
    console.error('PUT /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
