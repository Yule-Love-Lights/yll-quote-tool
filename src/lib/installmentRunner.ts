// The monthly installment runner (ledger row 448).
//
// Three customers pay their 2026 Homeworks job monthly (see src/lib/
// installments.ts). This module is the automation: on a given day, work out
// which scheduled payments are due, charge the card on file for them, and
// record the payment through `markInstallmentPaid` so the plan and the quote's
// collected total move together.
//
// THIS MOVES REAL MONEY. Four separate gates stand between this code and a
// customer's card, and ALL FOUR must be open:
//   0. PER CUSTOMER: `quotes.installment_auto_charge_consent_at` must be set.
//      NULL is the default for every row and means the customer never agreed to
//      a recurring card debit — which is the true state of all three migrated
//      plan customers, who came from a CRM where Jason collected every payment
//      by hand. A vaulted card is NOT consent: the token is written as an
//      unconditional side effect of any successful card payment. Read the
//      migration's own comment before writing a value into that column — two
//      customer-facing gaps must close first (the portal/PDF balance does not
//      move when an installment is collected, and the customer gets no receipt
//      of any kind). Premerge customer lens, PR #1051.
//   1. `VALOR_AUTO_CHARGE_ENABLED` — the existing repo-wide auto-charge flag.
//      `chargeBalanceOnFile` returns 'not-enabled' without it.
//   2. `INSTALLMENT_RUNNER_ENABLED` — this runner's OWN flag, so arming the
//      cron and arming the charging are two separate decisions and either can
//      be reversed from Vercel without a deploy. Off means every run is a dry
//      run, whatever the caller asked for.
//   3. An explicit `dryRun: false` on an operator-triggered run. A cron run
//      carries no body, so for a cron the flag in (2) is the whole switch.
// And one more, outside this file: NOTHING IS SCHEDULED. `vercel.json` has no
// entry for this route on purpose (Jason's call 2026-08-28 — dry-run first, no
// cron armed until he says so). Arming it is one line there plus flag (2).
//
// DO NOT ARM UNTIL LEDGER ROW 446 SHIPS. When a charge lands but recording it
// fails, the payment has to be recorded by hand — and `markInstallmentPaid` has
// no caller anywhere in the app yet, so today the recovery is a developer
// editing the database. Premerge staff lens, PR #1051.
//
// WHY THE ORDER REF IS `inst_` AND NOT `bal_`: the Valor webhook matches
// `bal_<quoteId>` and settles the WHOLE linked invoice as paid. Tagging a $453
// installment with that prefix would mark a $5,452 order paid in full. `inst_`
// matches nothing in the webhook's dispatch, so an installment charge is inert
// there (acknowledged, ignored, logged) and this module is the only thing that
// records it.

import { chargeBalanceOnFile, describeChargeSlot } from '@/lib/integrations/valorBalance';
import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  listInstallmentPlans,
  markInstallmentPaid,
  isOverdue,
  reconcilePlan,
  type InstallmentPlan,
} from '@/lib/installments';
import { nyDateString } from '@/lib/jobs/completingToday';

/** This runner's own kill switch — see gate (2) in the header. Parsed the same
 *  tolerant way as `isAutoChargeEnabled`, so 'true'/'1'/'yes'/'on' all arm it. */
export function isInstallmentRunnerEnabled(): boolean {
  const v = process.env.INSTALLMENT_RUNNER_ENABLED?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Absolute ceiling on a single automated installment charge. The largest
 * scheduled payment in the live plan set is $453.13, so this is roughly 5x
 * headroom — deliberately far tighter than the invoice route's $25,000, because
 * nobody is watching a cron. A corrupted amount must hit this, not the card.
 * Mirrors #170(c)'s reasoning at installment scale.
 */
export const MAX_INSTALLMENT_CHARGE_USD = 2_500;

export type SkipReason =
  | 'nothing-due'
  | 'no-card-on-file'
  | 'quote-not-booked'
  | 'nce-quote'
  | 'amendment-pending'
  | 'plan-out-of-step'
  | 'over-cap'
  | 'no-auto-charge-consent'
  | 'claim-needs-review'
  | 'charged-not-recorded'
  | 'linked-invoice-would-drift';

export type RunDecision = {
  quoteId: string;
  quoteNumber: number | null;
  customerName: string | null;
  installmentId: string | null;
  seq: number | null;
  amountUsd: number | null;
  dueDate: string | null;
  action: 'charge' | 'skip';
  /** EVERY blocker, not just the first one hit — a dry run that reports only
   *  "no card on file" hides that the plan is also out of step. */
  reasons: SkipReason[];
  detail: string | null;
  /** Dated payments on this plan that are ALSO due but deliberately left for a
   *  later run — see the one-charge-per-quote-per-run rule below. */
  alsoDue: number;
};

/**
 * Decide what a run would do. PURE — `asOf` is passed in and nothing here
 * touches the network, so the whole policy is unit-testable without a database.
 *
 * ONE CHARGE PER QUOTE PER RUN, always the oldest due payment. Two payments can
 * only both be outstanding if a run was missed, and catching up two months of
 * card charges in one silent batch is a much larger surprise than taking a day
 * longer. `alsoDue` reports the rest so a backlog is visible rather than quiet.
 */
export function planInstallmentRun(plans: InstallmentPlan[], asOf: Date): RunDecision[] {
  return plans.map((plan) => {
    const due = plan.installments
      .filter((i) => isOverdue(i, asOf))
      .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
    const target = due[0] ?? null;

    const base = {
      quoteId: plan.quoteId,
      quoteNumber: plan.quoteNumber,
      customerName: plan.customerName,
      installmentId: target?.id ?? null,
      seq: target?.seq ?? null,
      amountUsd: target?.amountUsd ?? null,
      dueDate: target?.dueDate ?? null,
      alsoDue: Math.max(0, due.length - 1),
    };

    if (!target) {
      return { ...base, action: 'skip' as const, reasons: ['nothing-due' as const], detail: null };
    }

    const reasons: SkipReason[] = [];
    const details: string[] = [];

    // THE CLAIM SLOT IS NEVER AUTO-RECLAIMED HERE, at any age.
    //
    // The charge-balance route reclaims a claim older than 15 minutes, and that
    // is right for it: a HUMAN is clicking, and can check Valor first. This is
    // an unattended cron. A leftover `pending:` sentinel cannot distinguish "the
    // process died before it ever called Valor" from "the call timed out after
    // the charge landed" — same sentinel either way — so on a daily cadence a
    // stale claim would silently become eligible again the next morning and
    // re-charge a payment that may already have been taken. Premerge customer
    // lens, PR #1051: a real double charge, $453.13 of somebody's money.
    //
    // So ANY value in the slot stops the runner and asks for a person.
    const slot = describeChargeSlot(target.valorTxnId);
    if (slot.kind === 'charged') {
      // paid_at is null (isOverdue guarantees it) but a real Valor txn id is
      // recorded: the card WAS charged and the recording step failed. Never
      // charge again — a human reconciles this one.
      reasons.push('charged-not-recorded');
      details.push(
        `Valor txn ${slot.txnId} is recorded against this payment but it is not marked paid — reconcile by hand, do not re-charge`,
      );
    } else if (slot.kind === 'in-flight') {
      reasons.push('claim-needs-review');
      details.push(
        `a charge was claimed at ${slot.sinceIso} and never completed — check Valor for this payment before clearing the claim; the runner will not retry it on its own`,
      );
    }

    if (!plan.autoChargeConsentAt) {
      reasons.push('no-auto-charge-consent');
      details.push(
        'the customer has not agreed to automatic charges on their saved card — a vaulted card is not consent',
      );
    }

    if (plan.quoteStatus !== 'booked') {
      reasons.push('quote-not-booked');
      details.push(`the quote reads '${plan.quoteStatus ?? 'unknown'}', not 'booked'`);
    }
    if (plan.isNce) {
      reasons.push('nce-quote');
      details.push('an NCE trade job settles through NCE, never a card charge');
    }
    if (plan.amendmentBlocksSettlement) {
      reasons.push('amendment-pending');
      details.push('a price increase is awaiting the customer’s re-approval');
    }
    const drift = reconcilePlan(plan);
    if (drift) {
      reasons.push('plan-out-of-step');
      details.push(drift);
    }
    if (!plan.hasCardOnFile) {
      reasons.push('no-card-on-file');
      details.push('no saved card — collect this one with a pay link, which vaults the card for next time');
    }
    if (target.amountUsd > MAX_INSTALLMENT_CHARGE_USD) {
      reasons.push('over-cap');
      details.push(
        `$${target.amountUsd.toFixed(2)} exceeds the $${MAX_INSTALLMENT_CHARGE_USD} automated-charge ceiling`,
      );
    }

    return {
      ...base,
      action: reasons.length ? ('skip' as const) : ('charge' as const),
      reasons,
      detail: details.length ? details.join('; ') : null,
    };
  });
}

/**
 * Quotes whose linked invoice would be left lying by an installment charge.
 *
 * `invoices.deposit_applied` is a SNAPSHOT taken when the invoice was created,
 * and `balance = total - deposit_applied` is stored, not derived. Recording an
 * installment moves `quotes.deposit_amount_usd` and nothing else, so a customer
 * looking at an open invoice would still see the pre-payment balance. There is
 * no partial-payment primitive on invoices today (only the full settle), and
 * wiring one is ledger row 446. Until then the runner refuses rather than
 * charging a card and leaving a customer-visible figure wrong.
 *
 * Returns quoteId -> the human-readable reason.
 */
export function invoiceDriftBlockers(
  invoices: { id: string; quote_id: string | null; invoice_number: number | null; status: string }[],
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const inv of invoices) {
    if (!inv.quote_id) continue;
    if (inv.status === 'paid' || inv.status === 'cancelled') continue;
    blocked.set(
      inv.quote_id,
      `invoice #${inv.invoice_number ?? inv.id} is '${inv.status}' and its stored balance would not move with the payment (ledger row 446)`,
    );
  }
  return blocked;
}

export type ChargeOutcome = {
  quoteId: string;
  quoteNumber: number | null;
  customerName: string | null;
  installmentId: string;
  seq: number;
  amountUsd: number;
  status: 'charged' | 'declined' | 'failed' | 'charged-not-recorded';
  txnId: string | null;
  message: string | null;
};

export type RunResult =
  | {
      ok: true;
      dryRun: boolean;
      /** The ET business day the run decided against. */
      today: string;
      decisions: RunDecision[];
      outcomes: ChargeOutcome[];
    }
  | { ok: false; error: string };

type ServiceClient = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

/**
 * Load the plans, decide, and (when `dryRun` is false) charge and record.
 *
 * Idempotency mirrors the charge-balance route's claim slot exactly, on
 * `installments.valor_txn_id`: pre-claim `pending:<iso>` with a compare-and-swap
 * BEFORE the Valor call, so two overlapping runs cannot both charge. On a failed
 * charge the claim is released with a CAS on our own exact sentinel (never
 * clobbering someone else's). On an ambiguous TIMEOUT the claim is deliberately
 * LEFT — the money may have moved — and the 15-minute stale window is the only
 * release valve.
 */
export async function runInstallments(opts: { asOf?: Date; dryRun: boolean }): Promise<RunResult> {
  const asOf = opts.asOf ?? new Date();
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false, error: 'Supabase service role not configured' };

  const loaded = await listInstallmentPlans();
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const decisions = planInstallmentRun(loaded.plans, asOf);

  // The invoice-drift gate needs a query, so it is layered on top of the pure
  // planner rather than living inside it.
  const candidateQuoteIds = decisions.filter((d) => d.action === 'charge').map((d) => d.quoteId);
  if (candidateQuoteIds.length) {
    const { data: invoices, error: invErr } = await sb
      .from('invoices')
      .select('id, quote_id, invoice_number, status')
      .in('quote_id', candidateQuoteIds);
    if (invErr) return { ok: false, error: `Could not check linked invoices: ${invErr.message}` };
    const blocked = invoiceDriftBlockers(
      (invoices ?? []) as { id: string; quote_id: string | null; invoice_number: number | null; status: string }[],
    );
    for (const d of decisions) {
      const why = blocked.get(d.quoteId);
      if (d.action === 'charge' && why) {
        d.action = 'skip';
        d.reasons = [...d.reasons, 'linked-invoice-would-drift'];
        d.detail = d.detail ? `${d.detail}; ${why}` : why;
      }
    }
  }

  const today = nyDateString(asOf);
  const outcomes: ChargeOutcome[] = [];
  if (opts.dryRun) return { ok: true, dryRun: true, today, decisions, outcomes };

  for (const d of decisions) {
    if (d.action !== 'charge' || !d.installmentId || d.amountUsd == null || d.seq == null) continue;
    outcomes.push(await chargeOne(sb, d));
  }

  return { ok: true, dryRun: false, today, decisions, outcomes };
}

async function chargeOne(sb: ServiceClient, d: RunDecision): Promise<ChargeOutcome> {
  const installmentId = d.installmentId as string;
  const amountUsd = d.amountUsd as number;
  const seq = d.seq as number;
  const base = {
    quoteId: d.quoteId,
    quoteNumber: d.quoteNumber,
    customerName: d.customerName,
    installmentId,
    seq,
    amountUsd,
  };

  // The vault token is read HERE, at charge time, and never travels through the
  // plan shape the admin API returns to a browser.
  const { data: quote, error: qErr } = await sb
    .from('quotes')
    .select('valor_vault_token, customer_name, customer_email')
    .eq('id', d.quoteId)
    .maybeSingle();
  if (qErr || !quote) {
    return {
      ...base,
      status: 'failed',
      txnId: null,
      message: `Could not read the quote: ${qErr?.message ?? 'no row'}`,
    };
  }
  const q = quote as { valor_vault_token: string | null; customer_name: string | null; customer_email: string | null };
  if (!q.valor_vault_token) {
    return {
      ...base,
      status: 'failed',
      txnId: null,
      message: 'The saved card disappeared between planning and charging',
    };
  }

  // Pre-claim the slot. Conditional on paid_at still null AND the slot still
  // empty, so a concurrent run loses the race and charges nothing.
  const sentinel = `pending:${new Date().toISOString()}`;
  const { data: claimed, error: claimErr } = await sb
    .from('installments')
    .update({ valor_txn_id: sentinel })
    .eq('id', installmentId)
    .is('paid_at', null)
    .is('valor_txn_id', null)
    .select('id');
  if (claimErr) {
    return {
      ...base,
      status: 'failed',
      txnId: null,
      message: `Could not claim the charge slot: ${claimErr.message}`,
    };
  }
  if (!claimed || claimed.length === 0) {
    return {
      ...base,
      status: 'failed',
      txnId: null,
      message: 'Another run holds the charge slot for this payment, or it was settled first',
    };
  }

  const releaseClaim = async (why: string): Promise<void> => {
    const { data: released, error: relErr } = await sb
      .from('installments')
      .update({ valor_txn_id: null })
      .eq('id', installmentId)
      .eq('valor_txn_id', sentinel)
      .select('id');
    if (relErr) console.warn(`[installmentRunner] claim release failed (${why}):`, relErr);
    else if (!released || released.length === 0) {
      console.warn(`[installmentRunner] claim release matched no row (${why}) — the slot moved under us`);
    }
  };

  const result = await chargeBalanceOnFile({
    vaultToken: q.valor_vault_token,
    amountUsd,
    orderRef: `inst_${d.quoteId}_${seq}`,
    customerName: q.customer_name,
    customerEmail: q.customer_email,
  });

  if (!result.ok) {
    const ambiguousTimeout = result.reason === 'error' && !!result.message?.toLowerCase().includes('timed out');
    if (ambiguousTimeout) {
      // Money may have moved. Replace our `pending:` claim with a sentinel that
      // `describeChargeSlot` reads as 'charged', so the planner reports
      // `charged-not-recorded` and NOTHING re-attempts this payment at any age.
      // Leaving the `pending:` claim was enough for the 15-minute operator flow
      // it was copied from, and wrong here: a daily cron would find it stale by
      // morning. Best-effort — if the stamp itself fails the `pending:` claim
      // still stands and the runner still refuses (it never reclaims), so the
      // worst case is a less legible slot, not a retry.
      const marker = `ambiguous-timeout:${new Date().toISOString()}`;
      const { error: markErr } = await sb
        .from('installments')
        .update({ valor_txn_id: marker })
        .eq('id', installmentId)
        .eq('valor_txn_id', sentinel);
      if (markErr) console.warn('[installmentRunner] could not stamp the ambiguous-timeout marker:', markErr);
      return {
        ...base,
        status: 'charged-not-recorded',
        txnId: null,
        message: `Valor timed out — the charge MAY have landed. Check Valor for this payment before doing anything else. The slot is stamped "${marker}" and nothing will retry it until a person clears it. (${result.message})`,
      };
    }
    await releaseClaim(result.reason);
    return {
      ...base,
      status: result.reason === 'declined' ? 'declined' : 'failed',
      txnId: null,
      message: result.message ?? result.reason,
    };
  }

  // Amount mismatch: a card-on-file sale can capture LESS than requested (a
  // partial auth), and a wrong capture in EITHER direction means the books would
  // not match the card. Two-sided with the same 1c tolerance the charge-balance
  // route uses — an earlier draft here checked only under-capture while claiming
  // parity with that route, which the premerge technical lens caught.
  if (result.chargedUsd == null || Math.abs(result.chargedUsd - amountUsd) > 0.01) {
    return {
      ...base,
      status: 'charged-not-recorded',
      txnId: result.txnId,
      message: `Valor approved ${result.chargedUsd == null ? 'an unknown amount' : `$${result.chargedUsd.toFixed(2)}`} against a $${amountUsd.toFixed(2)} payment — NOT recorded. Reconcile in Valor.`,

    };
  }

  const recorded = await markInstallmentPaid({
    installmentId,
    paidAt: new Date(),
    source: 'valor',
    valorTxnId: result.txnId,
  });
  if (!recorded.ok) {
    return {
      ...base,
      status: 'charged-not-recorded',
      txnId: result.txnId,
      message: `The card WAS charged (txn ${result.txnId ?? 'unknown'}). ${recorded.error} — check /admin/installments: the payment may be recorded against the plan while the quote's collected total is short by this amount.`,
    };
  }

  return { ...base, status: 'charged', txnId: result.txnId, message: null };
}

/**
 * A skip that a person needs to know about: a payment IS due and something
 * stopped us collecting it. `nothing-due` is the ordinary quiet state and is
 * deliberately not one of these.
 *
 * This distinction is the whole of the premerge admin AND staff lenses' shared
 * HIGH. The first draft built the alert from `outcomes`, which only ever holds
 * CHARGE attempts, so a run that refused to collect $453.13 from a real customer
 * produced exactly the same silence as a day with nothing scheduled. An
 * automation that fails quietly is worse than no automation.
 */
export function blockedDecisions(decisions: RunDecision[]): RunDecision[] {
  return decisions.filter(
    (d) => d.action === 'skip' && d.installmentId !== null && !d.reasons.includes('nothing-due'),
  );
}

/**
 * The staff alert text for a completed run, or null when there is nothing worth
 * waking anyone for. Pure, so the wording is testable.
 *
 * A run with no charges, no problems and no BLOCKED payments sends NOTHING —
 * the same quiet-day rule the completing-today ping uses, and the norm for most
 * of the year. A blocked payment repeats on every run until somebody acts on it,
 * which is the point: it is an uncollected bill, not a notification.
 */
export function runSummaryMessage(result: RunResult): string | null {
  if (!result.ok) return `Installment runner FAILED: ${result.error}`;
  const charged = result.outcomes.filter((o) => o.status === 'charged');
  const problems = result.outcomes.filter((o) => o.status !== 'charged');
  const blocked = blockedDecisions(result.decisions);
  if (!charged.length && !problems.length && !blocked.length) return null;

  const lines: string[] = [`Installment runner — ${result.today}${result.dryRun ? ' (DRY RUN)' : ''}`];
  for (const o of charged) {
    lines.push(
      `Charged $${o.amountUsd.toFixed(2)} — ${o.customerName ?? 'Unknown'}, quote #${o.quoteNumber ?? '?'}, payment ${o.seq}`,
    );
  }
  for (const o of problems) {
    lines.push(
      `PROBLEM (${o.status}) $${o.amountUsd.toFixed(2)} — ${o.customerName ?? 'Unknown'}, quote #${o.quoteNumber ?? '?'}, payment ${o.seq}: ${o.message ?? ''}`.trim(),
    );
  }
  for (const d of blocked) {
    lines.push(
      `NOT COLLECTED $${(d.amountUsd ?? 0).toFixed(2)} due ${d.dueDate ?? '?'} — ${d.customerName ?? 'Unknown'}, quote #${d.quoteNumber ?? '?'}: ${d.reasons.join(', ')}${d.detail ? ` (${d.detail})` : ''}`,
    );
  }
  return lines.join('\n');
}
