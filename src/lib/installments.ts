// Installment plans (Homeworks migration, 2026-08-28).
//
// Three customers pay their 2026 job monthly — Raymond Brown, Mary O'Connor and
// Jane Laguerre. Homeworks had no installment feature: Jason collected each
// payment by hand and edited the invoice, so the schedule lived only in his
// notes. `installments` is that schedule made real — one row per scheduled
// payment (see migrations/2026-08-28-installments.sql).
//
// THE DEPOSIT IS NOT A ROW HERE. `quotes.deposit_amount_usd` stays the running
// total collected, so for any quote with a plan:
//     deposit_amount_usd = initial deposit + every installment marked paid
// That invariant is what `reconcilePlan` below checks, and it is the reason
// this module never writes deposit_amount_usd and installments in two places
// out of step — markInstallmentPaid moves both, or neither.
//
// NOTHING HERE CONTACTS A CUSTOMER. No email, no SMS, no pay link, no charge.
// Collecting a payment is a separate, deliberate action.

import { getSupabaseServiceClient } from '@/lib/supabase';
import { nyDateString } from '@/lib/jobs/completingToday';
import { latestConsentAmendment, blocksSettlement, type AmendmentTrailEntry } from '@/lib/amend';

export type Installment = {
  id: string;
  quoteId: string;
  seq: number;
  amountUsd: number;
  /** Null when the payment is due after the install rather than on a date. */
  dueDate: string | null;
  dueOnCompletion: boolean;
  paidAt: string | null;
  paidSource: 'homeworks' | 'valor' | 'manual' | null;
  /** Doubles as the runner's idempotency slot, exactly as
   *  `invoices.valor_balance_txn_id` does for the balance charge: null (never
   *  charged), `pending:<iso>` (a charge is in flight, or crashed and left its
   *  claim), or a real Valor txn id. Read it with `describeChargeSlot`. */
  valorTxnId: string | null;
  /** The operator who recorded this payment. NULL means not attributable: money
   *  collected at home.works before this tool existed, or an automatic charge,
   *  which has no human actor by definition. Mirrors `invoices.settled_by`. */
  paidBy: string | null;
  note: string | null;
};

export type InstallmentPlan = {
  quoteId: string;
  quoteNumber: number | null;
  customerName: string | null;
  customerEmail: string | null;
  /** The whole order, not just the plan. */
  quoteTotal: number;
  /** Everything collected so far, including the initial deposit. */
  collected: number;
  /** quoteTotal − collected. */
  balance: number;
  installments: Installment[];
  /** Sum of the scheduled payments — excludes the initial deposit. */
  planTotal: number;
  planPaid: number;
  planOutstanding: number;
  /** collected − planPaid: what was taken up front, before the schedule began.
   *
   *  KNOWN AND ACCEPTED (Jason, 2026-08-29): this is DERIVED, so anything the
   *  customer paid that is not one of the scheduled amounts lands here. Jane
   *  Laguerre reads $2,733.75 where she actually paid a $2,718.75 deposit — the
   *  extra $15.00 is the late fee that rode inside her second installment
   *  payment ($468.13 for a $453.13 instalment) and has nowhere else to live.
   *  Her COLLECTED total and everything derived from it are exactly right; only
   *  the split between "deposit" and "instalments" is off by that fee. Left
   *  alone deliberately rather than modelling fees, which would be a schema
   *  change for one $15 line. */
  initialDeposit: number;
  /** Whether the customer has a card on file to charge. The TOKEN itself is
   *  deliberately not carried here — this shape is returned verbatim by
   *  GET /api/admin/installments, so a vault token on it would ship a payment
   *  credential to every browser that opens the page. The runner re-reads the
   *  token server-side at charge time instead. */
  hasCardOnFile: boolean;
  /** The linked quote's own state, carried so the runner (row 448) can refuse
   *  to charge a quote that is no longer a live booked order. */
  quoteStatus: string | null;
  isNce: boolean;
  /** True when the quote's latest amendment is still awaiting the customer's
   *  consent — the same `blocksSettlement` gate the charge-balance route uses,
   *  so an amend-up can never be collected without a re-approval. */
  amendmentBlocksSettlement: boolean;
  /** When the customer agreed their saved card may be charged automatically for
   *  the scheduled payments. NULL means they never did, and the runner refuses.
   *  See migrations/2026-08-28-installment-auto-charge-consent.sql for why this
   *  is not implied by having a card on file. */
  autoChargeConsentAt: string | null;
};

/** The next DATED payment owed — a due-on-completion one is deliberately never
 *  "next", because it has no date and must never be auto-charged. Returns null
 *  when the plan is settled or everything left is due on completion. */
export function nextDuePayment(plan: InstallmentPlan): Installment | null {
  const dated = plan.installments
    .filter((i) => !i.paidAt && !i.dueOnCompletion && i.dueDate)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  return dated[0] ?? null;
}

/** True when a dated payment is due on or before `asOf`. Pure — `asOf` is
 *  passed in, never read from the clock, so this is deterministic.
 *
 *  The comparison is against the ET CALENDAR DAY, not the UTC one (row 449).
 *  `due_date` is a DATE column holding a business date, and `toISOString()`
 *  rolls over at 8pm ET (7pm in standard time) — so for the last few hours of
 *  every evening a payment due TOMORROW read as overdue. Cosmetic while nothing
 *  auto-charged off it; not cosmetic now that the runner (row 448) decides what
 *  to charge from exactly this predicate. */
export function isOverdue(inst: Installment, asOf: Date): boolean {
  if (inst.paidAt || inst.dueOnCompletion || !inst.dueDate) return false;
  return inst.dueDate <= nyDateString(asOf);
}

/** The invariant from this file's header, as a check rather than a comment:
 *  what the plan says is still owed must equal what the quote says is still
 *  owed. Returns null when they agree, or a human-readable difference. */
export function reconcilePlan(plan: InstallmentPlan): string | null {
  const diff = Math.round((plan.balance - plan.planOutstanding) * 100) / 100;
  if (Math.abs(diff) < 0.005) return null;
  return `quote balance ${plan.balance.toFixed(2)} vs plan outstanding ${plan.planOutstanding.toFixed(2)} (${diff > 0 ? '+' : ''}${diff.toFixed(2)})`;
}

const r2 = (n: number) => Math.round((n + 1e-9) * 100) / 100;

type Row = {
  id: string;
  quote_id: string;
  seq: number;
  amount_usd: number | string;
  due_date: string | null;
  due_on_completion: boolean;
  paid_at: string | null;
  paid_source: string | null;
  valor_txn_id: string | null;
  paid_by: string | null;
  note: string | null;
};

function toInstallment(r: Row): Installment {
  return {
    id: r.id,
    quoteId: r.quote_id,
    seq: r.seq,
    amountUsd: Number(r.amount_usd),
    dueDate: r.due_date,
    dueOnCompletion: r.due_on_completion,
    paidAt: r.paid_at,
    paidSource: (r.paid_source as Installment['paidSource']) ?? null,
    valorTxnId: r.valor_txn_id,
    paidBy: r.paid_by,
    note: r.note,
  };
}

/** Every plan, newest quote first. Read-only. */
export async function listInstallmentPlans(): Promise<
  { ok: true; plans: InstallmentPlan[] } | { ok: false; error: string }
> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  const { data: rows, error } = await sb
    .from('installments')
    .select('id, quote_id, seq, amount_usd, due_date, due_on_completion, paid_at, paid_source, valor_txn_id, paid_by, note')
    .order('quote_id')
    .order('seq');
  if (error) return { ok: false, error: error.message };

  const byQuote = new Map<string, Installment[]>();
  for (const r of (rows ?? []) as Row[]) {
    const list = byQuote.get(r.quote_id) ?? [];
    list.push(toInstallment(r));
    byQuote.set(r.quote_id, list);
  }
  if (byQuote.size === 0) return { ok: true, plans: [] };

  const { data: quotes, error: qErr } = await sb
    .from('quotes')
    .select('id, quote_number, customer_name, customer_email, total, deposit_amount_usd, valor_vault_token, status, is_nce, approval_snapshot, installment_auto_charge_consent_at')
    .in('id', [...byQuote.keys()]);
  if (qErr) return { ok: false, error: qErr.message };

  const plans: InstallmentPlan[] = [];
  for (const q of (quotes ?? []) as {
    id: string; quote_number: number | null; customer_name: string | null;
    customer_email: string | null; total: number | string | null;
    deposit_amount_usd: number | string | null; valor_vault_token: string | null;
    status: string | null; is_nce: boolean | null;
    approval_snapshot: { amendments?: AmendmentTrailEntry[] } | null;
    installment_auto_charge_consent_at: string | null;
  }[]) {
    const installments = byQuote.get(q.id) ?? [];
    const quoteTotal = Number(q.total ?? 0);
    const collected = Number(q.deposit_amount_usd ?? 0);
    const planPaid = r2(installments.filter((i) => i.paidAt).reduce((a, i) => a + i.amountUsd, 0));
    plans.push({
      quoteId: q.id,
      quoteNumber: q.quote_number,
      customerName: q.customer_name,
      customerEmail: q.customer_email,
      quoteTotal,
      collected,
      balance: r2(quoteTotal - collected),
      installments,
      planTotal: r2(installments.reduce((a, i) => a + i.amountUsd, 0)),
      planPaid,
      planOutstanding: r2(installments.filter((i) => !i.paidAt).reduce((a, i) => a + i.amountUsd, 0)),
      initialDeposit: r2(collected - planPaid),
      hasCardOnFile: !!q.valor_vault_token,
      quoteStatus: q.status,
      isNce: !!q.is_nce,
      amendmentBlocksSettlement: blocksSettlement(latestConsentAmendment(q.approval_snapshot?.amendments)),
      autoChargeConsentAt: q.installment_auto_charge_consent_at,
    });
  }
  plans.sort((a, b) => (b.quoteNumber ?? 0) - (a.quoteNumber ?? 0));
  return { ok: true, plans };
}

/**
 * Record a payment against one scheduled installment, and move the quote's
 * collected total by the SAME amount in the same call — the two can never drift
 * apart, which is the whole point of the invariant above.
 *
 * Guarded: an installment already marked paid is refused rather than
 * double-counted, so a duplicate click or a retry is a no-op.
 *
 * Does NOT charge anything. The caller has already collected the money (a Valor
 * charge, a cash payment); this records it.
 */
export async function markInstallmentPaid(input: {
  installmentId: string;
  paidAt: Date;
  source: 'valor' | 'manual';
  valorTxnId?: string | null;
  /** The operator who recorded it. Omitted/null for the runner's automatic
   *  charges, which have no human actor — a NULL here is information, not a
   *  gap. Added after the premerge admin lens found this money write had no
   *  attributable actor at all, while its sibling `markInvoicePaidManually` has
   *  recorded `settled_by` since #225. */
  paidBy?: string | null;
}): Promise<{ ok: true; amountUsd: number } | { ok: false; error: string }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  // Compare-and-swap on paid_at being null: the loser of a race updates zero
  // rows and never touches the quote's total.
  const { data, error } = await sb
    .from('installments')
    .update({
      paid_at: input.paidAt.toISOString(),
      paid_source: input.source,
      valor_txn_id: input.valorTxnId ?? null,
      paid_by: input.paidBy ?? null,
    })
    .eq('id', input.installmentId)
    .is('paid_at', null)
    .select('quote_id, amount_usd')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Already recorded as paid' };

  const row = data as { quote_id: string; amount_usd: number | string };
  const amount = Number(row.amount_usd);

  // The quote's collected total moves by a READ-then-WRITE, which is a
  // lost-update race: two installments settled at the same moment would both
  // read the same starting figure and the second write would erase the first,
  // leaving the customer's collected total short by a whole payment. So the
  // write carries the value it read as a compare-and-swap — if anything moved
  // the total in between, the update matches zero rows and we read again
  // rather than clobbering it. (Premerge technical lens, PR #1049.)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: q, error: readErr } = await sb
      .from('quotes')
      .select('deposit_amount_usd')
      .eq('id', row.quote_id)
      .maybeSingle();
    if (readErr) {
      return { ok: false, error: `Installment recorded, but the quote total could not be read: ${readErr.message}` };
    }
    const current = Number((q as { deposit_amount_usd: number | string | null } | null)?.deposit_amount_usd ?? 0);
    const { data: moved, error: qErr } = await sb
      .from('quotes')
      .update({ deposit_amount_usd: r2(current + amount) })
      .eq('id', row.quote_id)
      .eq('deposit_amount_usd', current)
      .select('id');
    if (qErr) {
      return { ok: false, error: `Installment recorded, but the quote total did not update: ${qErr.message}` };
    }
    if (moved && moved.length > 0) return { ok: true, amountUsd: amount };
    // Zero rows: someone else moved the total between the read and the write.
    // Loop and re-read so this payment is added to THEIR figure, not instead of it.
  }
  // Three lost races in a row is not contention, it is something wrong. The
  // installment is already marked paid, so say plainly that the two are now out
  // of step — reconcilePlan surfaces it on /admin/installments too.
  return {
    ok: false,
    error: 'Installment recorded, but the quote total could not be updated after 3 attempts — the plan and the quote are now out of step.',
  };
}
