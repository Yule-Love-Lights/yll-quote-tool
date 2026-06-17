// Custom graphic library — delete one (task #32 Phase 3).
//   DELETE /api/uploads/[id] → { ok: true }
// Removes the library entry + the storage object. Already-placed copies on
// designs keep their imagePath and just render broken (a deliberate trade-off,
// matching the design tool).

import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { deleteCustomUpload } from '@/lib/customUploads';

export const runtime = 'nodejs';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  try {
    await deleteCustomUpload(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/uploads/:id] DELETE failed:', err);
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  }
}
