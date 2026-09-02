-- =====================================================================
-- Sign hand-outs get an idempotency key (ledger row 480).
--
-- issueSigns dedups a double-submitted hand-out by reading the worker's
-- latest row and comparing (qty, issuing admin) inside a 15-second window.
-- That is SELECT-then-INSERT: two genuinely simultaneous submits both read
-- an empty window and both insert, so the ledger doubles and the warehouse
-- is drawn down twice for one physical stack of signs.
--
-- The fix is the same shape the settlement lines use: let the DATABASE hold
-- the guarantee instead of asking the code to remember. The screen mints one
-- id per confirmed hand-out, so a retry of that same click carries the same
-- id and loses on the unique index; two real hand-outs carry different ids
-- and both land, which the old time window could not tell apart.
--
-- request_id is NULLABLE and the index is PARTIAL for two reasons: rows
-- written before this shipped carry no key and must not collide with each
-- other, and a caller that sends no id still gets the old 15-second window
-- as a fallback rather than an error.
--
-- HOW TO APPLY: safe/additive per AGENTS.md - a nullable column add plus a
-- partial unique index that cannot collide with existing data. The table
-- also holds zero rows today, verified before applying.
-- =====================================================================

alter table public.advertising_sign_issuances
  add column if not exists request_id uuid;

create unique index if not exists advertising_sign_issuances_request_key
  on public.advertising_sign_issuances (request_id)
  where request_id is not null;
