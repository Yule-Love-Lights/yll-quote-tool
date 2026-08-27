# Operations Hub Inside Cool Tool

## Source Of Truth

Quote Tool and Cool Tool are the same product. The repository is `Yule-Love-Lights/yll-quote-tool`.

The product direction is to fold the planned Operations Hub into the existing Cool Tool. Do not create a separate Operations Hub app, and do not rebuild the Quote Tool from scratch.

The Cool Tool remains the system of record for customers, quotes, jobs, scheduling, staff, crew assignments, inventory, time, breaks, payroll inputs, invoices, customer communications, and operational reporting.

Past Operations Hub notes are product context only. They are not proof that the current repo has a feature, and they are not permission to copy old code or migrations.

## Superseded Remnants Still On Master

The scrapped separate-Hub direction left real artifacts on current master. They look authoritative but they describe the old direction, not this plan:

- `docs/context/OPERATIONS_HUB_CONTRACT.md` (v1.6.0-draft). It says the Hub owns all advertising and uses phone-OTP auth. Both points are superseded by this document.
- The byte-identical mirror of that contract in the `yll-call-copilot` repo (`docs/operations-hub/INTEGRATION-CONTRACT.md`).
- The AGENTS.md "Operations Hub contract" ownership row reserving `/api/ops/v1/**` for a separate Hub.
- Three machine routes with no consumer: `src/app/api/ops/v1/jobs/[id]/arrive`, `depart`, and `complete`. Built for the Hub; they are the natural foundation for the Crew My Day actions.

Task ledger row 433 tracks their disposition, which is Naldo's call. Any audit session must treat these as superseded remnants, not as current truth, and should propose what to do with each (likely: reuse the routes for Crew My Day, mark or strip the contract).

## How The System Should Work In Theory

The Cool Tool should become one operating system for Yule Love Lights. Office users should work from the full internal tool. Crew/installers should see only the work needed for their day. Advertising workers should eventually get a separate simple surface for campaigns, yard signs, door hangers, and reviewed placement proof.

There should be one canonical backend for each business fact:

- Customers live once.
- Quotes live once.
- Jobs live once.
- Schedules live once.
- Crew assignments live once.
- Time punches live once.
- Breaks live once.
- Payroll inputs live once.
- Inventory lives once.
- Advertising placements live once after that section is built.

Role-specific pages may show different views of those records, but they must not create parallel systems under different names.

## Role Model

Current product decision:

- Office and Operator are the same internal group.
- Admin is only Naldo and Jason.
- Crew and Installer are the same restricted field group.
- Advertising is the only genuinely new role/section to add.

Do not split Office and Operator into separate permission systems unless Naldo explicitly asks for that later. Admin should stay a narrow owner-level role for Naldo and Jason.

Office/operator users should use the main internal Cool Tool. Admin users should be able to see the normal Office tool and manually switch into Crew/Installer and Advertising views through clear buttons when needed. Admin-only approval and review controls should stay limited to Naldo and Jason unless Naldo changes that later.

Crew/installers must stay blocked from office/customer/quote/invoice/payroll-sensitive areas unless a specific future feature safely grants a narrow view. Advertising users must not receive broad operator access.

Before adding Advertising accounts or pages, audit the current role helpers and route protection. The known risk where loose role interpretation treats unknown non-admin roles as operator is current, not just historical: `roleOf` in `src/lib/auth/supabaseServer.ts` returns `'operator'` for any role value that is not exactly `'admin'`. Crew logins avoid it only through the separate `CREW_ROLE` marker and its guards. A new `'advertising'` value dropped into `app_metadata.role` today would receive full operator access. New roles need positive allowlists, not "anything except crew" logic.

## Existing Foundation To Reuse

The current Cool Tool already has major Operations Hub foundations:

- Supabase email/password login.
- Operator dashboard and shell.
- Navigation for Home, Inbox, Customers, Quotes, Jobs, Invoices, Inventory, Insights, and Settings. Leads and Schedule pages exist (`/admin/leads`, `/admin/schedule`) but deliberately hold no nav slot today; audit `src/components/dashboard/OperatorNav.tsx` for the current list.
- Customer, quote, job, invoice, inventory, schedule, inbox, settings, and insights areas.
- Crew member records.
- Crew account restrictions.
- Office clock concepts.
- Shift, break, job segment, and job assignment foundations.
- Crew-facing job action APIs under existing ops routes.
- Telegram and time/payroll-related foundations.

Several of these foundations are dormant in production even though the schema and code exist: `job_segments` has never held a row, and shifts are barely used. An audit must count production rows and report each foundation as used or dormant. Schema shape alone is not proof of a working feature.

Implementation work must audit current master before changing code. File names and route names from old notes are hints, not current truth.

## Office / Operator Workflow

Office users should use the existing Cool Tool as their daily command center.

Expected office work:

- Review new leads and quote requests.
- Work the Inbox as the daily operations queue.
- Claim work when needed.
- Follow up with customers.
- See quotes, customers, jobs, invoices, inventory, schedule, and insights.
- Monitor overdue work, stalled work, and upcoming jobs.
- Review crew time exceptions and job completion signals.
- Eventually review call insights, customer promises, and operational commitments if the call pipeline returns.

The preferred first direction is to keep office work inside the existing Cool Tool areas, especially Inbox for customer and follow-up work. A separate Office Tasks system should only be added if Inbox and follow-ups cannot cover manual internal tasks cleanly.

If a durable Office Tasks model is added later, it should start manual-only and include:

- 24-hour default due time.
- Statuses: open, blocked, completed, dismissed.
- Only open and blocked tasks shown in the active list.
- Required reason for blocked and dismissed.
- Idempotent mutations.
- Immutable audit events.
- Creator and assignee tracking.
- No automatic customer sending.
- No time, break, payroll, quote, or job side effects unless separately designed.

## Admin Workflow

Admin is only Naldo and Jason. Admin should see everything Office sees, plus owner-level controls and review tools.

Admin should have buttons or view switches for:

- Main Office tool.
- Crew/Installer view.
- Advertising view.

Admins may need these switches to test the worker experiences, review placement proof, approve or reject advertising submissions, inspect payroll inputs, and troubleshoot operational flows.

## Crew / Installer Workflow

Crew and Installer are the same group. Their surface should be a restricted "My Day" style experience built from canonical Cool Tool data.

Crew/installers should see:

- Approved jobs assigned to them.
- Today's schedule.
- Relevant start time, crew, prep notes, and job instructions.
- Narrow job details required to complete the work.
- Arrival, departure, and completion actions using the existing canonical job/time paths.
- Their own current time status where appropriate.

Crew/installers should not see:

- Full customer lists.
- Quote lists.
- Invoices.
- Internal office dashboard data.
- Payroll settings.
- Broad reporting.
- Admin settings.

Manual time punches are authoritative. GPS may support review or suggested arrival/departure later, but it must not silently change paid time.

Telegram will likely remain the main crew workflow because the crew may prefer it. The app-based My Day view should still exist as an option and as a foundation for future workers who may not use Telegram.

## Advertising / SimpleCrew Workflow

Advertising is the only new role and should be built as its own section inside the Cool Tool.

The first Advertising workflow should be sign placement capture.

Advertising should support:

- Campaigns.
- Yard sign placement runs.
- Door hanger tasks.
- Advertising worker assignments.
- Placement proof photos plus GPS.
- Exact house and street tracking.
- Route and neighborhood reporting.
- Review status: pending, accepted, rejected, and resubmitted.
- Sign inventory allocation and reconciliation.
- Performance and payroll summaries from reviewed records.

Advertising users should see a simple worker-facing surface:

- Assigned campaigns or runs.
- What they need to do today.
- Their own pending, accepted, rejected, or resubmitted placements.
- Rejection reasons for their own rejected placements.
- Pending estimated earnings.
- Accepted earned amount so far.
- Daily and weekly earnings views.
- A capture flow for photo and location evidence.
- Their own submitted work and status.

Office/operator users should not see Advertising placement status by default.

Admin users should see:

- Campaign setup.
- Worker assignments.
- Run progress.
- Map/review view.
- Placement proof.
- Rejection and resubmission workflow.
- Inventory allocation.
- Payroll summary inputs.

Yard sign pay should be based only on accepted placements. The intended starting rate is $2.50 per accepted yard sign placement.

Advertising workers should not clock in or out for advertising pay. People may place signs at their own pace, such as putting down one sign while already out somewhere. Advertising payroll should be accepted sign count times the approved per-sign rate.

Door hangers should be modeled, but pay should remain off until Naldo explicitly approves a pay rule. Door hanger activity must not enter payable placement counts by default.

Advertising proof should be reviewed before it affects payroll. Field submissions are evidence, not final payroll truth. Only Admin users, currently Naldo and Jason, should accept or reject placements. Rejected placements may be resubmitted.

## Exact Address Capture

Every Advertising proof photo should use GPS. This applies to yard signs and door hangers.

In theory, exact house and street tracking works like this:

1. The worker takes a proof photo in the app.
2. The app captures GPS coordinates at the same time as the photo.
3. The backend stores the raw latitude, longitude, accuracy, timestamp, and photo reference.
4. The system reverse-geocodes the GPS point into a suggested street address.
5. The system stores both the raw GPS evidence and the suggested address.
6. Admin reviews the photo, GPS point, suggested address, route, and neighborhood before accepting or rejecting the placement.
7. If the reverse lookup is wrong or unclear, Admin can correct the address before accepting it.

Door hangers should track exact houses and streets like yard signs, plus route and neighborhood reporting.

## Advertising Privacy

Advertising users should not receive broad access to customer or business-sensitive data.

Expected privacy pattern:

- Advertising users can capture and view their own local or pending submissions.
- Advertising users can see rejection reasons for their own rejected submissions.
- Office/operator users do not see Advertising placement status by default.
- Admin can review exact evidence.
- After review, exact coordinates, addresses, and photos should remain Admin-sensitive unless a specific worker view requires them.
- Worker-facing reports should prefer totals, statuses, or generalized locations over unrestricted exact maps.

## Jobs And Scheduling

Jobs and schedules should stay in the existing Cool Tool job system. Do not create a second schedule or dispatch table for Ops Hub.

Office/admin should manage jobs and schedules from the existing internal areas. Crew/installers should see assigned jobs through a restricted surface. Advertising should have its own campaign/run schedule only for advertising work, tied back to the same staff and payroll concepts where needed.

## Time, Breaks, And Payroll

Time, breaks, job segments, and payroll inputs must remain canonical inside the Cool Tool.

Rules to preserve:

- Store timestamps in UTC.
- Display operational time in `America/New_York`.
- Manual punches are authoritative.
- Breaks and job segments should not be duplicated.
- Payroll calculations must use reviewed, canonical data.
- GPS can be used as supporting evidence, not as an automatic pay editor.
- Money must be stored and calculated in integer cents.
- Payroll-affecting actions need audit trails and retry-safe/idempotent behavior.

## Inventory And Sign Allocation

Inventory already exists and should be reused where possible.

Advertising sign inventory should eventually handle:

- Signs available.
- Signs issued to a campaign or worker.
- Signs placed.
- Signs recovered if that workflow is later needed.
- Reconciliation between issued signs and accepted placements.

Sign inventory can live inside the existing Inventory section, using the same backend data where practical. Do not build a separate inventory system for advertising unless the existing inventory model cannot safely support the sign workflow.

## Call / HighLevel / Railway Area

Call, HighLevel, transcript, grading, and coaching features are desired future areas, but they need a separate audit before implementation.

Known direction:

- Email/password login stays.
- Railway is not needed for the Cool Tool UI.
- Railway was retired for the old standalone Hub direction.
- Do not bring Railway back casually.
- Vercel is appropriate for the Cool Tool UI and normal authenticated APIs.
- The desired future direction is automatic recording and transcript ingestion, not manual-only importing.
- Durable/background work may still need a worker architecture if call ingestion, polling, transcription, grading, retries, queues, or scheduled processing return.

About 1,210 call transcripts already exist in the sibling `yll-call-copilot` Supabase project and its repo. Check there before declaring any part of the chain missing; a repo-scoped audit of the quote tool alone will wrongly report that no transcription exists.

Before rebuilding call features, audit the full chain:

- HighLevel/provider event or export.
- Recording availability.
- Ingestion or polling.
- Database persistence.
- Transcription.
- Grading or coaching analysis.
- Customer promise extraction.
- Review process.
- Task creation, if approved.
- Display inside Cool Tool.

Do not enable live calls, live transcription, automatic sends, cron jobs, Twilio Verify, Turnstile, phone login, or Cloudflare auth work without a separate explicit decision.

Call-derived tasks should not be created silently. Any future promise or commitment needs a clear owner, due date, review process, completion evidence, and audit trail.

## What Not To Build

Do not:

- Create a separate Operations Hub app.
- Rebuild the Quote Tool.
- Create a second Supabase project for Ops Hub.
- Copy old Hub migrations blindly.
- Copy old Railway setup.
- Recreate quote, customer, job, schedule, time, break, payroll, or inventory data under another name.
- Use old cross-app contracts as direct build specs.
- Add Advertising users before role protection is audited.
- Treat old PRs, branches, docs, or ledgers as current truth.
- Run generic production database pushes.
- Change production data without current narrow authorization.

## Recommended Build Sequence

1. Audit current `master`.
   - Confirm current auth, role helpers, route protection, nav, dashboard, inbox, jobs, schedule, crew, time, inventory, and existing ops APIs.

2. Update docs.
   - State that Operations Hub is now internal to Cool Tool.
   - Identify which old documents are historical.
   - Name current role decisions.

3. Harden role handling for Advertising.
   - Audit every role helper and route gate.
   - Preserve current Office/operator behavior.
   - Preserve Admin as Naldo and Jason only.
   - Preserve current crew/installer restrictions.
   - Add positive allowlists for future Advertising access.

4. Define Office work.
   - Keep customer and follow-up work inside existing Office areas, especially Inbox.
   - Only add a separate Office Tasks model if necessary.

5. Design Advertising.
   - Write the product/privacy/pay spec before schema work.
   - Start with sign placement capture.
   - Require photo plus GPS for placement proof.
   - Limit accept/reject authority to Admin.
   - Model door hangers with pay disabled.

6. Build Advertising foundations.
   - Campaigns, runs, placements, evidence, review status, and inventory linkage.
   - Keep payroll impact behind reviewed accepted records.

7. Build or polish Installs / Crew My Day.
   - Reuse existing assignments and job/time actions.
   - Keep it restricted and mobile-friendly.
   - Keep Telegram as a likely main workflow while preserving the app option.

8. Add reporting.
   - Office/admin sees queue health, advertising production, accepted placements, crew progress, time exceptions, and payroll inputs.
   - Crew and advertising users see only their own scoped work.

9. Revisit Call/HighLevel.
   - Audit current ingestion and processing first.
   - Decide whether durable workers are needed.
   - Add review-before-task behavior.

## Open Questions

- Should Inbox become the full Operations Work Queue, or are there manual task types that require a separate Office Tasks model?
- What door hanger pay rule should exist later, if any?
- Which HighLevel call data still matters enough to rebuild?
- Does automatic call recording and transcript ingestion need durable background workers?

## Workstream Prompts

Use these prompts when running concurrent planning or implementation sessions. Each session should audit the current repo before proposing code, and should write its findings to a file under `docs/context/` so they persist beyond the chat.

### Office / Admin Foundation Prompt

```text
Work inside Yule-Love-Lights/yll-quote-tool, also called the Cool Tool. Do not create a separate Operations Hub and do not rebuild Quote Tool.

Audit the current Office/Operator/Admin foundation. Office and Operator are the same internal group. Admin is only Naldo and Jason.

Confirm current auth, role helpers, proxy route protection, navigation, dashboard, Inbox, Leads, Customers, Quotes, Jobs, Invoices, Inventory, Insights, Settings, and admin-only controls.

Note: roleOf in src/lib/auth/supabaseServer.ts treats every role value that is not exactly 'admin' as operator. Any new role needs a positive allowlist, never the default collapse.

Plan the smallest safe improvements so Admin can use the normal Office tool and manually switch into Crew/Installer and Advertising views for review/testing. Do not weaken crew restrictions. Do not add Advertising broad operator access.

Output what exists, what is missing, risks in role handling, files involved, tests needed, and open questions.
```

### Advertising Prompt

```text
Work inside Yule-Love-Lights/yll-quote-tool, also called the Cool Tool. Advertising is the only new role/section.

Plan the first Advertising workflow: yard sign placement capture.

Advertising workers should capture photo plus GPS proof for exact houses and streets. The system should also support route and neighborhood reporting. Placements should move through pending, accepted, rejected, and resubmitted states.

Every proof photo should capture GPS. Reverse-geocode the GPS point into a suggested exact address, while also storing the raw latitude, longitude, accuracy, timestamp, and photo reference. Door hangers should track exact houses and streets like yard signs.

Only Admin users, currently Naldo and Jason, can accept or reject placements. Rejected placements may be resubmitted. Advertising workers can see the rejection reason for their own rejected placements. Office/operator users should not see Advertising placement status by default.

Advertising pay is per accepted sign only. Starting rate is $2.50 per accepted yard sign placement. Do not add clock-in/out or time-based payroll for Advertising. Door hangers should be modeled but pay stays disabled until Naldo approves a rule.

Sign inventory should live inside the existing Inventory section where practical. Do not duplicate inventory, payroll, customers, jobs, or staff data.

Output the product model, permission model, database proposal, privacy rules, review flow, inventory relationship, tests, and first PR-sized implementation slice.
```

### Installs / Crew My Day Prompt

```text
Work inside Yule-Love-Lights/yll-quote-tool, also called the Cool Tool. Crew and Installer are the same restricted field group.

Audit the current crew/install job actions, Telegram workflows, assignments, shifts, breaks, job segments, and existing /api/ops/v1 routes.

The /api/ops/v1 job routes were built for the scrapped separate Operations Hub and currently have no consumer, and job_segments has never held a production row. Count production rows for shifts, breaks, job segments, and assignments; treat dormant foundations as first-real-use risk, not as proven features.

Plan an optional app-based My Day view for crew/installers. Telegram will likely remain the main workflow, but the app should exist as an option and as a foundation for future workers.

Crew/installers should see approved assigned jobs, today's schedule, start time, crew info, prep notes, narrow job details, arrive/depart/complete actions, and their own time state where appropriate.

Crew/installers must not see full customer lists, quotes, invoices, office dashboard data, payroll settings, broad reporting, or admin settings.

Manual time punches are authoritative. GPS may support review later but must not silently edit paid time.

Output what exists, what is missing, route and permission risks, proposed UI, files involved, tests, and first PR-sized implementation slice.
```

### HighLevel Calls Prompt

```text
Work inside Yule-Love-Lights/yll-quote-tool, also called the Cool Tool. Call/HighLevel features are desired future Operations Hub features inside the Cool Tool, but they require an audit before implementation.

The desired direction is automatic recording and transcript ingestion, not manual-only imports.

Audit the full current chain: HighLevel/provider call source, recording availability, ingestion or polling, persistence, transcription, grading/coaching analysis, customer promise extraction, review process, task creation if approved, and display in Cool Tool.

About 1,210 call transcripts already exist in the sibling yll-call-copilot Supabase project and its repo. Check there before declaring any part of the chain missing.

Do not enable live calls, live transcription, automatic sends, cron jobs, Twilio Verify, Turnstile, phone login, Cloudflare auth work, or Railway-style background processing without explicit approval.

If automatic ingestion needs durable/background work, explain the architecture options and risks. Vercel is fine for UI and normal APIs, but durable polling, retries, queues, transcription, and grading may need a worker design.

Call-derived tasks should not be created silently. Any future promise or commitment needs owner, due date, review, completion proof, and audit trail.

Output current findings, missing pieces, safe architecture options, data/privacy risks, tests, and a no-code recommendation for the first implementation slice.
```

## Final Claude / Codex Prompt

Use this full prompt when starting the first Claude or Codex planning session:

```text
ROLE
You are a senior product architect and staff-level engineer helping Yule Love Lights build a serious home service operating system.

Think like a multi-million dollar home service business developer. Your job is to understand the existing repo first, preserve what already works, and create a clean plan before implementation.

REPO
https://github.com/Yule-Love-Lights/yll-quote-tool

PRODUCT CONTEXT
Quote Tool = Cool Tool.

The existing yll-quote-tool repo is the Cool Tool. The goal is not to rebuild the Quote Tool and not to create a separate Operations Hub app.

The goal is to fold the planned Operations Hub features into the existing Cool Tool as internal role-based sections.

The Cool Tool remains the source of truth for:
- customers
- quotes
- jobs
- scheduling
- staff
- crew assignments
- inventory
- time
- breaks
- payroll inputs
- invoices
- customer communications
- reporting

Past Operations Hub chats, branches, migrations, and docs are context only. Do not treat them as current truth until the current repo proves it.

SUPERSEDED REMNANTS ON MASTER
The scrapped separate-Hub direction left artifacts on current master that look authoritative but describe the old direction:
- docs/context/OPERATIONS_HUB_CONTRACT.md (v1.6.0-draft). It says the Hub owns all advertising and uses phone-OTP auth. Both points are superseded by this prompt.
- The AGENTS.md "Operations Hub contract" ownership row reserving /api/ops/v1/** for a separate Hub.
- Three machine routes with no consumer: src/app/api/ops/v1/jobs/[id]/arrive, depart, and complete. Likely reusable for Crew My Day.
Task ledger row 433 tracks their disposition, which is Naldo's decision. Treat these as superseded remnants, not current truth, and propose a disposition for each in your report.

FIRST TASK
This first session is audit and planning only.

Do not write implementation code yet.
Do not create migrations yet.
Do not change production data.
Do not deploy.
Do not merge.
Do not copy old Operations Hub code.

First audit the current repo and then write a plan.

CURRENT ROLE DECISIONS

- Office and Operator are the same internal group.
- Admin is only Naldo and Jason.
- Crew and Installer are the same restricted field group.
- Advertising is the only genuinely new role/section to add.

Admin should normally use the main Office/Operator tool, but Admin should also be able to manually switch into:
- Office view
- Crew/Installer view
- Advertising view

Admin-only approval/review powers should stay limited to Naldo and Jason unless Naldo changes that later.

ROLE GUARDRAILS
Crew/Installer users must not see:
- full customer lists
- quotes
- invoices
- internal office dashboard data
- payroll settings
- broad reporting
- admin settings

Advertising users must not get broad Office/Operator access.

Before adding Advertising, audit all current role helpers, route gates, and app perimeter protection. The concern that loose role interpretation can accidentally treat unknown roles as operator is confirmed current: roleOf in src/lib/auth/supabaseServer.ts returns 'operator' for any role value that is not exactly 'admin'. Crew logins avoid it only through the separate CREW_ROLE marker and its guards. A new 'advertising' value in app_metadata.role today would receive full operator access. Use positive allowlists.

OFFICE / OPERATOR THEORY
Office/Operator users use the main Cool Tool.

Office work should stay inside existing Cool Tool areas where possible:
- Inbox
- Leads
- Customers
- Quotes
- Jobs
- Schedule
- Inventory
- Invoices
- Insights
- Settings

This area list is approximate. Leads and Schedule pages exist (/admin/leads, /admin/schedule) but hold no nav slot today; audit src/components/dashboard/OperatorNav.tsx for the current navigation.

Office should be able to:
- review new leads and quote requests
- work customer follow-ups
- claim work if that already exists
- monitor overdue or stalled work
- see upcoming jobs
- review crew/job completion signals
- eventually review call insights and customer promises

Do not create a duplicate task system unless the audit proves Inbox/follow-ups cannot support the needed work.

If a durable Office Tasks model is proposed later, it should start manual-only and include:
- 24-hour default due time
- statuses: open, blocked, completed, dismissed
- required reason for blocked/dismissed
- idempotent mutations
- immutable audit events
- creator and assignee tracking
- no automatic customer sending
- no time, break, payroll, quote, or job side effects unless separately approved

ADMIN THEORY
Admin is only Naldo and Jason.

Admin should see everything Office sees, plus owner-level review and approval tools.

Admin should have view switches/buttons for:
- main Office tool
- Crew/Installer view
- Advertising view

Admin should handle:
- Advertising placement review
- accept/reject/bulk accept placements
- correction of GPS/address issues
- payroll input review
- operational troubleshooting
- sensitive reporting

CREW / INSTALLER THEORY
Crew and Installer are the same group.

They should have a restricted My Day app view, but Telegram will likely remain the main workflow because the crew may prefer Telegram.

The app should still exist as an option and future foundation.

Crew/Installer should see:
- approved assigned jobs
- today's schedule
- start time
- crew info
- prep notes
- narrow job details needed for the work
- arrive/depart/complete actions
- their own time state where appropriate

Crew/Installer should not see the full office side.

Manual time punches are authoritative. GPS can support review or suggestions, but GPS must not silently change paid time.

Do not create a parallel schedule, time, break, job segment, or payroll system.

ADVERTISING / SIMPLECREW THEORY
Advertising is the main new role and section.

Advertising workers use simple email/password login.

The first Advertising workflow is sign placement capture.

Advertising should eventually support:
- campaigns
- yard sign placement runs
- door hanger tasks
- advertising worker assignments
- proof photos
- GPS capture
- exact house/street tracking
- route and neighborhood reporting
- pending/accepted/rejected/resubmitted states
- sign inventory allocation
- payroll summaries from reviewed accepted records

Advertising worker view should show:
- assigned campaigns or runs
- what they need to do today
- their own pending placements
- their own accepted placements
- their own rejected placements
- rejection reasons for their own rejected placements
- pending estimated earnings
- accepted earned amount so far
- daily and weekly earnings views

Office/Operator users should not see Advertising placement status by default.

Admin users should see:
- campaign setup
- worker assignment
- run progress
- map/review view
- placement proof
- rejection and resubmission workflow
- bulk accept
- inventory allocation
- payroll summary inputs

ADVERTISING PROOF AND GPS
Every Advertising proof photo should use GPS.

The worker should not manually type GPS. The app should capture GPS automatically from the device when the proof photo is taken.

For each proof photo, store:
- photo reference
- latitude
- longitude
- GPS accuracy
- timestamp
- worker
- campaign/run
- suggested address from reverse GPS lookup
- route
- neighborhood
- status

Reverse-geocode GPS into a suggested exact address.

Exact house/street tracking should work like this:
1. Worker takes proof photo.
2. App captures GPS at the same time.
3. Backend stores raw GPS, accuracy, timestamp, and photo.
4. System reverse-geocodes GPS into a suggested exact address.
5. Admin reviews photo, map pin, GPS accuracy, suggested address, route, and neighborhood.
6. Admin can correct the address if reverse lookup is wrong.
7. Admin accepts, rejects, or bulk accepts reviewed placements.

YARD SIGN RULES
Yard sign pay is based only on accepted placements.

Starting pay rule:
- $2.50 per accepted yard sign placement

No Advertising clock-in/out.
No hourly pay.
No time-based payroll for Advertising.

Rejected placements do not count for pay.
Rejected placements can be resubmitted.
Advertising workers can see rejection reasons.

Duplicate detection needs planning:
- Do not block purely by GPS because multiple signs may validly be placed near one intersection.
- Compare nearby GPS points, exact suggested address, campaign, worker/day, and proof photos.
- Consider photo-similarity review as a future duplicate-detection aid.
- Admin should make the final decision.

DOOR HANGER RULES
Door hangers should be modeled.
Door hanger pay is disabled until Naldo approves a future rule.

Door hangers should track exact houses and streets like signs.
They should also support route and neighborhood reporting.

If pay is enabled later:
- no proof for a house means no pay for that house

For now:
- door hangers should not enter payable placement counts
- do not invent a door hanger pay rule

INVENTORY / SIGN ALLOCATION
Sign inventory should live inside the existing Inventory section if practical.

Advertising sign inventory should eventually track:
- signs available
- signs issued to campaign or worker
- signs placed
- signs recovered if needed later
- reconciliation between issued signs and accepted placements

Do not create a second inventory system unless the audit proves the existing one cannot support this safely.

TIME / PAYROLL RULES
The Cool Tool owns canonical time and payroll inputs.

Preserve:
- timestamps stored in UTC
- operational display in America/New_York
- manual punches authoritative
- money in integer cents
- idempotent payroll-affecting actions
- audit trails for important actions

GPS can support review but must not silently edit paid time.

Advertising pay is not time-based. It is accepted sign count times approved per-sign rate.

HIGHLEVEL CALLS / RECORDINGS / TRANSCRIPTS
HighLevel call features are desired future Operations Hub features inside Cool Tool.

The desired direction is automatic recording and transcript ingestion, not manual-only imports.

About 1,210 call transcripts already exist in the sibling yll-call-copilot Supabase project and its repo. Check there before declaring any part of the chain missing.

Audit before building:
- HighLevel/provider call source
- recording availability
- ingestion or polling
- persistence
- transcription
- grading/coaching analysis
- customer promise extraction
- review process
- task creation if approved
- display in Cool Tool

Do not enable without explicit approval:
- live calls
- live transcription
- automatic sends
- cron jobs
- Twilio Verify
- Turnstile
- phone login
- Cloudflare auth work
- Railway-style background processing

Railway was retired for the old separate Hub direction. Do not bring it back casually.

Vercel is fine for the Cool Tool UI and normal APIs. If automatic call ingestion, polling, transcription, grading, queues, retries, or scheduled processing are needed, explain durable worker options and risks.

Call-derived tasks should not be created silently. Any future promise or commitment needs:
- owner
- due date
- review
- completion proof
- audit trail

WHAT NOT TO BUILD
Do not:
- create a separate Operations Hub app
- rebuild Quote Tool
- create a second Supabase project
- copy old Hub migrations blindly
- copy old Hub code blindly
- copy Railway setup
- duplicate customers, quotes, jobs, schedule, time, breaks, payroll, inventory, or communications
- give Advertising broad Office/Operator access
- weaken crew restrictions
- infer identity matches from names
- run generic production database pushes
- change production data without narrow approval

AUDIT REQUIREMENTS
Read the current repo before proposing implementation.

Audit:
- AGENTS.md
- current docs
- migrations
- auth and role helpers
- proxy/perimeter route protection
- operator navigation
- dashboard
- Inbox
- Leads
- Customers
- Quotes
- Jobs
- Schedule
- Inventory
- Invoices
- Insights
- Settings
- crew members
- shifts
- breaks
- job segments
- job assignments
- Telegram workflows
- existing /api/ops routes
- any HighLevel/integration code
- docs/context/OPERATIONS_HUB_CONTRACT.md and the AGENTS.md ownership row, as superseded remnants per above
- production row counts for crew_members, shifts, breaks, job_segments, and job_assignments; several foundations are dormant (job_segments has never held a row), so report each as used or dormant, because schema shape alone is not proof of a working feature

OUTPUT SHAPE
Give a full planning report with:

1. What already exists in the repo.
2. What is missing.
3. What should be reused.
4. What should not be copied from old Ops Hub work.
5. Role and permission risks.
6. Recommended final information architecture.
7. Recommended build order.
8. Separate implementation workstreams:
   - Office/Admin foundation
   - Advertising
   - Installs / Crew My Day
   - HighLevel Calls
9. First PR-sized slice for each workstream.
10. Database tables likely needed.
11. Routes/pages likely needed.
12. Tests and verification needed.
13. Questions for Naldo before code is written, including the row 433 remnant disposition.

Write the full report to a new file under docs/context/ in the repo so it persists beyond this chat, and propose task ledger rows for the build items.

BAR
The plan should be good enough that another developer can start from it without rereading all past chats.

SELF-REVIEW
Before finalizing, check:
- Did you clearly preserve Quote Tool = Cool Tool?
- Did you avoid creating a separate Ops Hub?
- Did you avoid rebuilding the Quote Tool?
- Did you keep Office = Operator?
- Did you keep Admin limited to Naldo and Jason?
- Did you keep Crew = Installer?
- Did you keep Advertising as the only new role?
- Did you make Advertising pay per accepted sign only?
- Did you include pending estimated earnings and accepted earned amount for Advertising workers?
- Did you include GPS reverse lookup and exact address tracking?
- Did you keep HighLevel automatic but deferred pending audit?
- Did you treat old chats/docs as context, not current code truth?
- Did you treat the superseded contract and the /api/ops/v1 remnants as row 433 decisions, not current truth?
```
