-- Installment plans (Homeworks migration, 2026-08-28).
--
-- Three customers pay their 2026 job in monthly instalments — Raymond Brown,
-- Mary O'Connor and Jane Laguerre. Homeworks had no instalment feature; Jason
-- collected each payment by hand and edited the invoice, so the schedule lived
-- only in his notes. This table is the schedule: what is owed, when, and what
-- has already been collected.
--
-- One row per scheduled payment. The customer's initial deposit is NOT a row
-- here — that is already `quotes.deposit_amount_usd`, which stays the running
-- total collected. So for any quote:
--     deposit_amount_usd = initial deposit + every instalment marked paid
--
-- `due_on_completion` marks the final payment several of these plans carry,
-- which is due after the install rather than on a calendar date — that is an
-- ordinary balance-on-completion, which the tool already collects, and it is
-- flagged so nothing ever tries to auto-charge it on a date.
--
-- Additive and idempotent: creates a new table only, touches no existing data.

create table if not exists installments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  seq integer not null,
  amount_usd numeric(10,2) not null check (amount_usd > 0),
  -- NULL when the payment is due on completion rather than on a date.
  due_date date,
  due_on_completion boolean not null default false,
  paid_at timestamptz,
  -- 'homeworks' for money collected before the migration, 'valor' for a card
  -- charge through this tool, 'manual' for cash/check recorded by staff.
  paid_source text check (paid_source in ('homeworks', 'valor', 'manual')),
  valor_txn_id text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quote_id, seq),
  -- A dated payment or a due-on-completion one, never both and never neither.
  constraint installments_due_shape check (
    (due_on_completion and due_date is null) or (not due_on_completion and due_date is not null)
  )
);

create index if not exists installments_quote_idx on installments (quote_id, seq);

-- The working query: what is owed and when, soonest first.
create index if not exists installments_outstanding_idx
  on installments (due_date)
  where paid_at is null and not due_on_completion;

create trigger installments_updated_at
  before update on installments
  for each row execute function dashboard_set_updated_at();
