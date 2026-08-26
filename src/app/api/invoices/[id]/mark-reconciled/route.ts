// POST /api/invoices/[id]/mark-reconciled  (operator-only)
//
// Row 414 — the explicit staff override for the stale-invoice markers
// (approval_snapshot.paymentBlocked / .invoiceResyncFailed).
//
// WHY THIS EXISTS: row 404 (#959) gave the markers a clearing path via
// charge-balance, but ONLY when its staleness check runs and passes — and
// `mark-paid`, the cash/check action EVERY customer not on card-on-file
// settles through, never touches them. Post-#959 that is provably terminal:
// charge-balance 409s 'no-balance' on a settled invoice before it can reach
// its clear. mark-paid deliberately does NOT clear (it runs no staleness
// check, so a clear there would be unjustified — the same reasoning that
// rules out an overrideStale clear). So a marker on an invoice that settled
// through mark-paid could never leave, and the ⚠ could only accumulate.
//
// THE SHAPE: a human asserts "I checked this invoice against the agreed
// total; the discrepancy the marker flags is resolved or does not apply."
// That is a MONEY-MARKER override, so it is audited in the same atomic write:
// one CAS on approval_snapshot removes both marker keys AND appends a
// `markerOverrides` entry naming who asserted it, what was cleared, and the
// marker payloads that were cleared (the forensic content would otherwise be
// destroyed by the very action that needs auditing). PR #970's admin lens
// ruled the shape: foreground casSwapApprovalSnapshot + a 409 on conflict —
// the override either records its audit line or does not happen. Never the
// best-effort appendQuoteAuditEntry, whose may-drop contract is wrong for
// "who overrode a money marker".
//
// Population at build time (2026-08-26, prod): ZERO quotes carry either
// marker — this ships ahead of the season that will mint them, which is the
// cheapest window a guard ever gets (the row 378 lesson).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { getInvoice } from '@/lib/invoices';
import { casSwapApprovalSnapshot } from '@/lib/quoteAudit';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (!invoice.quote_id) {
    // The markers live on the QUOTE's snapshot; an invoice with no linked
    // quote structurally cannot carry one.
    return NextResponse.json({ error: 'No linked order to reconcile', code: 'no-quote' }, { status: 409 });
  }

  const sb = getSupabaseServiceClient()!;
  // Confirmed read, never coerced (quoteAudit trap 2): a failed read must be
  // a 503 the operator retries, not an empty object we write over the frozen
  // agreement.
  const { data: quoteRow, error: readErr } = await sb
    .from('quotes')
    .select('approval_snapshot')
    .eq('id', invoice.quote_id)
    .maybeSingle<{ approval_snapshot: Record<string, unknown> | null }>();
  if (readErr || !quoteRow) {
    return NextResponse.json(
      { error: "Couldn't read the order's current state — nothing was changed. Try again.", code: 'read-failed' },
      { status: 503 },
    );
  }
  const prior = quoteRow.approval_snapshot;
  const cleared = {
    paymentBlocked: prior?.paymentBlocked,
    invoiceResyncFailed: prior?.invoiceResyncFailed,
  };
  if (!prior || (!cleared.paymentBlocked && !cleared.invoiceResyncFailed)) {
    // Idempotent-friendly: a double-click's second request lands here.
    return NextResponse.json(
      { error: 'This invoice has no unreconciled marker to clear.', code: 'no-markers' },
      { status: 409 },
    );
  }

  const operator = await getOperator();
  const priorOverrides = Array.isArray(prior.markerOverrides) ? (prior.markerOverrides as unknown[]) : [];
  const next: Record<string, unknown> = Object.fromEntries(
    Object.entries(prior).filter(([k]) => k !== 'paymentBlocked' && k !== 'invoiceResyncFailed'),
  );
  next.markerOverrides = [
    ...priorOverrides,
    {
      action: 'mark-reconciled',
      by: operator?.email ?? null,
      at: new Date().toISOString(),
      invoiceId: id,
      // The cleared payloads ride IN the audit entry — clearing them is the
      // action being audited, and without this the override destroys the only
      // record of what it overrode.
      cleared,
    },
  ];

  const outcome = await casSwapApprovalSnapshot(
    sb,
    invoice.quote_id,
    prior,
    next,
    '[api/invoices/:id/mark-reconciled]',
  );
  if (outcome === 'error') {
    return NextResponse.json({ error: 'Failed to record the reconciliation' }, { status: 500 });
  }
  if (outcome === 'conflict') {
    return NextResponse.json(
      { error: 'The order changed while you were reconciling — reload and retry.', code: 'concurrent-edit' },
      { status: 409 },
    );
  }
  return NextResponse.json({
    ok: true,
    cleared: Object.keys(cleared).filter((k) => (cleared as Record<string, unknown>)[k] !== undefined && (cleared as Record<string, unknown>)[k] !== null),
  });
}
