-- Who recorded an installment payment (ledger row 446, premerge admin lens).
--
-- `markInstallmentPaid` moves real money on the books — it marks a scheduled
-- payment collected and raises the quote's collected total — and shipped with no
-- record of who did it. Its direct sibling, the manual invoice settle
-- (`markInvoicePaidManually`), has recorded `settled_by` since #225 for exactly
-- this reason: a money action needs a WHO, not just a when and a how.
--
-- NULL means "not attributable": every row the #1049 migration wrote (those were
-- collected at home.works, by hand, before this tool existed) and anything the
-- runner charges automatically, which has no human actor by definition. A NULL
-- here is therefore information, not a gap.
--
-- Additive and nullable: safe to apply ahead of the code that writes it.

alter table public.installments
  add column if not exists paid_by uuid references auth.users(id) on delete set null;

comment on column public.installments.paid_by is
  'The operator who recorded this payment. NULL = collected before the migration, or charged automatically by the installment runner (no human actor). Mirrors invoices.settled_by.';
