# P4P labor tracking + operations: the plan (finalized draft) and the recon behind it

> Written 2026-08-06 for Naldo. Two parts. Part A is the plan, locked from Naldo's
> answers in the 2026-08-06 Q&A rounds. Part B is the recon it was built on (the P4P
> system, Copilot/Homeworks, P4P Software, the codebase). Living doc for the
> initiative. Related: `project_inventory_system.md` (#82, kanban + materials) and
> the yll-call-copilot repo (the future YLL Operations Hub).

---

# PART A: THE PLAN

## A1. What we are building, one paragraph

The quote tool becomes the operations system: budgeted hours computed from each
job's real design geometry, a crew time clock tied to jobs, a full scheduling
calendar, and the P4P pay engine (labor-revenue pool, base-pay floor, efficiency,
weekly payroll breakdown). Copilot CRM retires once parity ships. Crew-facing
screens land in the YLL Operations Hub (the yll-call-copilot repo), which reads
from the quote tool. Pay runs in shadow mode first: everyone stays on hourly while
the numbers prove themselves, then the switch flips.

## A2. Locked decisions (from Naldo, 2026-08-06)

| Decision | Call |
|---|---|
| System of record | Quote tool. Copilot retires after parity (it is only used for Jason's clock today). |
| Scheduling | FULL calendar in the quote tool: drag-drop, crew assignment, capacity from budgeted hours, dispatch view. |
| Time clock | All three, phased: (1) Telegram bot per-job clock, (2) day-clock with office review/split, (3) web clock inside the Operations Hub later. Office reviews and approves entries. |
| Labor revenue on blended prices | Per-category labor % (roofline X%, wreaths Y%, ...). Engine already itemizes every job. |
| Labor revenue % to the team | UNKNOWN on purpose. Naldo does not know the business's number yet. Shadow mode measures it; a weekly in-season review ritual sets and tunes it. See A4. |
| Rollout | Shadow mode first. Crew stays hourly, sees the would-be P4P numbers, pay flips only when trusted. |
| Drive time | Counts toward job hours (Naldo's call). Matches P4P practice: the clock runs door to door and the day's budgeted hours include windshield time, which is why route density matters in the lawn version. For YLL, each job's BH gets a travel allowance; shadow mode calibrates it. |
| Pay period | Weekly. Payroll is mostly manual today; automating the breakdown is a goal of this build. |
| Production rates | Never tracked before. Seed from a one-sitting estimate session with Jason, then calibrate from shadow-mode actuals. Past history cannot supply them (no job-level hours exist anywhere, Copilot's clock was never job-linked). |
| Guardrails, season 1 | Yellow slips YES, damage deductions YES, training bonus YES. Profit sharing NOT season 1. Referral bonuses: cheap to include (a manual bonus row), in unless Naldo says drop. |
| Pool membership | Install team (SonSon, Little James, Big James). Jason's status TBD (office manager; today he is the only one clocking in). |
| Takedown | OPEN. Naldo has not designed this yet. Options in A6. |

**Base rates.** Naldo's numbers vs what Copilot profiles actually say (verified
2026-08-06 on each employee profile):

| Person | Naldo said | Copilot profile | Note |
|---|---|---|---|
| SonSon | $16/hr | $16.00 | match |
| Little James | $17/hr | $16.00 | mismatch, reconcile |
| Big James | "$20-something" | $20.00 | match |
| Jason | $8/hr | $10.00 | mismatch, reconcile |

**Compliance flag, not optional:** Long Island minimum wage is **$17.00/hr as of
Jan 1, 2026** (NYC/LI/Westchester tier). Overtime is 1.5x after 40 hours, and NY
counts performance pay/commissions in the regular rate when computing OT. So the
P4P base-pay floor for the install crew must be at least $17.00, which means the
$16 rates above are below the legal hourly floor and need attention regardless of
P4P. Payroll is manual today; before the first real P4P paycheck, have an
accountant or payroll provider bless the formula. Sources:
[NY DOL 2026 increase](https://www.governor.ny.gov/news/money-your-pockets-governor-hochul-reminds-new-yorkers-minimum-wage-increase-january-1),
[Proskauer 2026 summary](https://www.proskauer.com/blog/new-york-state-minimum-wage-and-exempt-salary-updates-for-2026).

## A3. The ecosystem split (stated assumption, correct me if wrong)

- **Quote tool (this repo):** system of record and the engine. Tables, BH math,
  labor-revenue math, pay math, scheduling data, office admin screens, the
  Telegram bot, APIs for the hub.
- **YLL Operations Hub (yll-call-copilot repo, being built in another session):**
  the crew- and office-facing app. Crew clock-in page, my-hours, my-efficiency,
  my-P4P-earnings. Also call tracking and, later, the yard-sign/door-hanger team
  (explicitly out of scope here).
- **GHL:** stays the CRM for leads/comms. Untouched by this build.

## A4. The learning loop (because the numbers are unknown)

Naldo said it straight: he does not know the labor %, the production rates, or
really any of the labor economics yet. The plan treats that as a feature. Shadow
mode is the instrument:

1. Ship BH + time capture BEFORE pay changes. Every job accumulates: budgeted
   hours, actual hours, labor revenue at the configured %, would-be pool, would-be
   effective hourly per person, vs what hourly actually cost.
2. **Weekly in-season review ritual (Naldo asked for this reminder):** once the
   season starts, every week the morning digest carries a P4P economics block:
   last week's efficiency by person, implied labor % (what % of labor revenue
   hourly pay actually consumed), would-be P4P pay vs actual hourly pay, BH
   accuracy by item category. Naldo + Jason look at it and turn the dials.
   Until the digest block ships, the reminder runs as a standing weekly scheduled
   reminder (see A7 item 1).
3. Rates converge, trust builds, THEN the pay switch flips (per person or whole
   crew at once, Naldo's call at the time).

## A5. Build phases

Ordered so shadow data starts flowing before the season, and money math ships
last. Each phase shippable alone, gates green, normal PR flow.

**Phase 1: budgeted hours + labor revenue on every job.**
Per-category labor % and production rates (ft per man-hour by roofline difficulty,
minutes per wreath/garland/spritzer/tree/stake-ft/bistro-ft, plus a per-job travel
allowance) go into BUSINESS_RULES. On quote approval the job stores
`budgeted_hours` and `labor_revenue_cents` computed from the design's real items.
Office can override BH per job (the S24 rule: seeded numbers stay editable).
Inputs needed first: the Jason estimate session for seed rates.

**Phase 2: time capture.**
`job_time_entries` (job, person, start, stop, source, approved_by). Telegram bot:
per-job start/stop plus plain day clock-in/out. Office screen: review, edit,
split a day across jobs, approve. This replaces Jason's Copilot habit. Manual add
for forgot-to-clock. From this point shadow data accumulates.

**Phase 3: scheduling, full calendar.**
Crew assignment on jobs, drag-drop week/month calendar, unscheduled-work list,
capacity view driven by BH per person per day (Copilot's model: daily BH capacity,
booked-out-until), dispatch/day view. Install dates stop syncing from Copilot;
the Zapier feed (#84) retires. This is the biggest UI phase and can overlap
Phase 2 (different surfaces).

**Phase 4: the P4P engine, shadow mode.**
Test-first, money code. Per job: efficiency (BH vs actual). Per week per person:
pool share by hours, base floor true-up at max(base rate, $17.00), OT at 1.5x on
a regular rate that includes performance pay, non-billable hours at base, the
weekly payroll breakdown export (CSV). Runs silently alongside hourly pay; powers
the digest economics block (A4). Known failure list to test before code:
integer cents, rounding direction, partial crews, multi-day jobs crossing the
weekly boundary (template rule: base during, performance dollars on completion),
floor true-up interacting with OT, zero-BH jobs, unapproved time entries.

**Phase 5: the motivation loop.**
Crew-visible surfaces: Operations Hub my-stats page (hours, efficiency, would-be
then real P4P earnings), leaderboard, bot nudges ("yesterday 118%, effective
$26.40/hr"). Digest lines for the office. This is the piece that changes behavior;
it ships while still in shadow mode so the crew sees the upside before the switch.

**Phase 6: guardrails + the pay flip.**
Yellow slips (rework record; fixer's hours debit the guilty member's performance
dollars, never base, one pay period max), damage cases (same debit rule),
training bonus (+$4/hr for the trainer on days paired with a new hire, manager
approved), manual adjustment rows (referral bonus lives here). Then, when Naldo
calls it: flip from shadow to live pay. Rollback lever: flip back to hourly, the
shadow ledger keeps recording either way.

**Explicitly out of scope:** profit sharing (later season), yard-sign/door-hanger
team (separate initiative), routes/multi-stop optimization (YLL runs 1-3 jobs a
day, not 12-stop mow routes), GHL changes.

## A6. Open items (the short list that remains)

1. **Takedown design.** Not thought through yet (Naldo). Options when ready:
   (a) hold back a fixed slice of the job's labor revenue (say 15-20%) for the
   takedown visit's pool, or (b) auto-create a takedown job with its own BH and
   labor revenue at season end. Leaning (b) for clean per-visit efficiency, but
   this is Naldo's call and blocks nothing until Phase 4.
2. **Labor % starting value.** Shadow mode needs SOME number to display. Proposal:
   start the dial at the template's 33% and let the weekly ritual move it. Costs
   nothing while shadow.
3. **Jason in the pool or not.** Decide by Phase 4.
4. **Rate reconciliation.** Little James 16 vs 17, Jason 8 vs 10, and the $17.00
   legal floor. One conversation with the payroll/accountant.
5. **Referral bonus in season 1:** in unless Naldo drops it (manual row, trivial).

## A7. Immediate next actions

1. Standing weekly reminder for the in-season economics check (Naldo requested).
   Set as a scheduled weekly reminder starting late September, retired once the
   digest block (Phase 4) replaces it.
2. Naldo + Jason estimate session for seed production rates (Phase 1 input).
   Can run any time; one sitting.
3. Ledger row for the initiative + phase rows when building starts.
4. Phase 1 build brief once seed rates exist.

---

# PART B: THE RECON (2026-08-06, unchanged from the first pass)

## B1. The P4P system in plain English

Pay crews a share of labor revenue instead of pure hourly. Faster work means a
higher effective hourly rate. Slower work means less, but never below a base floor.

The core math:

- **Budgeted Hours (BH):** estimated labor hours for a job. 3 guys x 2 hours = 6 BH.
- **Labor revenue:** the labor portion of what the customer pays (not materials).
- **Team pool:** labor revenue x a set percent. The handout template uses 33%
  (40% in peak season for maintenance routes).
- **Split:** the pool divides among the crew, normally by hours worked on the job.
- **Effective hourly rate:** your share of the pool divided by your actual hours.
  Example: $500 labor, 33% = $165 pool. Budget 6 BH. Crew finishes in 4.5 actual
  hours: $165 / 4.5 = $36.67/hr, instead of $27.50 at budget pace.
- **Base pay floor:** pay-period average can never fall below base rate. If
  performance pay comes out lower, the company tops it up.
- **Efficiency:** BH vs actual hours. Over 100% means beat the budget.

The guardrail policies (from Naldo's 2-page handout):

- **Yellow slips (quality):** guilty crew member returns to fix the job unpaid, or
  the fixer's hourly cost is deducted from the guilty member's performance pay.
  Recorded on the employee profile. This stops rushing.
- **Damage cases:** cost comes out of performance dollars only (never base pay),
  one pay period max.
- **Multi-day jobs crossing a pay period:** pay base during, allocate performance
  dollars after the job completes.
- **Non-billable hours** (shop time, maintenance): base rate, manager approval.
- **Bonuses:** training a new hire +$4/hr; jobs at/over 49 BH get $1.50 per BH
  split by the office manager; $50 referral bonus; 10% quarterly profit sharing
  with attendance rules.
- **Grey areas:** owner/manager decides splits, decision final.

## B2. What Copilot/Homeworks has (and what YLL actually uses in it)

Naldo's account walked logged-in, read-only, 2026-08-06.

**In actual use:** Jason's daily clock-in/out since January (135 entries, category
"General Work", never tied to a job; clock-in required before the calendar opens).
Historical: 188 estimates (pre-quote-tool era, per Naldo; estimate lines carry a
Budgeted Hours column, e.g. the July 4 event estimate: $2,040 line, 8.75 BH), and
the full 57-item catalog with prices.

**Built in but never configured:** the per-item "Rate Charged to Client (for P4P)"
field (the labor-revenue portion; $0.00 on every YLL item), crews (none), BH
capacity planning (all zeros), Labor Efficiency (shows "-").

**Employee profiles:** compensation rate ($/hr), daily BH capacity 8, weekly BH
capacity, office-exclusion flag for capacity math.

**Feature map for reference:** My Day, KPI Cockpit (time to close, close ratio,
lead response, labor efficiency, effective $/hr, BH capacity, booked-out-until,
revenue mix), scheduler (calendar, dispatch board, waitlist, unscheduled work,
routes), time tracking (tracked/active/approve tabs, live map, add time, auto
clock-out at midnight, per-employee clock-in-required), invoices/estimates/
payments/expenses/level billing, reports (revenue by crew/city/county/customer,
P&L, AR aging, forecast), automations, visit forms, upsells, QuickBooks sync,
customer portal. Scheduler pages are gated behind clocking in, so they were read
from nav and docs, not driven (clocking in would have created a real time entry).

## B3. What P4P Software adds on top

Separate product from the CRM. $99/mo up to 5 users, $199/mo unlimited, **30-day
free trial**, free implementation and training. One-way integration FROM Homeworks
(customers + employee time clocks). It is the payroll math engine: per-job clock
vs BH, efficiency, effective hourly, payroll-period breakdown export (works with
QuickBooks/Gusto), base-floor enforcement, yellow slips, damage deductions from
performance pay only, manual adjustments, overtime handling, leaderboards,
maintenance vs project modes, routing. P4P University (free,
mikeandes.teachable.com/p/p4p-university) covers the whole method on video,
including rate setting (labor revenue %, variable %, base pay rate) and team
rollout. **Verdict: do not pay the $100.** Free trial + free university + the
handout + Naldo's own Copilot account cover everything; take the free month only
if a math question survives all that, ideally during Phase 4.

## B4. What the quote tool had at recon time

- Labor/time tracking: nothing. Crew assignment: nothing. Crew pay: nothing.
- Scheduling: `jobs.install_date` only, synced one-way FROM Copilot via Zapier
  (#84). Retires in Phase 3.
- Labor revenue: not split out; the separate labor pricing tier was removed (#17);
  all rates blended (per-foot roofline $8/$10/$12 by difficulty, per-item
  everything else).
- Useful hooks that exist: job lifecycle (to_schedule, scheduled, installed,
  requires_invoicing, done, completed_at), the crew Telegram bot (bot_users roles,
  completeInstall with material actuals + photos, captureLead, status, audit log),
  material actuals per job, the morning digest, and the design editor that knows
  exact footage and item counts per job. That last one is the unfair advantage:
  BH can be DERIVED from geometry instead of hand-typed like Copilot requires.

## B5. Sources

- Live walk of secure.copilotcrm.com (KPI Cockpit, Time Tracking + Settings,
  Employees + all 4 profiles, Crews, Items and Services + item detail, Estimates
  + estimate 189, Reports, Account Settings + Preferences).
- p4psoftware.com home, /pricing, /faq (features page 404s).
- P4P University curriculum (free).
- Naldo's "2 Page Document for P4P" PDF (the policy template in B1).
- Codebase recon: pricing engine, jobs, Telegram bot, migrations, task ledger,
  #82 inventory doc.
- NY wage law: NY DOL / Proskauer 2026 summaries (links in A2).
