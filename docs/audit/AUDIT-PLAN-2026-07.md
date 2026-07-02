# Full-tool QUALITY audit — plan (#110)

> **What:** a whole-tool audit for bugs, inefficiencies, dense-code quality, and refactor
> candidates — run in **interleaved waves** (audit an area → disposition with Jason → fix →
> next area), NOT one continuous mega-pass. Raised by Jason S20 (2026-07-02); ledger **#110**.
>
> **How this differs from #80** (`AUDIT-2026-06-26.md`): #80 was a bug/security audit of the
> then-current tool (109 verified findings; the auth cluster → #81, hardening → #90 — all
> shipped). #110 adds the QUALITY dimensions #80 didn't chase (inefficiency, refactor
> candidates, dead code, dense-file deep review, test-suite health, AI token cost) AND covers
> the large surface added since (#104 price overrides, #13 multi-image, #83 operator console,
> inbox v2, #53/#54 training). Every wave **dedupes against #80 + later review dispositions**
> — known, accepted-as-is findings are not re-reported unless the code materially changed
> (mechanical rule below).

## Locked decisions (Jason, 2026-07-02 — don't re-ask)

1. **Interleaved waves** — audit wave N → disposition sit-down → fix wave N as PRs → audit
   wave N+1. Not audit-everything-then-fix-everything (findings rot; master moves fast).
2. **`editor.ts` / editor-core is REFACTOR-FROZEN for this audit** — it's relay-locked
   (byte-parity with the standalone design tool). Bugs: fixable + relayed byte-identical.
   Structural/refactor findings: recorded **coarse-grained** (structure map + hotspot list,
   not line-level prescriptions — so they survive drift) and **fed into #29 (editor restyle)
   as its spec**; the fine-grained refactor pass happens when #29 actually starts.
3. **Naldo's areas ARE in scope (wave 7) — read-only.** Findings go to a handoff doc for
   Naldo; we open no routine PRs in his lane. **CRITICAL-in-Naldo's-lane protocol** (the one
   exception, pre-agreed): immediate ping to Naldo; either Naldo fixes same-day, OR Jason's
   assistant opens the PR with **Naldo as required reviewer** before merge. Master
   auto-deploys — a CRITICAL doesn't wait on lane etiquette, but it never merges without
   Naldo's eyes.
4. **Council: plan-critic-lite only** — one adversarial critique pass on this plan before
   wave 0 (**done 2026-07-02**: 17 findings, 2 BLOCKERs — all folded into v2; see Revision
   log). Full council reserved for any L-sized structural-refactor disposition the audit
   surfaces (e.g. "split QuoteBuilder"), not for the plan.

## Fix-now vs note-down rule

- **CRITICAL escape hatch:** anything money-wrong / data-loss / security found mid-audit →
  stop, fix immediately as its own small TDD PR (same rule #80 ran). In Naldo's lane → the
  protocol in decision 3.
- **Everything else:** findings ledger ONLY during the audit phase of a wave. Fixes happen in
  that wave's fix phase, after disposition
  (**fix-now / fix-later / accept / feed-#29 / hand-to-Naldo**).
- **Disposition ergonomics (anti-fatigue):** CRITICAL / HIGH / MEDIUM findings are
  dispositioned individually with Jason. **LOWs are batched** — presented as a grouped list
  with a default disposition of `accept`; Jason pulls individual LOWs up for fixing. LOWs may
  use a slimmed schema (id · type · file · summary · suggested fix).
- **`fix-later` findings convert to ledger rows at EACH wave close** — not at epic close —
  so a stalled epic never strands them inside the report.
- Why note-down: baseline stability (findings cite `file:line@SHA`); refactors need their own
  TDD + review cycle; findings cluster (see ALL findings on a file before picking the
  refactor shape); disposition discipline (some findings are accept-as-parity — don't
  blind-fix).

## Baseline, dedupe sources, artifacts

- **Baseline:** frozen at wave-0 start (`origin/master` SHA recorded in the report header).
  Re-frozen per wave (interleaving moves master); every finding cites `file:line@<wave-SHA>`.
- **Dedupe sources (seed in wave 0, timeboxed ~30 min):** `AUDIT-2026-06-26.md` +
  `_verified-raw.json` (109 findings incl. accepted/deferred WARNs) · Naldo's #83 24-agent
  audit fixes (PR #300) · S17–S19 adversarial-review dispositions from `session_log.md`,
  `session_log_naldo.md` **and their archives** (`session_log_archive.md` etc. — the
  archiving cadence may have moved them). Partial seeding is acceptable; the ledger grows as
  waves rediscover-and-dedupe.
- **Re-open rule (mechanical):** a deduped/accepted finding re-opens iff
  `git log --since=2026-06-26 -- <file>` shows commits touching the cited function/lines.
  No judgment call.
- **Artifacts (all created in wave 0):**
  - findings report `docs/audit/AUDIT-2026-07.md` (append per wave; #80's format — severity
    tiers, Issue → Root cause file:line → Exact fix, scorecard at close)
  - known-findings dedupe ledger `docs/audit/KNOWN-FINDINGS-2026-07.md`
  - **coverage manifest** `docs/audit/COVERAGE-MANIFEST-2026-07.md` — every `src/` file (plus
    the named non-src surfaces) assigned to **exactly one wave**; checked in; "100% assigned"
    is a wave-0 DoD item. The manifest is authoritative over the indicative scopes below.
  - **conventions charter** (one page, in the manifest doc or beside it) — the shared
    patterns every fix phase must follow so wave-1 fixes don't get re-churned when wave 6
    standardizes: auth-gate helper usage, input-validation pattern, error shape, the S18
    client/server import-boundary rule. Wave 6 then audits *adherence*, not invention.
  - Naldo handoff `docs/audit/AUDIT-2026-07-NALDO-HANDOFF.md` — created **in wave 0** as the
    append-target for every wave's `hand-to-Naldo` findings (not just wave 7's).

## Finding schema

`id (W<wave>-NNN)` · `area` · `type (bug | security | perf | cost | refactor | dead-code |
consistency | test-gap | a11y | docs-drift)` · `severity (CRITICAL | HIGH | MEDIUM | LOW)` ·
`confidence` · `file:line@SHA` · `summary` · `evidence` · `suggested fix` · `effort (S/M/L)` ·
`disposition (fix-now / fix-later / accept / feed-#29 / hand-to-Naldo)`.
(LOWs may use the slimmed schema above.)

## Waves

Scopes below are indicative — the **wave-0 coverage manifest is authoritative** and assigns
every file to exactly one wave. Named here explicitly (critic findings) so nothing falls
through: the **inventory stack**, `amend.ts`, the **auth perimeter itself**, GHL integration,
jobs/pipeline libs, `googleMaps.ts`/`geo.ts`, `app/insights`, and the non-`/api` route
`app/photos/[...path]/route.ts`.

| Wave | Area | Scope (indicative) |
|---|---|---|
| **0** | **Scoping** (half-session) | Freeze SHA · **coverage manifest (100% of src/ assigned)** · conventions charter · seed dedupe ledger (timeboxed) · create handoff doc · vitest coverage map per area · schema template. No findings produced. |
| **1** | **Money core** | `src/lib/pricing/**` (pricingEngine 853L, quoteForm) · #104 override path · `approve/route.ts` (701L) · valor webhook (582L) + `valor.ts` + `valorCheckout.ts` · `invoices.ts` (639L) + `invoiceStatus` + `balanceCollection` · **`amend.ts` (260L) + its route** · **`jobs.ts`/`jobStatus.ts` + `lib/pipeline`** · **`highlevel.ts`/`highlevelPipelines.ts`** (GHL stage-sync, money-adjacent) · **ALL money-bearing routes regardless of console ownership** (`charge-balance`, `pay-balance`, `mark-paid`) · `quoteMessages.ts` (514L) · **`portal/adapter.ts` audited ONCE here** — portal-lens findings tagged forward to wave 4's disposition. |
| **2** | **Data layer** (SHARED — Naldo heads-up on fixes) | `quotes.ts` · `designs.ts` (789L) · `supabase*.ts` clients · `trainingExamples.ts` · storage/photo lifecycle + retention route · `customers.ts`/`rebook.ts` · migrations-vs-code drift — **explicitly reconcile the two parallel schema sources** (`db/schema.sql` vs `migrations/FULL-SCHEMA.sql`) and document which is truth. |
| **3** | **Dense-file deep review** | `editor-core/editor.ts` (5,291L — bug lens FULL; refactor lens COARSE per decision 2) · `QuoteBuilder.tsx` (3,276L — fully refactorable, Jason's area) · `training/new/page.tsx` (1,459L). |
| **4** | **Portal** | `components/portal/**` (SelectionContext, WhatsIncluded, dark/snowglobe) · `sceneLinks.ts` · render-readonly · loader/types · #13 photo strips + galleries · approved page · portal-facing API · **light a11y checklist** (contrast on the dark/snowglobe themes, focus states, form labels — customers are 40+ homeowners on phones). |
| **5** | **AI / training** | `photoAnalysis.ts` (749L) · `seedFromAnalysis.ts` (515L) · prompt consts (ROOFLINE_TRACING_RULES / OUTPUT_JSON_SCHEMA / COMPLETED_INSTALL) · `sceneToFewShot` · training pages · corrections · analyze route · **`googleMaps.ts`/`geo.ts`** (image acquisition) · **token-cost/latency lens**: few-shot corpus growth (injected per analysis — cap?), #13 multi-image Vision payloads, prompt caching, image downscaling. The audit's banner word is *inefficiency* — recurring AI spend is in scope. |
| **6** | **API routes + cross-cutting** | all `src/app/api/**` + **non-`/api` routes** (`app/photos/[...path]/route.ts`) · **the #81 auth perimeter ITSELF** (`middleware.ts`, `lib/auth/**` — operatorGate/adminUsers/accountGuards) · validation/auth **adherence to the wave-0 charter** · dead code · dependency audit · client/server bundle boundaries (the S18 `sharp` lesson) · config (next/ts/eslint) · **`scripts/**`** (incl. `seed-admin.ts` — auth-relevant) · test-suite health · **observability lens**: logging/alerting seams on the surfaces the trial exercises (valor/telegram/whatsapp webhooks, inventory auto-send) · docs drift. |
| **7** | **Naldo's areas — READ-ONLY** | `app/page.tsx` · `components/dashboard/**` · `lib/dashboard/**` (inbox store 1,141L) · `api/dashboard/**` · jobs/invoices **console pages** (money-bearing *routes* are wave 1's) · inbox routes + ingest webhooks · **the inventory stack** (`lib/inventory/**` incl. `materialsProjection.ts` + `purchaseOrder.ts` auto-send · `app/inventory/**` · `components/inventory/**`) · `app/insights`. Output = handoff doc; **no routine PRs from us** (CRITICAL protocol in decision 3). |

**Execution order:** 0 → 1 → **7-audit runs EARLY, alongside wave 2** (it has no fix phase on
our side — pure read → handoff — and running it late would squander Naldo's lead time before
the Aug–Oct trial; precedent: both #80 CRITICALs lived in exactly this surface, and the inbox
ingests external webhooks) → 2 → 3 → 4 → 5 → 6. Wave numbers are identity labels, not order.

## Per-wave loop

1. **AUDIT** — one multi-agent workflow: dimension finders (bug / perf / refactor /
   dead-code / consistency lenses per area, + the wave-specific lenses above) →
   **adversarial verify every finding** (skeptic re-reads live code to refute; refactor
   findings verified on a different lens — *is the payoff real, is it safe, does it violate
   surgical-change/simplicity-first*) → dedupe vs known-findings ledger → completeness
   critic → append wave section to the report.
2. **DISPOSITION** — sit-down with Jason: CRITICAL/HIGH/MEDIUM individually; LOWs batched
   (default `accept`, pull-up to fix).
3. **FIX** — normal PR discipline: TDD, gates green (`tsc · lint · vitest`), never-stale
   re-gates, **conventions-charter adherence**, merges only on Jason's explicit go.
   **Characterization-test gate:** refactoring a thin-coverage file requires
   characterization tests FIRST (coverage map from wave 0 says which; pricingEngine is
   well-covered, QuoteBuilder likely isn't).
4. **CLOSE WAVE** — update the report · **convert fix-laters to ledger rows** · append
   hand-to-Naldo items to the handoff doc · update the #110 ledger row · re-freeze baseline ·
   next wave.

## Constraints & guardrails

- **editor-core freeze** (decision 2) — applies to `editor-core/**` + `sceneTypes.ts`
  structure; additive/bugfix changes relay byte-identical per the standing convention.
- **Naldo's lane** (decision 3) — wave-7 findings and any SHARED-file fix get his heads-up;
  audit reads are always fine; CRITICAL protocol above.
- Refactor fixes follow the Karpathy guidelines — surgical, payoff-argued, no
  refactor-for-its-own-sake; a finding without a concrete payoff is `accept`.
- Findings are point-in-time: **verify against live code before fixing** (the #80 staleness
  caveat, kept). The mechanical re-open rule governs dedupe.
- Timing: fix waves should land **before the Aug–Oct Jobber trial** — churn gets riskier once
  the trial runs.

## Definition of done

- **Wave 0:** manifest 100% assigned · charter written · dedupe ledger seeded · handoff doc
  + report + schema scaffolded · coverage map produced.
- **Per wave:** report section appended · every finding dispositioned · fix-now PRs merged +
  gates green · fix-laters converted to ledger rows · handoff appended · ledger updated.
- **Overall (#110 complete):** all 8 waves closed · scorecard written (same 6 dimensions as
  #80) · #29 spec seeded from wave-3 editor findings · Naldo handoff delivered.

## Cost expectation

Each audit wave ≈ one multi-agent workflow (~10–20 agents); fix phases are normal PR work.
Whole epic ≈ 4–6 sessions. Wave 0 + wave 1 audit fit in one session.

## Revision log

- 2026-07-02 — v1 drafted (Jason S20).
- 2026-07-02 — **v2 after the plan-critic-lite pass** (1 adversarial agent, 17 findings:
  2 BLOCKER · 5 SHOULD-FIX · 10 NICE — all accepted, finding 7 partially). Folded in:
  coverage manifest + 100%-assignment DoD (B1) · named the orphan subsystems — inventory
  stack, `amend.ts`, auth perimeter, GHL, jobs/pipeline, googleMaps/geo, insights, the
  non-`/api` photos route, scripts, dual schema files (B1/2/3) · money-bearing routes → wave
  1 regardless of console ownership (2) · `adapter.ts` audited once (4) · wave-7 audit moved
  early (5) · wave-0 conventions charter, wave 6 audits adherence (6) · editor.ts refactor
  lens coarsened to survive drift (7) · LOW-batching disposition ergonomics (8) ·
  fix-later→ledger at wave close (9) · dedupe seed sources named incl. archives + timeboxed
  (10) · doc self-contradiction fixed (11) · CRITICAL-in-Naldo's-lane protocol (12) ·
  mechanical re-open rule (13) · handoff doc created wave 0 (14) · AI token-cost lens wave 5
  (15) · a11y checklist wave 4 (16) · observability lens wave 6 (17).
