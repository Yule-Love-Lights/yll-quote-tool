-- =====================================================================
-- advertising_placements.worker_note — the per-photo note from the Simple
-- Crew replica build (Naldo, 2026-08-29): the capture queue offers "Take a
-- note..." under every shot, and the note rides the placement so admin
-- review sees it beside the photo. Free text from the worker about their
-- own placement; never money-bearing.
--
-- HOW TO APPLY: safe/additive per AGENTS.md (nullable column add).
-- =====================================================================

alter table public.advertising_placements
  add column if not exists worker_note text;

comment on column public.advertising_placements.worker_note is
  'Free-text note the worker attached to their own placement photo (Simple Crew replica capture queue). Editable by the owning worker only; shown to admin beside the photo in review.';
