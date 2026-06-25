// Customer-interest signal. Fired client-side when a customer hovers (desktop)
// or focuses/taps (mobile) the Approve button on the portal WITHOUT completing
// approval — a "they're seriously considering it" hot-lead signal. Records a
// single 'interested' event per quote (the first time) so the /customers/[id]
// activity feed shows it. Like the view receipt, it only counts once the quote
// has actually been SENT (a staff preview isn't a customer signal).
//
// POST /api/quotes/[id]/interested
//   { ok: true }                          — recorded
//   { ok: true, skipped: 'not-sent' | 'already' | 'log-unavailable' }
//
// Auth model mirrors /view + /approve: the quote UUID is the capability token.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = { id: string; quote_sent_at: string | null };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-interested', limit: 30, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, quote_sent_at')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: `Quote not found: ${fetchErr?.message ?? 'no row'}` }, { status: 404 });
  }

  // Interest only counts on a quote that's actually been sent to the customer.
  if (!quote.quote_sent_at) {
    return NextResponse.json({ ok: true, skipped: 'not-sent' });
  }

  // Record ONE 'interested' event per quote (the first time), so the feed shows
  // a single clean "Interested" marker. Best-effort throughout: any failure
  // (notably the `kind` column not migrated yet) must never error the portal.
  try {
    const { data: existing, error: checkErr } = await sb
      .from('quote_view_events')
      .select('id')
      .eq('quote_id', id)
      .eq('kind', 'interested')
      .limit(1);
    if (checkErr) {
      console.warn('[api/quotes/:id/interested] check failed (kind not migrated?):', checkErr.message);
      return NextResponse.json({ ok: true, skipped: 'log-unavailable' });
    }
    if (existing && existing.length > 0) {
      return NextResponse.json({ ok: true, skipped: 'already' });
    }
    const { error: insErr } = await sb
      .from('quote_view_events')
      .insert({ quote_id: id, viewed_at: new Date().toISOString(), kind: 'interested' });
    if (insErr) {
      console.warn('[api/quotes/:id/interested] insert failed:', insErr.message);
      return NextResponse.json({ ok: true, skipped: 'log-unavailable' });
    }
  } catch (err) {
    console.warn('[api/quotes/:id/interested] failed:', err);
    return NextResponse.json({ ok: true, skipped: 'error' });
  }

  return NextResponse.json({ ok: true });
}
