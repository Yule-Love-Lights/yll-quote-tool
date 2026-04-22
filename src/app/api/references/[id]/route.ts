import { NextRequest, NextResponse } from 'next/server';
import { deleteReferenceAsset } from '@/lib/referenceAssets';
import { isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  const ok = await deleteReferenceAsset(id);
  if (!ok) return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
