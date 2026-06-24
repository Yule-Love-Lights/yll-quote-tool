# Dashboard (task #58) — Build Plan / Spec for Review

> **Status:** LOCKED 2026-06-24 — Q1–Q4 answered by Naldo (see §4); Q5–Q7 deferred to their phases.
> **Author:** Claude (Naldo's session, 2026-06-24)
> **Scope:** Replace the boilerplate `/` page with the internal operator dashboard described in
> [Vision Handoff](VISION.md) (the document Naldo pasted to start this session).
> **Deliverable shape:** vision → current-architecture mapping + phased plan + data/integration gaps + recommendations.
> **Next step:** generate the Phase 1 task-by-task build plan (`docs/dashboard/PLAN_PHASE_1.md`), Naldo reviews, then execute.

---

## 1. What this plan IS / IS NOT

**IS:** a phased build/spec for review. Each phase is a coherent shippable chunk that produces a working dashboard or area on its own. Phases gate each other on data and decision availability, not on opinion.

**IS NOT:** a step-by-step TDD task list. That comes after Naldo approves the phase shapes. Each approved phase will then get its own task-by-task plan (file-by-file edits, tests, commits) generated via the `superpowers:writing-plans` skill.

---

## 2. Snapshot — where we're starting from

- `src/app/page.tsx` today renders the **default Next.js boilerplate** ("To get started, edit page.tsx…") with the Next.js + Vercel buttons. That's task #58's placeholder; it's intentional.
- `src/app/layout.tsx` `<title>` is still **"Create Next App"** — fix that as part of this work.
- `globals.css` is **bare**: just `--background: #ffffff` / `--foreground: #171717`, Geist Sans/Mono, Tailwind v4. No brand tokens.
- The brand tokens **do exist** but they are **scoped to `.portal-dark-root`** in `src/app/portal/portal-dark.css`:
  - `--yd-bg: #0B140F` (deep evergreen) · `--yd-gold: #E8B862` (warm gold) · `--yd-red: #C8313D` (Christmas red, used sparingly) · `--yd-cream: #F4ECD8` (cream text). They drive the customer portal's dark/dramatic look.
- The operator-side UI today (e.g. `/admin/quotes`) uses **plain Tailwind grays** with a tiny green-600 admin eyebrow — no real "design system." That's the closest existing analog for the dashboard, but it's not the brand.
- Naldo's area (per `AGENTS.md`): `src/app/page.tsx`, `src/components/dashboard/**`, `src/app/api/dashboard/**`, `src/lib/dashboard/**`. None of those folders exist yet (except `page.tsx`). The boilerplate is the only file to touch initially.

---

## 3. System boundary — what stays out of this tool

The vision is unambiguous: **operations live in home.works**. This tool owns lead/quote → customer portal → approval → deposit → customer record + insights. We do **not** rebuild jobs/schedule/install/takedown/invoicing/payments/inventory inside this app.

⚠️ **Critical truth-check on the integration claim.** Naldo's vision says "home.works (connected): outbound `quote.send` on approval; inbound webhook records signature." The **code IS there** (`src/lib/integrations/homeworks.ts` Zapier outbound + `/api/integrations/homeworks/signed/route.ts` inbound signature webhook). **BUT:** in the project memory (Jason's work, task #16), this integration was **shelved**: "we're not wiring home.works into this quote tool (the approve route's Zapier hook stays in code but goes unused)." The hook is there; nobody is using it right now.

Implication for the plan: any phase that needs to **read operational data BACK from home.works** (installs per month, time-to-get-paid, labor efficiency, collected revenue) is **blocked on a deeper home.works integration that has not been built and was deliberately deferred**. Phases 1–4 of this plan deliberately need **zero** home.works data; Phase 5 calls out exactly what's needed to unlock the operational metrics. See open question Q1.

---

## 4. Open questions — LOCKED 2026-06-24

> Naldo's answers (2026-06-24). Q1–Q4 explicit; Q5–Q7 defaulted to (A) per Naldo's blanket "use your recommendations" for later-phase decisions. Revisit before each phase that depends on them.

- **Q1 — home.works integration: LOCKED — (A) Plan around it being unavailable.** Phases 1–4 use native data only. Operational metrics (time-to-get-paid, labor efficiency, installs per month, collected revenue) are stubbed with explicit "needs home.works integration" notes. Phase 5 designs the deeper integration when we're ready.

- **Q2 — Brand tokens: LOCKED — (A) Light cream/evergreen operator surface, reusing the existing portal brand values.** Use the SAME color values that already exist in `portal-dark.css` (`#F4ECD8` cream · `#0B140F` evergreen · `#E8B862` gold · `#C8313D` red) — do NOT invent new colors. Lift them out of the portal-scoped CSS into a small set of shared brand tokens in `globals.css`, then layer operator-specific surface tokens on top (light cream background, evergreen text + primary, gold accents, red for "needs attention" emphasis). Portal CSS continues to use the same brand values in its dark-surface configuration; nothing about the portal changes.

- **Q3 — Service type field: LOCKED — (A) Add `service_type` ENUM on `quotes` in Phase 2.** Values: `'holiday' | 'permanent' | 'event'`. Backfill existing rows to `'holiday'`. Operator picks when starting/editing a quote. Drives the per-service dashboard sections.

- **Q4 — Requests area: LOCKED — (A) Defer to HighLevel.** No native Requests inbox. The dashboard "Needs attention" worklist will include a row like "X new HighLevel contacts with no quote yet" that deep-links to HighLevel. One source of truth for leads; less to build + maintain.

- Q5 — Customers area data model: defaulted to **(A) no new table — aggregate quotes by `highlevel_contact_id`**. Confirm before Phase 3 build.
- Q6 — Recurring-client model: defaulted to **(A) defer to Phase 6**. Confirm when we get there.
- Q7 — Chart library: defaulted to **Recharts**. Confirm before Phase 4 build.

---

## 5. Vision → current-architecture map

| Vision concept | Status in current code | Action |
|---|---|---|
| Dashboard at `/` | Boilerplate placeholder (intentional, #58) | **Build new.** Phase 1. Naldo's area. |
| KPI: booked revenue | `quotes.total` summed where `customer_approved_at IS NOT NULL` | Native ✅. Phase 1. |
| KPI: active quotes / customers | `quotes` filtered by lifecycle timestamps | Native ✅. Phase 1. |
| KPI: avg quote turnaround (created → sent) | `quote_sent_at - created_at` average | Native ✅. Phase 1. |
| KPI: conversion / close ratio | `approved / sent` from timestamps | Native ✅. Phase 1. |
| Needs-attention worklist | The full lifecycle timestamp chain is on `quotes` (`created_at → quote_sent_at → customer_approved_at → homeworks_sent_at → homeworks_signed_at`) | Native ✅. Phase 1. |
| Per-service breakdown (Holiday/Permanent/Event) | No `service_type` field exists on `quotes` | **Add column, backfill, ask in builder.** Phase 2. |
| Installed status (per-month chart) | Not in this tool; would need home.works confirmation event | **Stub in Phase 2** with `homeworks_signed_at` as a weak proxy; **real fix Phase 5** (deeper home.works integration). |
| Customers area + HighLevel detail | `highlevel_contact_id` stored on `quotes`; `getContact()` + `searchContacts()` in `integrations/highlevel.ts` | Plumbing exists ✅. Build the UI in Phase 3. |
| "View in HighLevel" deep link | Trivial; HL contact URL pattern is well-known | Phase 3. |
| Insights / charts (revenue line, service donut, etc.) | All native; no chart library installed yet | Pick a chart library, then Phase 4. |
| Operational metrics (time-to-get-paid, labor efficiency, installs by month, collected revenue) | Requires home.works data we don't currently ingest | **Phase 5** — gated on a home.works integration scope decision (Q1). |
| Recurring-client model + LTV / attrition / annual value | No customer table; no recurring concept; no per-customer revenue history | **Phase 6** — gated on Q5/Q6. |
| Inventory rollup from line items | Future / out of scope here | **Phase 8** — note only; likely belongs in home.works or its own module. |
| Permanent customers don't archive (stay in "ongoing care") | No status concept yet for permanent | Falls out of Phase 2 + Phase 6. |

---

## 6. Phased build plan

Each phase is a coherent, shippable chunk. Branch name suggestion shown for each (Naldo's `naldo/<slug>` convention from `AGENTS.md`).

### Phase 1 — Dashboard shell + Native KPIs + Worklist (the MVP)
**Branch:** `naldo/dashboard-shell`
**Goal:** Replace the boilerplate `/` with a real operator home — KPI strip, needs-attention worklist, "New quote" CTA. Native data only; zero new integrations; zero schema changes.

**Includes:**
- Establish operator brand tokens in `globals.css` per Q2 — **reuse the existing brand color values from `portal-dark.css`** (cream `#F4ECD8` · evergreen `#0B140F` · gold `#E8B862` · red `#C8313D`). Lift those four values up into a small set of shared brand variables (e.g. `--brand-cream`, `--brand-evergreen`, `--brand-gold`, `--brand-red`) at `:root`. Then add operator-surface tokens on top for the light dashboard (cream background, evergreen text/primary, gold accents, red for "needs attention" emphasis). Portal CSS keeps using the same brand values for its dark surface — zero portal change.
- Fix `<title>` and `<meta description>` in `src/app/layout.tsx` (shared file — claim it with Jason per `AGENTS.md`).
- Build the dashboard shell: `src/app/page.tsx` becomes the dashboard; introduce `src/components/dashboard/{Header,KpiStrip,Worklist,NewQuoteCTA}.tsx`.
- `src/lib/dashboard/metrics.ts` — pure functions over `quotes` that compute: booked revenue (sum of `total` where approved), active quote count, active customer count (distinct `highlevel_contact_id` with a non-final-state quote), avg turnaround in days, conversion rate.
- `src/lib/dashboard/worklist.ts` — pure function that classifies quotes into worklist rows from the lifecycle timestamps (rules: drafted-not-sent > N days; sent-no-reply > N days; approved-but-homeworks-not-sent; etc.).
- `src/app/api/dashboard/route.ts` — single GET that returns `{ kpis, worklist }` JSON.
- Worklist rows are LINKS — each row deep-links to the place that resolves it (`/quote/[id]`, `/admin/quotes`, or HighLevel).
- A small `<nav>` for the operator surface: Home (dashboard), Quotes (link to `/admin/quotes`), Quote Builder (link to `/quote/new`). No new pages built; just the nav.
- Unit tests for `metrics.ts` and `worklist.ts` (pure → easy + high-value).

**Deliberately deferred to later phases:** per-service breakdown, charts, customer detail, anything reading from home.works, the Requests area.

### Phase 2 — Service-type + per-service dashboard sections
**Branch:** `naldo/dashboard-service-type`
**Goal:** Add the holiday / permanent / event lens to the data + the dashboard.

**Includes:**
- New migration `migrations/YYYY-MM-DD-quotes-service-type.sql` adding a nullable `service_type` enum column to `quotes` (values: `'holiday' | 'permanent' | 'event'`), defaulting NULL → backfilled to `'holiday'` for all existing rows. Idempotent per `CONVENTIONS.md` §6.
- Builder form (`src/app/quote/new/page.tsx` — Jason's area, **coordinate first**) gets a service-type radio. Default 'holiday'. Persists via `saveQuote`. Editable on `/quote/[id]`.
- Dashboard adds per-service sections under the worklist:
  - **Holiday** — booked vs installed by install month (use `homeworks_signed_at` as proxy until Phase 5; mark proxy explicitly in the UI). Show season goal (configurable).
  - **Permanent** — active jobs + "in care" count (recurring base; just "all permanent customers" until Phase 6).
  - **Event** — upcoming + booked + revenue.
- Season goal config (e.g. "47/50 homes"): start as a constant in `src/lib/dashboard/config.ts`; defer making it editable until Naldo asks.

### Phase 3 — Customers area + HighLevel live detail
**Branch:** `naldo/dashboard-customers`
**Goal:** Native list view of customers (aggregated from `quotes` by `highlevel_contact_id`) + a detail page that loads live HighLevel data + quote history.

**Includes:**
- `src/app/customers/page.tsx` — list view: distinct contacts, with count of quotes, latest quote total, total lifetime spend with us (from `quotes.total` sums), latest lifecycle stage.
- `src/app/customers/[contactId]/page.tsx` — detail: server-side `getContact(contactId)` call (already in `integrations/highlevel.ts`) shown alongside their `quotes` history.
- "View full profile in HighLevel" deep link button (HL contact URL: `https://app.gohighlevel.com/v2/location/{locationId}/contacts/detail/{contactId}` — confirm pattern with Jason before shipping).
- New API: `src/app/api/dashboard/customers/route.ts` (list) + `src/app/api/dashboard/customers/[contactId]/route.ts` (detail). HL fetch is server-side only (key never to client).
- No new database table.
- Worklist links to customer rows where appropriate.

### Phase 4 — Insights (native charts)
**Branch:** `naldo/dashboard-insights`
**Goal:** The chart layer — trailing-12-month revenue line, service donut, close ratio, time-to-close, avg job value by service.

**Includes:**
- Add Recharts (or chosen lib per Q7) — `package.json` is shared, **coordinate with Jason**.
- New `src/app/insights/page.tsx` — the dedicated insights area.
- New `src/lib/dashboard/insights.ts` — pure aggregations over `quotes` (trailing-12-month revenue, by-service donut, close ratio %, time-to-close days, avg job value, revenue heatmap service×month).
- Embed the top 1–2 insight widgets on the main dashboard (revenue line + service donut) so the home view shows them; the full grid lives at `/insights`.
- Donut categories: package/service names that already appear in line items (Architectural Lighting, Bistro, Santa's Roofline, Landscape, Trees, Other). Map line-item kinds → display names in one place.

### Phase 5 — home.works deeper integration (UNBLOCKS operational metrics)
**Branch:** TBD; this phase is GATED on Q1 + a design decision Jason and Naldo make together.
**Goal:** Surface operational metrics — time-to-get-paid, labor efficiency, installs/takedowns by month, collected revenue.

**Includes (sketch, design firmed up before build):**
- A `homeworks_events` table (or extension of `quotes`) that records install/takedown/invoice/payment events from home.works.
- An integration mechanism: webhook ingest (new Zapier zaps Naldo configures pointing at new `/api/integrations/homeworks/events/*` routes), polling, or direct API if home.works exposes one (research needed).
- Dashboard's "installed" / "collected" / "time to pay" stats switch from proxies → real data; "needs home.works" notes disappear.

**This phase needs Naldo + Jason to align on scope before planning further.**

### Phase 6 — Recurring-client model + client-value metrics
**Branch:** TBD; gated on Q5/Q6.
**Goal:** Permanent / recurring concept formalized → LTV per recurring client, annual value, attrition rate, lead response time.

**Includes (sketch):**
- A view or table that materializes the recurring concept (`is_recurring`, `recurring_started_at`, etc.) — Q6 decides whether it's a derived view or a real table.
- Customer detail page gets LTV, annual value, churn-risk badge.
- Dashboard Permanent section becomes a real retention/care surface (next service due, last contact date if HL exposes it).
- Lead-response time requires a "first response" timestamp — either capture on quote creation or pull from HL conversation history.

### Phase 7 — Requests intake (only if Q4 → option B)
Skip entirely if Q4 = (A, recommended). Otherwise: build a Requests inbox here that mirrors a HighLevel pipeline stage with a "Convert to quote" action.

### Phase 8 — Inventory rollup (future / parking lot)
Per the vision, this is a "later concept." Don't build until needs become concrete. Likely the right home is home.works or a dedicated module, not the dashboard. *(A placeholder `/inventory` page + nav slot now exists; the real material-rollup feature is unbuilt.)*

### Phase 9 — Jobber historical-data import (backlog; Naldo side-note 2026-06-24)
**Goal:** one-time import of historical customer + job/revenue data from **Jobber** into this tool so Insights reflects the FULL history, not just quotes created here.

**Data landscape (Naldo, confirmed):** **Jobber = OLD customer data** (historical, static — no new activity); **home.works = NEW/current** ops data; **HighLevel = leads, lacks the rich history from either.** So Jobber is a *historical* source.

**Approach — one-time import, NOT a live integration** (the data is static, so no ongoing API sync needed):
1. Naldo exports from Jobber → **CSV** (account-owner export of Clients + a job/invoice/revenue report). Lower-friction than the Jobber API (which needs an OAuth app); the API is only worth it if a *live* sync is ever wanted (it isn't — Jobber is the old system).
2. Build an importer that loads the CSVs into a dedicated **`historical_jobs`** (legacy) table in Supabase — kept separate from the live `quotes` table so native vs imported data never blur.
3. Extend the Insights aggregations (`monthlyRevenue`, `revenueByService`, `computeInsightStats`) to **blend** historical + live, with the imported history clearly distinguished.

**Boundary:** Claude will NOT log into Jobber (no credential entry); **Naldo runs the export.** Blocked on Naldo providing the CSV files. Priority: side-note / not urgent.

---

## 7. Data gaps + integration needs — the canonical list

**Schema additions (this tool, Supabase):**
1. **`quotes.service_type` ENUM** (Phase 2) — `'holiday' | 'permanent' | 'event'`. Migration + backfill.
2. **`quotes.notes`** (preexisting half-done, see `CURRENT_STATE.md` §4.4 — "TODO wire up when notes field is added to quotes"). Not strictly needed by the dashboard but cheap to address while we're touching the table.
3. **Recurring-client model** (Phase 6) — a `customer_records` view or table. Decision deferred until then.
4. **`homeworks_events` table** (Phase 5) — to record install/takedown/invoice/payment events back from home.works. Schema designed when home.works integration scope firms up.

**External integrations:**
5. **HighLevel** — already configured + working. Customer detail (Phase 3) only needs the existing `getContact()` (zero new endpoints). Confirm the HL contact-detail URL pattern with Jason before shipping the "View in HighLevel" deep link.
6. **home.works** — current Zapier integration is **outbound only** (estimate created from approval) + **inbound signature webhook**. NOT enough for operational metrics. Phase 5 needs:
   - Either: new Zapier zaps pushing install-confirmed / takedown-scheduled / invoice-paid / payment-received events into new `/api/integrations/homeworks/events/*` routes we'd build (mirrors today's `signed` route pattern).
   - Or: home.works exposes a read API (research needed; likely not for typical home-services CRMs).
7. **Lead-response time** (Phase 6) needs a "first response" timestamp source — likely HighLevel conversation history (`/conversations/messages` endpoint already wired for outbound; the read direction isn't yet).

**Tokens / shared files (claim with Jason before editing):**
8. `src/app/layout.tsx` — to fix `<title>` and add the operator nav wrapper (or scope it to non-portal routes).
9. `src/app/globals.css` — to add operator brand tokens (Q2 → A).
10. `package.json` + lockfile — when adding the chart library in Phase 4.

**No-op (intentionally NOT a gap):**
- Quote lifecycle timestamps. They're all there: `created_at`, `quote_sent_at`, `customer_approved_at`, `homeworks_sent_at`, `homeworks_signed_at`. Phase 1 leans entirely on these.
- HighLevel `contact_id` per quote. Already stored on `quotes`. Customers area (Phase 3) keys off this.

---

## 8. Recommendations

**Where the dashboard lives:** **Root `/`** — replace the boilerplate. Already reserved for this in the project plan (task #58 explicitly says "do NOT 'fix' the empty homepage; build the dashboard here"). The operator opens the app to their home screen; the customer never sees `/` (they get `/portal/[id]` links directly). Confirmed: zero conflict.

**Requests area:** **Defer to HighLevel** (option A in Q4). Reasons: HighLevel already owns leads, the existing `/quote/new` flow already pulls a HL contact, and the dashboard worklist can surface "leads with no quote yet" without us building or maintaining a Requests inbox here. We can always add a native intake later if HL friction becomes a problem.

**Naldo-specific safe practices** (from `AGENTS.md`):
- All Phase 1 work fits cleanly inside Naldo's owned files (`src/app/page.tsx`, `src/components/dashboard/**`, `src/app/api/dashboard/**`, `src/lib/dashboard/**`) **EXCEPT** `globals.css` and `layout.tsx`, which are shared → **claim with Jason first**.
- Branch `naldo/dashboard-shell` off fresh master; open a PR; don't commit to `master`.
- Run gates before commit: `npx tsc --noEmit` · `npm run lint` · `npm test`.

**Order I'd actually build:** Phase 1 → 2 → 3 → 4. That gives Naldo a real, useful operator screen end-to-end (KPIs + worklist + per-service + customers + charts) using only native data, before we even start the conversation about deeper home.works integration. Phases 5–6 unlock the operational + LTV metrics; 7–8 are optional.

---

## 9. Suggested next step

1. **Naldo** reviews this plan and answers Q1–Q7 in §4. (Inline in this doc, or reply to me — either works.)
2. **Claude** updates the plan with Naldo's answers (locking decisions) + writes the Phase 1 task-by-task TDD plan as `docs/dashboard/PLAN_PHASE_1.md` using the `superpowers:writing-plans` skill.
3. **Naldo** reviews Phase 1's task plan.
4. **Claude** executes Phase 1 on `naldo/dashboard-shell` (after Naldo claims the `globals.css` + `layout.tsx` shared files with Jason).

---

## Appendix — Files I read while preparing this plan

- `docs/CURRENT_STATE.md`, `docs/CONVENTIONS.md`, `docs/ONBOARDING.md`, `AGENTS.md`
- `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`
- `src/app/portal/portal-dark.css`, `src/app/portal/portal-snowglobe.css` (brand tokens)
- `src/app/admin/quotes/page.tsx` (closest existing operator-UI analog)
- `src/lib/quotes.ts` (data model + lifecycle fields)
- `src/lib/integrations/highlevel.ts`, `src/lib/integrations/homeworks.ts`
- `migrations/` directory listing (schema history)
- The full task ledger (#1–#66) and the latest session-log entries (S10–S12)
