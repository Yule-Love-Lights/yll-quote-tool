import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoiceDetail, setInvoiceTaxOverride, setInvoicePaymentPreference } from '@/lib/invoices';
import { isAutoChargeEnabled, describeChargeSlot } from '@/lib/integrations/valorBalance';

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
  // Echo the auto-charge flag so the operator UI only renders the "Charge saved
  // card" button when the capability is actually enabled (else it stays hidden —
  // the pay-link is the balance method until Valor is confirmed). chargeState
  // (#170d) makes an in-flight/stuck charge claim visible to staff.
  return NextResponse.json({
    ...detail,
    autoChargeEnabled: isAutoChargeEnabled(),
    chargeState: describeChargeSlot(detail.invoice.valor_balance_txn_id),
  });
}

// PATCH — operator settings on the invoice. Body carries exactly one of:
//   { taxOverridden: boolean } — toggle the manual tax-override (SPEC §4.3);
//     re-prices the invoice + reconciles its status.
//   { paymentPreference: 'card_on_file' | 'cash_check' | null } — #170(d):
//     how this customer settles the balance (metadata; gates the charge button).
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
  let body: { taxOverridden?: unknown; paymentPreference?: unknown };
  try {
    body = (await req.json()) as { taxOverridden?: unknown; paymentPreference?: unknown };
  } catch {
    body = {};
  }
  if ('paymentPreference' in body) {
    const pref = body.paymentPreference;
    if (pref !== null && pref !== 'card_on_file' && pref !== 'cash_check') {
      return NextResponse.json(
        { error: "paymentPreference must be 'card_on_file', 'cash_check', or null" },
        { status: 400 },
      );
    }
    const invoice = await setInvoicePaymentPreference(id, pref);
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, invoice });
  }
  if (typeof body.taxOverridden !== 'boolean') {
    return NextResponse.json({ error: 'taxOverridden (boolean) or paymentPreference is required' }, { status: 400 });
  }
  let invoice;
  try {
    invoice = await setInvoiceTaxOverride(id, body.taxOverridden);
  } catch (err) {
    // B3 fix: setInvoiceTaxOverride throws when the invoice is already paid.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Cannot update invoice', code: 'invoice-paid' },
      { status: 409 },
    );
  }
  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, invoice });
}
