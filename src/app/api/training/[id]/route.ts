import { NextRequest, NextResponse } from 'next/server';
import { getTrainingHouse, deleteTrainingHouse } from '@/lib/training';
import { isSupabaseConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// Audit fix (id-route-uuid-guards): reject a non-UUID id before it reaches the
// DB, where Postgres raises 22P02 and surfaces as a confusing 404/500.
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const house = await getTrainingHouse(id);
  if (!house) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ house });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const ok = await deleteTrainingHouse(id);
  if (!ok) return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
