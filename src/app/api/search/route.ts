// GET /api/search?q=<text> — the operator header search box.
//
// Operator-gated and READ ONLY: no inserts, no updates, no RPC. Returns four
// groups (customers, quotes, jobs, invoices) already ranked active-first by
// src/lib/search/globalSearch.ts, which owns all the logic and all the tests.
// This file is the thin edge: auth, configuration, the query string, and the
// error shape.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { emptyResults, globalSearch } from '@/lib/search/globalSearch';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const q = req.nextUrl.searchParams.get('q') ?? '';

  try {
    const results = await globalSearch(getSupabaseServiceClient()!, q);
    return NextResponse.json({ results });
  } catch (err) {
    // A search failure is a non-event for the rest of the page, but it must
    // not read as "no matches" — the box shows a real error line, so the
    // status code has to say so rather than quietly returning empty groups.
    console.error('[api/search] failed:', err);
    return NextResponse.json({ error: 'Search failed', results: emptyResults() }, { status: 500 });
  }
}
