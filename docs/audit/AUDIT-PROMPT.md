# Full-tool audit prompt (`/ultrareview` deep pass)

> **What this is:** a ready-to-paste prompt for a COMPLETE, multi-agent audit-and-fix pass over
> the whole quote tool, to be run in its **own dedicated 3–5h session** (NOT launched from the
> session that authored it). Authored by Naldo, 2026-06-26. Tracked as **ledger #80**.
>
> **How to use:** open a fresh Claude Code session in this repo, paste everything in the fenced
> block below as the first message, and let it run. It writes its report to `docs/audit/AUDIT-<date>.md`
> and opens one PR per confident fix (CRITICALs first, gated green, PR-not-master).
>
> **Why it's tuned the way it is:** the prompt is grounded in the tool's REAL architecture
> (staff-built quotes · GoHighLevel CRM · ValorPay hosted-page deposit · Google Maps · Claude
> Vision · $1,000 minimum · 50% deposit · no link expiry) so the auditing session doesn't waste
> cycles chasing features the tool doesn't have. It also maps each audit phase to the installed
> skills. NOTE for the running session: only invoke skills that appear in YOUR OWN system-reminder
> skills list — don't guess names; installed skills can differ machine-to-machine.

---

```
ultracode

You are a senior full-stack engineer + security specialist running a COMPLETE audit of this quote tool (the "Yule Love Lights" Next.js app you're sitting in). Find every bug, vulnerability, logic error, and improvement, then give a prioritized, fix-it action plan. Be direct — do not soften findings — but do not invent issues; every finding must cite real file:line and a concrete fix.

## HOW TO RUN IT (a deep run — 3–5 hrs of agent work is fine)
Run as a **multi-agent workflow**: one thorough finder per audit lens (the 13 sections below) → **adversarially verify EVERY finding** (a skeptic agent that tries to REFUTE it against the live code; keep only what survives) → a **completeness-critic pass** ("what did we miss — a route with no validation, a calc edge case, a secret, a retention gap, an integration failure path, a mobile surface?") → spawn finders for the gaps → synthesize. Scope = the **WHOLE tool**, not a diff. Write the report to a dated `docs/audit/AUDIT-<date>.md` AND surface the scorecard + CRITICALs in chat. Then **fix everything you're confident on** — one PR per fix (CRITICALs first), gated green, PR-not-master.

## USE YOUR INSTALLED SKILLS (invoke via the Skill tool at each stage — don't reinvent these)
Lead with the portable **superpowers** skills (they fit this repo as-is):
- **Map the codebase first** → `superpowers:using-superpowers` is already loaded; for orientation use the claude-mem `smart-explore` skill, or run `/graphify src` then query the graph (see AGENTS.md — a graph may already exist).
- **Fan out the audit + the fixes** → `superpowers:dispatching-parallel-agents` and `superpowers:subagent-driven-development`.
- **Root-cause every confirmed bug** → `superpowers:systematic-debugging` (don't guess — reproduce, then fix the cause).
- **Write each fix test-first** → `superpowers:test-driven-development` (red→green→refactor; pricing/payment/auth fixes MUST land with a failing-then-passing test).
- **Generate improvement ideas (the "suggestions" deliverable)** → `superpowers:brainstorming`.
- **Code review on your own diffs before merge** → `superpowers:requesting-code-review` + `superpowers:receiving-code-review`.
- **Isolate + land each fix cleanly** → `superpowers:using-git-worktrees`, then `superpowers:finishing-a-development-branch`.
- **The final re-review (your "make sure everything's up to date" step)** → `superpowers:verification-before-completion`.
- **Frontend / mobile / UX lens (§6, §7)** → the `frontend-design` skill.

OPTIONAL heavier path — if you'd rather run this as a formal tracked audit, the **GSD** suite can do it end-to-end, but it expects a `.planning/` structure (this repo uses `docs/context/`, so it'll scaffold one): `gsd-scan` / `gsd-map-codebase` (assess) → `gsd-secure-phase` (threat verification) → `gsd-code-review` (bugs/security/quality) → `gsd-ui-review` (6-pillar frontend audit) → `gsd-add-tests` → `gsd-audit-fix` / `gsd-code-review-fix` (autonomous find→classify→fix→test→commit) → `gsd-ship` (PR + review + merge-prep). Use this only if you want the GSD tracking overhead; otherwise stick to the superpowers skills above. Run `find-skills` or `gsd-help` if unsure what's available. **Invoke a skill BEFORE the matching stage, not after. Only invoke skills that appear in YOUR OWN system-reminder skills list — don't guess names.**

## ORIENT FIRST (cold start)
- Read `AGENTS.md` + `docs/context/task_ledger.md` + both session logs to learn the architecture and what's shipped.
- Audit the LIVE production code: branch/worktree off **fresh `origin/master`**.
- Gates for any fix: `npx tsc --noEmit` · `npm run lint` · `npm test` (vitest) — all green before a PR.

## ⚠️ WHAT THE TOOL ACTUALLY IS (audit reality — do NOT chase features it doesn't have)
- **Staff-built quotes, not auto-quotes.** Staff use `/quote/new`: Claude Vision analyzes a Google Street View + satellite image to *seed* a Konva design; staff calibrate scale (a "yardstick") + adjust. The design IS the master item list; per-unit pricing derives from it. Staff hit **Send** → a GoHighLevel opp moves to "Bid Sent" + the customer gets an SMS/email portal link. **So "is there human review?" → yes, by design.**
- **The customer** opens `/portal/[quoteId]` (a bare UUID is the only token), picks a package + colors, **Approves** → freezes an `approval_snapshot` (jsonb) → **ValorPay hosted-page 50% deposit** → a Valor webhook (HMAC-SHA256) marks the quote **booked**.
- **CRM = GoHighLevel. Payments = ValorPay. Maps = Google. DB = Supabase (Postgres, service-role on server). AI = Anthropic Claude.**
- **NOT present (don't invent):** no "Homeworks"/home.works integration (shelved), no automated warehouse-materials sync, no fully-automated satellite→quote, no in-app 24/48hr drip (that's GoHighLevel workflow config, OUTSIDE this repo — audit the code seams + flag what's config-side).
- **Order minimum = $1,000** (staff can waive), **NOT $800**. **Deposit = 50%.**
- **Confirmation/portal links have NO expiry today** (UUIDs) — a real finding, not a misassumption.

## AUDIT SCOPE — cover ALL of these (adjusted to the reality above)
1. **Bugs & logic errors** — AI design-seed accuracy (tree/bush/roofline detection + scale calibration → wrong item list → wrong quote); pricing-engine errors (under/over-quote, material-qty/footage/rounding); silent API failures; state not persisting between builder steps; edge cases (Google Maps returns no image; ambiguous property; geocode fails); any path that outputs a wrong quote.
2. **Security** — secrets exposed to the client (`NEXT_PUBLIC_*`) or committed; missing input validation/sanitization; injection (Supabase query building; **prompt injection** where address/notes/images feed Claude); CORS; **unauthenticated endpoints/admin pages** (is there ANY auth on the operator UI/API?); rate limiting (can analyze/send/approve be spammed?); image-upload validation; **IDOR** (reach another's quote/design/snapshot via the UUID? enumeration feasible?); token/session handling.
3. **Third-party integration risks** — Google Maps (key exposure, uncapped quota, failed pulls unhandled); Claude Vision (prompt injection, low-quality/low-confidence handling, the analyzer-outage fail-safe); **GoHighLevel** (job/opp silently lost if GHL is down on send/approve? webhook/trigger auth); **ValorPay** (webhook HMAC + replay/idempotency); any failure → wrong/no quote or no follow-up.
4. **Data & accuracy** — Vision margin of error → price impact; material quantities conservative or under-quoting?; the staff human-review gate; the "satellite doesn't match my property" path.
5. **Performance & reliability** — quote/analyze response time at 50+ leads/day; API calls parallel vs sequential; caching repeated Google Maps lookups per address; page-timeout-mid-quote; sync vs queued.
6. **UX & customer experience** — what the customer sees on failure; confirmation-step clarity; accidental duplicate submissions; package differentiation + pricing clarity.
7. **Mobile / iOS** (customers are 40+ homeowners on phones) — every customer page responsive, no pinch/zoom; tap targets ≥ 44×44px; satellite image on 3G/4G without timeout/layout break; inputs with correct `type`/`inputmode` (tel/email/number); body/input text ≥ 16px (iOS auto-zoom); package + approval flow with no horizontal scroll; visible loading states (avoid double-submit); enough satellite detail to confirm on a small screen; SMS/email link previews in iMessage + mobile mail; Safari/iOS specifics (100svh, position:fixed, backdrop-filter).
8. **Business-logic gaps** — pricing locked against customer inputs?; minimum enforced (**$1,000**, with staff-waive); 50% deposit on every output; can a quote ever be **$0/negative/NaN**?
9. **Customer data & privacy** — addresses/emails/phone/images stored securely; at-rest encryption (Supabase default); over-collection; **image lifecycle** (deleted vs indefinite; bucket private+signed vs public); **link expiry** (none today — flag it); PII in URLs/logs.
10. **CRM mapping** (GoHighLevel; no warehouse sync) — GHL opp fields map correctly (title/value/source/stage)?; **duplicate detection** (re-send → two opps?); flag the **absence** of warehouse/materials export + buffer as a gap if ops needs it.
11. **Follow-up automation** (lives in GoHighLevel, not this repo) — audit the code seams ("Bid Sent" move, SMS/email on send/approve); explicitly call out the 24/48hr drip, stop-on-reply, send-time windows, and touch caps as **GHL workflow config**, out of code scope.
12. **Admin & oversight** — admin view of every quote in-flight + status + creator; audit trail (who created/touched, when); manual review/override before customer; error logging (structured vs console); monitoring/alerting if the tool goes down in peak season.
13. **Missing features critical for production** — fallback if Vision fails / low-confidence; clear error vs blank screen on any step failure; fallback when the customer says the satellite image is wrong; dead-ends where the customer gets stuck.

## DELIVERABLE FORMAT
`docs/audit/AUDIT-<date>.md` with: **Executive summary** (one paragraph); **CRITICAL** (fix before peak season — could send a wrong quote, expose a vuln, or lose data), each as **[Issue] → [Root Cause, file:line] → [Exact Fix]**; **HIGH** (first week), **MEDIUM** (first month), **LOW / nice-to-have** (same format); **SUMMARY SCORECARD** rating Security / Accuracy / Reliability / Mobile / UX / Production-Readiness on **Not Ready / Needs Work / Solid / Production-Ready**, each with a one-line justification. Merge true duplicates; order within each tier by blast radius. Surface the scorecard + CRITICAL list in chat too.

## THEN FIX
One PR per fix you're confident on (CRITICALs first), test-first (`superpowers:test-driven-development`), gated green, PR-not-master, flagged for review.

## THEN RE-REVIEW (don't skip — `superpowers:verification-before-completion`)
Re-read the entire output and re-verify against the live code: nothing missed, no false positives, every "fixed" item actually merged + live, and the report + ledger reflect reality. Report what the re-review changed.
```
