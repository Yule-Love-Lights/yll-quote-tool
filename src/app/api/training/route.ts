import { NextRequest, NextResponse } from 'next/server';
import { saveTrainingHouse, listTrainingHouses, TrainingHousePayload } from '@/lib/training';
import { isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Training data requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }
  const items = await listTrainingHouses(200);
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Training data requires Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }

  let body: TrainingHousePayload;
  try {
    body = (await req.json()) as TrainingHousePayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.photos || body.photos.length === 0) {
    return NextResponse.json({ error: 'At least one photo is required' }, { status: 400 });
  }

  const saved = await saveTrainingHouse(body);
  if (!saved) {
    return NextResponse.json({ error: 'Failed to save training house — check server logs' }, { status: 500 });
  }
  return NextResponse.json({ id: saved.id });
}
