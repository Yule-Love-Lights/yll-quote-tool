import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { backfillCustomersFromQuotes } from '@/lib/customers';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// POST /api/admin/customers/backfill
//
// One-shot operator-triggered backfill: promotes every existing identity-bearing,
// not-yet-linked quote into the persistent customers/properties tables. Idempotent
// (re-running is safe — find-or-create deduplicates). Returns a summary so the
// operator can see how many quotes were linked vs skipped (no stable identity).
//
// Test quotes (is_test=true) are excluded inside backfillCustomersFromQuotes —
// the caller doesn't need to pass anything special.
//
// Requires a Supabase service-role key (needed for the customers/properties
// writes that customers.ts routes through the service client). Returns 503 if
// not configured so the operator gets a clear error rather than a silent no-op.

export async function POST() {
  const denied = await requireOperator();
  if (denied) return denied;

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
