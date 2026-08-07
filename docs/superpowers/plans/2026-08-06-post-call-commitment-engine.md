# Post-call commitment engine — v1 plan (ledger #217)

> Drafted 2026-08-06 (Naldo session, remote). Origin: Naldo fell behind on a heavy
> call day and asked how to make every completed phone call generate less
> after-work. This plan was designed from the day's REAL data (all queries run
> against the two prod Supabase projects), Naldo's four rulings recorded below,
> and the in-flight OPERATIONS_HUB_CONTRACT (PR #701). Quick-win siblings:
> ledger #218–#221. Hardened at the S53 wrap by a four-lens review (13 findings
> fixed into this doc, 2 accepted; see the S53 session-log entry).

## The problem, evidenced (Wed 2026-08-06)

22 call events hit the copilot; 4 real conversations transcribed. Reconciling
every promise made in those transcripts against what actually went out
(customers by first name + initial here; full identities are in the DB rows
cited at the bottom):

- **Sheryl M.** (event lead): promised pictures by text (✅ link SMS 11:00 AM)
  and a **"3-ish" same-day callback → never attempted** (zero outbound to her
  number after 10:54 AM). No customer record, no quote; her
  `dashboard_contacts` row has no display name.
- **Rich D.**: SMS 6:51 PM *"We're putting together your custom holiday
  lighting quote right now!"* → **no quote was created after 1:15 PM.**
- **Chris H.**: outbound attempt 6:36 PM (no connect) → he called back
  7:04 PM, hung up in the IVR after 13s → no re-dial; inbox item escalated all
  night, unresponded.
- **Yelena N.**: quote #1263 built + texted DURING the 16-min call (✅ the
  model workflow) — but three open loops rode on it: redesign once she texts a
  current photo (bushes deliberately excluded until then), a promised
  follow-up from the owner (she asked a question only he can answer), and a
  decision follow-up after she confers at home.
- **Sharon M.**: approved #1173 ✅; open: NCE processing + business cards (her
  emailed request), GHL stage drag-back (Jason's S34 note).

Done today: 4 quotes moved + 1 approval. Promised-but-unstarted: **3 quotes**
(Sheryl M., Rich D., Chris H.). Plus `follow_ups`: 16 pending, 10 overdue
since July.

**The standing caution (from our own data):** two machine-generated task queues
already exist and die unworked — `second_mile_touches` (108 rows, 0 ever
completed) and the overdue `follow_ups` backlog. Extraction is NOT the
bottleneck; **surfacing + verified closure is.** This plan is judged on that,
which is why the item lifecycle below is a v1 deliverable, not a later polish.

## What already exists (verified, not assumed)

- **Copilot** (Supabase `yll-call-copilot`, `mjmociuxxxwxvasnpxav`): polls GHL
  every few minutes (`recording_sync_state`), stores `call_recordings` (284) →
  `transcripts` (1,210; raw_text + utterances + customer name/phone +
  `ghl_contact_id` + rep_email on outbound) → **already runs an LLM pass per
  call** (`learnings`: summary/objections/questions; `call_scores`: rubric).
  Measured latency today: transcript ≈ +30 min, extraction ≈ +45–75 min.
  The Sheryl call's machine summary literally says "the rep … committed to
  getting back." Commitments are read today — then die in a table.
- **Quote tool**: GHL mirror (`dashboard_contacts` with `ghl_contact_id`,
  `inbox_items` incl. `channel='call'` events — body-less "📞 Inbound call",
  the known gap), auto `follow_ups` on quote send (`dashboard.followUpDays`),
  Telegram bot + morning digest LIVE (#168 build), and the ground truth for
  verification: it sends the quotes (`quotes.quote_sent_at`, with a direct
  nullable `quotes.highlevel_contact_id` column), mirrors outbound SMS, and
  the copilot logs every call attempt.
- **#168's plan** already sketched "GHL call transcripts → action items" and
  parked it on "confirm transcription exists." **Prerequisite now CONFIRMED**
  — the copilot has been transcribing GHL calls for a month. That sketch is
  superseded by this plan.
- **OPERATIONS_HUB_CONTRACT v1.2.0-draft (PR #701, in flight):** hub owns
  employee profiles/auth and the office/call tools; QT owns quotes/jobs/time
  and `/api/ops/v1`; envelope rules = idempotency keys, outbox/inbox dedup,
  entity versions, kill switches, operatorGate-in-same-PR, DLQ → Telegram.

## Naldo's rulings (2026-08-06, this session — don't re-ask)

1. **The checklist lives in the OPERATIONS HUB dashboard, not the QT
   dashboard.** (His words: "This would live in the operations hub dashboard,
   not the quote tool dashboard.")
2. **v1 autonomy = checklist + auto-verify ONLY.** No auto-actions; prepared
   drafts/one-tap execution is v2 (behind the bot's existing confirm-yes gate).
3. **Coverage = everyone on the line** (Naldo, Jason, office) — per-employee
   boards keyed to who took the call. Depends on #219 (inbound attribution).
4. Quick wins greenlit as ledger rows: #218 transcription-failure triage,
   #219 inbound rep attribution, #220 no follow-ups on internal quotes,
   #221 copilot RLS lockdown.

## Architecture (respecting the hub contract's ownership split)

```
GHL calls ──► copilot sync ──► transcripts ──► NEW: commitment extractor
                                               (cheap model, structured output)
                                                    │  call_commitments
                                                    ▼
                    OPERATIONS HUB: per-employee "My open loops" board
                    (hub-owned UI, per ruling 1)
                                                    ▲
   Quote tool ── verification EVENT FEED ───────────┘
   (quote_sent/viewed/approved · outbound SMS · call attempts)
   → propose as a NEW contract flow ("Flow H") via the contract's §10 change
     process. Flow H events carry the FULL §1 envelope — idempotency_key,
     entity_version, source, transactional outbox on QT / inbox dedup on the
     reader. A bare contact-keyed event stream is NOT the shape.
                                                    │
   Telegram bot (QT, live today) ◄──────────────────┘
   per-call DM ~30–60 min after hangup + promised-time pings + digest sweep
   (this whole ping flow ships behind its own kill-switch env flag)
```

- **Commitment taxonomy** (typed, per item: contact, rep, promised time?):
  `send_quote` · `send_photos` · `callback` (with the promised time — "3-ish"
  → 15:00±) · `schedule_estimate` · `send_info` · `other(free text)`.
- **Item lifecycle (the closure half — designed now, expensive to retrofit):**
  states `open → cleared (auto) | done (manual tap) | dismissed (with reason) |
  expired`. One-tap **dismiss-with-reason** from the DM/board ("not mine" /
  "already handled" / "never said that") is mandatory — extraction is an LLM
  over imperfect transcripts (see #218's failure rate), and a per-employee
  accountability item with no dispute path is a phantom mark against a rep.
  Dismissals are logged as extractor feedback. Items auto-**expire** at 7 days,
  and the digest carries open/stale/expired counts so a silent pileup is
  visible — this is the explicit anti-`second_mile_touches` mechanism. The
  **unclaimed lane** (unattributed inbound, until #219 lands) appears in BOTH
  admins' digests until claimed, so it has owners by default.
- **Auto-verify mapping.** Presence-only signals are NOT sufficient — clearing
  matches on contact + rep + a content/duration signal:
  | Commitment | Clears when | False-clear guard |
  |---|---|---|
  | send_quote | a quote linked to the contact gets `quote_sent_at` (direct: `quotes.highlevel_contact_id`, nullable — fall back through `customers.hl_contact_id`) | sent by a DIFFERENT rep → item closes visibly as "done by <rep>", never silently |
  | send_photos / send_info | outbound SMS/email to the contact **containing media or a portal/lookbook link** | any other outbound → item goes "needs-confirm" (one tap), never auto-clears |
  | callback @T | a **connected** outbound call to the contact (≥20s — the copilot's own threshold) or manual tap | a failed attempt (voicemail / short) suppresses the breach ping but does NOT clear the item |
  | schedule_estimate | v1: manual check-off | calendar/GHL appointment wiring is v2 |
  | other | manual check-off | — |
  A commitment whose breach ping fires ("promised 3 PM callback not made by
  3:30") pings the rep NOW — same-day, not in tomorrow's digest. That is the
  feature that would have saved all three of today's dropped leads.
- **Attribution:** outbound = copilot `ghl_user_id`/`rep_email` (works today);
  inbound = #219 (blocker for per-employee boards). NOTE: the hub's canonical
  staff identity is `employee_id` (contract Flow I) — the
  `rep_email`/`ghl_user_id` → `employee_id` mapping must exist before the hub
  board (slice 4) can key per-employee lanes. Named dependency, not implied.
- **Sequencing honesty:** the hub dashboard doesn't exist yet as a usable
  surface. The extractor + `call_commitments` + the Telegram DM ping + the
  digest sweep can ship FIRST (QT bot is live today); the hub board renders
  the same table when the hub ships. Destination per ruling 1 is unchanged —
  flag to Naldo that v1's visible surface starts as Telegram + digest.

## Build slices (each independently shippable)

1. **Extractor + table** (copilot side, where transcripts + LLM passes already
   run): per-transcript structured extraction → `call_commitments`
   (transcript_id, ghl_contact_id, rep, kind, detail, promised_at?, status
   incl. dismissed_reason, verified_by_event?, created/cleared timestamps,
   dedupe key). Backfillable.
2. **Telegram ping + lifecycle actions + digest section** (QT side): DM the
   rep their new open loops after each transcribed call, with the one-tap
   done/dismiss buttons; promised-time breach pings; open/stale/expired counts
   in the existing morning digest. Behind a kill-switch env flag; any NEW
   crew-reachable route enters `operatorGate`'s allowlist in the same PR
   (contract rule; the existing telegram webhook route is already gated).
3. **Verification event feed** (QT side): emit quote/SMS/call events with the
   full §1 envelope; the clearing job matches them to open commitments under
   the false-clear guards above. Coordinate as contract Flow H (Codex + Naldo
   ruling; contract PR).
4. **Hub board** (hub side, Codex's lane): per-employee open-loops lane
   reading the same table. Out of this repo's scope; contract + the
   rep-identity mapping above govern.

## Non-goals (v1)

No auto-actions (no auto-SMS, no auto-created quote shells) · no GHL-task
mirroring · no coaching/scoring changes · no new inbox.

## Open questions

- **Customer/contact identity is NOT solved and NOT covered by the contract**
  (its Flow I maps staff only). `ghl_contact_id` linkage is demonstrably
  imperfect in today's own evidence (a headline lead's contact row has no
  display name; `quotes.highlevel_contact_id` is nullable — the #700 backfill
  class was 166/168 NULL). Design a digits-suffix phone fallback matcher + a
  no-match review lane, or items false-OPEN forever (the inverse hazard of
  false-clear).
- Where `call_commitments` lives: copilot DB (proposed — transcripts + jobs
  there; hub reads it naturally) vs QT DB (events are born there). Decide with
  Codex when Flow H is drafted; either works with the contract's envelope.
- Extraction cadence: piggyback the existing hourly-ish learnings batch first,
  or a faster per-transcript trigger (a 6:51 PM promise extracted at 8 PM is
  fine for the digest, marginal for same-evening pings).
- Yelena had no pending `follow_ups` row while same-day sends for others did —
  understand why (#220's acceptance criterion) before trusting follow_ups as a
  verification input.

## Session evidence pointers (for the build session)

- Copilot: `transcripts` 1c4abb71 / 798f585a / c7a6107f (Sheryl M. ×3),
  ce0219d2 (Yelena N.). 2026-08-06 failures: 3 × `status='failed'` inbound 43s.
- QT: quotes #1173/#1262–#1265; `follow_ups` 16 pending (10 overdue);
  `second_mile_touches` 108 pending / 0 done; `app_settings` keys
  `dashboard.followUpDays`, `telegram_chat_routing`.
- Code: `src/lib/dashboard/inbox/ghl.ts` + `/api/dashboard/ghl/webhook`
  (calls recognized, body-less); #168 plan §"Related opportunity";
  `docs/context/OPERATIONS_HUB_CONTRACT.md` (PR #701).
