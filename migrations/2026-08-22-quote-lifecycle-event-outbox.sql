-- Quote Tool Flow Q: canonical quote lifecycle facts and transactional outbox.
--
-- This migration is additive and roll-forward only. It deliberately does not
-- retrofit invented lifecycle events for legacy rows: first_sent_at is copied
-- from the pre-existing local-send timestamp, while new facts begin at the
-- first event written through record_quote_lifecycle_event.

begin;

alter table public.quotes
  add column if not exists first_sent_at timestamptz,
  add column if not exists entity_version integer not null default 0;

update public.quotes
set first_sent_at = quote_sent_at
where first_sent_at is null
  and quote_sent_at is not null;

alter table public.quotes
  drop constraint if exists quotes_entity_version_nonnegative;
alter table public.quotes
  add constraint quotes_entity_version_nonnegative check (entity_version >= 0);

create table if not exists public.quote_requests (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null,
  source_system text not null,
  source_record_id text not null,
  customer_reference text not null,
  quote_id uuid references public.quotes(id) on delete set null,
  assignee_employee_id uuid,
  created_at timestamptz not null default now(),
  constraint quote_requests_source_record_unique unique (source_system, source_record_id)
);

create table if not exists public.quote_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  -- Naldo's call 2026-08-25. This was `on delete restrict`, which made
  -- deleting ANY quote fail once these triggers are live, while deleteQuote()
  -- erases the design and house photos FIRST: irreversible photo loss plus an
  -- undeletable quote row.
  --
  -- Cascade here is the whole fix. A deleteQuote() REORDER was also proposed and
  -- approved, then dropped once implementing it showed it was wrong:
  -- designs.quote_id is `on delete set null` and deleteDesignsForQuote() looks
  -- designs up BY quote_id, so removing the quote first orphans the row and
  -- strands the customer's photos in storage forever. src/lib/quotes.ts keeps
  -- its designs-first order and is untouched by this migration.
  quote_id uuid references public.quotes(id) on delete cascade,
  quote_request_id uuid references public.quote_requests(id) on delete restrict,
  event_type text not null,
  entity_version integer not null,
  occurred_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  actor_employee_id uuid,
  source text not null,
  idempotency_key text not null,
  correlation_id uuid not null,
  causation_id uuid,
  payload jsonb not null default '{}'::jsonb,
  constraint quote_lifecycle_events_entity_version_nonnegative check (entity_version >= 1),
  constraint quote_lifecycle_events_subject check (num_nonnulls(quote_id, quote_request_id) = 1),
  constraint quote_lifecycle_events_source check (source in ('hub_pwa', 'telegram', 'office', 'admin', 'system')),
  constraint quote_lifecycle_events_actor check (source = 'system' or actor_employee_id is not null),
  constraint quote_lifecycle_events_type check (event_type in (
    'QuoteRequestReceived', 'QuoteRequestLinked', 'QuoteCreated', 'QuoteAssigned',
    'QuoteUnassigned', 'QuoteMeaningfulEditRecorded', 'QuoteRevisionSaved',
    'QuoteWorkWaitStarted', 'QuoteWorkWaitEnded', 'QuoteSentRecorded',
    'QuoteDeliveryAttempted', 'QuoteDeliveryOutcomeRecorded', 'QuoteChangesRequested',
    'QuoteAccepted', 'QuoteDeclined', 'QuoteExpired', 'QuoteAbandoned',
    'QuoteCancelled', 'QuoteBooked', 'QuoteReopened', 'QuotePromiseRecorded',
    'QuotePromiseSuperseded', 'QuotePromiseCancelled', 'QuotePromiseFulfilled'
  )),
  constraint quote_lifecycle_events_quote_version_unique unique (quote_id, entity_version),
  constraint quote_lifecycle_events_idempotency_unique unique (idempotency_key)
);

create table if not exists public.quote_event_outbox (
  sequence bigint generated always as identity primary key,
  -- Cascade, not restrict. This was the SECOND wall on the delete chain: even
  -- with the events FK cascaded and the immutable trigger narrowed, this one
  -- still blocked the same delete, reproduced live by a review. An outbox row
  -- with no event is meaningless, so it goes when its event goes.
  event_id uuid not null unique references public.quote_lifecycle_events(id) on delete cascade,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  delivery_attempts integer not null default 0,
  last_error text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  constraint quote_event_outbox_delivery_attempts_nonnegative check (delivery_attempts >= 0)
);

create table if not exists public.ops_machine_request_nonces (
  key_id text not null,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (key_id, nonce)
);

create table if not exists public.employee_authorization_snapshots (
  snapshot_id uuid primary key,
  employee_id uuid not null,
  entity_version integer not null,
  authorization_policy_version text not null,
  snapshot jsonb not null,
  idempotency_key text not null unique,
  payload_hash text not null,
  effective_at timestamptz not null,
  accepted_at timestamptz not null default now(),
  source_key_id text not null,
  constraint employee_authorization_snapshots_entity_version_positive check (entity_version >= 1),
  constraint employee_authorization_snapshots_policy_version_nonempty check (length(authorization_policy_version) > 0),
  constraint employee_authorization_snapshots_employee_version_unique unique (employee_id, entity_version)
);

create index if not exists quote_lifecycle_events_quote_accepted_idx
  on public.quote_lifecycle_events (quote_id, accepted_at, id);
create index if not exists quote_event_outbox_feed_idx
  on public.quote_event_outbox (sequence) where dead_lettered_at is null;
create index if not exists ops_machine_request_nonces_expires_idx
  on public.ops_machine_request_nonces (expires_at);

create index if not exists employee_authorization_snapshots_current_idx
  on public.employee_authorization_snapshots (employee_id, entity_version desc);

-- The event is immutable once accepted. Outbox delivery metadata remains
-- mutable because its retries are operational state rather than business fact.
create or replace function public.reject_quote_lifecycle_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'quote lifecycle events are immutable';
end;
$$;

drop trigger if exists quote_lifecycle_events_immutable on public.quote_lifecycle_events;
-- UPDATE only, deliberately. This used to be `before update or delete`, and a
-- cascade delete fires a child table's own row triggers, so deleting any real
-- quote raised 'quote lifecycle events are immutable' and rolled back. A review
-- reproduced that live in a throwaway Postgres before this change.
--
-- Immutability here means history is never REWRITTEN. Deleting the parent quote
-- is a different act, and Naldo's 2026-08-25 call was explicitly that events die
-- with their quote, which is what the cascade expresses. Blocking the cascade
-- did not preserve history, it only made the quote undeletable after its photos
-- had already been erased.
create trigger quote_lifecycle_events_immutable
  before update on public.quote_lifecycle_events
  for each row execute function public.reject_quote_lifecycle_event_mutation();

alter table public.quote_requests enable row level security;
-- Audit lock-down, restored after the immutability trigger was narrowed to
-- UPDATE only (it had to be: a cascade delete fires the child's row triggers,
-- so 'before update or delete' made every real quote undeletable).
--
-- Narrowing the trigger left a gap: a standalone DELETE of one event row would
-- have succeeded, where before it was refused. Revoking the privilege closes
-- that without re-blocking the cascade. VERIFIED empirically in a throwaway
-- Postgres, because the two cases behave differently and I did not want to
-- assume: as service_role a direct DELETE is refused with 'permission denied
-- for table quote_lifecycle_events', while deleting the parent quote as that
-- same role still cascades the event away. Referential actions are enforced by
-- the database itself and do not re-check the deleting role's DELETE grant.
revoke delete on public.quote_lifecycle_events from service_role;
revoke delete on public.quote_event_outbox from service_role;

alter table public.quote_lifecycle_events enable row level security;
alter table public.quote_event_outbox enable row level security;
alter table public.ops_machine_request_nonces enable row level security;
alter table public.employee_authorization_snapshots enable row level security;

-- Atomic writer for quote-scoped lifecycle transitions. The caller supplies
-- the exact current-version expectation so stale writes cannot overwrite a
-- newer canonical fact. It returns the accepted event and new entity version.
create or replace function public.record_quote_lifecycle_event(
  p_quote_id uuid,
  p_expected_entity_version integer,
  p_event_type text,
  p_occurred_at timestamptz,
  p_actor_employee_id uuid,
  p_source text,
  p_idempotency_key text,
  p_correlation_id uuid,
  p_causation_id uuid,
  p_payload jsonb,
  p_status text,
  p_latest_sent_at timestamptz,
  p_first_sent_at timestamptz
)
returns table (event_id uuid, entity_version integer, first_sent_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quote public.quotes%rowtype;
  v_event_id uuid;
  v_entity_version integer;
begin
  if p_expected_entity_version < 0 then
    raise exception 'expected entity version must be non-negative';
  end if;

  select * into v_quote
  from public.quotes
  where id = p_quote_id
  for update;

  if not found then
    raise exception 'quote not found';
  end if;
  -- Ledger #93, matching the append trigger's guard. Dead code today (this
  -- function has no callers) but it must not become the door test traffic walks
  -- through the moment someone wires it up.
  if coalesce(v_quote.is_test, false) then
    raise exception 'lifecycle events are not recorded for test quotes';
  end if;
  if v_quote.entity_version <> p_expected_entity_version then
    raise exception 'entity version conflict';
  end if;

  v_entity_version := v_quote.entity_version + 1;

  -- Suppress the append trigger for this transaction: this function inserts
  -- the event itself, with the real actor/source/payload the trigger cannot
  -- know. Third argument true = local to the current transaction.
  perform set_config('yll.skip_lifecycle_trigger', 'on', true);

  update public.quotes
  set entity_version = v_entity_version,
      status = coalesce(p_status, status),
      quote_sent_at = coalesce(p_latest_sent_at, quote_sent_at),
      -- Qualified with the table name deliberately. The RETURNS TABLE OUT
      -- parameter is also called first_sent_at and shadows the column, so the
      -- bare references here raised 'column reference "first_sent_at" is
      -- ambiguous' on EVERY call. Dead code today (no callers), which is the
      -- only reason it was never noticed; found by running the function in a
      -- throwaway Postgres rather than by reading it.
      first_sent_at = case
        when p_event_type = 'QuoteSentRecorded'
          then coalesce(public.quotes.first_sent_at, p_first_sent_at)
        else public.quotes.first_sent_at
      end
  where id = p_quote_id;

  insert into public.quote_lifecycle_events (
    quote_id, event_type, entity_version, occurred_at, actor_employee_id, source,
    idempotency_key, correlation_id, causation_id, payload
  ) values (
    p_quote_id, p_event_type, v_entity_version, p_occurred_at, p_actor_employee_id,
    p_source, p_idempotency_key, p_correlation_id, p_causation_id,
    coalesce(p_payload, '{}'::jsonb)
  ) returning id into v_event_id;

  insert into public.quote_event_outbox (event_id) values (v_event_id);

  -- Re-arm the trigger for any later statement in this same transaction.
  perform set_config('yll.skip_lifecycle_trigger', 'off', true);

  return query select v_event_id, v_entity_version,
    (select q.first_sent_at from public.quotes q where q.id = p_quote_id);
end;
$$;

revoke all on function public.record_quote_lifecycle_event(
  uuid, integer, text, timestamptz, uuid, text, text, uuid, uuid, jsonb, text, timestamptz, timestamptz
) from public;
grant execute on function public.record_quote_lifecycle_event(
  uuid, integer, text, timestamptz, uuid, text, text, uuid, uuid, jsonb, text, timestamptz, timestamptz
) to service_role;

-- Existing Quote Tool routes already update the quote row with compare-and-swap
-- guards. These paired triggers make every supported lifecycle change atomically
-- produce its canonical event and outbox row, including routes that predate
-- Flow Q. Unknown display-only changes do not create a lifecycle fact.
create or replace function public.quote_lifecycle_event_type(old_row public.quotes, new_row public.quotes)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when old_row.id is null then 'QuoteCreated'
    when new_row.quote_sent_at is distinct from old_row.quote_sent_at then 'QuoteSentRecorded'
    when new_row.status is distinct from old_row.status then case new_row.status
      when 'changes_requested' then 'QuoteChangesRequested'
      when 'approved' then 'QuoteAccepted'
      when 'declined' then 'QuoteDeclined'
      when 'abandoned' then 'QuoteAbandoned'
      when 'cancelled' then 'QuoteCancelled'
      when 'booked' then 'QuoteBooked'
      when 'sent' then 'QuoteSentRecorded'
      else null
    end
    else null
  end;
$$;

create or replace function public.prepare_quote_lifecycle_event()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_event_type text;
begin
  v_event_type := case when tg_op = 'INSERT'
    then 'QuoteCreated'
    else public.quote_lifecycle_event_type(old, new)
  end;
  if v_event_type is not null then
    new.entity_version := case when tg_op = 'INSERT' then 1 else coalesce(old.entity_version, 0) + 1 end;
    if v_event_type = 'QuoteSentRecorded' then
      new.first_sent_at := coalesce(old.first_sent_at, new.first_sent_at, new.quote_sent_at);
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.append_quote_lifecycle_event()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_event_type text;
  v_event_id uuid;
begin
  -- The RPC below authors its own richer event (real actor, source and
  -- payload) for the same (quote_id, entity_version). Without this guard both
  -- it and this trigger insert that pair and collide on
  -- quote_lifecycle_events_quote_version_unique, rolling back the quote update
  -- that triggered it. The flag is transaction-local (set_config's third arg),
  -- so it cannot leak into another statement.
  if coalesce(current_setting('yll.skip_lifecycle_trigger', true), '') = 'on' then
    return new;
  end if;

  -- Ledger #93: test quotes stay out of real reporting. The Ops Hub feed has
  -- no is_test column to filter on, so the isolation has to happen here, at
  -- the point the event is written, or fake traffic is indistinguishable to
  -- every consumer downstream.
  if coalesce(new.is_test, false) then return new; end if;

  v_event_type := case when tg_op = 'INSERT'
    then 'QuoteCreated'
    else public.quote_lifecycle_event_type(old, new)
  end;
  if v_event_type is null then return new; end if;
  insert into public.quote_lifecycle_events (
    quote_id, event_type, entity_version, occurred_at, actor_employee_id,
    source, idempotency_key, correlation_id, causation_id, payload
  ) values (
    new.id, v_event_type, new.entity_version, now(), null, 'system',
    format('quote:%s:%s', new.id, new.entity_version), gen_random_uuid(), null,
    jsonb_strip_nulls(jsonb_build_object(
      'quote_number', new.quote_number,
      'customer_ref', new.customer_id,
      'first_sent_at', new.first_sent_at,
      'first_send', case when v_event_type = 'QuoteSentRecorded' then old.first_sent_at is null else null end,
      'delivery_mode', case when v_event_type = 'QuoteSentRecorded' then 'manual_external' else null end,
      'total_cents', case when v_event_type = 'QuoteSentRecorded' then round(new.total * 100)::integer else null end
    ))
  ) returning id into v_event_id;
  insert into public.quote_event_outbox (event_id) values (v_event_id);
  return new;
end;
$$;

drop trigger if exists quote_lifecycle_prepare on public.quotes;
create trigger quote_lifecycle_prepare
  before insert or update on public.quotes
  for each row execute function public.prepare_quote_lifecycle_event();
drop trigger if exists quote_lifecycle_append on public.quotes;
create trigger quote_lifecycle_append
  after insert or update on public.quotes
  for each row execute function public.append_quote_lifecycle_event();

commit;
