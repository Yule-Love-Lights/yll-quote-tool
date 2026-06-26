# Jobber-flow — Quotes → Jobs → Invoices for the YLL Quote Tool

> **Design spec (brainstorm output) — 2026-06-26, Naldo.** Status: DRAFT for review. Not yet a ledger task, not yet committed (PR-not-master; commit on Naldo's go). Built from a live walkthrough of Naldo's Jobber account + an 11-agent research synthesis (`wf_17c039d8-29e`).

## 1. Goal & context

Make the YLL quote tool **mimic Jobber's Quotes → Jobs → Invoicing stages and process**, so Yule Love Lights can **retire Jobber for operations**. End state: **our tool + home.works** run operations; **Jobber is kept only for old data** (one-time import = existing task #72) and as the reference we're modeling.

We already own the **front of the funnel** better than Jobber (AI-designed quotes, live editable design, customer portal, 50% Valor deposit → "booked"). The gap is the **operations + money tail**: Jobs, Invoices, and collecting the remaining 50% balance. This spec adds that tail in Jobber's shape.

**Live Jobber model we're mirroring** (observed in Naldo's account 2026-06-26):
Quote (named packages + $0 included items + % discount + 8.625% tax + **50% required deposit** + contract/disclaimer + client message, **valid 15 days**, sent via text) → customer approves + pays 50% deposit → **Job** (From-Quote link, one-off vs recurring/Glow365, "Requires invoicing" when done) → **Invoice** (full total, **deposit applied → 50% balance**) → customer pays balance → Paid. Naldo's account: 1,648 quotes · 481 jobs · 457 invoices · receivables $43,392.

## 2. Locked decisions (from the brainstorm)

| Topic | Decision |
|---|---|
| **Scope** | Build **Quotes + Jobs + Invoices** stages with explicit statuses + a **dashboard Workflow board**. |
| **Scheduling** | **NOT in this tool** — lives in **home.works**, connecting later (placeholder + ledger). |
| **Receivables / AR** | **No** business-wide AR/aging tracking. (Per-invoice balance still exists + is collected.) |
| **End goal** | Our tool + home.works = operations; **Jobber retired**. We keep Jobber's *flow*, not the subscription. |
| **Balance (remaining 50%)** | Collect **via Valor**: on install-complete, **auto-charge the saved card**; on failure/no card → **send a portal "pay balance" link**. |
| **Decline / changes** | Customer can **Decline with a reason** *or* **Request changes** from the portal. |
| **E-signature** | **Capture a signature** on approval (into the approval snapshot). |
| **Job creation** | **Automatic** — on approval + deposit paid. |
| **Invoice creation** | **Automatic** — on job marked Installed/Complete. |
| **Where Jobs/Invoices live** | ⚠️ **TO BE DETERMINED.** *Recommendation:* the Job + Invoice **records live in our tool** (where the pipeline board, statuses & Valor balance are); only install **scheduling** goes to home.works, syncing at the connection point. Confirm when the home.works integration is scoped. |
| **Display IDs** | *Recommendation:* add sequential **Quote # / Job # / Invoice #** for display + reference, keeping the UUID as the internal id + portal-link token (see §4.6). |
| **Tax** | Stay at **8.75%** (engine is correct; Jobber's 8.625% is stale). Add a simple **manual tax-override** for rare exemptions; no formal exemption system. |
| **Cancellations** | Add a **Cancelled** booking state; **refunds stay manual in Valor** (no refund integration to build). |
| **Amend booked order** | **Yes — in-tool.** Staff can re-open a booked order, add/remove items, and the balance **auto-recomputes** (deposit already paid stays applied). |
| **Repeat customers** | **Yes** — one-click **"rebook last season"** + **multi-property** per customer (needs stable Customer + Property identity). |
| **Permanent / Glow365 recurring** | **Deferred** to the ledger (tackle with the permanent-lighting side of the tool). |
| **QuickBooks sync** | **Out of this build** (ledger as a possible later phase). |
| **PDF quote/invoice/receipt** | **Idea only** (ledger; not now). |
| **On-my-way / install-complete texts** | **Idea only** (ledger; not now). |
| **Review requests** | **Already handled in HighLevel** — do not build. |

## 3. Lifecycle & status model

One linked chain (mirrors Jobber, anchored to a Customer + Property):

```
Lead (HighLevel) → Quote → [Job] → [Invoice] → Paid
```

**Quote statuses:** Draft → Sent → Viewed → Approved → Booked (deposit paid)
— plus **Changes requested**, **Declined (with reason)**, **Cancelled**, **Lost/Archived**.

**Job statuses (auto-created at Booked):** To schedule → Scheduled *(home.works, later)* → Installed/Complete → Requires invoicing → Done.

**Invoice statuses (auto-created at Installed/Complete):** Draft → Awaiting payment → Paid. *(No Past-due/aging view — Naldo opted out of AR tracking; balance auto-charges, so unpaid is the exception.)*

The **dashboard Workflow board** (Naldo's area, #58) renders this as a Jobber-style pipeline: **Quotes · Jobs · Invoices** columns with per-status counts (mockup shown in-chat for comparison).

## 4. Feature requirements by stage

### 4.1 Quotes (enhance what we have)
- Explicit **status enum + badges** (above) replacing today's purely timestamp-derived state.
- Portal actions: **Approve (with signature)** · **Decline → reason** · **Request changes → note**.
  - *Request changes* → quote returns to staff (status: Changes requested) → staff edit → resend.
  - *Decline* → status Declined; capture the reason; surface to staff (+ optional HighLevel note).
- **E-signature capture** at approval: typed or drawn signature stored in `approval_snapshot` with name + timestamp (+ IP/user-agent for the record). Lightweight capture, not DocuSign-grade.
- Keep existing: 4 derived packages, add-ons (rush/premium-takedown/early-install/color), discount, **8.75% tax**, 50% deposit, contract/disclaimer, client message.

### 4.2 Jobs (new)
- **Auto-create a Job** when a quote is Approved **and** the deposit is paid (the Valor webhook is the trigger point — same place "booked" is set today) — **the Job record is created in our tool** (vs home.works = TBD, see §2).
- Job carries the **line items** + a **From-Quote** link; it is a **snapshot** at creation (later quote edits don't silently propagate — amendments are explicit, see §4.4).
- **Job type:** one-off (seasonal) vs **permanent/Glow365** (recurring billing deferred — job object can carry the type now).
- Statuses per §3. **Installed/Complete** is a staff action and is the **invoice trigger**.
- **Scheduling is out** — a placeholder "Scheduling handled in home.works" slot; the dormant home.works `send`/`signed` routes are the eventual handoff (separate ledger task).

### 4.3 Invoices (new)
- **Auto-create an invoice** when a job is marked **Installed/Complete** — **the Invoice record is created in our tool** (vs home.works = TBD, see §2).
- Invoice = full total, with the **deposit applied as a payment** → **balance = total − deposit paid** (mirrors Jobber's invoice math exactly).
- **Balance collection (Valor):** on creation, **auto-charge the saved Valor vault card**; on decline/no-card-on-file → **send the customer a portal "pay balance" link** (reuse the Valor hosted-page flow used for the deposit). On success → status **Paid** + receipt + HighLevel stage move.
- **Tax 8.75%**; a per-quote/invoice **manual tax-override** toggle (zeroes/edits tax) for rare exemptions.
- No AR/aging view. A **Cancelled** state exists; refunds are done manually in Valor.

### 4.4 Amend a booked order (new — the delicate one)
Today the approve route **freezes** `approval_snapshot` and the portal goes **read-only**; re-approval returns 409. To support post-deposit add/remove:
- A staff **"Edit booking"** action re-opens the booked order's line items.
- Recompute total on change; **deposit already paid stays applied**; **new balance = new total − deposit paid**.
- **Increase** → larger balance (collected at install via the auto-charge/link). **Decrease below deposit** → overpayment → **refund handled manually in Valor** (flag to staff; consistent with the cancellation decision).
- **Preserve the record:** keep the original signed snapshot; store amendments as a versioned trail (who/when/what changed) rather than overwriting — the signature attests to the original agreement.
- *Open detail:* whether/how to re-notify or re-sign the customer on an amendment (default: staff-initiated, optional customer notice). To confirm during planning.

### 4.5 Customer + Property identity + rebook (new)
- Promote customers from loose matching (HL contact → email → phone → name) to a **stable Customer** object, with **one-or-more Properties** (home + rental + relative's).
- Quotes/Jobs/Invoices reference Customer + Property.
- **"Rebook last season"** — one click clones a customer/property's last approved quote + design into a fresh quote for the new season.

### 4.6 Display IDs (new — recommendation)
Today a quote's only id is an internal UUID (e.g. `cc429b24…`); task #77 surfaces its first 8 chars. **Recommendation:** add a separate **human-friendly sequential number per type** — **Quote #**, **Job #**, **Invoice #** (like Jobber's #1691 / #486 / #336) — for display, phone & email reference, while **keeping the UUID** as the stable primary key.
- **Three independent running sequences** (quote, job, invoice each get their own).
- **Keep the UUID as the portal-link token.** ⚠️ The portal URL must stay the non-guessable UUID — a sequential number in the URL would let anyone enumerate other customers' quotes (a real PII leak, tied to the #81 audit). Sequential #s are **display-only**, never the access key.
- **Seed:** start each sequence where you like — I lean **#1000** so early real customers don't see "#1" (alternatives: #1, or continue past Jobber's last ~#1691 to avoid cross-reference confusion).
- Supersedes #77's truncated-UUID display.

## 5. Data-model impact (high level)
- New columns/objects: explicit **status** field(s); **Job** (fields-on-quote or a `jobs` table — decide in planning) with type + From-Quote + install/complete state; **Invoice** (balance/status/payment-applied) ; **signature** in the snapshot; **amendment trail**; **Customer + Property** identity + linkage.
- Reuse: `valor_vault_token` (already stored at deposit) for the balance auto-charge; the Valor webhook/hosted-page patterns; HighLevel stage moves + `quoteMessages.ts`.
- **Display numbers:** per-type sequential counters (`quote_number` / `job_number` / `invoice_number`) alongside the UUID (see §4.6).
- Migrations follow the repo's pattern (`migrations/*.sql`, applied to live Supabase per the project's migration process).

## 6. Phased plan

> **Phase 0 is a hard prerequisite.** Every new operator/customer surface here (invoices, jobs, payment history, vault-token balance charges, amend-order) MUST land behind real auth.

- **Phase 0 — Auth perimeter (#81)** · *blocking.* Server-side operator auth (middleware) + gate the open APIs; confirm the portal capability-token model before adding money-moving customer actions. *(Jason's area; already the documented next-session top priority.)*
- **Phase 1 — Status spine + decline/changes + e-signature.** Status enum/badges across the pipeline; portal Decline-with-reason + Request-changes; signature capture into the snapshot.
- **Phase 2 — Jobs (auto).** Auto-create Job at Booked; From-Quote link; statuses incl. Installed/Complete; home.works scheduling placeholder; the **Workflow board** goes live on the dashboard.
- **Phase 3 — Invoices (auto) + balance via Valor.** Auto-create invoice at Installed/Complete; deposit-applied → balance; auto-charge card → fallback pay-link; Paid + receipt; manual tax-override; Cancelled state.
- **Phase 4 — Amend booked order.** Re-open + re-price a booked order with the deposit applied + amendment trail.
- **Phase 5 — Customer + Property identity + "rebook last season."**
- **Deferred (ledger):** permanent/Glow365 recurring billing · home.works scheduling connection · QuickBooks sync · PDF docs · on-my-way/install-complete texts · (full Visits/crew/job-costing, tips, ACH, capacity limits, inventory, in-tool refunds, assessments — out).

*Phases 1–3 deliver the most Jobber-parity for the least risk (they close the deposit-to-paid gap). 4–5 are higher-value adds that touch the approval model + identity.*

## 7. Dependencies, ownership & risks
- **#81 auth (Phase 0)** gates everything customer/operator-data-facing.
- **Area ownership:** the **Workflow board** is Naldo's dashboard area; the **Quotes/Jobs/Invoices engine + portal + Valor balance + amend-order** are mostly **Jason's area + the SHARED data layer** (`quotes.ts`, new tables, types). → Needs **coordination + review with Jason**; PR-not-master; gates (`tsc`·`lint`·`test`) green; a human approves each merge.
- **Risk — amend-order** rewrites the "freeze snapshot / read-only after approval" assumption that several flows rely on (approve route 409, portal lock). Design carefully + adversarially review.
- **Risk — money movement** (auto-charging a saved card) must sit behind auth and reuse the proven idempotent Valor webhook patterns.

## 8. Ledger items to add (at session-close docs PR)
1. **Jobber-flow initiative** (this spec) — Quotes/Jobs/Invoices stages + Valor balance invoice + amend-order + Customer/Property + rebook.
2. **home.works scheduling connection** (placeholder, future) — and note **#16 un-dropped/re-scoped** (home.works is back as a complement, for scheduling).
3. **Permanent/Glow365 recurring billing** — deferred to the permanent-lighting work.
4. **QuickBooks accounting sync** — possible later phase.
5. **Ideas:** PDF quote/invoice/receipt · on-my-way/install-complete texts.

## 9. Open items to confirm during planning
- Job model: fields-on-`quotes` vs a dedicated `jobs` table (and same for invoices).
- Amend-order: customer re-notify/re-sign behavior on an amendment.
- Exact terminology on screen (Quote vs Estimate; "Booked" vs "Job/Won"; "Balance" vs "Final invoice") — default: keep current YLL wording unless Naldo prefers Jobber's.
- Workflow-board placement on the dashboard (replace vs sit alongside the existing worklist).
- **Where Jobs/Invoices are created** — our tool vs home.works boundary (§2); depends on scoping the home.works integration.
- Display-ID **seed** (start at #1 vs #1000 vs continue past Jobber's numbering).

## Key source files (anchors for the implementation plan)
- Lifecycle/data: `src/lib/quotes.ts`
- Send / Approve / Pay: `src/app/api/quotes/[id]/send/route.ts` · `approve/route.ts` · `pay/route.ts`
- Valor (booked source of truth): `src/app/api/integrations/valor/webhook/route.ts` · `src/lib/integrations/valor.ts` · `valorCheckout.ts`
- Portal: `src/app/portal/[quoteId]/page.tsx` · `approved/page.tsx` · `src/lib/portal/{loader,adapter,derivePackages}.ts`
- HighLevel + messaging: `src/lib/integrations/highlevel.ts` · `src/lib/quoteMessages.ts`
- home.works (live but UI-hidden): `src/app/api/integrations/homeworks/{send,signed}/route.ts`
- Dashboard/CRM: `src/app/page.tsx` · `src/app/customers/page.tsx` · `src/lib/dashboard/*`
- Pricing/tax (8.75%): `src/lib/pricing/pricingEngine.ts`
