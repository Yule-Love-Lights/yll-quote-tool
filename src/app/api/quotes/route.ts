import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, isSupabaseConfigured } from '@/lib/supabase';
import { deleteAllQuotes, listQuotes } from '@/lib/quotes';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// Operator-only routes for listing + bulk-deleting persisted quote rows. Used by
// /admin/quotes to clean up fake/test entries during development. The operator
// surface is gated by the session perimeter (ledger #81); these handlers also
// call requireOperator() as defense in depth — DORMANT until AUTH_GATE_ENABLED
// =true, so the same-origin /admin/quotes fetches keep working today and ride
// the operator session cookie once the gate is live.

// Audit fix (g29-route): the bulk wipe deletes ALL customer PII in a single
// call. Require an explicit confirmation header IN ADDITION to operator auth so
// a stray/forged request can't one-shot the whole table. The caller must echo
// this exact phrase.
const DELETE_ALL_CONFIRM = 'DELETE ALL QUOTES';

export async function GET() {
  // Operator-only: this returns every customer's quote (PII). Gating it used to
  // 401 the /admin/quotes page because the old static-secret half-gate broke the
  // plain `fetch('/api/quotes')`; the dormancy-aware guard fixes that — it's a
  // no-op until the gate is enabled, and a logged-in operator's session cookie
  // rides the same-origin fetch automatically once it is.
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const items = await listQuotes(500);
  return NextResponse.json({ items });
}

// Bulk delete — operator-only PLUS an explicit confirmation header. Returns count.
export async function DELETE(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  // Audit fix (g29-route): second factor for the full-PII wipe — the caller must
  // explicitly confirm intent, not just be an authenticated operator.
  if (req.headers.get('x-confirm-delete-all') !== DELETE_ALL_CONFIRM) {
    return NextResponse.json(
      { error: `Bulk delete requires confirmation: send header x-confirm-delete-all: ${DELETE_ALL_CONFIRM}` },
      { status: 428 }, // Precondition Required
    );
  }
  try {
    const count = await deleteAllQuotes();
    return NextResponse.json({ deleted: count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
