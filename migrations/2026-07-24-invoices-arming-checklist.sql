-- #170 auto-charge arming checklist (2026-07-24). Two additive nullable
-- columns on invoices:
--   valor_txn_log — jsonb array of retired charge records. When an amend
--     reopens a PAID invoice (new balance due), the live
--     valor_balance_txn_id/valor_receipt_url move here so the new charge
--     cycle starts clean (fixes the misleading 'already-charged' 409) while
--     the old txn stays reconcilable.
--   payment_preference — how this customer pays the balance:
--     'card_on_file' | 'cash_check' | null (unset). 'cash_check' replaces the
--     one-click charge button with an explicit override so nobody charges a
--     card the customer said they'd settle in cash.
alter table invoices add column if not exists valor_txn_log jsonb;
alter table invoices add column if not exists payment_preference text;
alter table invoices drop constraint if exists invoices_payment_preference_check;
alter table invoices add constraint invoices_payment_preference_check
  check (payment_preference is null or payment_preference in ('card_on_file', 'cash_check'));
