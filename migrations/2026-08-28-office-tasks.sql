-- =====================================================================
-- office_tasks / office_task_events — Office Tasks, the single task list
-- (calls merge plan S1, docs/context/calls_merge_plan_2026-08.md).
--
-- Ported from the yll-call-copilot repo (master fb1bf326,
-- supabase/migrations/20260821141530_office_tasks.sql — its `ops_tasks` /
-- `ops_task_events`), adapted per the plan's architecture decision 1
-- ("Identity: the operator IS the actor"):
--   - Renamed to office_tasks / office_task_events (the plan's table names).
--   - Actor columns (created_by, assigned_to, actor) are operator auth user
--     ids (uuid, NO FK to any employees table) — matching the
--     dashboard_activity actor convention — instead of the copilot's
--     ops_employees(id) foreign keys. The copilot's "actor must be an
--     active employee" existence check is DROPPED from both RPCs below:
--     there is no employees table to check against, and operator validity
--     is already enforced upstream by requireOperator()/Supabase auth
--     before either RPC is ever called.
--   - An office_tasks_set_updated_at BEFORE UPDATE trigger is added (this
--     repo's own convention — see crew_members.sql / shifts.sql) even
--     though ops_update_own_task's port (office_tasks_update_status) also
--     stamps updated_at itself; the two are redundant, not conflicting.
--
-- Everything else is a FAITHFUL port: the twice-guarded design (an
-- advisory-xact-lock + payload-aware idempotency replay on top of a normal
-- unique-index CAS), the immutability triggers (no deletes; provenance
-- columns immutable; terminal rows frozen; events table fully immutable),
-- and the creator-or-assignee update authorization. See the RPC bodies
-- below for a line-by-line porting note against the copilot original.
--
-- S1 SCOPE: no producers besides manual entry yet (source_system stays
-- 'manual' for every row created here — call_commitment and quote_tool
-- values are reserved for later slices S6/S8). RLS ENABLED + FORCED, ZERO
-- POLICIES — service-role only, reached through the two SECURITY DEFINER
-- RPCs below (which do their own authorization) plus a plain SELECT for
-- the list endpoint.
--
-- HOW TO APPLY: NOT applied by this PR. This migration creates functions
-- and triggers, which are off AGENTS.md's migration self-apply allowlist
-- (that allowlist covers only additive/nullable column adds, new indexes,
-- RLS-enable-with-zero-policies on a brand-new table, and guarded seed
-- inserts) — the seat asks Naldo and applies it separately.
--
-- AMENDED 2026-08-29 for slice S6 (docs/context/calls_merge_plan_2026-08.md),
-- STATED LOUDLY per that slice's build brief: this migration was still
-- UNAPPLIED (see above), so this is an in-place amendment, not a second
-- migration. created_by changes from NOT NULL to NULLABLE, gated by a new
-- CHECK that still REQUIRES it for 'manual' rows (a human always creates
-- those via office_tasks_create_manual, which already rejects a null actor
-- with 42501) while ALLOWING it to be null for any other source_system.
-- Reason: S6's new producer (office_tasks_create_from_commitment,
-- migrations/2026-08-29-call-commitments.sql) creates tasks straight from a
-- phone call with no operator to credit — there is no actor to be the
-- "creator" of a machine-detected commitment.
--
-- office_tasks_update_status's ownership check below —
--   if p_actor <> v_task.created_by and p_actor is distinct from v_task.assigned_to
-- — is UNCHANGED by this amendment, and needs no change: when created_by and
-- assigned_to are both NULL, `p_actor <> NULL` evaluates to NULL, `NULL and
-- <anything but false>` is NULL, and plpgsql's IF treats a NULL condition as
-- false — so the ownership check silently never fires for one of these
-- null-owner tasks, and ANY operator can already claim/block/complete/
-- dismiss it through this same RPC. That is the S6 plan's "assign-to-me
-- falls out naturally" case, achieved by existing NULL comparison semantics
-- with zero RPC body changes — see migrations/2026-08-29-call-commitments.sql
-- for the full reasoning.
-- =====================================================================

create table public.office_tasks (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'manual'
    check (source_system in ('manual', 'call_commitment', 'quote_tool')),
  source_event_id text
    check (source_event_id is null or char_length(source_event_id) <= 256),
  title text not null
    check (
      nullif(btrim(title), '') is not null
      and char_length(title) <= 200
    ),
  detail text
    check (detail is null or char_length(detail) <= 2000),
  status text not null default 'open'
    check (status in ('open', 'blocked', 'completed', 'dismissed')),
  due_at timestamptz not null default (now() + interval '24 hours'),
  -- Operator auth user ids (auth.users.id) — NO FK per decision 1. There is
  -- no employees table in the Quote Tool; identity IS the operator.
  -- Nullable as of the 2026-08-29 (S6) amendment above: a 'manual' row is
  -- always created by a real, authenticated operator (enforced below by
  -- office_tasks_created_by_presence, mirroring office_tasks_create_manual's
  -- own p_actor-required check), but a machine-sourced row (S6's
  -- call_commitment producer) has no operator to credit.
  created_by uuid,
  assigned_to uuid,
  completed_at timestamptz,
  dismissed_at timestamptz,
  blocked_at timestamptz,
  blocked_reason text
    check (blocked_reason is null or char_length(blocked_reason) <= 500),
  dismissal_reason text
    check (dismissal_reason is null or char_length(dismissal_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint office_tasks_source_event_presence check (
    (source_system = 'manual' and source_event_id is null)
    or (source_system <> 'manual' and nullif(btrim(source_event_id), '') is not null)
  ),
  -- Added by the 2026-08-29 (S6) amendment above: a 'manual' row must always
  -- carry a real creator; any other source_system may leave it null (a
  -- machine-sourced row has no operator to credit).
  constraint office_tasks_created_by_presence check (
    source_system <> 'manual' or created_by is not null
  ),
  constraint office_tasks_status_fields_check check (
    (
      status = 'open'
      and completed_at is null
      and dismissed_at is null
      and blocked_at is null
      and blocked_reason is null
      and dismissal_reason is null
    )
    or (
      status = 'blocked'
      and completed_at is null
      and dismissed_at is null
      and blocked_at is not null
      and nullif(btrim(blocked_reason), '') is not null
      and dismissal_reason is null
    )
    or (
      status = 'completed'
      and completed_at is not null
      and dismissed_at is null
      and blocked_at is null
      and blocked_reason is null
      and dismissal_reason is null
    )
    or (
      status = 'dismissed'
      and completed_at is null
      and dismissed_at is not null
      and blocked_at is null
      and blocked_reason is null
      and nullif(btrim(dismissal_reason), '') is not null
    )
  )
);

create unique index office_tasks_source_event_unique
  on public.office_tasks (source_system, source_event_id)
  where source_event_id is not null;

create index office_tasks_creator_due_idx
  on public.office_tasks (created_by, due_at, id);

create index office_tasks_assignee_due_idx
  on public.office_tasks (assigned_to, due_at, id);

-- Read by the history view (GET /api/tasks?status=history), newest-activity-first.
create index office_tasks_status_updated_idx
  on public.office_tasks (status, updated_at desc, id);

create table public.office_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.office_tasks(id),
  event_type text not null
    check (event_type in ('created', 'assigned', 'blocked', 'completed', 'dismissed')),
  actor uuid not null,
  idempotency_key uuid not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (actor, idempotency_key)
);

create index office_task_events_task_created_idx
  on public.office_task_events (task_id, created_at, id);

alter table public.office_tasks enable row level security;
alter table public.office_tasks force row level security;
alter table public.office_task_events enable row level security;
alter table public.office_task_events force row level security;

revoke all privileges on table public.office_tasks, public.office_task_events
  from public, anon, authenticated, service_role;
grant select on table public.office_tasks, public.office_task_events to service_role;

-- Keep updated_at fresh on every write (mirrors crew_members.sql / shifts.sql).
-- Runs alongside office_tasks_enforce_transition below (also BEFORE UPDATE);
-- Postgres fires same-event triggers in name order ('e' < 's'), so the
-- immutability/terminal check always sees the row as the caller submitted it
-- before this trigger re-stamps updated_at — no interaction between the two.
create function public.office_tasks_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger office_tasks_set_updated_at
  before update on public.office_tasks
  for each row execute function public.office_tasks_set_updated_at();

-- Task identity, source provenance, assignment, deletion, and terminal rows
-- are immutable in this foundation, ported unchanged from the copilot's
-- enforce_ops_task_transition (only the column names changed:
-- created_by_employee_id -> created_by, assigned_employee_id -> assigned_to).
-- A later reviewed assignment workflow can replace this rule without making
-- direct service-role DML authoritative.
create function public.office_tasks_enforce_transition()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'task rows cannot be deleted';
  end if;

  if new.id is distinct from old.id
     or new.source_system is distinct from old.source_system
     or new.source_event_id is distinct from old.source_event_id
     or new.created_by is distinct from old.created_by
     or new.assigned_to is distinct from old.assigned_to
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'task ownership and provenance are immutable';
  end if;

  if old.status in ('completed', 'dismissed') and new is distinct from old then
    raise exception using errcode = '23514', message = 'terminal task cannot change';
  end if;

  return new;
end
$function$;

revoke all on function public.office_tasks_enforce_transition()
  from public, anon, authenticated, service_role;

create trigger office_tasks_enforce_transition
before update or delete on public.office_tasks
for each row execute function public.office_tasks_enforce_transition();

-- Fully immutable audit trail, ported unchanged.
create function public.office_task_events_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'task audit events are immutable';
end
$function$;

revoke all on function public.office_task_events_reject_mutation()
  from public, anon, authenticated, service_role;

create trigger office_task_events_reject_mutation
before update or delete on public.office_task_events
for each row execute function public.office_task_events_reject_mutation();

-- office_tasks_create_manual — port of the copilot's ops_create_manual_task.
-- Line-by-line porting note against the original:
--   - p_actor_employee_id -> p_actor (uuid, no employees-table check).
--   - REMOVED: "if not exists (select 1 from ops_employees where id =
--     p_actor_employee_id and employee.active) then raise 42501" — no
--     employees table exists per decision 1; the caller (requireOperator())
--     already guarantees p_actor is a live, authenticated operator before
--     this function is ever invoked.
--   - ADDED a plain "p_actor is not null" check in its place, raising the
--     SAME 42501 the removed employee-lookup used to raise on a missing/
--     inactive actor. Without it a null actor would fail later as a bare
--     NOT NULL violation (23502) on the office_tasks insert, or as a crossed
--     wire in the advisory-lock hash — 42501 is the clearer, and the route's
--     existing error-code mapping already expects it.
--   - Everything else (the advisory-xact-lock keyed on actor+idempotency
--     key, the payload-aware idempotency replay comparing event_type +
--     detail jsonb, the future-due-date check, the insert-task-then-insert-
--     event pair) is unchanged.
--   - assigned_to is set to p_actor (self-assigned) on manual creation,
--     matching the copilot's assigned_employee_id := p_actor_employee_id.
create function public.office_tasks_create_manual(
  p_title text,
  p_detail text,
  p_due_at timestamptz,
  p_actor uuid,
  p_idempotency_key uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_task_id uuid;
  v_existing_event_type text;
  v_existing_detail jsonb;
  v_normalized_title text := btrim(p_title);
  v_normalized_detail text := nullif(btrim(p_detail), '');
  v_request_detail jsonb;
begin
  if p_actor is null then
    raise exception using errcode = '42501', message = 'an authenticated actor is required';
  end if;
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'idempotency key is required';
  end if;
  if nullif(v_normalized_title, '') is null or char_length(v_normalized_title) > 200 then
    raise exception using errcode = '22023', message = 'task title is invalid';
  end if;
  if v_normalized_detail is not null and char_length(v_normalized_detail) > 2000 then
    raise exception using errcode = '22023', message = 'task detail is too long';
  end if;

  v_request_detail := jsonb_build_object(
    'operation', 'create_manual',
    'title', v_normalized_title,
    'detail', v_normalized_detail,
    'due_at', p_due_at
  );

  -- Serialize first use of one actor/key pair. A concurrent retry waits for
  -- the first transaction and then returns the same durable result.
  perform pg_advisory_xact_lock(
    hashtextextended(p_actor::text || ':' || p_idempotency_key::text, 0)
  );

  select task_id, event_type, detail
  into v_task_id, v_existing_event_type, v_existing_detail
  from public.office_task_events
  where actor = p_actor
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_event_type is distinct from 'created'
       or v_existing_detail is distinct from v_request_detail then
      raise exception using errcode = '23505', message = 'idempotency key payload conflicts';
    end if;
    return v_task_id;
  end if;

  if p_due_at is not null and p_due_at <= now() then
    raise exception using errcode = '22023', message = 'task due time must be in the future';
  end if;

  insert into public.office_tasks (
    title,
    detail,
    due_at,
    created_by,
    assigned_to
  ) values (
    v_normalized_title,
    v_normalized_detail,
    coalesce(p_due_at, now() + interval '24 hours'),
    p_actor,
    p_actor
  )
  returning id into v_task_id;

  insert into public.office_task_events (
    task_id,
    event_type,
    actor,
    idempotency_key,
    detail
  ) values (
    v_task_id,
    'created',
    p_actor,
    p_idempotency_key,
    v_request_detail
  );

  return v_task_id;
end
$function$;

revoke all on function public.office_tasks_create_manual(text,text,timestamptz,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.office_tasks_create_manual(text,text,timestamptz,uuid,uuid)
  to service_role;

-- office_tasks_update_status — port of the copilot's ops_update_own_task.
-- Line-by-line porting note against the original:
--   - p_actor_employee_id -> p_actor (uuid, no employees-table check);
--     REMOVED the same "active employee" existence check as above, for the
--     same reason, and ADDED the same "p_actor is not null" -> 42501 check
--     in its place.
--   - v_task.created_by_employee_id -> v_task.created_by,
--     v_task.assigned_employee_id -> v_task.assigned_to.
--   - Everything else (the advisory-xact-lock, the payload-aware
--     idempotency replay, the creator-or-assignee ownership check raising
--     42501, the terminal-status guard, the per-status reason
--     requirement/prohibition, the row lock via `for update`) is unchanged.
create function public.office_tasks_update_status(
  p_task_id uuid,
  p_status text,
  p_reason text,
  p_actor uuid,
  p_idempotency_key uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_task public.office_tasks%rowtype;
  v_existing_task_id uuid;
  v_existing_event_type text;
  v_existing_detail jsonb;
  v_normalized_reason text := nullif(btrim(p_reason), '');
  v_request_detail jsonb;
begin
  if p_actor is null then
    raise exception using errcode = '42501', message = 'an authenticated actor is required';
  end if;
  if p_idempotency_key is null then
    raise exception using errcode = '22023', message = 'idempotency key is required';
  end if;
  if p_status is null or p_status not in ('blocked', 'completed', 'dismissed') then
    raise exception using errcode = '22023', message = 'invalid task status action';
  end if;
  if p_status in ('blocked', 'dismissed') and v_normalized_reason is null then
    raise exception using errcode = '22023', message = 'a reason is required';
  end if;
  if p_status = 'completed' and v_normalized_reason is not null then
    raise exception using errcode = '22023', message = 'completed tasks do not accept a reason';
  end if;
  if v_normalized_reason is not null and char_length(v_normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'task reason is too long';
  end if;

  v_request_detail := jsonb_build_object(
    'operation', 'set_status',
    'status', p_status,
    'reason', v_normalized_reason
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_actor::text || ':' || p_idempotency_key::text, 0)
  );

  select task_id, event_type, detail
  into v_existing_task_id, v_existing_event_type, v_existing_detail
  from public.office_task_events
  where actor = p_actor
    and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_task_id is distinct from p_task_id
       or v_existing_event_type is distinct from p_status
       or v_existing_detail is distinct from v_request_detail then
      raise exception using errcode = '23505', message = 'idempotency key payload conflicts';
    end if;
    return v_existing_task_id;
  end if;

  select *
  into v_task
  from public.office_tasks
  where id = p_task_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'task does not exist';
  end if;
  if p_actor <> v_task.created_by
     and p_actor is distinct from v_task.assigned_to then
    raise exception using errcode = '42501', message = 'task is not owned by actor';
  end if;
  if v_task.status in ('completed', 'dismissed') then
    raise exception using errcode = '22023', message = 'terminal task cannot change';
  end if;

  update public.office_tasks
  set
    status = p_status,
    completed_at = case when p_status = 'completed' then now() else null end,
    dismissed_at = case when p_status = 'dismissed' then now() else null end,
    dismissal_reason = case when p_status = 'dismissed' then v_normalized_reason else null end,
    blocked_at = case when p_status = 'blocked' then now() else null end,
    blocked_reason = case when p_status = 'blocked' then v_normalized_reason else null end,
    updated_at = now()
  where id = p_task_id;

  insert into public.office_task_events (
    task_id,
    event_type,
    actor,
    idempotency_key,
    detail
  ) values (
    p_task_id,
    p_status,
    p_actor,
    p_idempotency_key,
    v_request_detail
  );

  return p_task_id;
end
$function$;

revoke all on function public.office_tasks_update_status(uuid,text,text,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.office_tasks_update_status(uuid,text,text,uuid,uuid)
  to service_role;
