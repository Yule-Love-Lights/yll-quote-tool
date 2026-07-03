import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { backfillCustomersFromQuotes } from '@/lib/customers';
import { requireAdmin } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// POST /api/admin/customers/backfill
//
// One-shot admin-triggered backfill: promotes every existing identity-bearing,
// not-yet-linked quote into the persistent customers/properties tables. Idempotent
// (re-running is safe — find-or-create deduplicates). Returns a summary so the
// admin can see how many quotes were linked vs skipped (no stable identity).
//
// Test quotes (is_test=true) are excluded inside backfillCustomersFromQuotes —
// the caller doesn't need to pass anything special.
//
// Audit fix (W2-020): gated with requireAdmin (strict, never dormancy-bypassed)
// to match the /api/admin/* namespace's sibling routes (admin/users) and the
// conventions charter §1 — a one-time customer/property data migration is an
// admin data op, not routine operator traffic.
//
// Requires a Supabase service-role key (needed for the customers/properties
// writes that customers.ts routes through the service client). Returns 503 if
// not configured so the admin gets a clear error rather than a silent no-op.

export async function POST() {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  try {
    const summary = await backfillCustomersFromQuotes();
    return NextResponse.json(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Backfill failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
