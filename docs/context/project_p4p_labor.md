# P4P labor tracking: Copilot/Homeworks recon, gaps, and the build plan

> Written 2026-08-06 for Naldo. Goal: understand the Pay-For-Performance (P4P) system,
> learn everything Copilot CRM (now "Homeworks", by Mike Andes) and P4P Software do,
> compare against the quote tool, and lay out what we build so the quote tool has its
> own version. Sources: Naldo's live Copilot account (driven logged-in, read-only),
> p4psoftware.com (pricing + FAQ), the free P4P University curriculum, the 2-page P4P
> handout PDF, and a full recon of this codebase.

## 1. The P4P system in plain English

Pay crews a share of labor revenue instead of pure hourly. Faster work means a higher
effective hourly rate. Slower work means less, but never below a base floor.

The core math:

- **Budgeted Hours (BH):** estimated labor hours for a job. 3 guys x 2 hours = 6 BH.
- **Labor revenue:** the labor portion of what the customer pays (not materials).
- **Team pool:** labor revenue x a set percent. The handout template uses 33%
  (40% in peak season for maintenance routes).
- **Split:** the pool divides among the crew, normally by hours worked on the job.
- **Effective hourly rate:** your share of the pool divided by your actual hours.
  Beat the budget, rate goes up. Example: $500 labor, 33% = $165 pool. Budget 6 BH.
  Crew finishes in 4.5 actual hours: $165 / 4.5 = $36.67/hr split-adjusted, instead
  of $27.50 at budget pace.
- **Base pay floor:** pay-period average can never fall below base rate ($18/hr in
  the template). If performance pay comes out lower, the company tops it up.
- **Efficiency:** BH vs actual hours. Over 100% means beat the budget.

The guardrail policies (from the 2-pager):

- **Yellow slips (quality):** guilty crew member returns to fix the job unpaid, or the
  fixer's hourly cost is deducted from the guilty member's performance pay. Recorded
  on the employee profile. This stops rushing.
- **Damage cases:** cost comes out of performance dollars only (never base pay), one
  pay period max.
- **Multi-day jobs crossing a pay period:** pay base during, allocate performance
  dollars after the job completes.
- **Non-billable hours** (shop time, maintenance): base rate, needs manager approval.
- **Bonuses:** training a new hire +$4/hr; jobs at/over 49 BH get $1.50 per BH split
  by the office manager; $50 referral bonus; 10% quarterly profit sharing with
  attendance rules.
- **Grey areas:** owner/manager decides splits, decision final.

## 2. What Copilot/Homeworks has (and what YLL already uses in it)

Naldo's account is live and partially in use. Real findings from the logged-in walk:

**Already in active use:**
- **Time clock:** Jason Balroop has clocked in/out nearly every workday since January.
  135 entries, 203 hours in the current view, all category "General Work" (never tied
  to a job). Clock-in is required before the calendar opens, for all 5 employees.
- **Estimates:** 188 estimates live in Copilot (21 pending, 12 accepted). Estimate
  line items carry a **Budgeted Hours column** (example: the July 4 event estimate,
  $2,040 line, 8.75 BH). So YLL is quoting in two systems today: Copilot and the
  quote tool.
- **Product catalog:** all 57 YLL items (spritzers, wreaths, garland, bistro) exist
  in Copilot with prices and marketing descriptions.
- **Employees:** all 5 set up (SonSon, Jason, Little James, Big James, Naldo), with
  compensation rate ($20/hr on the install team profile checked) and a daily BH
  capacity of 8.

**Built in but NOT configured:**
- **The P4P rate per item.** Every item has two prices: "Rate Charged on Estimates"
  (what the customer sees) and "Rate Charged to Client (for P4P)" (the labor-revenue
  portion that feeds crew pay). Every YLL item has the P4P rate at $0.00. This is the
  single switch that would turn on labor-revenue tracking in Copilot, and it was
  never set.
- **Crews:** zero crews created, so no crew assignment or Revenue-by-Crew reporting.
- **BH capacity planning:** KPI Cockpit shows # of BH/Employees 0, BH per week
  capacity 0, booked-out-for empty. Labor Efficiency shows "-" (no job-linked time).

**The rest of the feature map** (for completeness): My Day, KPI Cockpit (time to
close, close ratio, lead response, labor efficiency, effective $/hr, booked-out
runway, revenue mix), scheduler (week/month calendar, dispatch board, routes,
waitlist, unscheduled work), time tracking (tracked/active/approve tabs, live map,
add time, approval flow, auto clock-out at midnight), invoices, payments, expenses,
level billing, reports (revenue by crew/city/county/customer, P&L, AR aging, revenue
forecast), automations, visit forms, upsells, QuickBooks sync, customer portal.
Effective rate on the cockpit today: $33.03/hr (thin data).

## 3. What P4P Software adds on top

Separate product from the CRM. $99/mo up to 5 users, $199/mo unlimited,
**30-day free trial**, free implementation and training. One-way integration FROM
Homeworks (customers + employee time clocks flow in). It is the payroll math engine:

- Per-job time clock against budgeted hours, efficiency score, effective hourly rate.
- Payroll period reports (it is not payroll software; it exports the breakdown for
  QuickBooks/Gusto).
- Base-pay floor enforcement ("we use base pay to ensure each employee makes a bare
  minimum regardless of efficiency").
- Yellow slip tracking, damage deductions from performance pay only.
- Manual adjustments (bonuses, breaks, notes), overtime handling, leaderboards and
  crew notifications, maintenance mode vs project mode, simple/advanced routing.
- P4P University (free videos) covers rate-setting: labor revenue %, variable %,
  base pay rate, variable base rate, plus rollout scripts for the team.

## 4. What the quote tool has today (recon of the codebase)

- **Labor/time tracking: nothing.** No hours fields, no clock in/out, no timesheets.
- **Crew assignment: nothing.** No link between jobs and people.
- **Scheduling: deliberately out of the tool.** `jobs.install_date` syncs one-way
  FROM Homeworks via Zapier (#84). The two systems are already wired.
- **Labor revenue: not split out.** The pricing engine retired its separate labor
  tier (#17). Prices are per-foot roofline ($8/$10/$12 by difficulty), per-foot
  stake, per-item spritzers/wreaths/garland, flat fees. Labor and materials are
  blended in every rate.
- **Crew pay: nothing.** No rates, no commission, no payroll anywhere.
- **What DOES exist and helps:** job lifecycle (to_schedule, scheduled, installed,
  requires_invoicing, done, with completed_at), the crew Telegram bot (roles table,
  completeInstall with material actuals + photos, captureLead, status, full audit
  log), material actuals per job, the morning digest, and the design editor that
  knows exact footage and item counts per job.

## 5. The gap map

| Capability | Copilot/Homeworks | P4P Software | Quote tool |
|---|---|---|---|
| Time clock (clock in/out) | Yes, in use daily | Yes, per job | None |
| Time tied to a job | Yes (visits) | Yes | None |
| Budgeted hours per job | Yes (estimate lines) | Yes | None |
| Labor revenue split from price | Yes (P4P rate per item, unconfigured) | Yes | None (blended rates) |
| Efficiency / effective $/hr | Yes (cockpit) | Yes, core feature | None |
| Crew pay calc + payroll export | No (P4P does it) | Yes | None |
| Base-pay floor true-up | No | Yes | None |
| Yellow slips / deductions | Tag only | Yes | None |
| Leaderboards / crew notifications | Partial | Yes | None |
| Crew assignment | Yes (crews, dispatch) | Yes | None |
| Scheduling calendar | Yes, gated behind clock-in | Routes | Deliberately external (#84) |
| Quoting from a house design | No | No | Yes, the core strength |
| Auto-BH from measured footage | No (manual BH entry) | No | Not yet, but all inputs exist |
| Crew field reporting (materials, photos) | Visit forms | Partial | Yes (Telegram bot) |

The quote tool's unfair advantage: it already knows the geometry of every job
(footage, corners, wreath counts, difficulty). Copilot makes a human type budgeted
hours per estimate line. We can DERIVE budgeted hours from the design using
production rates (feet per man-hour by item type). Nobody else can do that.

## 6. Build plan: P4P inside the quote tool

Recommended shape, in order. Each phase is shippable alone.

**Phase 0, decisions on paper (Naldo, no code):** pick the labor revenue % (the
template's 33%? seasonal bump?), base rates per person, production rates (how many
feet of roofline per man-hour, per difficulty; minutes per wreath, spritzer, garland,
stake ft, bistro ft), and who is in the pool. One sitting with Jason.

**Phase 1, budgeted hours + labor revenue on every job:** add production rates and
per-category labor-revenue % to BUSINESS_RULES. At quote approval, compute and store
`budgeted_hours` and `labor_revenue_cents` on the job from the design's real items.
Show BH on the job. No behavior change anywhere else.

**Phase 2, crew time on the job via the Telegram bot:** crew already lives in the
bot. Add `startJob` / `stopJob` (or fold into completeInstall): job_time_entries
table (job, person, start, stop, source), office edit/approve screen. This replaces
the Copilot "General Work" clock with time tied to actual jobs. Keep it dumb and
forgiving: manual add for forgot-to-clock.

**Phase 3, the money math:** per job, efficiency = BH vs actual. Per pay period,
per person: pool share, base floor true-up, overtime, non-billable hours at base,
a payroll breakdown export (CSV for the payroll provider). Test-first: this is
money code, the failure list is known (rounding, partial crews, multi-day jobs
crossing periods, floor true-up, OT interaction).

**Phase 4, the motivation loop:** live effective $/hr on the job card, leaderboard,
morning digest lines (yesterday's efficiency by person), bot notifications ("you
ran 118% yesterday, effective $26.40/hr"). This is the piece that changes behavior.

**Phase 5, guardrails:** yellow slip records (rework debits performance pay, never
base), damage cases, training/big-job bonuses, profit-sharing tracker. Only after
the core loop is trusted.

**Compliance flag (real, not optional):** NY labor law still requires hourly
records, minimum wage per hour worked, and overtime at 1.5x the regular rate, and
the regular rate must INCLUDE performance pay when computing OT. The base-pay floor
must be the legal minimum or higher. Have the payroll provider or accountant bless
the formula before the first real P4P paycheck. P4P's own FAQ leans on exactly this
base-pay mechanism for legality.

## 7. The $100 question

**Do not pay yet.** Three reasons:

1. P4P Software has a **30-day free trial** (and a promo running). If we want to
   copy its payroll-report UX while building Phase 3, take the free month then.
2. P4P University is **free** and has the entire methodology on video, including
   the rate-setting math. The 2-pager already gives the policy template.
3. Naldo's own Copilot account already exposes the BH mechanics (estimate BH
   column, per-item P4P rate, capacity fields). The mechanism is not a mystery
   anymore; it is documented above.

Pay only if, mid-build, we hit a math question the free sources cannot answer.

## 8. The elephant: two systems are half in use

Today YLL runs the quote tool AND Copilot in parallel: 188 estimates, the daily
time clock, and the full catalog live in Copilot; quoting, portal, deposits, jobs,
and crew bot live in the quote tool, with install dates flowing Copilot -> quote
tool through Zapier. Double entry is real and the catalogs will drift.

Decision for Naldo (not made here): if the quote tool is the future, the P4P build
above replaces Copilot's clock and estimates over time, and Copilot winds down to
just scheduling (or eventually nothing). Until Phase 2 ships, keep using the
Copilot clock so the habit does not break. If instead Copilot is the future for
ops, the alternative is: set the per-item P4P rates in Copilot, create the crews,
make crew clock into visits instead of General Work, and pay $99/mo for P4P
Software. That path is faster to start but rents the capability forever and leaves
the quote tool's geometry advantage on the table.

## 9. Questions for Naldo (needed before Phase 1)

1. Labor revenue %: is 33% the number? Different for install vs takedown vs service
   calls? Seasonal bump like the template's 40%?
2. Base rates: per person today (the Copilot profile showed $20/hr for one
   installer; confirm the rest).
3. Production rates: rough feet-per-man-hour for roofline by difficulty, and
   minutes per wreath/garland/spritzer/tree/stake-ft/bistro-ft. Jason likely has
   these in his head; the estimate history can back them out.
4. What counts as labor revenue on a blended price: a flat % of each item category,
   or explicit labor rates per item? (Copilot solves this with the per-item P4P
   rate; we would put an equivalent field in BUSINESS_RULES.)
5. Takedown: same pool math as install?
6. Who approves time entries and splits (the "office manager decides" role)?

## 10. Sources

- Live walk of secure.copilotcrm.com (KPI Cockpit, Time Tracking + Settings,
  Employees + detail, Crews, Items and Services + item detail, Estimates + estimate
  189, Reports catalog, Account Settings + Preferences). Scheduler pages are gated
  behind clocking in, so they were read from nav + docs, not driven.
- p4psoftware.com home, /pricing, /faq (features page 404s).
- P4P University curriculum (mikeandes.teachable.com/p/p4p-university), free.
- "2 Page Document for P4P" PDF from Naldo (the policy template quoted in section 1).
- Codebase recon: pricing engine, jobs, Telegram bot, migrations, task ledger, #82
  inventory doc.
