# YLL — Operations Dashboard & Customer System — Vision Handoff

> Captured from product-planning sessions that used an OLDER version of the tool and
> throwaway neutral prototypes. This document is the **vision/requirements**, not a design.
> Hand this to an agent that is current on the live tool.

## 0. Read this first — your task & two hard rules

**Your task:** PLAN, don't build yet. Read the current tool's `docs/CURRENT_STATE.md`,
`docs/CONVENTIONS.md`, and the existing design system, then map this vision onto the
*current* architecture and produce a **phased build plan/spec for review**. Call out every
data gap and integration need. No code until the plan is approved.

**Hard rule 1 — DESIGN:** Ignore the look of any prototype that generated this vision. They
were neutral, illustrative mockups on an old version. Build everything with the **current
tool's existing design system, components, and brand** (warm cream / evergreen / red / gold).
The dashboard must look native to the current app — do not recreate prototype visuals, fonts,
or layouts.

**Hard rule 2 — SYSTEM BOUNDARY:** This tool owns **quoting + customer + insights**.
**Operations live in home.works**, which is already connected. Do NOT rebuild operations
(jobs, scheduling, install, takedown, invoicing, payments, inventory) inside this tool.

## 1. One-line product definition

An internal operator app for Yule Love Lights that owns everything quote- and customer-related
— AI quoting (photo → live design → price), the customer portal + approval + deposit, customer
records, and an operations **dashboard/insights layer** — while operational execution happens in
**home.works** (already integrated) and **HighLevel** is the CRM system of record (already integrated).

## 2. System boundary — who owns what (critical)

- **This tool:** lead/quote intake, AI quoting, customer portal + approval + deposit, customer
  records & insights, and the dashboard.
- **home.works (connected):** jobs, scheduling, install, takedown, invoicing, payments, crew/labor.
  Current integration is Zapier — outbound `quote.send` fires on approval; inbound webhook records
  signature. (Confirm exactly what data home.works can return today vs. what needs a deeper integration.)
- **HighLevel (connected):** CRM / contact system of record.

**Implication for the dashboard:** quote/customer/revenue/conversion metrics are **native**
(computed from this tool's Supabase). Operational metrics (time-to-get-paid, labor efficiency,
installs/takedowns by month, collected revenue) live in **home.works** — surface them only where
the connection exposes them. Part of your plan: determine what the current home.works connection
returns, and propose how to get the rest (deeper API integration vs. additional webhooks).

## 3. Lifecycle & the home.works handoff

`Quote → Quote approved (deposit paid)` — owned by **this tool** (tracked via the `quotes`
timestamp chain: created → sent → approved → homeworks_sent → homeworks_signed).
Then handoff to **home.works**: `Job created → scheduled → installed → takedown`.

**Service-aware branch at the end:**
- Holiday & Event → **takedown** (Jan–Feb for holiday) → archived (job closes out).
- Permanent → **no takedown** → enters an **ongoing-care relationship** (warranty checks, seasonal
  color swaps, repairs, upsell). Permanent customers are recurring and the highest-value — the
  dashboard must keep them surfaced, not archive them.

The dashboard should reflect these stages/branches even though execution is in home.works.

## 4. Service lines (add a `service_type` concept)

| Line | Cadence | Avg job value (illustrative) | Notes |
|---|---|---|---|
| Holiday lighting | Seasonal (installs ~Sep–Dec, takedown Jan–Feb) | ~$2,180 | High volume; the season goal (e.g. "47/50 homes") |
| Permanent lighting | Year-round | ~$13,000 | Recurring "ongoing care"; ~6× a holiday job — strategically important |
| Event lighting | Date-driven | ~$4,800 | Weddings, Sweet 16s, Quinceañeras, Diwali, corporate |

The dashboard breaks results down by service line.

## 5. Dashboard — the Home view (sections; describe content, not visuals)

1. **Header** — app title + a primary "New quote" action.
2. **General KPIs** — booked revenue; active quotes/customers; **avg quote turnaround
   (created → sent)** — Naldo's stated #1 lever, make it prominent; conversion / close ratio.
3. **Needs-your-attention worklist** — the priority surface. Rows derive from the quote lifecycle
   (+ home.works status where available): quotes drafted-not-sent, quotes sent with no reply (>N days),
   approvals where the home.works handoff failed, designs/quotes awaiting internal approval, etc.
   Each row links to the place that resolves it.
4. **Per-service sections:**
   - **Holiday** — broken down **by install month** (September / October / November …) showing
     **booked vs installed** per month (installed status sourced from home.works), plus the season goal.
   - **Permanent** — active jobs + an **"in care"** count (recurring base), not a pipeline that empties.
   - **Event** — upcoming + booked + revenue.
5. **Insights** — see §6.

## 6. Insights / metrics — the full list (grouped by data source)

Build the **native** ones first; stub the rest with explicit "needs X" notes (in the old system many
of these read $0 only because the data wasn't captured — same will be true here until the underlying
field/area/integration exists).

**A. Native (this tool's Supabase):**
- Month revenue — trailing-12-month line chart
- Revenue by service — trailing-12-month donut. Real package/service names seen in their data:
  Architectural Lighting Package, Bistro Lights, Santa's Roofline Display Package, Landscape Lighting,
  Trees, Other
- Close ratio (%) and Conversion rate (%)
- Average job value, Average quote value
- Time to close (days; created → approved)
- (Nice-to-have) Revenue heatmap (service × month); Avg job value by service (bar)

**B. home.works-sourced (operational):**
- Time to get paid (days)
- Labor efficiency
- Installs / takedowns by month
- Collected revenue

**C. Customer / recurring (needs a recurring-client model + revenue history):**
- Lead response time (days) — needs a Requests intake + first-response timestamp
- Attrition rate (%)
- Lifetime value per recurring client
- Annual value per recurring client
- Annual value per project client

## 7. App navigation / "areas"

The vision used a list-view-per-area pattern (overview counts on top + filterable table) — keep
that pattern, but scope to the boundary:

- **Native areas (build here):** Home (dashboard), Requests (lead intake — confirm vs. HighLevel),
  Quotes, Customers, Insights. Optionally read-only Jobs/Schedule views that *display* home.works data.
- **home.works' areas (do NOT build here):** Jobs, Schedule, Invoices, Payments, Inventory.

## 8. Customers area + HighLevel connection (buildable on existing integration)

Clicking any customer opens a detail that **loads live from HighLevel** (`getContact`) — phone,
email, tags, pipeline stage, lifetime value — alongside their quote/job history (this tool's data),
with a **"view full profile in HighLevel"** deep link. The plumbing exists: `getContact`/
`searchContacts` in `integrations/highlevel.ts`, and quotes already store `highlevel_contact_id`.

## 9. Inventory (future — note only)

Once jobs are booked, auto-roll-up material orders (C9 bulbs, roofline clips, mini-light strands,
extension cords, spritzer stakes, wreaths, garland) from quote line items into purchase orders.
Triggered off "job booked," sourced from line items (which this tool owns) — but order execution
likely belongs in home.works or a later module. Keep as a flagged future concept.

## 10. Data-model additions the vision implies (assess vs. current schema)

- `service_type` on quotes/customers (holiday / permanent / event).
- A recurring-vs-project client classification + revenue history (powers the client-value metrics
  and the permanent "ongoing care" model).
- A path to read operational status/metrics from home.works (current connection is Zapier outbound
  + signature webhook — likely insufficient for rich metrics; propose the upgrade).
Reconcile all of this against the actual current tables (`quotes`, `designs`, etc.).

## 11. Deliverable I want back from you

1. A phased build plan/spec mapped onto the current tool + current design system.
   - **Phase 1:** Home dashboard MVP — native KPIs + needs-attention worklist + per-service sections,
     in the current design system.
   - **Later phases:** HighLevel customer detail views; the native Insights (charts/tables); deeper
     home.works metrics; recurring-client model + client-value metrics; inventory.
2. Every data gap + integration need called out explicitly.
3. A recommendation on where the dashboard lives (suggest root `/` as the internal operator home,
   replacing the current boilerplate landing) and on the Requests-area question (build vs. defer to HighLevel).
4. No code until I approve the plan. Use the current design system — not any prototype visuals.
