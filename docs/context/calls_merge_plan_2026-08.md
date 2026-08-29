# Calls merge plan: the copilot keep-list, ported into the Cool Tool

> Written 2026-08-28. Inputs: the Call Copilot teardown (Naldo's keep/cut
> rulings, 2026-08-27), `ops_hub_audit_2026-08.md` (workstream D and the
> follow-up rulings), `ghl_transcript_probe_2026-08.md` (the Deepgram
> verdict), and a same-day code recon of yll-call-copilot master `fb1bf326`
> (exact DDL, module inventory, cross-import sweep). This plan defines the
> PR-sized slices; it authorizes nothing by itself. Every slice follows
> AGENTS.md (gates, lens tiers, migration rules, merge-go per PR), and every
> scheduled timer stays OFF until Naldo explicitly enables it.

## Standing rulings this plan implements

Fresh tables in the Quote Tool database; nothing migrates from the copilot
database. Keep: grading pipeline steps 1 to 7, Office Tasks as the single
task list (sources: manual, call commitments, the follow-up strip), practice
room, scoreboard, personal-details scan, playbook system (it feeds grading
and practice). Cut: live-call console, Twilio, media bridge, phone login,
call console, screen pop, contact search, the rest of the second mile. All
operators see all coaching data (the copilot's rep-vs-coach walls do not
carry over). The copilot repo and both leftover Supabase projects retire
after the merge, with an export snapshot first.

## Six architecture decisions, made once so no slice re-litigates them

1. **Identity: the operator IS the actor.** The copilot's entire
   `ops_employees` / capabilities identity foundation is NOT ported. Every
   ported route swaps `resolveCurrentHubActor()` / `hasCapability()` for
   `requireOperator()` (admin-only surfaces use `requireAdmin()`), and every
   ported table that referenced `ops_employees(id)` stores the operator's
   auth user id instead, matching the `dashboard_activity` actor convention.
   Rep attribution on calls stays `rep_email` (from the GHL user on the call
   message), matched to operator emails for display.
2. **The cross-project client dies.** The copilot reads the Quote Tool's
   `quotes` table over the network (outcome labeling, quote-to-close).
   Post-merge these are local queries through the existing quotes data
   layer. The `QUOTE_TOOL_SUPABASE_*` env vars and client are not ported.
3. **Transcription is the HighLevel endpoint, Deepgram is gone.** A small
   adapter calls the transcription endpoint (proven working on the pinned
   `2021-07-28` API version) and produces the copilot's existing
   `TranscribeResult` shape (utterance array with speaker index, start/end
   seconds, text) so `flattenUtterances()` and every downstream consumer
   port unchanged. Known gaps the adapter build must handle: no confidence
   field in practice, sentence-level granularity only (sufficient for every
   shipped metric), and the inbound-call channel mapping must be
   spot-checked on real inbound calls before the old path is considered
   replaced. Calls where HighLevel has no transcript get marked failed with
   a reason, mirroring the existing per-recording failure convention.
4. **Brain review loses the noise-card input.** Its stats loader reads the
   cut dialer's `calls` and `coaching_events` tables (the one real
   keep-to-cut entanglement the recon found). The ported brain review reads
   only `call_scores`, `call_transcripts`, and learnings; the noise-card
   prompt input and the dialer-derived stats are stripped, stated in the
   ported file's own comment.
5. **Cron infrastructure is the Quote Tool's, not a second convention.**
   New crons use the existing `cronDenial()` / `CRON_SECRET` pattern and the
   `operatorGate` allowlist rule (same PR, verified logged out). Each
   pipeline gets its own enable flag, default off, so a valid deploy runs
   nothing until Naldo turns each timer on explicitly. The copilot's
   distinct 503-unconfigured vs 401-denied split and constant-time compare
   already exist in spirit here; where they do not, adopt them.
6. **Seeds start fresh, and the export snapshot must save the edits.** With
   no data migration, the rubric, offer elements, and playbooks restart
   from their seeded defaults. Any EDITED rubric/offer/playbook content in
   the copilot database is data and would be lost at decommission: the
   pre-retirement export snapshot must capture `rubric_versions`,
   `offer_versions`, `playbook_versions`, and `verticals` so Naldo can
   re-enter anything he had tuned. Same snapshot covers transcripts, scores,
   and learnings for history.

## Fresh tables (all follow the audit's conventions checklist: integer
cents where money ever appears, timestamptz, RLS on with zero policies,
CHECK constraints tying shape to state, updated_at triggers in the same
migration, FULL-SCHEMA.sql updated in the same PR, is_test where a feature
will be exercised end to end)

- `office_tasks` + `office_task_events`: port of the copilot's twice-guarded
  design, including the payload-aware idempotency RPCs, the advisory-lock
  replay protection, the immutability triggers, and the status CHECK. Actor
  columns become operator auth ids per decision 1. The ported list endpoint
  fixes BOTH halves of the copilot's known gap: it returns ALL sources (not
  manual only), and completed/dismissed tasks stay reachable through a
  history view or filter (the active list still shows open and blocked per
  the spec, but finished work must not become invisible).
- `call_recordings` + `recording_sync_state` (monotonic cursor RPC ports
  as-is) and `call_transcripts` (the copilot's `transcripts` shape:
  raw_text, utterances jsonb, rep_email, direction, duration, outcome
  columns, plus the extraction-tracking columns from its migration 0024).
- `verticals`, `playbook_versions`, `playbook_proposals`, `learnings`
  (full lifecycle ports, including the concurrency-safe
  `publishPlaybookVersion` retry-once pattern).
- `rubric_versions`, `offer_versions` (versioned config, seeded in the
  migration exactly as the copilot seeds them).
- `call_scores`, `feedback_cards` (one score per transcript, one card per
  score, lazy materialization on read, no cron).
- `call_commitments` plus the two Postgres functions that carry its
  twice-reviewed TOCTOU fix. Ported FAITHFULLY, not reimplemented: the
  never-relabel-a-settled-commitment guarantee lives in those functions.
- `practice_sessions` (isolated by design; writes scores to itself only).
- `personal_touches`: a narrow fresh table for the one surviving second-mile
  piece, copying the dedupe-key and scanned-ledger conventions
  (`personal_touch:<transcript>:<hash>` unique key, a per-transcript scan
  record) without porting the four-kind second-mile queue.
- Scoreboard settings ride in `app_settings` (one key), not a ported
  singleton table.

## The slices, in build order

Each slice is one PR: branch off fresh master, gates green, lens review at
the tier its paths dictate (migrations and staff UI make most of these FULL
tier), merge only on Naldo's go. Builders treat the copilot file paths named
in the recon (`recon-copilot-port` scratchpad, and the copilot repo itself
read-only) as reference source.

**S1. Office Tasks.** Tables, RPCs, triggers, the two routes, the
OfficeTasksCard ported onto the dashboard, actor seam rewired per decision
1. No producers besides manual entry yet. The card's idempotency-key-per-
action client pattern ports as-is. Independent of everything else; first
because commitments (S6) and the follow-up strip (S8) need the container.

**S2. Call ingest.** `call_recordings`/`call_transcripts` tables, the GHL
export sync (paging, 20-page cap, 24h overlap window, under-20s skip, CAS
claim), the HighLevel transcript adapter (decision 3), the junk gate, and a
manual "process next batch" admin surface. First task INSIDE the slice: a
read-only probe of the conversations export endpoint against the live
location (the copilot's own comments say its shape was never verified
live), plus the inbound-call channel-mapping spot-check. Cron route
registered, allowlisted, and left disabled.

**S3. Verticals and playbooks.** Tables, seeds, read layer, generate and
distill flows, proposal approve/apply, the versioned-publish helper, and
the playbook manager UI reachable from the nav this time (the copilot left
it and the analytics workspace unreachable per the teardown; the port does
not repeat that). The recon calls this the largest, most tangled-with-
itself area: if it does not review comfortably as one PR, split it as
S3a (tables, seeds, read layer, enough for S4's prompts) and S3b (the
generate/distill/approve lifecycle and UI), with S4 depending only on S3a.

**S4. Scoring.** `rubric_versions`/`offer_versions` with seeds, the scoring
engine (model per the copilot: Sonnet-tier; totals computed in code, never
by the model), hard metrics from utterances, the substantive gate, outcome
labeling as a LOCAL quotes query (decision 2), learnings extraction, the
stateless batch runner, and the rubric/offer settings screens. Depends on
S2 and S3.

**S5. Coaching surfaces.** Feedback cards (lazy materialization, the
one-fix rule `fix === null`, the feeling-tier thresholds that fixed a real
truthy-render bug), the call review browser, on-demand audio playback, and
card seen-state. Visibility per the ruling: all operators see all cards and
the review browser; no per-rep scoping. Also the Practice Room:
`practice_sessions`, the four persona states, the turn/length limits, the
CAS end-and-score claim, reusing the S4 scoring engine, isolated by design
(writes only to its own table, never to call_scores or any real record).
Depends on S4.

**S6. Commitments into tasks.** The extractor (Haiku-tier, call-anchored
time resolution, 30-day offset cap), the faithful TOCTOU persistence port,
extraction tracking with quarantine, and the producer that turns each
commitment into an `office_tasks` row via `source_system='call_commitment'`
plus the unique source-event guard. Cron registered, disabled. Depends on
S1, S2; ties into #217's ledger row (mark it superseded-into-this-slice at
the close sync).

**S7. Rollups.** Scoreboard (local quote-to-close, the honest flywheel
with rebook-only-connected, TV mode, settings in app_settings; visibility
simplified per the all-operators ruling), weekly digest (zero-call honesty
guard ports as-is), brain review with decision 4's strip, and the
personal-touch scan writing `personal_touches` surfaced on the customer
profile. Narrative model tier: keep the copilot's top-tier weekly calls
(two per week, negligible cost) unless Naldo says otherwise. Depends on S4.

**S8. Turn-ons and retirement.** The follow-up-strip task producer
(`source_system='quote_tool'`), then per-timer enablement asks to Naldo
(sync, scoring, commitments hourly staggered; digest Friday; brain review
Monday; schedules re-confirmed against real call volume at enable time,
not copied blind). Then the copilot retirement, which is destructive and
gated twice: FIRST the export snapshot (decision 6) is taken and its
contents verified against the live copilot row counts, with the
verification shown to Naldo; THEN, only on Naldo's separate explicit go
naming the deletion, decommission the copilot Supabase project and
`yll-ops-hub-staging` and archive the copilot repo. No session performs
the decommission on this plan's authority alone. S8 gets a full review
round even though its diff may carry no migration or UI of its own: it
changes what runs on a schedule and destroys a system, which is exactly
the class the FULL tier exists for. Depends on everything.

## Risks and residuals, named now

- The GHL conversations export endpoint's live shape is a hypothesis until
  S2's probe (the transcription endpoint is proven; the export listing is
  not).
- Inbound-call channel mapping (rep vs customer) is unverified; S2 carries
  the spot-check before Deepgram-free grading is trusted on inbound calls.
- The rep-speaker heuristic in hard metrics (first speaker = rep) is a
  documented copilot deviation the port inherits; the HighLevel channel
  field may allow something better in S4, but that is an improvement, not a
  precondition.
- Edited rubric/offer/playbook content does not migrate (decision 6); the
  snapshot protects it, and re-entering is Naldo's call.
- Practice, feedback, junk gate, scoring, commitments, and the personal
  scan were all verified free of live-call imports by grep; brain review
  was the one exception and is handled by decision 4.

## Proposed ledger rows (numbers claimed at close sync)

One row per slice S1 through S8 carrying that slice's constraints from this
plan, a pointer note on row 217 (superseded into S6), and a retirement row
for the snapshot-then-decommission sequence.
