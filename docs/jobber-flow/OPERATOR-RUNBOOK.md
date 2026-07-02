# Operator runbook — Aug–Oct parallel-with-Jobber trial (#83)

> **Naldo S20 close, pinned S21 (2026-07-02).** The #83 Jobber operator workflow
> (create → job → complete → invoice → close) is COMPLETE + LIVE + verified on
> prod (Options console #288/#293, audit-fixes #300, rebook+backfill #306,
> deposit-fix/reconciliation #309, Needs-Action queue #310). Live-verified
> end-to-end + 3 LLM council reviews → the council's verdict: **run an Aug–Oct
> parallel-with-Jobber trial.**

## 🔒 The shadow rule

**Jobber is source of truth through October. The tool only shadows.**

During the Aug–Oct trial, every booking/job/invoice still gets entered in
Jobber as usual — that record is what's real. The quote tool runs the SAME
work in parallel so staff and Naldo can compare its numbers against Jobber's
and build confidence before cutting over. If the tool and Jobber ever
disagree, **Jobber wins.** Do not let the tool's numbers (dashboard revenue,
Needs-Action queue, invoice balances) override or skip a Jobber entry during
the trial window.

**Auto-charge stays OFF.** The one-click "Charge remaining balance" button
(Valor card-on-file/MIT) is gated behind `VALOR_AUTO_CHARGE_ENABLED` and must
stay off through the trial — see
[`VALOR-AUTOCHARGE-FOR-JASON.md`](./VALOR-AUTOCHARGE-FOR-JASON.md) for what's
needed to eventually flip it on (Jason-gated, not part of the trial).

## Where to look for more

- **What shipped + how it was verified:** the S20 entry in
  `docs/context/session_log_naldo.md`.
- **Spec / decisions / phases:** `SPEC.md`, `PLAN.md` in this folder.
- **Trial-blocker bugs found + fixed:** `AUDIT-2026-07-01.md`.
- **Ledger status:** task **#83** in `docs/context/task_ledger.md`.

## Trial exit criteria (not yet scheduled)

Cutting Jobber over to the tool as source of truth is a separate, explicit
decision for Naldo to make after the Aug–Oct trial — not automatic at a
calendar date. Until that decision is made, the shadow rule above holds.
