# ⚠️ Needs Jason — open decisions, verifications & reviews (audit #110)

> Durable tracker of everything from the #110 audit epic that needs **Jason's personal
> call, a hands-on device check, or a human review** — so none of it is missed once the
> audit/fix work moves on. Created S20 (2026-07-04). Tick items off as they're handled.
> The findings themselves live in `AUDIT-2026-07.md`; this is only the "can't be automated /
> not mine to decide" residue.

## 1. Product / decision calls — only Jason can answer

- [x] **W2-026 — RESOLVED (Jason, 2026-07-06): NEWEST-WIN.** When a new quote comes in for an existing
  customer, update their contact fields (name/email/phone) to the newest quote's values (when present).
  **✅ BUILT + LIVE (PR #418, master `433d8f5`):** `findOrCreateCustomer` + `findOrCreateProperty` now refresh
  contact fields + display address/geo to newest-if-present (was first-wins; a missing field never wipes the
  stored value). SHARED `customers.ts` — Jason-authorized; Naldo heads-up in the handoff. +3 tests.
- [x] **Package "Save $X" — RESOLVED (Jason, 2026-07-06): KEEP HIDDEN.** No bundle-discount feature — packages
  cost the same as à la carte, so there are no real savings to show. Current 0/hidden behavior is correct; not
  building bundle discounts. (`lib/portal/derivePackages.ts`.)
- [x] **W5 image downscaling — RESOLVED (Jason, 2026-07-06): KEEP the 1568px downscaling.** Detection quality
  verified good on device; keep the cheaper path. No code change. (`photoAnalysis.ts` `downscaleImageForVision`.)
- [ ] **Auto-charge (#83) — Jason: KEEP AS-IS for now (2026-07-06); flagged for NALDO** to weigh in on whether
  to pursue (added to his handoff doc). The Valor card-on-file/MIT decision stays Jason's; blocks nothing.
  Spec: `docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md`.
  - [ ] **W1-012 rider** — amend computes `requiresReconsent` but **nothing enforces it**;
    this MUST be closed before `VALOR_AUTO_CHARGE_ENABLED` is ever flipped on (staff could
    amend a booked order UP and MIT-charge a total the customer never re-approved). Recorded
    in the VALOR-AUTOCHARGE doc.
- [x] **W6-008 — `simulate-deposit` public vs operator — RESOLVED (Jason, 2026-07-04): option (a).** Fixed in
  PR #394 — allowlisted + `requireOperator` removed + `is_test===true`→403 pre-mutation boundary (anon caller
  can only ever touch a test quote). LIVE (inert until the auth gate flips).

## 2. Hands-on device / in-browser checks — automation can't do these

- [x] **W4-003 — VERIFIED (Jason, 2026-07-06): works.** Signature draw → type → draw resets to blank + Approve stays disabled until a fresh stroke.
- [ ] **W4-013 — SEEDED, ready to verify (2026-07-06):** a test quote in the exact state →
  [`portal/5d4c8b19-…-ca69fe117120`](https://quote.yulelovelights.com/portal/5d4c8b19-af33-4f4a-813e-ca69fe117120)
  (cancelled + approved + unpaid, `is_test` — safe to delete). Confirm **no actionable "Complete deposit" button**.
- [x] **W4-002 — ACCEPTED review-only (2026-07-06):** can't reproduce via a link (needs a live checkout network failure); verified by review, leaving as-is.
- [x] **W5 downscale detection quality — VERIFIED (Jason, 2026-07-06): looks good** → KEEP the 1568px downscaling (the §1 decision).
- [ ] **W5 prompt-cache savings (fixed, needs confirm)** — confirm `cache_read_input_tokens
  > 0` on a **repeat analyze within 5 min** (the ~90% input-token savings actually landing) —
  visible in Anthropic usage/logs, not surfaced to the client.
- [ ] **Railing AI (carry-over from S18 #108)** — run the analyzer on a **real porch/deck-
  railing photo**; the pipeline shipped but live detection is still unconfirmed.
- [x] **#13 "Every angle" gallery — VERIFIED (Jason, 2026-07-06): looks good → KEEP** (trial flag can come off).
- [x] **W3-002/030 — VERIFIED (Jason, 2026-07-06): behaves as expected + safe.** The standalone strand's clone
  bills (kept its tag); duplicated grouped-strand *members* become loose tag-less strands (the tag lives on the
  group) → not billed until re-grouped, but visibly loose (no more disguised-unbilled ghost). **Jason declined**
  the optional "duplicate-a-group → billed copy of the group" follow-up.
- [x] **W3-009 — VERIFIED (Jason, 2026-07-06): works** — paste lands at the cursor / offset (landing on top only when the cursor is exactly on the original's corner — non-issue).
- [ ] **W3-001 (fixed, needs confirm)** — pull a **street-preferred address** (tree-cover /
  ambiguous road so satellite roofline lines come back empty) → the AI's Santa's/Gingerbread
  **footage should survive**, not snap to 0.
- [x] **W3-014 — VERIFIED (Jason, 2026-07-06): works** — markup survives across photo swaps.
- [ ] **STILL OPEN (not checked yet):** W3-001 footage · W5 prompt-cache savings (Anthropic console) · Railing AI live detection.

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

- [x] **W1 fix-later — DONE (S21 resume, 2026-07-04, master `13ba733`, PRs #402/#403/#404):**
  W1-006 (double-charge durable record + staff email + log) · W1-008 (cancel-refund record + email + log
  — approval_snapshot marker, no migration) · W1-010 + W1-013 (money-path route tests) · W1-020 (GHL
  stage-knob drift). **W1-019 was ALREADY FIXED** (W2-031 query-collapse + W4-016 loader-parallelize +
  W4-033 column-narrow, shipped S20 — builder verified live, no-op). **STILL OPEN:**
  - [ ] **W1-068** — job `line_items` selection filter (cosmetic; in Naldo's `jobs.ts`, gnarly portal-id
    mapping) → **hand to Naldo** or leave.
- [x] **#80-102 — DONE (PR #404):** the runQuote/Send flush-swallow half — Calculate + Send now warn
  and abort on a flush rejection instead of pricing/sending a stale scene (mirrors W3-006's capture fix).
- [ ] **W3 fix-later (deferred — recommend leaving):** W3-008 server-reorder half (the `saveSeq` token
  closed the UI-race; a fuller in-flight abort/queue stays deferred in the frozen editor.ts — self-heals) ·
  training per-photo **calibration** (`feetPerUnit` stays whole-house; separate change).
- [x] **W6 fixes — DONE (S21 resume, 2026-07-04, master `ce7632f`, PRs #394/#395):** HIGH W6-002 + W6-GAP-1 ·
  auth allowlist cluster W6-001/005/008 (all INERT until `AUTH_GATE_ENABLED` flips) · observability W6-003/009/010 ·
  test-gaps W6-004/006/011/016/017 · LOW W6-014/015. **STILL OPEN:**
  - [ ] **#396 (W6-012 tooling)** — SHARED eslint/vitest config → **Naldo reviews before merge** (held). **Loop Naldo.**
  - [ ] **W6-013** — middleware→proxy Next.js 16 convention rename — deferred to its own task.
  - [ ] **Loop Naldo** — W6-003 (valor auto-PO) + W6-010 (jobs/cancel) fixes touch his domain (route-level only).
- [ ] **W6-007 → Naldo:** 6 event/permanent money engines never audited → money-lens pass added to his handoff
  (`AUDIT-2026-07-NALDO-HANDOFF.md`). Manifest generator fixed (regenerated, exit 0). **Loop Naldo.**
- [x] **All 8 waves AUDITED** (W0–W7); **W6 FIXED (S21).** Remaining epic tail = #396 + W6-013 + the W1/W3 fix-laters.

---
_Update this file as items are handled. Pointer lives in the #110 ledger row._
