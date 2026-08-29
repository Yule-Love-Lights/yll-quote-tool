-- Auto-charge consent for installment plans (ledger row 448, premerge customer lens).
--
-- The installment runner charges a saved card with no human in the loop. The
-- three customers on plans came from a retired CRM where Jason collected every
-- payment BY HAND — none of them ever agreed to a recurring card debit, and the
-- card gets vaulted as an unconditional side effect of any successful card
-- payment (there is no "remember this card" step anywhere in the tool). So
-- nothing in the system established consent, and without this column the runner
-- would have started debiting people who had only ever paid one-off.
--
-- NULL means NO CONSENT, and the runner refuses. That is the default for every
-- existing row and every future one; consent is recorded deliberately, per
-- quote, by a person, and the timestamp is the record of when.
--
-- ⚠️ TWO THINGS MUST SHIP BEFORE ANY VALUE IS WRITTEN HERE (premerge customer
-- lens on PR #1051 — both are real and both are recorded in the ledger):
--   1. The customer's own figures must move when an installment is collected.
--      Today `quotes.deposit_amount_usd` moves and the frozen
--      `approval_snapshot.customerSelection.currentDepositUsd` does not, so the
--      portal card and the Quote PDF (src/lib/pdf/docModels.ts's balanceDue)
--      would both keep showing the pre-payment balance forever.
--   2. The customer must be told. There is no receipt of any kind today — the
--      only notification on a successful charge is a staff Telegram line, so a
--      homeowner's first signal would be their bank statement.
-- Recording consent before those land turns two latent bugs into live ones.
-- This comment is the gate: it is why the column exists, not decoration.
--
-- Additive and nullable: safe to apply ahead of the code that reads it.

alter table public.quotes
  add column if not exists installment_auto_charge_consent_at timestamptz;

comment on column public.quotes.installment_auto_charge_consent_at is
  'When the customer agreed that scheduled installment payments may be charged to their saved card automatically. NULL = no consent = the runner refuses (src/lib/installmentRunner.ts).';
