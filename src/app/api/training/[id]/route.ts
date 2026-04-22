import { NextRequest, NextResponse } from 'next/server';
import { getTrainingHouse, deleteTrainingHouse } from '@/lib/training';
import { isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  const house = await getTrainingHouse(id);
  if (!house) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ house });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const { id } = await params;
  const ok = await deleteTrainingHouse(id);
  if (!ok) return NextResponse.json({ error: 'Failed to delete' }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
