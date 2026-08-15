# P4P labor tracking + operations: the plan, the recon, and the review

> Living doc for the initiative. Written 2026-08-06 for Naldo.
> **Part A** is the plan, locked from Naldo's answers across three Q&A rounds and
> corrected by a five-lens adversarial review the same day.
> **Part B** is the recon it was built on (the P4P system, Copilot/Homeworks, P4P
> Software, this codebase).
> **Part C** is the review record: what five reviewers found and what was done
> about each finding.
> Related: `project_inventory_system.md` (#82) and the yll-call-copilot repo
> (the YLL Operations Hub).

---

# PART A: THE PLAN

> **ADDENDUM 2026-08-06 (evening), binding over anything below that conflicts.**
> The cross-assistant merge with Codex's Operations Hub plan is complete. Naldo's
> final rulings (F1-F4, logged in the hub repo's
> `docs/operations-hub/DECISIONS.md`) change this plan as follows:
> (1) F2: the Quote Tool owns ALL canonical time (day clock, breaks, job
> segments, travel) as one paid-day envelope; the hub is capture UI, offline
> queue, and raw GPS evidence. This restores and widens Phase 2 below.
> (2) F1: parallel tracks. Phase 2's Sept 21 target is BACK, Telegram-bot-first,
> writing to the canonical ledger; the hub's capture UI joins later.
> (3) F3: manual Arrived/Departed punches are authoritative for pay; GPS
> corroborates and suggests only.
> (4) F4: the clock gate softens to a non-sensitive pre-clock-in summary, exact
> details unlock at accepted clock-in, with an audited owner override.
> The integration authority is now `docs/context/OPERATIONS_HUB_CONTRACT.md`
> (v1.0.0-draft, canonical in this repo, mirrored in the hub repo); its Flow B
> state machine supersedes this doc's A8 draft API table. Hub-side behavior
> authority is the hub repo's `docs/operations-hub/OPERATIONS-HUB-SPEC.md`.

## A1. What we are building, one paragraph

The quote tool becomes the operations system: budgeted hours computed from each
job's real design geometry, a crew time clock tied to jobs, a full scheduling
calendar, and the P4P pay engine (labor-revenue pool, base-pay floor, efficiency,
weekly payroll breakdown). Copilot CRM retires once parity ships. Crew-facing
screens land in the YLL Operations Hub (the yll-call-copilot repo), which reads
from the quote tool over HTTP. Pay runs in shadow mode first: everyone stays on
hourly while the numbers prove themselves, then the switch flips.

## A2. Locked decisions

| Decision | Call |
|---|---|
| System of record | Quote tool. Copilot retires after parity (today it only holds Jason's clock). |
| Scheduling | FULL calendar in the quote tool: drag-drop, crew assignment, capacity from budgeted hours, dispatch view. |
| Time clock | All three, phased: (1) Telegram bot per-job clock, (2) day-clock with office review and split, (3) web clock in the Operations Hub later. |
| Labor revenue on blended prices | Per-category labor % (roofline X%, wreaths Y%, ...). Computed from the pre-tax labor subtotal only. |
| Labor revenue % to the team | UNKNOWN on purpose. Naldo does not know the business's number yet. Shadow mode measures it; the weekly ritual sets and tunes it. Dial starts at 33%. |
| Rollout | Shadow mode first. Crew stays hourly, sees the would-be numbers, pay flips only when trusted. |
| Drive time | Counts toward job hours. ONE authoritative source (see A5 Phase 2), never both the clock and a BH allowance feeding the same pool. |
| Pay period | Weekly. Hours paid in the current week; performance pay paid the following week, after the 7-day quality window clears. Business timezone America/New_York, pinned explicitly everywhere. |
| Production rates | Never tracked before. Seed from one estimate session with Jason, then calibrate from shadow-mode actuals. |
| Quality guardrail | Forfeiture of UNEARNED performance pay, never a deduction from wages. See A3, this is a legal requirement not a preference. |
| Quality window | 7 days from job completion. Performance pay is provisional until it clears. |
| Pool membership | Install team only: SonSon, Little James, Big James. Jason is OUT, hourly (he approves instead). |
| Crew model | One team, assigned per day. Whoever is on the job that day shares its pool by hours. No fixed crew names. |
| Clock gate | ON. Crew cannot see the day's schedule until clocked in. Server-side check, office/admin exempt by role. Needs a documented override path (open, A6). |
| Approver | Jason approves time entries and settles grey-area splits. Backup approver still open (A6). |
| Language | Per-profile language option covering crew UI AND the earnings/quality-notice text, not just navigation. |
| Takedown | Paid plain hourly this season, outside the pools. Still clocked per job so the data designs next season's rule. |
| Season dates | Installs start the last week of September 2026. Takedown season starts about Jan 5 (unconfirmed). Phases 1-2 live before installs start. |
| Copilot retirement | Cancel only after Phases 2 AND 3 are both live and have run clean in the field for two weeks. |

**Base rates** (Naldo confirmed; Copilot profiles verified 2026-08-06):
SonSon $16, Little James $17 (raise, Copilot profile stale), Big James $20,
Jason $10 (out of pool).

**Wage-floor flag, recorded and deliberately deferred by Naldo (2026-08-06).**
Long Island minimum wage is $17.00/hr as of Jan 1 2026, and NY counts
performance pay in the regular rate when computing overtime. SonSon at $16 and
Jason at $10 sit below that floor. Naldo's call is that this does not matter at
this point in time, so it is recorded here and not raised again. It stays a
build input: the engine's base floor must be a configurable number per person,
so whatever the rates become, the math follows them. Sources:
[NY 2026 increase](https://www.governor.ny.gov/news/money-your-pockets-governor-hochul-reminds-new-yorkers-minimum-wage-increase-january-1),
[Proskauer summary](https://www.proskauer.com/blog/new-york-state-minimum-wage-and-exempt-salary-updates-for-2026).

## A3. Quality guardrail: forfeiture, not deduction (LEGAL, not a preference)

The original plan copied the P4P handout: yellow slips and damage cases debit the
guilty member's performance dollars. **That mechanism is very likely unlawful in
New York and has been removed.**

Why: NY Labor Law §190(1) defines wages as "the earnings of an employee for labor
or services rendered, regardless of whether the amount of earnings is determined
on a time, piece, commission or other basis." Performance pay tied to work already
performed falls inside that definition, so it is wages. §193 permits deductions
from wages only in enumerated categories, all of which must be "for the benefit of
the employee," and NY DOL treats repayment of employer losses (breakage, spoilage,
damage) as prohibited **even with written consent**. Calling the money performance
pay instead of base pay changes nothing. Penalties reach the full amount deducted
plus liquidated damages up to 100% plus attorney's fees.
Sources: [§193 text](https://www.nysenate.gov/legislation/laws/LAB/193),
[§190 definitions](https://www.nysenate.gov/legislation/laws/LAB/190),
[Lipsky Lowe on breakage charges](https://lipskylowe.com/deducting-money-from-workers-wages/).

**What replaces it (Naldo's design, 2026-08-06).** Damage and anything that goes
wrong on a property is a yellow slip. A yellow slip inside the quality window
means the performance pay for that job is **never earned**, capped at that
amount, with no carry-forward to future periods. Base pay is untouched always.
That is forfeiture under plan terms, which NY courts uphold, rather than a
deduction from earned wages.

**Three conditions keep it lawful, all three are build or paperwork requirements:**

1. **Written comp plan before the work.** The plan document must state up front
   that performance pay on a job is earned only if the job clears quality review
   with no yellow slip. Signed before the season. An employment attorney reviews
   the wording. This is now a one-document review, not a rebuild.
2. **Capped to the affected job, no carry-forward.** Already Naldo's design.
3. **Never labeled as earned before the window clears.** This is the software
   constraint. Substance beats labels: if the app tells a crew member he earned
   $100 on Tuesday and it disappears Friday, that reads as a deduction no matter
   what the comp plan calls it.

**Therefore performance pay is a state machine, not a number:**

```
provisional  --(7 days clean, no yellow slip)-->  earned  -->  paid
     |
     +--(yellow slip inside the window)-->  forfeited (that job only)
```

- Every crew-facing surface (my-earnings, leaderboard, bot nudges) MUST render
  provisional amounts as pending quality review. Never "earned", never "you made".
- `earned_at` is stamped only when the window closes clean.
- Only `earned` rows can enter a payroll export.
- Quality window: **7 days from job completion** (Naldo, 2026-08-06).
- **Payout cadence, by design (Naldo, 2026-08-06): hours are paid in the current
  week at base rate; performance pay is paid the FOLLOWING week, after the 7-day
  window closes.** This is not a workaround for the lag, it is the structure that
  makes the whole thing safe: every performance dollar that reaches payroll has
  already cleared the quality gate, so nothing is ever paid and then clawed back,
  and nothing needs to be. The legal requirement (never label it earned before
  the gate) and the payroll cadence line up on their own.
- Build consequence: a pay period's export has two components with different
  origins. Week N's export carries week N hours plus week N-1's cleared
  performance pay. The export format and the my-earnings endpoint must both make
  that split obvious, or a crew member reading their stub will think a week is
  missing.
- Rework hours also flow into the job's actual hours (see A5 Phase 2), so a
  return visit lowers everyone's effective rate on that job through the math
  itself. No deduction exists anywhere in the system.

Yellow slips still get recorded on the crew member's record and feed raises,
eligibility, and coaching. They never touch a paycheck line.

## A4. The ecosystem split (confirmed)

- **Quote tool (this repo):** system of record and engine. Tables, BH math,
  labor-revenue math, pay math, scheduling data, office screens, the Telegram
  bot, and token-authed HTTP APIs for the hub.
- **YLL Operations Hub = yll-call-copilot, extended.** Not a new repo. Crew
  clock-in, my-hours, my-stats, my-earnings live there, alongside the existing
  sales/coach app. Later: the yard-sign/door-hanger team (out of scope here).
- **Data wiring:** the hub calls quote tool APIs. Each app keeps its own
  database. Verified 2026-08-06: the two already run separate Supabase projects,
  so this matches reality with zero migration.
- **Division of labor:** Codex works full-stack on hub features, including the
  quote tool API routes its screens need. Two assistants in one repo, so:
  - Codex reads this repo's `AGENTS.md` and follows it as a third dev: branch
    prefix `codex/...`, PR into master, gates green
    (`npx tsc --noEmit · npm run lint · npm test`), a human merges, never merge
    stale.
  - **AGENTS.md needs a real ownership row for Codex** (its table names only
    Jason and Naldo) with a named human reviewer for Codex PRs. Open, A6.
  - **Schema migrations for the labor tables (`crew_members`,
    `job_time_entries`, job BH/labor-revenue columns) have ONE author: this
    repo's assistant.** Codex consumes via API and never migrates these tables.
    Prevents two assistants racing the same first migration.
  - The contract doc is the handshake: endpoints, auth, and shapes are written
    there BEFORE either side builds. Home:
    `docs/context/OPERATIONS_HUB_CONTRACT.md` (canonical) with a pointer copy in
    `yll-call-copilot/docs/`.
- **GHL:** stays the CRM for leads and comms. Untouched.

## A5. Build phases

Money math ships last. Shadow data starts flowing before the season.

**Hard date:** installs start the last week of September 2026 and shadow data
must flow from day one. Targets: Phases 1 + 2 live by Sept 21, Phase 3 early
October, Phase 4 during October, Phases 5-6 in season, the pay flip when the
numbers are trusted.

### Phase 1: the person entity, budgeted hours, labor revenue

- **`crew_members` table ships HERE**, not later: quote-tool identity, the
  Telegram user id, the hub's auth id, base rate, pool membership, language,
  active dates. Phases 2 and 4 both need a real person entity; introducing it
  later would mean migrating live payroll data.
- Production rates and per-category labor % into BUSINESS_RULES: feet per
  man-hour for roofline by difficulty, minutes per wreath/garland/spritzer/tree/
  stake-foot/bistro-foot, plus a per-job travel allowance. **Every category needs
  a stated conservative default** so an unmapped or one-off line item never
  silently computes $0 labor revenue.
- Job stores `budgeted_hours` and `labor_revenue_cents`, derived from the
  design's real items. Office can override BH per job.
- **Labor revenue is computed from the pre-tax labor subtotal.** Sales tax is
  never in the pool.
- **Recompute trigger, explicit:** the pool is computed from the labor revenue at
  **invoice-final**, not at quote approval. Quotes stay editable after approval,
  and discounts, comps, change orders, and non-payment all move the real number.
  The job stores the approval-time figure as a planning estimate, clearly
  distinct from the payout basis. A job that is never invoiced or never collected
  pays no pool (policy call recorded here so the code cannot drift).

### Phase 2: time capture

**Shipped so far:** the `shifts` day-clock ledger (S57) and `shift_breaks`
(S58, `migrations/2026-08-11-shift-breaks.sql`, applied to prod 2026-08-11).
Breaks are unpaid, so paid time is the shift envelope minus break time;
`src/lib/shiftBreaks.ts` owns that arithmetic, merges overlapping breaks so an
office correction cannot subtract the same minutes twice, and clips breaks to
the envelope. Clock-out auto-closes a running break at the punch time and marks
it `auto_closed` for the `open_break` exception queue, per the contract's Flow B
semantics — it never rejects the clock-out. Still unbuilt: job
arrive/depart/complete segments, travel, and the Telegram wiring.

- `job_time_entries`: job, crew member, start, stop, source (bot / office /
  hub), **`stoppage_reason`** (completed / weather / no-access / materials /
  other), `entry_kind` (install / rework / non-billable / travel),
  `approved_by`, `approved_at`.
- **`stoppage_reason` ships from day one.** A crew sent home 40% through a job
  otherwise reads as beating the budget and poisons the shadow-mode data the
  entire learning loop depends on. It cannot be backfilled; nobody will remember
  which Tuesday it rained.
- **Append-only audit trail.** Editing or splitting an entry writes a new row and
  preserves the original with who and when. Never overwrite. NY requires
  contemporaneous, accurate payroll records retained six years, and these entries
  become the basis of disputes.
- **Auto clock-out at midnight** (Copilot behavior that must NOT be lost) so a
  forgotten clock-out cannot silently inflate hours.
- **Idempotency on every clock write.** Clock in twice, retry on bad signal, stop
  a job never started, double-tap start: all handled by an explicit state guard,
  not by hoping. These rows feed paychecks.
- **Travel time has one authoritative source.** Either the running clock between
  jobs OR the per-job BH travel allowance, never both feeding the same pool.
  Decision belongs in the Phase 2 brief.
- **Rework against a closed job:** `done` is a terminal job status today, so the
  rule must be explicit. Rework entries are allowed against a closed job, tagged
  `entry_kind = rework`, and they roll into that job's actual hours for
  efficiency, but they do not reopen billing.
- Office screen: review, edit, split a day across jobs, approve. Manual add for
  forgot-to-clock.
- **Entries lock at payroll export.** An edit after the lock creates an
  adjustment row in the NEXT period. Never a silent retroactive change to a
  period already paid.

### Phase 3: scheduling, full calendar

- Crew assignment on jobs, drag-drop week/month calendar, unscheduled-work list,
  dispatch/day view.
- Capacity view driven by BH per person per day. **Derivation must be stated:**
  Phase 1 computes job-level BH only, so per-person capacity comes from job BH
  divided across the assigned crew for that day, and reads as unassigned load
  until a job has an assignment.
- Install dates stop syncing from Copilot; the Zapier feed (#84) retires.

### Phase 4: the P4P engine, shadow mode

Test-first, money code. The failing-test list is written before implementation.

- Per job: efficiency (BH vs actual hours, weather-flagged entries excluded from
  the learning signal).
- Per week per person: pool share by hours, base floor true-up, overtime,
  non-billable at base, the weekly payroll breakdown export.
- **Integer cents end to end.** No float division anywhere in the pipeline.
  Round only at final display or payout. **Remainder cents go to the crew**
  (largest-remainder split), never silently truncated, because truncation
  systematically favors the company.
- **Timezone America/New_York** for week boundaries, day-clock resets, and DST.
- **Floor-true-up alarm:** if more than a set share of jobs or dollars in a week
  needed a base-floor top-up, the digest flags it loudly and the pay flip is
  held. Production rates are guesses; this is the wire that trips when the
  guesses are wrong, instead of the company quietly bleeding every week.
- Runs silently alongside hourly pay and powers the weekly economics block.

**Known failure list to test before code:** integer cents and rounding
direction; remainder-cent ownership; partial crews; a person on two jobs the same
day; overlapping or orphaned entries; multi-day jobs crossing the weekly
boundary; zero-BH jobs; **jobs completed with zero clocked hours** (division by
zero); unapproved entries; edits after a period is paid; cancelled or refunded
jobs; discounts and comps after approval; travel double-count; sales tax leaking
into labor revenue; floor true-up interacting with overtime; the labor-% dial
changing mid-period (the rate in effect when the job was WORKED governs).

### Phase 5: the motivation loop

- Operations Hub my-stats (hours, efficiency, provisional vs earned pay),
  leaderboard, bot nudges.
- **Every surface respects the provisional/earned gate from A3.** This is the
  legal constraint made visible; it is not a copy tweak.
- Ships during shadow mode so the crew sees the upside before the flip.

### Phase 6: guardrails and the pay flip

- Yellow slip records with **evidence and a response step**: a photo or note
  attaches, the named crew member sees it and can respond before it finalizes.
  With daily rotating assignment, attribution is genuinely ambiguous, and
  "decision final" with no evidence trail will not survive contact with a real
  dispute.
- Training bonus (+$4/hr for the trainer on days paired with a new hire, manager
  approved). Referral bonus as a manual adjustment row.
- **Written comp plan issued and signed before the flip** (A3 condition 1).
- **NY Wage Theft Prevention Act pay-rate notice** to each crew member before
  their individual pay flip, in their primary language. Changing someone's pay
  basis from hourly to performance-based triggers this. Not optional, and not in
  the original plan at all.
  [NY DOL Notice of Pay Rate](https://dol.ny.gov/notice-pay-rate).
- **Pay-stub field check:** the weekly export must carry what NY requires on a
  stub (rate AND basis of pay, gross, itemized deductions and allowances, dates
  covered, employer details) before it becomes the actual stub.
- **Pay-mode flag is a real field** on `crew_members` (per person) plus a global
  switch, named now so Phase 6 does not invent it under deadline pressure. That
  flag IS the rollback lever: flip back to hourly, the shadow ledger keeps
  recording either way.

**Out of scope:** profit sharing (later season), the yard-sign/door-hanger team,
route optimization (YLL runs 1-3 jobs a day, not 12-stop mow routes), GHL changes.

## A6. Open items

**Needs Naldo (product decisions, none block starting Phase 1):**

1. **Weather and no-work days.** Shop time is protected at base rate; a rained-out
   day currently has no stated floor. Outdoor work, Sept to Jan, Long Island.
   Needs a rule before the season.
2. **Clock-gate override.** The gate makes the bot a hard dependency for starting
   any job. Dead phone, no signal, phone left in the truck. One documented
   override path (a foreman override, or Jason clocks them in) before Phase 2.
3. **Backup approver** when Jason is out. He will be sick or away during the
   Sept-Dec crunch, and unapproved entries block weekly payroll.
4. **Off-season (Feb-Aug).** Are pools paused, does permanent-lighting work run
   under a different rule, does the crew revert to plain hourly automatically?
5. **Success metrics.** How does anyone know this worked? Nothing in the plan
   defines it. Candidates: efficiency trend, floor-top-up frequency, crew
   retention, hours captured without office correction, payroll time saved.
6. **Labor % starting dial:** 33% proposed for shadow mode.
7. **Takedown season start date** (recorded as about Jan 5 from a garbled voice
   answer).
8. **The fast-worker ceiling is a communication item, not a bug.** The pool
   splits by hours, so everyone on a job earns the same effective rate that day.
   A strong installer paired with a trainee cannot out-earn the trainee on that
   job. That is how P4P works, but if the crew discovers it on a bad paycheck
   instead of hearing it up front, it reads as a bait-and-switch. Say it in the
   rollout conversation.

**Needs a professional (before Phase 4 code and before the flip):**

9. **Employment attorney:** review the comp-plan wording that makes performance
   pay conditional (A3 condition 1). One document.
10. **Payroll provider or accountant:** the exact overtime regular-rate formula
    including performance pay (weighted-average vs supplemental-premium), how
    multi-day jobs crossing a week allocate, and whether the weekly export meets
    NY pay-stub content rules. Also worth asking: spread-of-hours pay, which
    applies when a workday spans more than 10 hours and could be triggered by
    drive time plus multi-job days.

**Needs a repo change:**

11. **AGENTS.md ownership row for Codex** with a named reviewer, before parallel
    work starts.
12. **Placeholder-rate recompute mechanism (flagged by the S57 wrap review's
    admin lens).** Every job created by Phase 1's `createJobFromQuote` wiring
    stamps `jobs.rates_are_placeholder = true` (only when an estimate was
    actually computed — a job with no estimate at all, e.g. missing geometry,
    gets `false`, since there's nothing placeholder about a number that was
    never computed). Nothing reads this flag today; it exists purely so a
    future pass can find and fix the jobs that used guessed production
    rates once the Jason seed-rates session (A7 item 2) produces real ones.
    Until that recompute pass is built, the manual query is:
    `select id, quote_id, budgeted_hours, labor_revenue_cents from jobs
    where rates_are_placeholder = true order by created_at`. This item is the
    actual follow-up; the flag by itself does nothing.
13. **DECIDED 2026-08-11 (Naldo, S58) — accepted risk, closed. Do not
    re-open.** Real crew wage data (SonSon, Little James, Big James, Jason
    Balroop's hourly rates) is committed in plaintext, permanently, in
    `migrations/2026-08-07-crew-members.sql` and its git history. Naldo's
    ruling: leave it as is and write down what that accepts. It was raised
    twice during S57 (at the PR #712 review and again at the wrap review)
    with no decision, and asked a third time at the start of S58.

    **The reasoning:** private repo, small team, and comparable data already
    sits in Copilot CRM today. The exposure is not worth the cost of moving
    it.

    **What is being accepted, stated plainly so nobody has to rediscover it:**

    - Anyone with read access to this repository can see every crew member's
      hourly wage. That is both devs, any assistant session either dev runs,
      and anyone either of them grants access to later.
    - Anyone who has ever cloned this repository already has the values on
      their disk, including clones made before this decision.
    - Git history retains the values permanently. Deleting or editing the
      migration file changes nothing about that — the original blob stays
      reachable in history, so a later "let's just take it out" edit would
      look like a fix without being one.
    - Scrubbing history is the only thing that would actually remove them,
      and it was considered and rejected: it rewrites every commit hash,
      breaks every open PR and every existing clone, and buys little given
      the access list above.
    - Any host the repository is mirrored to inherits the same exposure. This
      matters most if the repo is ever made public or handed to an outside
      contractor. **That is the one condition that should reopen this
      decision** — not a general re-litigation, but specifically a change in
      who can read the repo.

    **Forward-looking preference, not a blocker:** future rate seeding is
    better done as an out-of-band admin action than as a tracked migration
    file, since new rows would otherwise widen this same exposure. That is a
    preference for new work, not a reason to revisit the rows already
    committed.

## A7. Immediate next actions

1. DONE 2026-08-06: standing weekly reminder created (cloud routine "P4P weekly
   economics check", Mondays 9am ET, quiet until Sept 28). Retire it once the
   digest block ships. **Note:** Phase 4 lands during October, so the first few
   firings have no computed numbers to review. Either accept that or pull a
   minimal Phase 1-2 query into the reminder.
2. Naldo + Jason estimate session for seed production rates AND the per-category
   labor percentages. One sitting, both outputs. **Put a date on it**; Phase 1
   gates on it and Phase 1 gates the Sept 21 target.
3. Get Codex's hub plan doc into the repo, then write
   `docs/context/OPERATIONS_HUB_CONTRACT.md` from both plans and mirror a pointer
   into `yll-call-copilot/docs/`.
4. Ledger row for the initiative and per-phase rows when building starts.
5. Phase 1 build brief once seed rates exist (Naldo's go).
6. Copilot cancellation: after Phases 2 AND 3 are both live and have run clean in
   the field for two weeks. Before cancelling, confirm nobody uses its reports,
   QuickBooks sync, or customer portal.

## A8. What the hub needs from the quote tool (draft API surface)

Starting list for the contract doc, so Codex has something concrete to react to.
All endpoints token-authed, all added to `operatorGate`'s allowlist in the same
PR that creates them, all verified logged-out.

| Endpoint | Purpose | Phase |
|---|---|---|
| `GET /api/ops/me/day` | today's assigned jobs; empty until clocked in | 2-3 |
| `POST /api/ops/clock/in` / `clock/out` | day clock, mirrors the bot | 2 |
| `POST /api/ops/jobs/{id}/start` / `stop` | per-job clock | 2 |
| `GET /api/ops/me/hours` | this week's entries, approved vs pending | 2 |
| `GET /api/ops/me/stats` | efficiency, budgeted vs actual, effective hourly | 4-5 |
| `GET /api/ops/me/earnings` | breakdown: base, pool share, floor true-up, bonuses, **provisional vs earned** | 4-6 |
| `GET /api/ops/leaderboard` | crew-wide efficiency board | 5 |
| `GET /api/ops/schedule` | week view if the hub renders it | 3 |

**Non-negotiables for the contract doc:**

- **Identity:** `crew_members` (Phase 1) holds the quote-tool id, the Telegram
  user id, and the hub's auth id. One mapping table, one owner.
- **The clock gate is enforced server-side on every request**, against one
  canonical state (an open `job_time_entries` row), never a cached hub session
  flag. Office/admin exemption is a role check on the same endpoint, not a
  client-side branch. Two databases means a stale hub session must not be able to
  read the schedule with the clock stopped.
- **Idempotency** on every mutating endpoint.
- **`me/earnings` must return provisional and earned separately** and the hub
  must render them differently (A3 condition 3).

---

# PART B: THE RECON (2026-08-06)

## B1. The P4P system in plain English

Pay crews a share of labor revenue instead of pure hourly. Faster work means a
higher effective hourly rate. Slower work means less, but never below a base
floor.

- **Budgeted Hours (BH):** estimated labor hours for a job. 3 guys x 2 hours = 6 BH.
- **Labor revenue:** the labor portion of what the customer pays, not materials.
- **Team pool:** labor revenue x a set percent. The handout template uses 33%
  (40% in peak season for maintenance routes).
- **Split:** the pool divides among the crew by hours worked on the job.
- **Effective hourly rate:** your share divided by your actual hours. Example:
  $500 labor, 33% = $165 pool, budget 6 BH. Crew finishes in 4.5 hours:
  $36.67/hr instead of $27.50 at budget pace.
- **Base pay floor:** pay-period average never falls below base rate; the company
  tops it up.
- **Efficiency:** BH vs actual. Over 100% means beat the budget.

Guardrail policies from Naldo's 2-page handout (the lawn-care template):
yellow slips, damage cases, multi-day jobs paying base until complete,
non-billable hours at base with manager approval, training bonus +$4/hr, $1.50
per BH on jobs over 49 BH, $50 referral bonus, 10% quarterly profit sharing,
owner settles grey areas. **Note:** the handout's deduction mechanics were
rewritten for NY law, see A3.

## B2. What Copilot/Homeworks has, and what YLL actually uses

Walked logged-in, read-only, 2026-08-06.

**In actual use:** Jason's daily clock-in/out since January (135 entries,
category "General Work", never tied to a job; clock-in required before the
calendar opens). Historical: 188 estimates from the pre-quote-tool era (lines
carry a Budgeted Hours column, e.g. a July 4 event estimate at $2,040 / 8.75 BH)
and the full 57-item catalog.

**Built in but never configured:** the per-item "Rate Charged to Client (for
P4P)" field ($0.00 on every YLL item), crews (none created), BH capacity
planning (all zeros), Labor Efficiency (shows "-").

**Employee profiles:** compensation rate, daily BH capacity 8, weekly BH
capacity, office-exclusion flag.

**Feature map:** My Day, KPI Cockpit (time to close, close ratio, lead response,
labor efficiency, effective $/hr, BH capacity, booked-out-until, revenue mix),
scheduler (calendar, dispatch board, waitlist, unscheduled work, routes), time
tracking (tracked/active/approve tabs, live map, add time, **auto clock-out at
midnight**, per-employee clock-in-required), invoices/estimates/payments/
expenses/level billing, reports (revenue by crew/city/county/customer, P&L, AR
aging, forecast), automations, visit forms, upsells, QuickBooks sync, customer
portal. Scheduler pages are gated behind clocking in, so they were read from nav
and docs rather than driven (clocking in would have created a real time entry).

## B3. P4P Software

Separate product from the CRM. $99/mo up to 5 users, $199/mo unlimited, **30-day
free trial**, free implementation. One-way integration FROM Homeworks. It is the
payroll math engine: per-job clock vs BH, efficiency, effective hourly, payroll
export for QuickBooks/Gusto, base-floor enforcement, yellow slips, manual
adjustments, overtime, leaderboards, maintenance vs project modes, routing. P4P
University (free) covers the method on video including rate setting.
**Verdict: do not pay the $100.** Free trial plus free university plus the
handout plus Naldo's own Copilot account cover everything; take the free month
only if a math question survives all that, ideally during Phase 4.

## B4. What the quote tool had at recon time

- Labor and time tracking: nothing. Crew assignment: nothing. Crew pay: nothing.
- Scheduling: `jobs.install_date` only, synced one-way from Copilot via Zapier
  (#84).
- Labor revenue: not split out; the separate labor pricing tier was removed
  (#17); all rates blended (per-foot roofline $8/$10/$12 by difficulty, per-item
  everything else).
- Hooks that exist: job lifecycle (to_schedule, scheduled, installed,
  requires_invoicing, done, completed_at), the crew Telegram bot (bot_users
  roles, completeInstall with material actuals and photos, captureLead, status,
  audit log), material actuals per job, the morning digest, and the design editor
  that knows exact footage and item counts. That last one is the unfair
  advantage: BH can be derived from geometry instead of hand-typed the way
  Copilot requires.

## B5. Sources

- Live walk of secure.copilotcrm.com (KPI Cockpit, Time Tracking + Settings,
  Employees + all profiles, Crews, Items and Services + item detail, Estimates +
  estimate 189, Reports, Account Settings + Preferences).
- p4psoftware.com home, /pricing, /faq (features page 404s).
- P4P University curriculum (free).
- Naldo's "2 Page Document for P4P" PDF.
- Codebase recon: pricing engine, jobs, Telegram bot, migrations, task ledger,
  #82 inventory doc.
- NY wage law: sources linked inline in A2, A3, A5, A6.

---

# PART C: THE REVIEW (2026-08-06)

Five independent adversarial reviewers read the plan: a crew member, the owner, a
staff engineer, a money-and-compliance lens, and a completeness critic. Kept here
so the reasoning behind each correction survives.

## C1. Findings fixed in the plan

| # | Lens(es) | Finding | Where fixed |
|---|---|---|---|
| 1 | Money, Crew | Yellow-slip and damage deductions from performance pay likely violate NY §193 even with consent | A3, rewritten as forfeiture of unearned pay with a 7-day window and a state machine |
| 2 | Owner, Technical | Labor revenue frozen at quote approval, so discounts, comps, change orders, and non-payment overpay the crew | A5 Phase 1, recompute at invoice-final |
| 3 | Technical | `crew_members` was a footnote but Phases 2 and 4 depend on it; later introduction means migrating live payroll data | A5 Phase 1, ships there |
| 4 | Completeness, Crew | Weather and rain-outs absent entirely; they corrupt the shadow-mode learning signal, not just a paycheck | A5 Phase 2, `stoppage_reason` from day one; A6 item 1 for the pay rule |
| 5 | Owner | Base-floor true-up is uncapped exposure against guessed production rates | A5 Phase 4, floor-true-up alarm holds the flip |
| 6 | Technical | Clock gate spans two databases with no named arbiter; a cached hub session could read the schedule | A8 non-negotiables, server-side check per request |
| 7 | Technical | No idempotency on clock endpoints feeding pay math | A5 Phase 2, A8 |
| 8 | Technical | Rework against a terminal `done` job had no rule | A5 Phase 2 |
| 9 | Money | No integer-cents mandate, no rounding direction, no remainder-cent owner | A5 Phase 4, remainder to the crew |
| 10 | Money, Technical | Timezone never stated for week boundaries or DST | A2, A5 Phase 4 |
| 11 | Money | Sales tax could leak into labor revenue | A5 Phase 1 |
| 12 | Money | Travel time could double-count (clock plus BH allowance) | A2, A5 Phase 2 |
| 13 | Money | Jobs completed with zero clocked hours divide by zero | A5 Phase 4 failure list |
| 14 | Money | Edits after payroll ran had no lock or reconciliation | A5 Phase 2 |
| 15 | Money, Completeness | Post-edit audit trail absent; NY requires six-year accurate records | A5 Phase 2, append-only |
| 16 | Completeness | Copilot's auto clock-out at midnight silently dropped | A5 Phase 2 |
| 17 | Owner, Completeness | Copilot cancelled after Phase 2, but Phase 3 replaces its calendar | A2, A7 item 6, gated on both plus two clean weeks |
| 18 | Money | WTPA pay-rate notice required when pay basis changes; absent | A5 Phase 6 |
| 19 | Money | Weekly export not checked against NY pay-stub content rules | A5 Phase 6, A6 item 10 |
| 20 | Technical | AGENTS.md has no ownership row for Codex, no named reviewer | A4, A6 item 11 |
| 21 | Technical | Two assistants could race the first migration on the same tables | A4, single migration author |
| 22 | Technical | Rollback lever named in prose but no field | A5 Phase 6, pay-mode flag on `crew_members` |
| 23 | Technical | Unmapped item categories would silently compute $0 labor revenue | A5 Phase 1, conservative defaults |
| 24 | Technical | Phase 3 capacity needs assignment that Phase 3 itself builds | A5 Phase 3, derivation stated |
| 25 | Crew | Yellow-slip attribution has no evidence step or right of response, with rotating daily crews | A5 Phase 6 |
| 26 | Crew | Language option covered navigation, not the earnings text a crew member needs to verify pay | A2 |
| 27 | Owner, Completeness | Weekly reminder fires before Phase 4 computes anything | A7 item 1 |
| 28 | Owner | Seed-rates session gates the hard date but had no date | A7 item 2 |
| 29 | Money | Labor-% dial could change mid-period | A5 Phase 4, rate when WORKED governs |

## C2. Findings recorded as open decisions, not fixed

Weather pay rule, clock-gate override, backup approver, off-season behavior,
success metrics, takedown date: all in A6. The fast-worker ceiling (A6 item 8) is
real but inherent to P4P; it is a rollout-communication item.

## C3. Findings acknowledged and deliberately deferred by Naldo

The below-minimum-wage rates (SonSon $16, Jason $10 vs the $17.00 Long Island
floor since Jan 1 2026) were flagged by two independent lenses as a live issue
separate from P4P. Naldo's call on 2026-08-06: not a concern at this time.
Recorded in A2, not raised again, and the engine treats the base floor as a
per-person configurable value so the math follows whatever the rates become.

## C4. What survived clean

Shadow-mode-before-money sequencing. Data phases before pay phases. The rollback
lever named rather than assumed. The `operatorGate` allowlist requirement carried
with its prod-incident precedent. The per-person earnings breakdown as a
checkable receipt. Test-first money code with an enumerated failure list.
