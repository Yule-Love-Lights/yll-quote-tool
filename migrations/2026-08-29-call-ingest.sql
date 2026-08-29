-- =====================================================================
-- Call ingest (calls_merge_plan_2026-08.md, slice S2) — call_recordings,
-- recording_sync_state, and call_transcripts. FRESH tables: nothing
-- migrates from the yll-call-copilot database (standing ruling, see the
-- plan's "Standing rulings" section). Fresh source: the yll-call-copilot
-- repo at master fb1bf326, migrations 0003/0007/0024 — read-only reference,
-- ported and adapted, not copy-pasted verbatim (decision 1: identity is the
-- operator, not ops_employees; the transcription source is the HighLevel
-- endpoint, not Deepgram; no verticals/metric_scope, both S3+ concerns).
--
-- NOT APPLIED to any database by this PR. Naldo applies it once he's ready
-- (see AGENTS.md's migration-application rule — a brand-new table with RLS
-- enabled and zero policies is on the safe/additive allowlist, but this PR
-- still asks rather than assumes).
--
-- call_recordings is the idempotency ledger: one row per GHL call message
-- (unique on ghl_message_id), status pending -> processing -> transcribed /
-- skipped / failed. recording_sync_state is a single-row (id=1) cursor the
-- sync job advances monotonically via advance_recording_sync_cursor (ported
-- from the copilot's migration 0024 almost verbatim — same GREATEST-based
-- upsert so a stale overlapping invocation can never move the cursor
-- backward; adapted only to this repo's `security definer set search_path =
-- public` convention (see allocate_display_number above) instead of the
-- copilot's `search_path = ''` + explicit revoke/grant boilerplate, which
-- isn't a pattern this repo otherwise uses).
--
-- call_transcripts holds the HighLevel-sourced transcript for a completed
-- call. Deliberately narrower than the copilot's `transcripts` table: no
-- vertical_id (verticals don't exist yet — S3), no metric_scope (that
-- column is copilot-only legacy provenance bookkeeping from its migration
-- 0020, not part of this port), and outcome always starts 'unknown' —
-- outcome labeling is a LOCAL quotes-table query per the plan's decision 2,
-- landing in S4, not here.
--
-- rep_email is nullable and NOT populated by this slice: the quote tool's
-- src/lib/integrations/highlevel.ts has no user-id -> email lookup helper
-- (the copilot's getGhlUserEmail has no equivalent here), so inventing one
-- inline or stuffing a raw GHL user id into rep_email would be silently
-- wrong. rep_ghl_user_id stores the ground-truth id from the call message
-- instead (S4 can add the email lookup and backfill from this column).
--
-- The eight commitment-extraction tracking columns + the partial pending-
-- extraction index are ported from the copilot's migration 0024 now, so S6
-- (call commitments) does not need a second migration to add them — per
-- this slice's brief. The index below intentionally omits copilot's
-- `and metric_scope = 'performance'` condition (no such column exists on
-- this table). The two PL/pgSQL functions that read/write these columns
-- (call_commitments_finalize_extraction, record_commitment_extraction_
-- failure) are NOT ported here — they reference call_commitments, which
-- does not exist until S6.
-- =====================================================================

create table if not exists public.call_recordings (
  id                   uuid primary key default gen_random_uuid(),
  ghl_message_id       text,
  ghl_contact_id       text,
  ghl_conversation_id  text,
  ghl_user_id          text,
  direction            text,
  called_at            timestamptz,
  duration_seconds     int,
  status               text not null default 'pending'
                         check (status in ('pending', 'processing', 'transcribed', 'skipped', 'failed')),
  skip_reason          text,
  transcript_id        uuid,
  detail               jsonb,
  processing_at        timestamptz,
  is_test              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Idempotency key: a re-run of the sync (or the 24h provider-visibility
-- overlap window re-scanning the same day) must never double-insert the
-- same call. Partial + unique because a message with no id at all should
-- never happen but the column stays nullable defensively (matches the
-- copilot's plain `unique` on a nullable text column — Postgres treats
-- multiple NULLs as distinct under a plain unique constraint too, so a
-- partial index is equivalent here; written explicitly for clarity).
create unique index if not exists call_recordings_ghl_message_id_key
  on public.call_recordings (ghl_message_id) where ghl_message_id is not null;

-- The batch runner's candidate query: plain-pending rows plus abandoned-
-- processing rows (processing_at older than the 15-minute staleness
-- cutoff), oldest first.
create index if not exists call_recordings_status_created_idx
  on public.call_recordings (status, created_at);

alter table public.call_recordings enable row level security;

create table if not exists public.recording_sync_state (
  id              int primary key default 1 check (id = 1),
  last_synced_at  timestamptz,
  detail          jsonb
);

alter table public.recording_sync_state enable row level security;

create table if not exists public.call_transcripts (
  id                    uuid primary key default gen_random_uuid(),

  -- Where this transcript came from, copilot's `source_file` convention
  -- generalized ("source label" — this slice's brief) since there is no
  -- upload path here yet: the pipeline stamps `ghl:<ghl_message_id>`.
  source                text,

  customer_name         text,
  customer_phone        text,
  called_at             timestamptz,
  raw_text              text not null,
  utterances            jsonb,

  rep_email             text,
  rep_ghl_user_id       text,
  direction             text,
  duration_seconds      int,
  ghl_contact_id        text,

  outcome               text not null default 'unknown'
                          check (outcome in ('booked', 'not_booked', 'unknown')),
  outcome_source        text,

  -- Commitment-extraction tracking (ported from the copilot's migration
  -- 0024 — see this file's header). All null/zero until S6's extractor runs.
  commitments_extracted_at                     timestamptz,
  commitment_extractor_version                 text,
  commitment_extracted_count                   integer,
  commitment_extraction_attempts               integer not null default 0,
  commitment_extraction_terminal_failures      integer not null default 0,
  commitment_extraction_last_attempt_at        timestamptz,
  commitment_extraction_quarantined_at         timestamptz,
  commitment_extraction_last_failure_code      text,

  is_test               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint call_transcripts_commitment_extracted_count_check
    check (commitment_extracted_count is null or commitment_extracted_count >= 0),

  constraint call_transcripts_commitment_extraction_marker_check
    check (
      (
        commitments_extracted_at is null
        and commitment_extractor_version is null
        and commitment_extracted_count is null
      )
      or (
        commitments_extracted_at is not null
        and nullif(btrim(commitment_extractor_version), '') is not null
      )
    ),

  constraint call_transcripts_commitment_extraction_attempts_check
    check (
      commitment_extraction_attempts >= 0
      and commitment_extraction_terminal_failures >= 0
      and commitment_extraction_terminal_failures <= commitment_extraction_attempts
      and (
        (
          commitment_extraction_attempts = 0
          and commitment_extraction_terminal_failures = 0
          and commitment_extraction_last_attempt_at is null
          and commitment_extraction_quarantined_at is null
          and commitment_extraction_last_failure_code is null
        )
        or (
          commitment_extraction_attempts > 0
          and commitment_extraction_last_attempt_at is not null
          and commitment_extraction_last_failure_code in (
            'deterministic_extraction_failed',
            'transient_dependency_failed'
          )
          and (
            commitment_extraction_quarantined_at is null
            or commitment_extraction_terminal_failures >= 3
          )
        )
      )
      and not (
        commitments_extracted_at is not null
        and commitment_extraction_quarantined_at is not null
      )
    )
);

-- S6's batch picker: oldest never-attempted work first, excluding anything
-- already extracted or quarantined. No metric_scope condition — see header.
create index if not exists call_transcripts_pending_commitment_extraction_idx
  on public.call_transcripts (
    commitment_extraction_last_attempt_at nulls first,
    called_at,
    id
  )
  where commitments_extracted_at is null
    and commitment_extraction_quarantined_at is null;

alter table public.call_transcripts enable row level security;

alter table public.call_recordings
  add constraint call_recordings_transcript_id_fkey
  foreign key (transcript_id) references public.call_transcripts(id) on delete set null;

-- ---------------------------------------------------------------------
-- updated_at triggers.
-- ---------------------------------------------------------------------
create or replace function public.call_recordings_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists call_recordings_updated_at on public.call_recordings;
create trigger call_recordings_updated_at
  before update on public.call_recordings
  for each row execute function public.call_recordings_set_updated_at();

create or replace function public.call_transcripts_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists call_transcripts_updated_at on public.call_transcripts;
create trigger call_transcripts_updated_at
  before update on public.call_transcripts
  for each row execute function public.call_transcripts_set_updated_at();

-- ---------------------------------------------------------------------
-- advance_recording_sync_cursor — monotonic cursor advance (ported from the
-- copilot's migration 0024). Takes the single row's lock and applies
-- GREATEST, so a stale overlapping invocation (a slow cron run racing a
-- staff-triggered batch) can never move a newer cursor backward.
-- ---------------------------------------------------------------------
create or replace function public.advance_recording_sync_cursor(
  p_next_cursor timestamptz,
  p_detail jsonb
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stored_cursor timestamptz;
begin
  if p_next_cursor is null then
    raise exception 'advance_recording_sync_cursor: p_next_cursor is required';
  end if;

  insert into recording_sync_state as sync_state (id, last_synced_at, detail)
  values (1, p_next_cursor, p_detail)
  on conflict (id) do update
  set
    last_synced_at = greatest(sync_state.last_synced_at, excluded.last_synced_at),
    detail = case
      when sync_state.last_synced_at is null
        or excluded.last_synced_at >= sync_state.last_synced_at
      then excluded.detail
      else sync_state.detail
    end
  returning last_synced_at into v_stored_cursor;

  return v_stored_cursor;
end;
$$;
