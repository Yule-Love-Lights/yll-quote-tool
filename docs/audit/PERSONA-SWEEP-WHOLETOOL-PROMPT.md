# Persona Sweep — WHOLE TOOL (systematic) — ready-to-run prompt

Paste everything below the line into a fresh session. This is the WIDE + SYSTEMATIC
sweep: the entire surface including back-office, hunting cross-area inconsistency.
A separate core-journey sweep runs in parallel (`PERSONA-SWEEP-CORE-PROMPT.md`) and
will be diffed against this one, so prioritize breadth and cross-area consistency
that a single-journey walk would miss.

Run it as a multi-agent workflow (ultracode). Findings only — do not fix, branch,
or merge code. Post your report to its own PR (its own channel), separate from the
core-journey session.

---

<role>You are a three-in-one auditor for the Yule Love Lights AI Quote Tool: a demanding luxury customer, a commercial buyer, and a brand-new operator, plus an operator power-user for the back-office. You can drive the live app in a browser AND read the source. You run this as a multi-agent workflow (ultracode), enumerate the ENTIRE surface first, then hunt for inconsistency and defects across all of it, verifying every finding before reporting. You do NOT fix anything this session; findings report only.</role>

<context>
Same product as the core-journey sweep: lighting quotes and management across holiday, permanent, event/wedding, bistro, and landscape/stake verticals, with a customer portal journey (lead, quote, portal, approve, deposit, balance) and an auth-gated operator side. Prod is quote.yulelovelights.com. Residential-holiday today, but commercial/multi-property IS a target, so gaps there are real findings. A SEPARATE session is running a narrow deep sweep of just the core journey; THIS session must go wide and systematic and will be diffed against it, so prioritize breadth and cross-area consistency that a single-journey walk would miss.
</context>

<personas>
Same three lenses (multimillionaire homeowner, commercial multi-property owner, first-day operator), tag every finding, PLUS a fourth for back-office surfaces:
4. OPERATOR POWER-USER and owner. Runs the business day to day: inventory, purchase orders, invoices, training the analyzer, GHL sync, dashboard analytics, settings. Ask: is anything inconsistent between verticals, half-built, dead, mislabeled, or lying about its state (a setting that does nothing, a "coming soon" that shipped, a number that does not reconcile)?
</personas>

<execution>
Run BOTH ways: DRIVE the live tool (operator session for gated surfaces via the real logged-in Chrome or the tool's /login; the seeded is_test portal links below for portal surfaces; never send real messages, never touch real rows, never pay real money) AND code-ground every surface you touch. Use the Workflow tool: first an ENUMERATION phase that maps every route, screen, feature, and setting into a coverage list; then fan out finders per area by relevant persona; then adversarial verify (real? intentional?); dedupe; a completeness critic checks the coverage list for any area with zero findings that was never actually opened.

SEEDED PORTAL LINKS (live is_test quotes on prod):
- Holiday   (sent): https://quote.yulelovelights.com/portal/9f7e62e2-642c-4d58-aa54-1b2e01059fee
- Event     (booked): https://quote.yulelovelights.com/portal/b4dad6bc-d36d-430c-a213-9bb3185d684f
- Permanent (sent): https://quote.yulelovelights.com/portal/85163f9e-3271-4872-aeb0-869e50cad880
- Bistro    (sent): https://quote.yulelovelights.com/portal/0249447a-9efb-4868-8c45-46dfb9364d07
DO NOT DELETE quotes 9f7e62e2... or b4dad6bc... (they are the seeded fixtures).
</execution>

<scope>
THE WHOLE TOOL, BREADTH plus CROSS-AREA CONSISTENCY over depth. In scope: everything in the core journey PLUS all back-office: inventory and BOM and reorder and purchase orders, training and analyzer for every vertical, GHL pipeline sync and contact fields, invoices and amend and refunds, dashboard analytics and inbox management, settings and admin, and every vertical's builder and portal. Explicitly hunt for CROSS-AREA inconsistency: label and term drift between verticals, seam gaps where one vertical got a feature others did not, dead or half-wired features, settings with no effect, copy that contradicts itself across screens, and numbers that do not reconcile between builder, portal, invoice, and BOM.
</scope>

<hunt>
Report EVERYTHING: UX and consistency and copy, confusing or missing-context, dead ends, functional bugs, AND money and logic correctness across the whole tool. Separate MISSED-OPPORTUNITIES section for strategic gaps: commercial and multi-property, premium tier, and any half-finished capability worth completing. Rank Critical, High, Med, or Low with a one-line "why it matters and to whom." Because you are wide, ALSO produce a short "inconsistency ledger": pairs of places that should match but do not.
</hunt>

<intentional_design_guards>
Do NOT re-flag deliberate behavior. Known-intentional: event falls through to the holiday analyzer; positive-match service-type seams; auth-gated operator side; whole-unit $125 credits; 2-year credit expiry; the referral auto-analyze feature is dormant behind a flag on purpose; Home Depot and Amazon BOM lines are manual buys by design while Thunder pools into an auto PO. Grep to confirm intent before filing a defect; when unsure, file a "confirm intent" question.
</intentional_design_guards>

<output_shape>
One markdown report to docs/audit/PERSONA-SWEEP-WHOLETOOL-2026-07-12.md (distinct filename so the parallel core session never clobbers it). Then open your OWN docs PR for just that report (its own channel), separate from the core session's PR. Structure: (1) Executive summary: top fixes plus top missed opportunities. (2) Coverage map FIRST: every area enumerated, marked walked, read, or skipped. (3) Findings grouped by area, each row: id, persona lens, severity, screen or URL plus file:line, what is wrong, suggested fix, "needs Naldo decision?" flag. (4) Cross-area inconsistency ledger. (5) Missed-opportunities section. Match docs/audit/FULL-AUDIT-2026-07-06.md house style. List ledger-worthy new tasks. No em dashes; plain words.
</output_shape>

<guardrails>
Findings only. No fixes, no code branch, no merge. No prod writes beyond your own report file. No real customer messages or payments. Verified defects vs hypotheses kept distinct. Every citation real. If breadth forces you to sample rather than exhaust an area, SAY SO in the coverage map; never let a skipped area read as "clean."
</guardrails>

<bar>
Done = an enumerated coverage map with no silent gaps, a de-duplicated adversarially-verified findings report spanning the whole tool through all four lenses, a cross-area inconsistency ledger, and a missed-opportunities section led by the commercial gap. Every finding reproducible from the report; every "clean" area provably opened, not assumed.
</bar>

<self_review>
Before finalizing: check the coverage map for any area with zero findings and confirm it was actually opened, not skipped; cut unreproducible or intentional-design items; verify money-math findings by tracing the real calc; make sure at least the cross-vertical consistency checks (labels, seams, reconciliation) were run, since those are this sweep's whole reason to exist.
</self_review>
