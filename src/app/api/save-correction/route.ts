import { NextRequest, NextResponse } from 'next/server';
import { saveCorrection, CorrectionPayload } from '@/lib/corrections';
import { isSupabaseConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Corrections require Supabase — set SUPABASE_URL and SUPABASE_ANON_KEY' },
      { status: 503 },
    );
  }

  let body: CorrectionPayload;
  try {
    body = (await req.json()) as CorrectionPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const saved = await saveCorrection(body);
  if (!saved) {
    return NextResponse.json({ error: 'Failed to save correction' }, { status: 500 });
  }
  return NextResponse.json({ id: saved.id });
}
