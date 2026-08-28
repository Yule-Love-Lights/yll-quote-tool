'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import {
  nextDuePayment,
  isOverdue,
  reconcilePlan,
  type InstallmentPlan,
} from '@/lib/installments';
import { describeChargeSlot } from '@/lib/integrations/valorBalance';
import { isAmbiguousTimeoutMarker, AMBIGUOUS_TIMEOUT_PREFIX } from '@/lib/installmentRunner';

// Payment plans (Homeworks migration, 2026-08-28). Three customers pay their
// 2026 job monthly. This page is READ-ONLY: it shows what is owed and when.
// Collecting a payment is a separate, deliberate action — nothing on this page
// charges a card or messages a customer.

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * An unpaid installment whose charge slot is not empty needs a person, not a
 * status. Returns null for the ordinary empty slot so the normal
 * Overdue/Scheduled rendering is untouched.
 */
export function chargeSlotLabel(valorTxnId: string | null): string | null {
  const slot = describeChargeSlot(valorTxnId);
  if (slot.kind === 'none') return null;
  if (isAmbiguousTimeoutMarker(valorTxnId)) return 'Charge outcome unknown';
  return slot.kind === 'charged' ? 'Charged — not recorded' : 'Charge claimed — check Valor';
}

export function chargeSlotTitle(valorTxnId: string | null): string {
  const slot = describeChargeSlot(valorTxnId);
  // The ambiguous-timeout marker is NOT a Valor reference, and must never be
  // shown as one: searching Valor for it finds nothing, which reads as "the
  // charge never happened" and invites collecting the money a second time.
  // (Adversarial delta-verify on the PR #1051 fix round.)
  if (isAmbiguousTimeoutMarker(valorTxnId)) {
    const when = (valorTxnId ?? '').slice(AMBIGUOUS_TIMEOUT_PREFIX.length);
    return `A charge for this payment timed out on ${when || 'an unknown date'} and we never saw Valor's answer. It may or may not have gone through. Search Valor by this customer, the amount and that date before collecting it again — do not assume it failed. Nothing will re-charge it automatically.`;
  }
  if (slot.kind === 'charged') {
    return `Valor reference ${slot.txnId} is on this payment but it is not marked paid. The money may already have been taken — reconcile in Valor. The runner will never re-charge it.`;
  }
  if (slot.kind === 'in-flight') {
    return `A charge was claimed at ${slot.sinceIso} and never completed. Check Valor for this payment before clearing it; the runner will not retry it on its own.`;
  }
  return '';
}

/** "5 Sep 2026" — short, unambiguous, and not locale-surprising. */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${month} ${y}`;
}

export default function InstallmentsPage() {
  const [plans, setPlans] = useState<InstallmentPlan[] | null>(null);
  const [autoCharge, setAutoCharge] = useState<{ runnerArmed: boolean; valorArmed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/installments');
        const json = (await res.json()) as {
          plans?: InstallmentPlan[];
          autoCharge?: { runnerArmed: boolean; valorArmed: boolean };
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Could not load payment plans');
        else {
          setPlans(json.plans ?? []);
          setAutoCharge(json.autoCharge ?? null);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach the server — try reloading.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const totalOutstanding = (plans ?? []).reduce((a, p) => a + p.planOutstanding, 0);

  return (
    <OperatorShell active="quotes">
      <div className="max-w-5xl mx-auto w-full">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--op-text)' }}>
            Payment plans
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--op-text-2)' }}>
            Customers paying their job in monthly installments. Read-only — collecting a
            payment is a separate step, and nothing here contacts the customer.
          </p>
          {/* Row 448 premerge (admin lens MED): the automation's on/off state
              lived only in Vercel's env-var screen, so nobody looking at the app
              could tell whether cards were being charged. It says so here. */}
          {autoCharge && (
            <p className="text-sm mt-2" style={{ color: 'var(--op-text-2)' }}>
              {autoCharge.runnerArmed && autoCharge.valorArmed ? (
                <span style={{ color: '#b45309' }}>
                  Automatic charging is <strong>ON</strong> — scheduled payments are charged to the
                  saved card of any customer who has agreed to it.
                </span>
              ) : (
                <>
                  Automatic charging is <strong>off</strong>. Every payment here is collected by
                  hand.
                </>
              )}
            </p>
          )}
        </header>

        {error && (
          <div
            className="rounded-md border p-3 text-sm mb-4"
            style={{ borderColor: 'var(--op-border)', color: '#dc2626' }}
          >
            {error}
          </div>
        )}

        {plans === null && !error && (
          <p className="text-sm" style={{ color: 'var(--op-text-2)' }}>Loading payment plans…</p>
        )}

        {plans?.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--op-text-2)' }}>No payment plans yet.</p>
        )}

        {plans && plans.length > 0 && (
          <p className="text-sm mb-4" style={{ color: 'var(--op-text-2)' }}>
            {plans.length} plan{plans.length === 1 ? '' : 's'} · <strong>{money(totalOutstanding)}</strong> still
            to collect
          </p>
        )}

        <div className="flex flex-col gap-4">
          {(plans ?? []).map((plan) => {
            const next = nextDuePayment(plan);
            const mismatch = reconcilePlan(plan);
            return (
              <section
                key={plan.quoteId}
                className="rounded-lg border p-4"
                style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>
                      {plan.customerName ?? 'Unknown customer'}{' '}
                      {plan.quoteNumber && (
                        <Link
                          href={`/admin/quotes/${plan.quoteId}`}
                          className="text-sm font-normal underline"
                          style={{ color: 'var(--brand-evergreen-3)' }}
                        >
                          #{plan.quoteNumber}
                        </Link>
                      )}
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--op-text-2)' }}>
                      Order {money(plan.quoteTotal)} · collected {money(plan.collected)} ·{' '}
                      {plan.initialDeposit > 0 && <>deposit {money(plan.initialDeposit)} · </>}
                      <strong>{money(plan.planOutstanding)} outstanding</strong>
                    </p>
                  </div>
                  <div className="text-right">
                    {next ? (
                      <>
                        <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-2)' }}>
                          Next payment
                        </div>
                        <div className="text-lg font-semibold" style={{ color: isOverdue(next, now) ? '#dc2626' : 'var(--op-text)' }}>
                          {money(next.amountUsd)}
                        </div>
                        <div className="text-xs" style={{ color: isOverdue(next, now) ? '#dc2626' : 'var(--op-text-2)' }}>
                          due {fmtDate(next.dueDate)}
                          {isOverdue(next, now) ? ' — overdue' : ''}
                        </div>
                      </>
                    ) : (
                      <div className="text-xs" style={{ color: 'var(--op-text-2)' }}>
                        No dated payment outstanding
                      </div>
                    )}
                    <div className="text-xs mt-1" style={{ color: plan.hasCardOnFile ? 'var(--op-text-2)' : '#92400e' }}>
                      {plan.hasCardOnFile ? 'Card on file' : 'No card on file'}
                    </div>
                  </div>
                </div>

                {/* The invariant made visible: if the plan and the quote ever
                    disagree about what is owed, say so on the page rather than
                    letting the two drift quietly. */}
                {mismatch && (
                  <p className="text-xs mt-2" style={{ color: '#dc2626' }}>
                    Plan and quote disagree — {mismatch}. Tell Jason before collecting anything.
                  </p>
                )}

                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: 'var(--op-text-2)' }}>
                        <th className="text-left font-medium py-1 pr-3">#</th>
                        <th className="text-left font-medium py-1 pr-3">Due</th>
                        <th className="text-right font-medium py-1 pr-3">Amount</th>
                        <th className="text-left font-medium py-1 pr-3">Status</th>
                        <th className="text-left font-medium py-1">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.installments.map((i) => (
                        <tr key={i.id} style={{ borderTop: '1px solid var(--op-border)' }}>
                          <td className="py-1.5 pr-3" style={{ color: 'var(--op-text-2)' }}>{i.seq}</td>
                          <td className="py-1.5 pr-3" style={{ color: 'var(--op-text)' }}>
                            {i.dueOnCompletion ? 'After install' : fmtDate(i.dueDate)}
                          </td>
                          <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>
                            {money(i.amountUsd)}
                          </td>
                          <td className="py-1.5 pr-3">
                            {i.paidAt ? (
                              <span style={{ color: 'var(--op-text-2)' }}>
                                Paid {fmtDate(i.paidAt.slice(0, 10))}
                                {i.paidSource ? ` · ${i.paidSource}` : ''}
                              </span>
                            ) : chargeSlotLabel(i.valorTxnId) ? (
                              // Row 448 premerge (staff + technical lenses): a
                              // payment whose card WAS charged but whose
                              // recording failed used to render as a plain red
                              // "Overdue", identical to one nobody had touched —
                              // so staff could chase a customer for money already
                              // taken. The charge slot is the only thing that
                              // knows, so it says so here.
                              <span style={{ color: '#b45309' }} title={chargeSlotTitle(i.valorTxnId)}>
                                {chargeSlotLabel(i.valorTxnId)}
                              </span>
                            ) : isOverdue(i, now) ? (
                              <span style={{ color: '#dc2626' }}>Overdue</span>
                            ) : (
                              <span style={{ color: 'var(--op-text-2)' }}>Scheduled</span>
                            )}
                          </td>
                          <td className="py-1.5 text-xs" style={{ color: 'var(--op-text-2)' }}>{i.note ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </OperatorShell>
  );
}
