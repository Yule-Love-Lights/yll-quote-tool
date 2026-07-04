import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rebookFromQuote } from '@/lib/rebook';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// POST /api/quotes/[id]/rebook
//
// #116 — revive a dead quote. Clone THIS specific quote (any status, including a
// terminal declined / cancelled / lost one) + its design into a fresh DRAFT so
// the operator can start a new season/attempt from the same specs. The original
// quote is left intact for the audit trail. Rebook-only (re-send of the same
// quote is deliberately out of scope per the S23 council).
//
// Returns:
//   200  { ok: true, quoteId, designId }   — rebook succeeded
//   400  { error }                          — invalid UUID
//   404  { error, code: 'no-source' }       — no quote matches the id
//   503                                     — Supabase service role not configured

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  const { id } = await params;
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const result = await rebookFromQuote(id);
  if (!result) {
    return NextResponse.json(
      { error: 'No quote to rebook from', code: 'no-source' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, quoteId: result.quoteId, designId: result.designId });
}
