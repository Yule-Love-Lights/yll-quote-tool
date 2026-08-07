# Post-call commitment engine — v1 plan (ledger #217)

> Drafted 2026-08-06 (Naldo session, remote). Origin: Naldo fell behind on a heavy
> call day and asked how to make every completed phone call generate less
> after-work. This plan was designed from the day's REAL data (all queries run
> against the two prod Supabase projects), Naldo's four rulings recorded below,
> and the in-flight OPERATIONS_HUB_CONTRACT (PR #701). Quick-win siblings:
> ledger #218–#221.

## The problem, evidenced (Wed 2026-08-06)

22 call events hit the copilot; 4 real conversations transcribed. Reconciling
every promise made in those transcripts against what actually went out:

- **Sheryl Massella** (event lead, engagement party Aug 22, tent + portico,
  Syosset): promised pictures by text (✅ link SMS 11:00 AM) and a **"3-ish"
  same-day callback → never attempted** (zero outbound to her number after
  10:54 AM). No customer record, no quote; her `dashboard_contacts` row has no
  name.
- **Rich Dalessio**: SMS 6:51 PM *"We're putting together your custom holiday
  lighting quote right now!"* → **no quote was created after 1:15 PM.**
- **Chris Hughes**: outbound attempt 6:36 PM (no connect) → he called back
  7:04 PM, hung up in the IVR after 13s → no re-dial; inbox item escalated all
  night, unresponded.
- **Yelena Nossa**: quote #1263 built + texted DURING the 16-min call (✅ the
  model workflow) — but three open loops rode on it: redesign once she texts a
  current photo (bushes deliberately excluded until then), "I'll have my boss
  call you" (she asked what the tool is built with), and a decision follow-up
  after she talks to her mom.
- **Sharon McDonough**: approved #1173 $7,051 ✅; open: NCE processing +
  business cards (her 5:10 PM email), GHL stage drag-back (Jason's S34 note).

Done today: 4 quotes moved (Sharon ×2, Yelena, julia lee) + 1 approval.
Promised-but-unstarted: **3 quotes** (Sheryl, Rich, Chris). Plus `follow_ups`:
16 pending, 10 overdue since July.

**The standing caution (from our own data):** two machine-generated task queues
already exist and die unworked — `second_mile_touches` (108 rows, 0 ever
completed) and the overdue `follow_ups` backlog. Extraction is NOT the
bottleneck; **surfacing + verified closure is.** This plan is judged on that.

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
  verification: it sends the quotes (`quote_sent_at`), mirrors outbound SMS,
  and the copilot logs every call attempt.
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
     process, riding §1 envelope rules. NOT side-channel plumbing.
                                                    │
   Telegram bot (QT, live today) ◄──────────────────┘
   per-call DM ~30–60 min after hangup + promised-time pings + digest sweep
```

- **Commitment taxonomy** (typed, per item: contact, rep, promised time?):
  `send_quote` · `send_photos` · `callback` (with the promised time — "3-ish"
  → 15:00±) · `schedule_estimate` · `send_info` · `other(free text)`.
- **Auto-verify mapping** (what clears an item without a human tap):
  | Commitment | Clears when |
  |---|---|
  | send_quote | a quote to the matched contact gets `quote_sent_at` |
  | send_photos / send_info | outbound SMS/email to the contact's number/email after the call (QT inbox mirror) |
  | callback @T | an outbound call to the contact after the call (copilot); **not cleared by T+30 min → ping the rep NOW, not tomorrow** |
  | schedule_estimate | v1: manual check-off (calendar/GHL appointment wiring is v2) |
  | other | manual check-off |
- **Attribution:** outbound = `ghl_user_id`/`rep_email` (works today);
  inbound = #219 (blocker for per-employee boards; until it lands, inbound
  commitments go to a shared "unclaimed" lane).
- **Sequencing honesty:** the hub dashboard doesn't exist yet as a usable
  surface. The extractor + `call_commitments` + the Telegram DM ping + the
  digest sweep can ship FIRST (QT bot is live today); the hub board renders
  the same table when the hub ships. Destination per ruling 1 is unchanged —
  flag to Naldo that v1's visible surface starts as Telegram + digest.

## Build slices (each independently shippable)

1. **Extractor + table** (copilot side, where transcripts + LLM passes already
   run): per-transcript structured extraction → `call_commitments`
   (transcript_id, ghl_contact_id, rep, kind, detail, promised_at?, status,
   verified_by_event?, created/cleared timestamps, dedupe key). Backfillable.
2. **Telegram ping + digest section** (QT side): DM the rep their new open
   loops after each transcribed call; promised-time breach pings; "still open
   from yesterday's calls" in the existing morning digest.
3. **Verification event feed** (QT side): emit quote/SMS/call events keyed by
   ghl_contact_id; the clearing job matches them to open commitments.
   Coordinate as contract Flow H (Codex + Naldo ruling; contract PR).
4. **Hub board** (hub side, Codex's lane): per-employee open-loops lane
   reading the same table. Out of this repo's scope; contract governs.

## Non-goals (v1)

No auto-actions (no auto-SMS, no auto-created quote shells) · no GHL-task
mirroring · no coaching/scoring changes · no new inbox.

## Open questions

- Where `call_commitments` lives: copilot DB (proposed — transcripts + jobs
  there; hub reads it naturally) vs QT DB (events are born there). Decide with
  Codex when Flow H is drafted; either works with the contract's envelope.
- Extraction cadence: piggyback the existing hourly-ish learnings batch first,
  or a faster per-transcript trigger (a 6:51 PM promise extracted at 8 PM is
  fine for the digest, marginal for same-evening pings).
- Yelena had no pending `follow_ups` row while Sharon/julia did (same-day
  sends) — understand why before trusting follow_ups as a verification input.

## Session evidence pointers (for the build session)

- Copilot: `transcripts` 1c4abb71 / 798f585a / c7a6107f (Sheryl ×3),
  ce0219d2 (Yelena). 2026-08-06 failures: 3 × `status='failed'` inbound 43s.
- QT: quotes #1173/#1262–#1265; `follow_ups` 16 pending (10 overdue);
  `second_mile_touches` 108 pending / 0 done; `app_settings` keys
  `dashboard.followUpDays`, `telegram_chat_routing`.
- Code: `src/lib/dashboard/inbox/ghl.ts` + `/api/dashboard/ghl/webhook`
  (calls recognized, body-less); #168 plan §"Related opportunity";
  `docs/context/OPERATIONS_HUB_CONTRACT.md` (PR #701).
