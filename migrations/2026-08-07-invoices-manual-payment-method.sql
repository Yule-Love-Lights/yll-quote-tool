-- #199 NCE money behaviors: manual-settlement payment method + the NCE trade
-- reference number.
--
-- paid_method — how a MANUALLY-settled invoice (mark-paid, not a Valor charge)
--   was actually collected: 'cash_check' | 'nce' | null. null covers BOTH a
--   legacy manual mark-paid (predates this column) and a Valor-settled invoice
--   (the balance webhook / charge-balance route settle via
--   valor_balance_txn_id, never write this column) — the two null cases are
--   told apart by whether valor_balance_txn_id is set.
-- payment_reference — the NCE trade-system payment reference number. Required
--   at NCE mark-paid time (enforced in the app, not a DB constraint — an
--   empty ref means the trade payment hasn't actually happened yet); editable
--   afterward for a typo fix via the reference-only update path.
--
-- Migration-first (column-add class, AGENTS.md Pitfalls): applies to prod
-- BEFORE the #199 code merges — the code reads/writes these columns from the
-- moment it ships. Idempotent: ADD COLUMN IF NOT EXISTS, mirroring
-- migrations/2026-07-24-invoices-arming-checklist.sql (same table, same
-- enum-ish-text + CHECK convention).

alter table invoices add column if not exists paid_method text;
alter table invoices add column if not exists payment_reference text;
alter table invoices drop constraint if exists invoices_paid_method_check;
alter table invoices add constraint invoices_paid_method_check
  check (paid_method is null or paid_method in ('cash_check', 'nce'));
