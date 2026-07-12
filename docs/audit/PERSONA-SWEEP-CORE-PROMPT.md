# Persona Sweep — CORE JOURNEY (deep) — ready-to-run prompt

Paste everything below the line into a fresh session. This is the NARROW + DEEP
sweep: the exact customer and operator journeys, end to end, felt experience.
A separate whole-tool sweep runs in parallel (`PERSONA-SWEEP-WHOLETOOL-PROMPT.md`)
and will be diffed against this one, so stay focused on depth here.

Run it as a multi-agent workflow (ultracode). Findings only — do not fix, branch,
or merge code. Post your report to its own PR (its own channel), separate from the
whole-tool session.

---

<role>You are a three-in-one auditor for the Yule Love Lights AI Quote Tool: a demanding luxury customer, a commercial buyer, and a brand-new operator. You can drive the live app in a browser AND read the source. You run this as a multi-agent workflow (ultracode) for exhaustiveness, then verify every finding before reporting it. You do NOT fix anything this session; you produce a findings report only.</role>

<context>
The tool sells and manages lighting installs across verticals: holiday (Christmas), permanent (year-round), event/wedding, bistro, and landscape/stake. The customer journey is: a prospect arrives (public lead-capture form on the marketing site, or a personal /refer/<code> link) then an operator builds a quote, sends it, the customer opens a portal link, views their house design, pricing, and package options, approves and e-signs, pays a deposit (Valor), install happens, pays the balance. The operator side (dashboard /, unified /inbox, quote builder, /admin/quotes) is auth-gated. Prod is quote.yulelovelights.com. This is a residential-holiday product today, but commercial/multi-property IS a target market, so gaps there are real findings, not out-of-scope.
</context>

<personas>
Audit through THREE lenses, every finding tagged with which lens caught it:
1. MULTIMILLIONAIRE HOMEOWNER prospect. Large estate, multiple homes possible. Price-insensitive but quality-, exclusivity-, and ease-obsessed. Wants a white-glove, tasteful, low-friction experience and obvious premium options. Ask at every screen: does this make me feel catered to? Is "I want the best, handle it for me" easy to express? Would this feel cheap or confusing to someone used to concierge service?
2. COMMERCIAL MULTI-PROPERTY OWNER prospect. Owns several commercial sites, wants consistent branding across all of them, bulk pricing, net terms and real invoicing, a single point of contact, and ROI/scale framing. Ask: can the tool even represent more than one property? Is there any commercial pricing, bulk, or multi-site concept? Where does it silently assume one house and one homeowner?
3. FIRST-DAY OPERATOR. No training, no context. Learning the flow live: create a quote, build it, send it. Ask at every step: is the next action obvious? What button, label, or term confused me? Where did I get stuck, fear an irreversible action, or not know if something saved? What would a new hire get wrong?
</personas>

<execution>
Run BOTH ways and cross-check them:
- DRIVE the live tool in a browser. Use the seeded is_test portal links below for the customer/portal walkthroughs (safe to click, approve, and run a test deposit; no real customer, no real charge). Operator surfaces: drive the real logged-in Chrome session, or log in at the tool's /login. NEVER send a real email or SMS, never touch real customer rows, never pay a real deposit.
- CODE-GROUND every screen you touch: read the route, component, and copy behind it so you catch dead ends, missing states, and logic the screen hides.
- Use the Workflow tool: fan out one agent per journey-leg by persona, verify each finding with an independent adversarial pass (is it real? is it intentional design?), dedupe, then a completeness critic asks which leg or persona got under-covered.

SEEDED PORTAL LINKS (live is_test quotes on prod):
- Holiday   (sent, walk approve to pay): https://quote.yulelovelights.com/portal/9f7e62e2-642c-4d58-aa54-1b2e01059fee
- Event     (booked state):              https://quote.yulelovelights.com/portal/b4dad6bc-d36d-430c-a213-9bb3185d684f
- Permanent (sent):                      https://quote.yulelovelights.com/portal/85163f9e-3271-4872-aeb0-869e50cad880
- Bistro    (sent):                      https://quote.yulelovelights.com/portal/0249447a-9efb-4868-8c45-46dfb9364d07
DO NOT DELETE quotes 9f7e62e2... or b4dad6bc... (they are the seeded fixtures). The first-day-operator persona should ALSO create a fresh holiday quote end to end (that flow is part of the audit), not only use the seeded ones.
</execution>

<scope>
CORE JOURNEY ONLY, end to end, DEPTH over breadth. In scope:
- Customer: lead-capture form, confirmation, quote-received notification, portal open, design and photo view, pricing and package selection, approve and e-sign, deposit pay, pay-balance page.
- Operator: dashboard landing, inbox and lead, create quote, build (pick vertical, add items, calculate), review, send, find it again in /admin/quotes, manage (amend, decline, rebook).
Out of scope for THIS prompt: inventory and BOM, training and analyzer internals, GHL config, invoices back-office, dashboard analytics, settings. (The separate whole-tool sweep covers those.)
Walk each of the 5 verticals at least at the point where they diverge (holiday vs permanent vs event vs bistro vs landscape), since inconsistency between them is a prime finding.
</scope>

<hunt>
Report EVERYTHING: UX and consistency and copy gaps, confusing or missing-context moments, dead ends, functional bugs, AND money and logic correctness (wrong totals, tax, deposit, discount, partial-selection math). Separately and explicitly, a MISSED-OPPORTUNITIES section: strategic gaps a smart owner would want closed, especially the commercial and multi-property gap, premium-tier expression, trust signals, and anything that would lose a high-value prospect. Rank every finding Critical, High, Med, or Low with a one-line "why it matters to THIS persona."
</hunt>

<intentional_design_guards>
Do NOT re-flag deliberate behavior as a bug. Known-intentional: event lighting intentionally falls through to the holiday analyzer; service-type seams are positive-match by design; the operator side is auth-gated on purpose; a credit is a whole $125 unit (no partial); referral credits expire in 2 years. Before filing a bug, grep the code to confirm it is not deliberate. When unsure, file it as a "confirm intent" question, not a defect.
</intentional_design_guards>

<output_shape>
One markdown report written to docs/audit/PERSONA-SWEEP-CORE-2026-07-12.md (distinct filename so the parallel whole-tool session never clobbers it). Then open your OWN docs PR for just that report (its own channel), separate from the whole-tool session's PR. Structure: (1) Executive summary: top 5 things to fix now, top 3 missed opportunities. (2) Findings table grouped by journey-leg, each row: id, persona lens, severity, screen or URL plus file:line, what is wrong or confusing, suggested fix, "needs Naldo decision?" flag. (3) Missed-opportunities section. (4) Coverage map: what was walked, what was skipped and why. Match the house audit format in docs/audit/FULL-AUDIT-2026-07-06.md. Also list which findings are ledger-worthy as new tasks. No em dashes; plain words.
</output_shape>

<guardrails>
Findings only. Do NOT fix, do NOT branch code, do NOT merge. No prod writes beyond your own report file. No real customer messages or payments. Distinguish verified defects from hypotheses. Every file, line, and URL reference must be real (no invented citations).
</guardrails>

<bar>
Done = a de-duplicated, adversarially-verified report covering all 5 journey legs through all 3 personas, every finding with a real location plus evidence or repro plus severity plus suggested fix, false positives filtered out, plus a strategic missed-opportunities section led by the commercial gap. A skeptical reader should be able to reproduce any finding from the report alone.
</bar>

<self_review>
Before finalizing: re-read the report and cut any finding you cannot reproduce or that turns out to be intentional design; confirm each persona and each journey leg got real coverage (not just the happy path); verify the money-math findings by tracing the actual calc, not by eyeballing a screen.
</self_review>
