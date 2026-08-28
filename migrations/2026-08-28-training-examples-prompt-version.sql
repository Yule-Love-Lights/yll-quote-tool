-- Fix round (PR #916, admin lens MED — roofline segmentation): stamp which
-- ANALYZER_PROMPT_VERSION (src/lib/photoAnalysis.ts) produced a captured
-- example's original_analysis, so scripts/measure-roofline-segmentation.ts
-- (or any future before/after tool) can group rows by which prompt actually
-- generated them and compare segmentation behavior across a prompt change
-- like this PR's.
--
-- Nullable text, no default/backfill — every existing row predates
-- promptVersion being stamped on analyzePhoto's result, so null means
-- "pre-versioning" (this PR's own prompt change and everything before it).
-- Scoped to HOLIDAY only (training_examples / src/lib/photoAnalysis.ts): this
-- PR's prompt edit touches only the holiday SYSTEM_PROMPT, not the separate
-- permanent-vertical prompt in src/lib/permanent/photoAnalysis.ts, so there
-- is nothing yet to compare before/after on permanent_training_examples. Add
-- the equivalent column there in its own migration if/when a permanent
-- prompt change needs the same before/after comparison.
--
-- Populated in src/lib/trainingExamples.ts's captureTrainingExample by
-- copying the value already stamped onto original_analysis at ANALYSIS time
-- (not re-stamped from the live constant at capture time) — a design can be
-- analyzed under one prompt and sent/captured under a different one, so
-- capture time is the wrong place to read the current constant.
alter table training_examples
  add column if not exists prompt_version text;

comment on column training_examples.prompt_version is
  'ANALYZER_PROMPT_VERSION (src/lib/photoAnalysis.ts) that produced this row''s original_analysis, copied from original_analysis.promptVersion at capture time. Null = captured before this column existed, or original_analysis predates the promptVersion field.';
