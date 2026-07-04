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
- [ ] **W5 image downscaling — DECISION contingent on the device-check in §2** — the analyzer
  now downscales images to **1568px** before the Claude Vision call (that's what makes it
  cheaper). It's the one W5 change that alters what Claude *sees*. If the §2 detection-quality
  check shows it hurts detection on large/detailed house photos, decide: keep it · raise the
  ceiling · or revert. (`lib/fewShot.ts` `downscaleImageForVision`.)
- [ ] **Auto-charge (#83)** — the standing Valor card-on-file/MIT decision (unchanged, still
  yours). Blocks nothing new; flagged for completeness. Spec: `docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md`.
  - [ ] **W1-012 rider** — amend computes `requiresReconsent` but **nothing enforces it**;
    this MUST be closed before `VALOR_AUTO_CHARGE_ENABLED` is ever flipped on (staff could
    amend a booked order UP and MIT-charge a total the customer never re-approved). Recorded
    in the VALOR-AUTOCHARGE doc.
- [ ] **W6-008 — `simulate-deposit` public vs operator** (decide before go-live, at fix-time). The anon
  portal calls `POST /api/quotes/[id]/simulate-deposit` for TEST quotes (moves no money, flips a test-only
  booking flag, already 400s non-test quotes). It's operator-gated + not in the allowlist → it 401s at
  go-live. **(a)** allowlist it + re-check `is_test===true` for anon callers (recommended, least change), or
  **(b)** move the trigger to an operator-only admin control. (`lib/auth/operatorGate.ts` PUBLIC_QUOTE_SUBROUTES.)

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
- [ ] **W5 downscale detection quality (fixed, needs confirm — feeds the §1 decision)** —
  analyze a **real large house photo** and eyeball that the 1568px downscaling doesn't
  visibly hurt detection vs full-res. The pipeline is live-verified to RUN (valid analysis
  returned); this is the quality question automation can't answer.
- [ ] **W5 prompt-cache savings (fixed, needs confirm)** — confirm `cache_read_input_tokens
  > 0` on a **repeat analyze within 5 min** (the ~90% input-token savings actually landing) —
  visible in Anthropic usage/logs, not surfaced to the client.
- [ ] **Railing AI (carry-over from S18 #108)** — run the analyzer on a **real porch/deck-
  railing photo**; the pipeline shipped but live detection is still unconfirmed.
- [ ] **#13 "Every angle" gallery (🧪 trial)** — final **keep/drop verdict** once it's been
  felt with real customer quotes.
- [ ] **W3-002/030 (fixed, needs confirm)** — in the editor: marquee-select a mix of grouped
  + ungrouped mini strands (or a linked twin) → **Duplicate / Ctrl+V / Ctrl+D** → confirm the
  clone now **shows up as a billed line** (before, it stayed on-canvas but was never billed).
- [ ] **W3-009 (fixed, needs confirm)** — Ctrl+C / Ctrl+V a **scattershot mini-area** → the
  paste should land offset, **not stacked exactly on the original** (was invisible-double-bill risk).
- [ ] **W3-001 (fixed, needs confirm)** — pull a **street-preferred address** (tree-cover /
  ambiguous road so satellite roofline lines come back empty) → the AI's Santa's/Gingerbread
  **footage should survive**, not snap to 0.
- [ ] **W3-014 (fixed, needs confirm)** — upload **2+ training photos**, mark up photo 1, then
  Auto-Analyze photo 2 → photo 1's confirmed markup must **survive** (was silently overwritten);
  the saved example should carry **both** photos' markup.

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
- [ ] **W3 fix-later:** W3-008 server-reorder half (the `saveSeq` token closed the UI-race; a
  fuller in-flight abort/queue was deferred in the frozen editor.ts — self-heals on next save) ·
  **#80-102 runQuote/Send flush-swallow** (the non-capture half — W3-006 only closed the
  training-capture instance; the Calculate/Send flush still swallows silently) · training
  per-photo **calibration** (`feetPerUnit` stays whole-house; per-photo calibration is a
  separate change).
- [ ] **W6 fix-later (audited S21, fixes HELD by Jason — do before go-live / the trial):**
  - **HIGH:** W6-002 (designs/[id]/photos: add getDesign→404 before upload, mirror the W2-008 sibling + test) ·
    W6-GAP-1 (add `rateLimitResponse` to `/api/login` — drop-in, the helper exists).
  - **Auth allowlist go-live cluster** (ONE operatorGate PR before flipping `AUTH_GATE_ENABLED`): W6-001
    (/api/health) · W6-005 (GET /api/quotes/[id]) · W6-008 (simulate-deposit — see the §1 decision first).
    All fail closed today; all 401 the moment the gate flips.
  - **Observability:** W6-003 (valor auto-PO fail log) · W6-009 (homeworks dup-send) · W6-010 (cancel quote-status).
  - **Test-gaps:** W6-004 login/logout · W6-006 middleware · W6-011 designs/[id] · W6-016 interested · W6-017 hotkeys.
  - **Accepted LOW (skip unless bored):** W6-012 worktree-ignore · W6-013 middleware→proxy (own task) · W6-014 stale comment · W6-015 NaN parse.
- [ ] **W6-007 → Naldo:** 6 event/permanent money engines never audited → money-lens pass added to his handoff
  (`AUDIT-2026-07-NALDO-HANDOFF.md`). Manifest generator fixed (regenerated, exit 0). **Loop Naldo.**
- [x] **All 8 waves AUDITED** (W0–W7). Remaining epic tail = the W6 fix backlog above + the W1/W3 fix-laters.

---
_Update this file as items are handled. Pointer lives in the #110 ledger row._
