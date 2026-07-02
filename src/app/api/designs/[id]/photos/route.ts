// Extra street photos on a design (#13 multi-image quoting).
//
//   POST /api/designs/[id]/photos — add one extra photo.
//     Body: { photoBase64, photoMediaType?, title? }. Stores the image in the
//     private `designs` bucket under the design's prefix, appends it to the
//     row's extra_photos, and returns the entry with a freshly-signed URL.
//     Extras are manual-only (never AI-analyzed) and carry no measurement.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { addDesignExtraPhoto, signDesignPhoto, isValidDesignId } from '@/lib/designs';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
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
  const photoBase64 = typeof body.photoBase64 === 'string' ? body.photoBase64 : null;
  const photoMediaType = typeof body.photoMediaType === 'string' ? body.photoMediaType : 'image/jpeg';
  const title = typeof body.title === 'string' ? body.title : null;
  if (!photoBase64) {
    return NextResponse.json({ error: 'photoBase64 is required' }, { status: 400 });
  }

  try {
    const entry = await addDesignExtraPhoto(id, photoBase64, photoMediaType, title);
    const url = await signDesignPhoto(entry.path);
    return NextResponse.json({
      photo: { id: entry.id, url, w: entry.w, h: entry.h, title: entry.title ?? null },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    console.error('POST /api/designs/[id]/photos error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
