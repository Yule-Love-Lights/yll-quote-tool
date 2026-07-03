# ⚠️ Needs Jason — open decisions, verifications & reviews (audit #110)

> Durable tracker of everything from the #110 audit epic that needs **Jason's personal
> call, a hands-on device check, or a human review** — so none of it is missed once the
> audit/fix work moves on. Created S20 (2026-07-04). Tick items off as they're handled.
> The findings themselves live in `AUDIT-2026-07.md`; this is only the "can't be automated /
> not mine to decide" residue.

## 1. Product / decision calls — only Jason can answer

- [ ] **W2-026** — when a new quote comes in for a customer whose row already exists, should
  their **contact/address fields update** to the newest quote's values, and if so does the
  newest quote win (or first-wins)? The fix was deliberately **skipped** pending this call.
  (`lib/customers.ts` findOrCreateCustomer/Property.)
- [ ] **Package "Save $X vs à la carte"** (from W4-034) — the fix made the savings
  **basis-consistent**, so today it renders **0 / hidden** (there's no real bundle-discount
  feature). Decide: do you want packages to actually show savings (i.e. build bundle
  discounts), or is 0/hidden correct? (`lib/portal/derivePackages.ts`.)
- [ ] **Auto-charge (#83)** — the standing Valor card-on-file/MIT decision (unchanged, still
  yours). Blocks nothing new; flagged for completeness. Spec: `docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md`.
  - [ ] **W1-012 rider** — amend computes `requiresReconsent` but **nothing enforces it**;
    this MUST be closed before `VALOR_AUTO_CHARGE_ENABLED` is ever flipped on (staff could
    amend a booked order UP and MIT-charge a total the customer never re-approved). Recorded
    in the VALOR-AUTOCHARGE doc.

## 2. Hands-on device / in-browser checks — automation can't do these

- [ ] **W4-003 (fixed, needs confirm)** — on a real portal: draw a signature → "Type my name
  instead" → "Or draw instead" → confirm the canvas is **blank** and **Approve stays disabled**
  until a fresh stroke. (Synthetic canvas strokes don't register, so this couldn't be
  automated — the reset logic was verified by review only.)
- [ ] **W4-013 (fixed, needs confirm)** — a quote that was approved-but-unpaid then
  **cancelled/declined by staff** should no longer show an actionable "Complete deposit"
  button. Needs a quote in that exact state to see.
- [ ] **W4-002 (fixed, needs confirm)** — the "Try again" button after a **real checkout
  network failure** now actually retries (verified by review; needs a live failure to trigger).
- [ ] **Railing AI (carry-over from S18 #108)** — run the analyzer on a **real porch/deck-
  railing photo**; the pipeline shipped but live detection is still unconfirmed.
- [ ] **#13 "Every angle" gallery (🧪 trial)** — final **keep/drop verdict** once it's been
  felt with real customer quotes.

## 3. Reviews / people (not decisions, but don't skip)

- [ ] **Loop Naldo** — today's fixes touched his SHARED **#83 modules** (`invoices.ts`,
  `jobs.ts`, `designs.ts`, `customers.ts`, `rebook.ts`) and change invoice/rebook behavior.
  He pre-cleared the edits, but he should know his invoicing now bills the **approved
  selection total** (W1-001) and rebook now carries `is_test`/`extra_photos` (W2-001/002)
  before his Aug–Oct trial prep.
- [ ] **Naldo's wave-7 handoff** — 96 findings in `AUDIT-2026-07-NALDO-HANDOFF.md`, incl. **9
  HIGH**. Three are trial-critical for HIS data integrity: inbox response-time measures
  cron-lag not customer-wait; "Followed" items still escalate; insights/worklist still count
  cancelled as booked (a B7 gap PR #300 missed). He should see these before trusting trial data.

## 4. Structural / migration decisions (deferred — flag when the topic comes up)

- [ ] **W2-015 / W2-016** got the **sanctioned fallback** (guarded-retry / fresh re-read), NOT
  true DB-atomicity — a real atomic fix for concurrent extra-photo uploads needs a **Postgres
  RPC + migration**. Fine for now; revisit if concurrent-upload collisions ever bite.
- [ ] **W2-009** customer de-dup is the **safest achievable without a schema change**; true
  cross-dimension customer uniqueness would need a **migration**.
- [ ] **`training_houses` (from W2-007)** — has **8 columns hand-created in Supabase**, not
  owned by any migration (predates `migrations/`). Not a bug, but the schema story isn't fully
  migration-tracked for that table.
- [ ] **editor.ts / #29** — when **wave 3** audits the dense files, `editor.ts` is
  refactor-frozen; structural findings feed **#29 (editor restyle)**, and any L-sized refactor
  there is **council-worthy** per the plan.

## 5. Fix-later backlog (recorded, not yet done — before the Aug–Oct trial)

- [ ] **W1 fix-later:** W1-006 (2nd-deposit durable record+alert) · W1-008 (cancel-of-paid
  refund record — needs design) · W1-010 (design-projection route tests) · W1-013 (approve-
  branch snapshot tests) · W1-019 (portal-open sequential DB round-trips) · W1-020 (GHL stage-
  config knob drift) · W1-068 (job `line_items` selection filter).
- [ ] **Unaudited waves:** **W3** (dense files — `editor.ts`/`QuoteBuilder.tsx`), **W5**
  (AI/training + token-cost lens), **W6** (routes + cross-cutting) — not yet audited; will
  surface more findings.

---
_Update this file as items are handled. Pointer lives in the #110 ledger row._
