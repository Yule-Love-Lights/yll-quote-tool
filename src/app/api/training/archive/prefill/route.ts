import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { getArchivePrefill } from '@/lib/archiveQueue';

// #167 P1 slice 3 — seed /training/new from an archive property.
//
// Distinct from /api/training/prefill, which projects an existing QUOTE's
// approved design into few-shot markup (#109). This one has no design and no
// markup to project: it hands over the daytime satellite to trace on, the
// address, the night photos as reference, and — the part that matters — the
// scale, so traced lines convert to real footage.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'The archive queue requires the Supabase service role' },
      { status: 503 },
    );
  }

  const addressKey = req.nextUrl.searchParams.get('addressKey');
  if (!addressKey?.trim()) {
    return NextResponse.json({ error: 'An addressKey is required' }, { status: 400 });
  }

  const prefill = await getArchivePrefill(addressKey);
  if (!prefill) {
    return NextResponse.json(
      { error: 'That property has no satellite imagery yet — fetch imagery before tracing it' },
      { status: 404 },
    );
  }
  return NextResponse.json(prefill);
}
