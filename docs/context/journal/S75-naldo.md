# S75 (Naldo) — 2026-08-28→29 — from prompt review to a LIVE calls-to-tasks system in one conversation: 6 PRs merged, 3 migrations applied, 7 days backfilled, hourly automation armed

## The arc

Started as a review of Naldo's Operations Hub audit prompt. Ended with the
calls-to-tasks feature live in production: office tasks on the dashboard,
HighLevel call transcripts ingested (Deepgram never needed), commitments
extracted into assigned tasks, and the hourly timers armed by Naldo the same
night. Along the way: the full Ops Hub audit, a read-only HighLevel
transcript probe with a measured Deepgram verdict, the eight-slice calls
merge plan, and the advertising role hardening. Two other lanes (admin
View-as mechanism, advertising schema) ran concurrently in Naldo's own
sessions off prompts this session wrote.

## Shipped (all merged + live)

- **#1025** ops-hub plan doc grounded in master reality (superseded-remnant
  handling, roleOf cite, nav truth, sibling-project pointer).
- **#1029** the Ops Hub audit report `ops_hub_audit_2026-08.md`: 6 recon
  agents + same-day prod measurements; all of Naldo's rulings folded in
  (teardown keep/cut, Office Tasks reversal, separate advertising
  population, all-operators coaching visibility, rate stamped at
  acceptance, Schedule nav now).
- **#1042** the GHL transcript probe `ghl_transcript_probe_2026-08.md`:
  HTTP 200 on the pinned 2021-07-28 version, channel split matching the
  stored Deepgram diarization (247/783 vs 235/798 words), verdict DEEPGRAM
  CAN BE DROPPED. Also documented this machine's router DNS poisoning of
  services.leadconnectorhq.com (filter IP 167.206.37.145; pin the real
  Cloudflare address).
- **#1056** the calls merge plan `calls_merge_plan_2026-08.md`: six
  architecture decisions, eight PR-sized slices, retirement double-gated.
- **#1043** advertising role hardening (workstream A slice 1): the
  population lock BEFORE any advertising account exists. Four lenses + a
  delta-verify caught and fixed a real 45px nav overflow at 1024px, two
  sibling-parity gaps (staff picker, office clock), and a half-wired
  ClockCard reason. Schedule nav item shipped inside it.
- **#1066** the calls track, ONE PR per Naldo's ruling (slices S1+S2+S6):
  office_tasks/office_task_events with the copilot's twice-guarded RPC
  design; call_recordings/call_transcripts + GHL export sync + the
  HighLevel transcript adapter + junk gate + /admin/calls; call_commitments
  with the TOCTOU finalize (producer folded into its transaction) creating
  tasks assigned to the rep who took the call. Naldo's launch rulings built
  in: EVERYTHING shared (manual tasks too, "Personal" badged), rep
  assignment via GHL user → operator email match.
- **Prod ops after the single merge-go:** three migrations applied via MCP
  and verified by schema queries; the 7-day backfill run through the REAL
  route handlers locally (DNS pinned): **79 calls → 22 transcripts (rep
  names resolved) → 19 commitments → 19 tasks (9 auto-assigned), zero
  failures**; Naldo set CALLS_SYNC_ENABLED/CALLS_EXTRACT_ENABLED and
  redeployed. Timers: sync :12, extract :27 hourly.

## Review record

Every PR lens-reviewed pre-merge at its tier (docs = process lens; code =
FULL four). #1066's round: 0 HIGH from personas, then the technical lens
BLOCKED with 2 HIGH **proven in a live postgres:16 container**: both
ON CONFLICT upserts targeted PARTIAL unique indexes (42P10), meaning the
sync could never insert a recording and the producer could never create a
task — the whole feature dead on arrival behind 9050 green tests, the
repo's third hit of this exact class. Fix round re-proven in the container;
two delta-verifies (one caught a half-wired UI reason path); final round
(shared-everything + rep assignment) delta-verified PASS with a live
truth-table on the relaxed ownership RPC. Close review: integration +
customer lenses (running at close; results in the close PR discussion or
the post-close delta if late).

## Decisions confirmed (do not re-litigate)

- Deepgram dropped; HighLevel transcription on the already-pinned API
  version. 13 of 79 calls had no HL transcript (mostly <45s) — an honest
  platform limit, recorded, not a bug.
- Inbound calls carry NO GHL user (ring-all): their tasks land in the
  shared pool. Naldo chose option 2: keep the pool, no GHL routing change,
  no guess-the-rep code.
- Everything-is-shared task visibility; rate/rep rulings per the audit doc.
- Email IS the account link: every named GHL rep matched their operator
  account 1:1 (Naldo 11/11, Kelly 4/4, Jason 1/1). No mapping table needed.

## Mistakes (full list in the scorecard)

Ran the four-lens round on a stale local tree missing S6 (caught via a
lens's "route missing" contradiction); hand-typed a SHA into
--match-head-commit (guard refused, twice); applied migration 1
comment-stripped instead of byte-verbatim; a background command chained a
poll after a fallible merge and left a conflicted tree sitting 40 minutes;
the backfill runner's stop condition read fields that didn't exist.

Gates at close: see close PR (run on fresh master in a clean worktree).
Master at close: `9a78becc`+. Next free ledger #: 466 after this close
(S75 minted 460-464 for the remaining calls slices, plus 465 at close for
the grant-hardening advisory).

Close review outcome: integration lens PASS (composition clean, prod schema matches the fully-amended files, backfill figures consistent, zero orphans) with one advisory deferred to row 465 (call-table grant hardening); customer lens PASS on live prod (clean cron denials, perimeter composition intact; a real-device 375px pass on /estimate and /login remains a human nicety, low risk).
