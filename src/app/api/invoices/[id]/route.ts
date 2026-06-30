import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoiceDetail, setInvoiceTaxOverride } from '@/lib/invoices';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Operator-only billing detail for one invoice (#83): the invoice + joined
// customer + the linked job's number/status. Service-role only (reads under RLS).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }
  const detail = await getInvoiceDetail(id);
  if (!detail) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  return NextResponse.json(detail);
}

// PATCH — operator toggles the manual tax-override (SPEC §4.3). Body:
// { taxOverridden: boolean }. Re-prices the invoice + reconciles its status.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }
  let body: { taxOverridden?: unknown };
  try {
    body = (await req.json()) as { taxOverridden?: unknown };
  } catch {
    body = {};
  }
  if (typeof body.taxOverridden !== 'boolean') {
    return NextResponse.json({ error: 'taxOverridden (boolean) is required' }, { status: 400 });
  }
  const invoice = await setInvoiceTaxOverride(id, body.taxOverridden);
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, invoice });
}
