// Design base-photo upload (design-tool integration, Path B — task #27).
//
//   POST /api/designs/[id]/photo — replace the base house photo.
//     Body: { photoBase64, photoMediaType? }. Stores the image in the private
//     `designs` bucket, measures it, records path + dimensions, and returns a
//     freshly-signed URL for the editor to load.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { uploadDesignPhoto, signDesignPhoto, isValidDesignId, getDesign } from '@/lib/designs';
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
  if (!photoBase64) {
    return NextResponse.json({ error: 'photoBase64 is required' }, { status: 400 });
  }

  // #110 W2-008: check existence before uploading — an update by id that
  // matches zero rows is not a Supabase error, so without this a stale/wrong
  // design id would still upload the blob and return 200, orphaning it.
  const row = await getDesign(id);
  if (!row) {
    return NextResponse.json({ error: 'Design not found' }, { status: 404 });
  }

  try {
    const { path, width, height } = await uploadDesignPhoto(id, photoBase64, photoMediaType);
    const photoUrl = await signDesignPhoto(path);
    return NextResponse.json({ photoUrl, photoW: width, photoH: height });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Upload failed';
    console.error('POST /api/designs/[id]/photo error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
