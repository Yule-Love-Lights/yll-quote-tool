// Per-design endpoints (design-tool integration, Path B — task #27).
//
//   GET /api/designs/[id] — load a design (scene + signed base-photo URL).
//   PUT /api/designs/[id] — update the scene (autosave) and/or link the design
//                            to a quote ({ scene?, quoteId? }).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  getDesignWithPhoto,
  updateDesignScene,
  linkDesignToQuote,
  isValidDesignId,
  type DesignScene,
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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { scene, quoteId } = body;
  if (scene === undefined && quoteId === undefined) {
    return NextResponse.json({ error: 'Nothing to update (provide scene and/or quoteId)' }, { status: 400 });
  }
  if (scene !== undefined && !isSceneShape(scene)) {
    return NextResponse.json({ error: 'scene must be an object with items[] and yardsticks[]' }, { status: 400 });
  }
  if (quoteId !== undefined && !isValidDesignId(quoteId)) {
    return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Update failed';
    console.error('PUT /api/designs/[id] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
