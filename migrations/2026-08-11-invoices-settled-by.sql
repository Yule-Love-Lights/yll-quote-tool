-- =====================================================================
-- invoices.settled_by — the operator who manually settled the invoice (#225).
--
-- markInvoicePaidManually (src/lib/invoices.ts) stamps paid_method,
-- payment_reference, and paid_at when staff record a cash/check/NCE
-- settlement, but nothing recorded WHO did it — the API route only logged the
-- operator on failure, so a successful settle left no "who" behind. Mirrors
-- inbox_items.handled_by (migrations/2026-06-28-dashboard-tables.sql): a
-- nullable uuid FK to auth.users, ON DELETE SET NULL so a deleted operator
-- account never blocks or cascades away the invoice row.
--
-- Nullable: every pre-existing row (and every future settle where the
-- operator identity genuinely can't be resolved, e.g. AUTH_GATE_ENABLED
-- dormant) predates or lacks this column. null does NOT mean "not manually
-- settled" — check paid_method / paid_at for that, same as handled_by's own
-- "NULL when system auto-resolved" convention.
--
-- HOW TO APPLY: apply directly via Supabase MCP (AGENTS.md migration-
-- application default — nullable add-column is on the allowlist). Idempotent;
-- safe to re-run. NOT applied by this commit — that is the operator's step.
-- =====================================================================

alter table public.invoices
  add column if not exists settled_by uuid references auth.users(id) on delete set null;
