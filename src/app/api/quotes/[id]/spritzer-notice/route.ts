// Staff switch for the portal's free-spritzer thank you.
//
// POST /api/quotes/[id]/spritzer-notice   (operator-only)
// Body:     { suppressed: boolean }
// Response: { ok: true, suppressed } | { error, code? }
//
// Why this exists: the portal reads the free-spritzer count out of the LABEL
// TEXT staff type into line items, because that is where the promise actually
// lives (measured 2026-09-03: 91 live quotes promise free spritzers and 94 of
// 96 such lines keep it inside the label of a PAID package line). Free text can
// be wrong in ways a parser must not try to guess at — a gift withdrawn after
// the label was typed, a phrasing that means something else, a promise already
// settled another way. This is how staff say "not on this one" without
// rewriting a label the customer may have already read.
//
// Deliberately the narrowest possible write: it flips ONE boolean inside the
// `inputs` jsonb and touches nothing else. It cannot move money — the flag is
// not a pricing input (the engine ignores it, exactly like `waiveMinimum`), the
// route never writes `result`, `total`, `deposit_amount_usd` or the approval
// snapshot, and it asserts the quote's own total is unchanged after the write
// rather than trusting that claim.
//
// Allowed on an approved or booked quote ON PURPOSE, unlike the staff-selection
// route next door. That route refuses because it would rewrite what a customer
// agreed to; this one changes no term of the order, and a booked quote is
// exactly where a wrong promise is most urgent to take down.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  inputs: Record<string, unknown> | null;
  total: number | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const suppressed = (body as { suppressed?: unknown } | null)?.suppressed;
  if (typeof suppressed !== 'boolean') {
    return NextResponse.json({ error: 'Body must be { suppressed: boolean }' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, inputs, total')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: `Quote not found: ${fetchErr?.message ?? 'no row'}` }, { status: 404 });
  }
  if (!quote.inputs) {
    // No priced inputs means no line items and so nothing to promise. Refuse
    // rather than fabricate an inputs object, which would give the pricing
    // engine a shape it never produced.
    return NextResponse.json(
      { error: 'This quote has no saved inputs yet, so there is no notice to change.', code: 'no-inputs' },
      { status: 409 },
    );
  }

  const nextInputs = { ...quote.inputs, suppressFreeSpritzerNotice: suppressed };

  const { error: writeErr } = await sb
    .from('quotes')
    .update({ inputs: nextInputs })
    .eq('id', id);
  if (writeErr) {
    return NextResponse.json({ error: `Could not save: ${writeErr.message}` }, { status: 500 });
  }

  // Read back and assert the money did not move. The update above names only
  // `inputs`, so this should be impossible — which is the point: an invariant
  // worth stating is worth checking, and a silent money change on a booked
  // order is the one failure this route must never contribute to.
  const { data: after, error: afterErr } = await sb
    .from('quotes')
    .select('id, inputs, total')
    .eq('id', id)
    .single<QuoteRow>();
  if (afterErr || !after) {
    return NextResponse.json(
      { error: 'Saved, but could not confirm the result. Refresh before changing it again.' },
      { status: 500 },
    );
  }
  if (Number(after.total ?? 0) !== Number(quote.total ?? 0)) {
    return NextResponse.json(
      { error: 'Refusing to report success: the quote total changed during this write.' },
      { status: 500 },
    );
  }

  const operator = await getOperator();
  console.info(
    `[spritzer-notice] quote=${id} suppressed=${suppressed} by=${operator?.email ?? 'unknown operator'}`,
  );

  return NextResponse.json({
    ok: true,
    suppressed: after.inputs?.suppressFreeSpritzerNotice === true,
  });
}
