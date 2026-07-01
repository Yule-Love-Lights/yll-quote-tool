import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { rebookLastSeason } from '@/lib/rebook';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// POST /api/customers/[customerId]/rebook
//
// Clone the customer's last APPROVED quote (+ its design) into a fresh draft
// so the operator can start a new season from the same specs. Optionally
// scoped to one property via the request body's `propertyId`.
//
// Returns:
//   200  { ok: true, quoteId, designId }   — rebook succeeded
//   400  { error }                          — invalid UUID
//   404  { error, code: 'no-source' }       — no approved quote to clone from
//   503                                     — Supabase service role not configured

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }

  const { customerId } = await params;
  if (!customerId || !UUID_RE.test(customerId)) {
    return NextResponse.json({ error: 'Invalid customer id' }, { status: 400 });
  }

  // Optional property scope from the request body (best-effort parse — a missing
  // or invalid body is fine; we just rebook across all properties).
  let propertyId: string | undefined;
  try {
    const body = (await req.json()) as { propertyId?: unknown };
    if (typeof body?.propertyId === 'string' && UUID_RE.test(body.propertyId)) {
      propertyId = body.propertyId;
    }
  } catch {
    // No body or non-JSON body → rebook without a property scope.
  }

  const result = await rebookLastSeason(customerId, propertyId);
  if (!result) {
    return NextResponse.json(
      { error: 'No approved quote to rebook from', code: 'no-source' },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, quoteId: result.quoteId, designId: result.designId });
}
