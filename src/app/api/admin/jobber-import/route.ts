import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import {
  parseJobberCsv,
  planJobberImport,
  commitJobberImport,
  type JobberColumnMap,
} from '@/lib/import/jobberImport';

export const runtime = 'nodejs';

// POST /api/admin/jobber-import
//
// One-time Jobber CSV import — SCAFFOLD (ledger #72). Accepts the raw CSV
// text + a JobberColumnMap (source header name → our field) and either:
//   mode: 'dry-run' (default) — parses + plans only. NO writes. Returns the
//         ImportPlan so an admin can review counts/dispositions before
//         committing anything.
//   mode: 'commit'  — also applies the plan (idempotent — see
//         commitJobberImport). Returns the plan AND the commit result.
//
// Mirrors the /api/admin/customers/backfill route's auth/guard shape:
// requireAdmin() (strict, never dormancy-bypassed) + a 503 when the
// service-role key isn't configured, so the admin gets a clear error rather
// than a silent no-op.

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  let body: { csv?: unknown; map?: unknown; mode?: unknown; isTest?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (!csv.trim()) {
    return NextResponse.json({ error: '"csv" is required' }, { status: 400 });
  }
  const map = body.map as JobberColumnMap | undefined;
  if (!map || typeof map !== 'object') {
    return NextResponse.json({ error: '"map" (JobberColumnMap) is required' }, { status: 400 });
  }
  const mode = body.mode === 'commit' ? 'commit' : 'dry-run';
  const isTest = typeof body.isTest === 'boolean' ? body.isTest : undefined;

  try {
    const rows = parseJobberCsv(csv);
    const plan = planJobberImport(rows, map, { isTest });

    if (mode === 'dry-run') {
      return NextResponse.json({ mode, plan });
    }

    const result = await commitJobberImport(plan, { isTest });
    return NextResponse.json({ mode, plan, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Import failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
