import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, isSupabaseConfigured } from '@/lib/supabase';
import { deleteAllQuotes, listQuotes } from '@/lib/quotes';

export const runtime = 'nodejs';

// Admin-only routes for listing + bulk-deleting persisted quote rows. Used
// by /admin/quotes to clean up fake/test entries during development. Delete
// operations require the shared ADMIN_SECRET header (x-admin-secret).

function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  // Listing every quote exposes customer PII (names, addresses, totals). It was
  // unauthenticated even though the only caller (/admin/quotes) already sends
  // x-admin-secret — so requiring it here closes the hole without breaking the
  // UI. Audit 2026-06 (security — unauthenticated PII listing).
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;
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
  try {
    const count = await deleteAllQuotes();
    return NextResponse.json({ deleted: count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
