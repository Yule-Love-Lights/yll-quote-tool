import { NextResponse } from 'next/server';
import { listCorrections } from '@/lib/corrections';
import { isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const items = await listCorrections(200);
  return NextResponse.json({ items });
}
