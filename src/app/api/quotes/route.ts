import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, isSupabaseConfigured } from '@/lib/supabase';
import { deleteAllQuotes, listQuotes } from '@/lib/quotes';
import { safeEqual } from '@/lib/security';

export const runtime = 'nodejs';

// Admin-only routes for listing + bulk-deleting persisted quote rows. Used
// by /admin/quotes to clean up fake/test entries during development. Delete
// operations require the shared ADMIN_SECRET header (x-admin-secret).

// Audit fix (g29-route): the bulk wipe deletes ALL customer PII in a single
// call behind nothing but the static admin secret. Require an explicit
// confirmation header in addition to the secret so a leaked/forged secret
// (or a stray CSRF-style request) can't one-shot the whole table. The caller
// must echo this exact phrase.
const DELETE_ALL_CONFIRM = 'DELETE ALL QUOTES';

function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }
  const provided = req.headers.get('x-admin-secret');
  // Audit fix: constant-time compare to avoid leaking the secret via timing.
  if (!safeEqual(provided ?? undefined, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET() {
  // NOTE: the admin quote LIST is intentionally NOT gated by the admin secret.
  // The /admin/quotes page loads it with a plain `fetch('/api/quotes')` (no
  // header) — the secret is only attached to delete actions — so gating GET
  // here 401'd the whole page ("Unauthorized"). The earlier audit gate was a
  // mistaken "non-breaking" assumption (reverted). Closing this PII-listing
  // exposure belongs to the operator-auth perimeter (ledger #81), which gates
  // the entire operator surface at once, not a half-gate that breaks the UI.
  // DELETE below stays gated (it already sends the secret).
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }
  const items = await listQuotes(500);
  return NextResponse.json({ items });
}

// Bulk delete. Caller must pass x-admin-secret. Returns count deleted.
export async function DELETE(req: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;
  // Audit fix (g29-route): second factor for the full-PII wipe — the caller
  // must explicitly confirm intent, not just present the admin secret.
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
