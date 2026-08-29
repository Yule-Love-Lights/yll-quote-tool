-- =====================================================================
-- call_commitments (calls_merge_plan_2026-08.md, slice S6) — rep promises
-- extracted from a call transcript ("I'll send your quote today", "I'll
-- call you back at 3"), plus the producer that turns each OPEN one into an
-- office_tasks row.
--
-- FAITHFUL PORT of the table + the finalize/failure functions from the
-- yll-call-copilot repo at master fb1bf326 (supabase/migrations/
-- 0021_call_commitments.sql, 0024_commitment_extraction_tracking.sql — 0022's
-- first upsert function is superseded by 0024's finalize function in the
-- copilot itself and is NOT ported here at all). Adapted only where the two
-- schemas genuinely differ:
--   - FK target is call_transcripts(id), this repo's table (S2), not the
--     copilot's transcripts(id).
--   - The finalize/failure functions read/write call_transcripts, not
--     transcripts, and DROP every metric_scope check and column reference:
--     that column does not exist on call_transcripts (no verticals system
--     exists yet — S3 is unbuilt; see migrations/2026-08-29-call-ingest.sql's
--     header, which already omitted metric_scope from the extraction-tracking
--     columns and index it pre-added for this slice).
--   - call_transcripts already carries the eight commitment-extraction
--     tracking columns + the partial pending-extraction index (added by S2's
--     migration precisely so this migration would not need a second ALTER).
--
-- The never-relabel-a-settled-commitment guarantee lives entirely in
-- call_commitments_finalize_extraction below: DEDUPE KEY = (transcript_id,
-- kind, extraction_index), and the function locks every existing row for the
-- transcript with `for update` before deciding, refusing the WHOLE batch the
-- instant any row has moved off 'open' -- all inside one transaction, so
-- there is no gap between the check and the write for a concurrent verify job
-- (a later slice) to slip a status change into. See the function's own
-- comment, ported from the copilot's persist.ts, for the full #217 review
-- history behind this design (a first fix did the check-then-write as two
-- application round trips; that TOCTOU gap is exactly what this single-
-- transaction function closes).
--
-- DEVIATION FROM THE BUILD BRIEF, noted explicitly: the brief describes this
-- function as "upsert ON CONFLICT". The copilot's OWN final version (0024,
-- which supersedes 0022's ON CONFLICT upsert with a create-or-replace) does
-- NOT upsert -- it DELETEs the transcript's entire still-open commitment set
-- and re-INSERTs the fresh extraction. 0024's own comment explains why: "A
-- prior process may have committed rows and crashed before a completion
-- marker existed. Replace the entire still-open set so a nondeterministic
-- retry cannot leave stale rows that are absent from the final extraction."
-- An ON CONFLICT upsert cannot removes a row that a shorter retry no longer
-- produces, so it can leave a stale extra commitment behind. This migration
-- ports the FINAL, superseding behavior (delete + insert), not the earlier
-- upsert the brief described, per this build's standing instruction to
-- distrust the brief where the actual code says otherwise.
--
-- THE PRODUCER (office_tasks_create_from_commitment) is NEW code for this
-- slice -- the copilot never built it (see the merge plan's S6 paragraph:
-- "the producer that turns each commitment into an office_tasks row").
-- Idempotent via office_tasks' existing (source_system, source_event_id)
-- partial unique index (S1), keyed on the commitment's own id.
--
-- ACTOR PROBLEM (stated loudly, per the build brief): a commitment-sourced
-- task has no operator to credit as its creator -- it is machine-generated
-- from a phone call, and S2 leaves rep identity as rep_ghl_user_id with no
-- operator mapping yet. office_tasks.created_by was NOT NULL in S1. This
-- migration's sibling amendment to migrations/2026-08-28-office-tasks.sql
-- (still unapplied, so amended in place rather than shipped as a second
-- migration) makes created_by NULLABLE for any non-'manual' source_system,
-- while still REQUIRING it for 'manual' rows (a human always creates those
-- through office_tasks_create_manual, which already enforces p_actor is not
-- null). assigned_to stays NULL here too -- nobody claims to know which
-- operator corresponds to which GHL user yet.
--
-- SILENT SIDE EFFECT worth stating just as loudly: office_tasks_update_
-- status's ownership check --
--   if p_actor <> v_task.created_by and p_actor is distinct from v_task.assigned_to
-- -- evaluates to NULL, not TRUE, when both created_by and assigned_to are
-- NULL (`p_actor <> NULL` is NULL, and `NULL and anything-but-false` is
-- NULL), and plpgsql's IF treats a NULL condition as false, so the ownership
-- check never fires for one of these null-owner tasks. ANY operator can
-- already claim/block/complete/dismiss a call_commitment task through the
-- existing, UNCHANGED office_tasks_update_status RPC -- no RPC code change
-- was needed for this. This is exactly the "assign-to-me falls out
-- naturally" the plan asked about: nobody is assigned, but everybody can act,
-- matching the plan's "all operators see all coaching data" ruling. No
-- office_task_events row is written by the producer below -- that table's
-- actor-keyed idempotency model is for RPC-mediated ACTOR actions, and a
-- system INSERT has no actor to attribute it to; a normal event row is
-- written the moment a real operator later calls office_tasks_update_status
-- on the task.
--
-- HOW TO APPLY: NOT applied by this PR (creates functions/triggers, off
-- AGENTS.md's migration self-apply allowlist, same as S1/S2's migrations)
-- -- the seat asks Naldo and applies it separately, alongside the sibling
-- amendment to 2026-08-28-office-tasks.sql (both are still unapplied, so
-- applying them together is the only sane order: this migration's finalize/
-- failure functions assume call_transcripts already has S2's tracking
-- columns, and the producer assumes office_tasks.created_by is nullable).
-- =====================================================================

create table public.call_commitments (
  id uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.call_transcripts(id) on delete cascade,
  ghl_contact_id text,
  -- Same identity column and convention as call_transcripts.rep_email
  -- (migrations/2026-08-29-call-ingest.sql) -- denormalized at extraction
  -- time from the parent transcript row, not populated by this slice (S2
  -- leaves call_transcripts.rep_email null; see that migration's header).
  rep_email text,
  kind text not null check (kind in ('send_quote', 'send_photos', 'callback', 'schedule_estimate', 'send_info', 'other')),
  detail text not null,
  -- Anchored to the CALL's wall-clock time (America/New_York), not
  -- extraction time -- see src/lib/commitments/time.ts. Nullable: not every
  -- commitment carries a specific time ("I'll follow up soon").
  promised_at timestamptz,
  status text not null default 'open' check (status in ('open', 'cleared', 'done', 'dismissed', 'expired')),
  dismissed_reason text,
  -- Free text naming the event that verified/cleared this commitment (e.g.
  -- "quote sent 2026-08-12", a GHL event id). Populated by a later slice's
  -- verification job -- nullable and unused by this slice's extractor.
  verified_by_event text,
  -- DEDUPE KEY, third column. Zero-based, per (transcript_id, kind). See
  -- this file's header for why this (not the freeform `detail` text) is the
  -- stable ordinal: Claude is not byte-deterministic about wording across
  -- re-extractions.
  extraction_index int not null default 0,
  created_at timestamptz not null default now(),
  cleared_at timestamptz
);

create unique index call_commitments_dedupe_key
  on public.call_commitments (transcript_id, kind, extraction_index);

-- Read by the producer (office_tasks_create_from_commitment's caller) and by
-- the /admin/calls debug page's commitment-status counts.
create index call_commitments_transcript_status_idx
  on public.call_commitments (transcript_id, status);

alter table public.call_commitments enable row level security;
alter table public.call_commitments force row level security;

revoke all privileges on table public.call_commitments
  from public, anon, authenticated, service_role;

-- Same grant shape as the copilot's 0021 -- select for the admin debug page's
-- counts; insert/update/delete for the finalize/failure functions below
-- (both SECURITY DEFINER, so this grant is defense-in-depth, not the only
-- path -- matches office_tasks_create_manual's own posture in S1).
grant select, insert, update, delete on table public.call_commitments
  to service_role;

-- ---------------------------------------------------------------------
-- call_commitments_finalize_extraction -- ported from the copilot's
-- migration 0024 (final/canonical form -- see this file's header for why
-- 0022's earlier ON CONFLICT upsert is not ported). Adapted: reads/writes
-- call_transcripts, not transcripts; every metric_scope check and column
-- reference is dropped (no such column here -- see header).
-- ---------------------------------------------------------------------
create function public.call_commitments_finalize_extraction(
  p_transcript_id uuid,
  p_rows jsonb,
  p_extractor_version text
) returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_extracted_at timestamptz;
  v_has_resolved boolean;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'p_rows must be a JSON array';
  end if;
  if nullif(btrim(p_extractor_version), '') is null then
    raise exception using errcode = '22023', message = 'p_extractor_version is required';
  end if;

  select transcript_record.commitments_extracted_at
  into v_extracted_at
  from public.call_transcripts as transcript_record
  where transcript_record.id = p_transcript_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'source transcript does not exist';
  end if;
  if v_extracted_at is not null then
    return 'already_finalized';
  end if;

  select bool_or(commitment_record.status <> 'open')
  into v_has_resolved
  from (
    select locked_commitment.status
    from public.call_commitments as locked_commitment
    where locked_commitment.transcript_id = p_transcript_id
    for update
  ) as commitment_record;

  if coalesce(v_has_resolved, false) then
    update public.call_transcripts
    set
      commitments_extracted_at = now(),
      commitment_extractor_version = 'preexisting-resolved',
      commitment_extracted_count = null,
      commitment_extraction_quarantined_at = null
    where id = p_transcript_id;
    return 'refused';
  end if;

  -- A prior process may have committed rows and crashed before a completion
  -- marker existed. Replace the entire still-open set so a nondeterministic
  -- retry cannot leave stale rows that are absent from the final extraction.
  delete from public.call_commitments
  where transcript_id = p_transcript_id;

  insert into public.call_commitments (
    transcript_id,
    ghl_contact_id,
    rep_email,
    kind,
    detail,
    promised_at,
    extraction_index
  )
  select
    p_transcript_id,
    row_record ->> 'ghl_contact_id',
    row_record ->> 'rep_email',
    row_record ->> 'kind',
    row_record ->> 'detail',
    (row_record ->> 'promised_at')::timestamptz,
    (row_record ->> 'extraction_index')::integer
  from jsonb_array_elements(p_rows) as row_record;

  update public.call_transcripts
  set
    commitments_extracted_at = now(),
    commitment_extractor_version = p_extractor_version,
    commitment_extracted_count = jsonb_array_length(p_rows),
    commitment_extraction_quarantined_at = null
  where id = p_transcript_id;

  return 'ok';
end
$function$;

revoke all on function public.call_commitments_finalize_extraction(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.call_commitments_finalize_extraction(uuid, jsonb, text)
  to service_role;

-- ---------------------------------------------------------------------
-- record_commitment_extraction_failure -- ported from the copilot's
-- migration 0024, same table adaptation as above (call_transcripts, no
-- metric_scope check).
-- ---------------------------------------------------------------------
create function public.record_commitment_extraction_failure(
  p_transcript_id uuid,
  p_failure_code text
) returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_attempts integer;
  v_extracted_at timestamptz;
  v_quarantined_at timestamptz;
  v_terminal_failures integer;
begin
  if p_failure_code is null or p_failure_code not in (
    'deterministic_extraction_failed',
    'transient_dependency_failed'
  ) then
    raise exception using errcode = '22023', message = 'invalid commitment extraction failure code';
  end if;

  select
    transcript_record.commitment_extraction_attempts,
    transcript_record.commitments_extracted_at,
    transcript_record.commitment_extraction_quarantined_at,
    transcript_record.commitment_extraction_terminal_failures
  into v_attempts, v_extracted_at, v_quarantined_at, v_terminal_failures
  from public.call_transcripts as transcript_record
  where transcript_record.id = p_transcript_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'source transcript does not exist';
  end if;
  if v_extracted_at is not null then
    return 'already_finalized';
  end if;
  if v_quarantined_at is not null then
    return 'already_quarantined';
  end if;

  v_attempts := v_attempts + 1;
  if p_failure_code = 'deterministic_extraction_failed' then
    v_terminal_failures := v_terminal_failures + 1;
  end if;
  update public.call_transcripts
  set
    commitment_extraction_attempts = v_attempts,
    commitment_extraction_terminal_failures = v_terminal_failures,
    commitment_extraction_last_attempt_at = clock_timestamp(),
    commitment_extraction_last_failure_code = p_failure_code,
    commitment_extraction_quarantined_at = case
      when v_terminal_failures >= 3 then clock_timestamp()
      else null
    end
  where id = p_transcript_id;

  return case when v_terminal_failures >= 3 then 'quarantined' else 'retry_scheduled' end;
end
$function$;

revoke all on function public.record_commitment_extraction_failure(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_commitment_extraction_failure(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------
-- office_tasks_create_from_commitment -- THE PRODUCER (new code, not a
-- copilot port -- see this file's header). Turns one OPEN call_commitments
-- row into an office_tasks row (source_system='call_commitment',
-- source_event_id=the commitment's own id). Idempotent via office_tasks'
-- existing (source_system, source_event_id) partial unique index (S1): a
-- retried call for the same commitment id is a no-op that returns the same
-- task id.
-- ---------------------------------------------------------------------
create function public.office_tasks_create_from_commitment(
  p_commitment_id uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_commitment public.call_commitments%rowtype;
  v_customer_name text;
  v_customer_phone text;
  v_customer_line text;
  v_title text;
  v_detail text;
  v_due_at timestamptz;
  v_task_id uuid;
begin
  select *
  into v_commitment
  from public.call_commitments
  where id = p_commitment_id
    and status = 'open';

  if not found then
    -- Not an error: the commitment may already have been actioned (status
    -- moved off 'open'), or the id may not exist. The only caller (the
    -- extraction pipeline) only ever passes ids it just wrote as 'open', so
    -- this is defensive rather than an expected path.
    return null;
  end if;

  select transcript_record.customer_name, transcript_record.customer_phone
  into v_customer_name, v_customer_phone
  from public.call_transcripts as transcript_record
  where transcript_record.id = v_commitment.transcript_id;

  v_title := case v_commitment.kind
    when 'send_quote' then 'Send quote'
    when 'send_photos' then 'Send photos'
    when 'callback' then 'Call back'
    when 'schedule_estimate' then 'Schedule estimate'
    when 'send_info' then 'Send info'
    when 'other' then 'Follow up'
    else 'Follow up'
  end;
  if nullif(btrim(v_commitment.detail), '') is not null then
    v_title := v_title || ': ' || btrim(v_commitment.detail);
  end if;
  v_title := left(v_title, 200);

  v_customer_line := nullif(
    trim(both ' ' from
      coalesce(v_customer_name, '')
      || case when v_customer_name is not null and v_customer_phone is not null then ' - ' else '' end
      || coalesce(v_customer_phone, '')
    ),
    ''
  );
  v_detail := v_commitment.detail;
  if v_customer_line is not null then
    v_detail := v_detail || E'\n\n' || v_customer_line;
  end if;
  v_detail := left(v_detail, 2000);

  v_due_at := coalesce(v_commitment.promised_at, now() + interval '24 hours');

  insert into public.office_tasks (
    source_system, source_event_id, title, detail, due_at, created_by, assigned_to
  ) values (
    'call_commitment', p_commitment_id::text, v_title, v_detail, v_due_at, null, null
  )
  on conflict (source_system, source_event_id) do nothing
  returning id into v_task_id;

  if v_task_id is null then
    select office_task.id into v_task_id
    from public.office_tasks as office_task
    where office_task.source_system = 'call_commitment'
      and office_task.source_event_id = p_commitment_id::text;
  end if;

  return v_task_id;
end
$function$;

revoke all on function public.office_tasks_create_from_commitment(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.office_tasks_create_from_commitment(uuid)
  to service_role;
