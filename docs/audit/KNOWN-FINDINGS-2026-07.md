# Known findings — dedupe ledger (#110)

> Seeded 2026-07-02 from #80 (AUDIT-2026-06-26) + PR #300 + S17–S19 review dispositions.
> Audit waves check candidates here before reporting. Re-open rule: a finding re-opens iff
> `git log --since=2026-06-26 -- <file>` touches the cited function/lines (see AUDIT-PLAN-2026-07.md).
> Waves APPEND newly-dispositioned findings here at wave close.
>
> Statuses: FIXED / ACCEPTED / DEFERRED / OPEN, plus **PARTIAL** (part shipped, remainder open — remainder named in summary)
> and **UNKNOWN** (fix status not determinable from the record — do not assume either way).
> Fix-wave key: **PR #152** = first audit-fix PR (pricing guards, portal boundaries, timeouts, viewport, headers, merged 2026-06-27);
> **PR #157** = GHL stage-sync persistence; **PR #173** = "Apply all audit fixes" (18 `audit2/g*` branches, g-number cited per row);
> **PR #222** = #81 operator auth perimeter (Supabase Auth, live on prod since S12, prod-probed S15);
> **PR #227/#228/#229/#230** = #90 hardening (RLS / created_by / retention cron / portal errors); **PR #236** = garland sections;
> **PR #290** = sceneLinks stable-id match (S17 #104 PR2); **PR #295/#298/#303/#304** = S17–S18 review fixes; **PR #300** = #83 pipeline fixes.

## #80 findings (109)

Ids #80-001…#80-101 = `_verified-raw.json` array order; #80-102…#80-109 = the 8 gap-pass findings (MD order, marked `_(gap pass)_` in AUDIT-2026-06-26.md).

| id | sev | file/area | summary | status | via |
|---|---|---|---|---|---|
| #80-001 | CRITICAL | src/app/customers/page.tsx | Customers list page server-renders all customers' PII unauthenticated | FIXED | PR #222 |
| #80-002 | CRITICAL | src/app/api/integrations/highlevel/contacts/route.ts | Unauthenticated CRM contact search enables full customer-PII enumeration | FIXED | PR #222 |
| #80-003 | HIGH | src/app/customers/[contactId]/page.tsx | Customer detail page leaks CRM PII to anonymous visitors (no auth) | FIXED | PR #222 |
| #80-004 | HIGH | src/app/admin/quotes/page.tsx | Operator pages have no server-side auth — full staff UI renders anonymously | FIXED | PR #222 |
| #80-005 | HIGH | src/app/api/save-correction/route.ts | save-correction persists fully unvalidated body into the AI training corpus | FIXED | route removed (corrections flow retired; no /api/save-correction today) |
| #80-006 | HIGH | src/app/portal/[quoteId]/page.tsx | No error/not-found boundary: bare Next.js page on missing quote / Supabase-down | FIXED | PR #152 (+#230) |
| #80-007 | HIGH | src/app/api/settings/route.ts (+training/uploads/designs) | Entire operator API surface is unauthenticated | FIXED | PR #222 (26 routes migrated to requireOperator/requireAdmin) |
| #80-008 | HIGH | src/app/api/integrations/highlevel/attach/route.ts | Unauthenticated CRM attach/create — pipeline vandalism + quote-row poisoning | FIXED | PR #222 (+#173 g20) |
| #80-009 | MEDIUM | src/lib/quotes.ts | deleteAllQuotes one-call full-PII wipe reachable from weakly-gated delete route | FIXED | PR #173 g29 (confirm token) + #222 |
| #80-010 | MEDIUM | src/lib/dashboard/queries.ts | Insights/close-ratio metrics silently degrade on query failure / 500-row cap | FIXED | PR #173 g26 |
| #80-011 | MEDIUM | src/lib/design/seedFromAnalysis.ts | Garland section count silently falls back to 1 without calibration (under-bill) | FIXED | PR #236 (yardstick-scale, axis-aware, + unscaled warning) |
| #80-012 | MEDIUM | db/schema.sql (photos/corrections/training tables) | Full base64 images embedded inline in DB rows — bloat, log-leak, PII at rest | OPEN | — |
| #80-013 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Snapshot price and internal-email price can disagree (two sources of truth) | FIXED | PR #173 g1 (server recompute is single source) |
| #80-014 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Approve trusts client-supplied total/deposit, no server-side recompute | FIXED | PR #173 g1 |
| #80-015 | MEDIUM | src/app/api/save-correction/route.ts | saveCorrection accepts unauthenticated, unvalidated payload feeding the few-shot | FIXED | route removed |
| #80-016 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | $1,000 order minimum gate client-only, bypassable via direct API call | FIXED | PR #173 g1 (server threshold aligned) |
| #80-017 | MEDIUM | src/app/api/quotes/route.ts | GET /api/quotes lists all quotes (names, addresses, totals) with no auth | FIXED | PR #222 (first gated #152, reverted #176 as prod regression, re-gated by auth perimeter) |
| #80-018 | MEDIUM | src/lib/googleMaps.ts | Google Maps fetch() calls have no timeout/AbortController | FIXED | PR #152 |
| #80-019 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Approve email/SMS failures silently lost — staff never learn | FIXED | PR #173 (approval-notify-marker migration) |
| #80-020 | MEDIUM | src/lib/rateLimit.ts | In-memory rate limiter per-process and unbounded — weak Google cost-DoS guard | PARTIAL | PR #173 g22 (Map now bounded/evicting; still per-process in-memory) |
| #80-021 | MEDIUM | src/app/api/quotes/route.ts | Single static admin secret — no rotation/expiry/identity, sessionStorage | FIXED | PR #222 (per-user Supabase Auth) |
| #80-022 | MEDIUM | db/schema.sql | No creator/actor attribution on quotes — zero audit trail | FIXED | PR #228 (created_by trail; column added #173 g29) |
| #80-023 | MEDIUM | src/app/api/designs/[id]/photo/route.ts | Design/satellite photo upload has no size limit — JSON-body DoS | FIXED | PR #173 g5 |
| #80-024 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Portal/approve/send links are bare UUIDs that never expire | OPEN | — |
| #80-025 | MEDIUM | src/components/portal/snowglobe/InteractiveHero.tsx | Hero render image has no onError fallback (broken-image icon) | FIXED | PR #173 g11 |
| #80-026 | MEDIUM | src/components/portal/snowglobe/StickyBottomBar.tsx | Approve failure surfaces raw technical error string to the customer | FIXED | PR #173 g10 |
| #80-027 | MEDIUM | src/lib/quotes.ts; src/lib/designs.ts | Customer property photos never deleted — indefinite PII retention | FIXED | PR #173 g27 (erase on delete) + #229 (retention cron — NOTE: cron is dormant) |
| #80-028 | MEDIUM | src/app/layout.tsx | No viewport meta — iOS safe-area insets resolve to 0 | FIXED | PR #152 (viewportFit:'cover') |
| #80-029 | MEDIUM | src/app/api/quote/route.ts | quote POST unauthenticated, persists arbitrary rows / re-prices existing quotes | FIXED | PR #173 g3 (validation) + #222 (auth) |
| #80-030 | MEDIUM | src/components/design/DesignCanvas.tsx | Live design hero has no loading/skeleton state — blank stage on 3G/4G | FIXED | PR #173 g11 |
| #80-031 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Approve trusts client-sent dollar amounts without server recompute | FIXED | PR #173 g1 |
| #80-032 | MEDIUM | src/app/api/quotes/[id]/approve/route.ts | Approve stores client total/deposit verbatim into the authoritative snapshot | FIXED | PR #173 g1 |
| #80-033 | MEDIUM | src/app/api/quotes/[id]/send/route.ts | /send + /approve swallow GHL failures — no durable record or staff alert | FIXED | PR #157 (stage-sync state + ?retryGhl) |
| #80-034 | MEDIUM | src/lib/portal/sceneLinks.ts | sceneLinks zips per-category by order — mis-links after post-Calculate edits | FIXED | PR #173 g9 (count guard) + #290 (stable-id match, reorder/swap-proof) |
| #80-035 | MEDIUM | src/app/api/training-examples/route.ts | Unauthenticated training writes can poison future analyses via few-shot | FIXED | PR #222 (route now requireOperator) |
| #80-036 | MEDIUM | src/app/api/training/route.ts | training POST inserts unvalidated numbers/arrays/photos into training_houses | PARTIAL | auth via #222; payload validation not verified in any fix wave |
| #80-037 | MEDIUM | db/schema.sql | All PII tables have RLS disabled — single key leak exposes every record | FIXED | PR #227 (RLS on all 14 tables, verified on prod) |
| #80-038 | LOW | src/app/api/integrations/homeworks/signed/route.ts | Shelved-but-live home.works webhook can advance any quote's pipeline stage | OPEN | — (hardened by #173 g21 but endpoint remains live) |
| #80-039 | LOW | src/lib/design/projectScene.ts | Projection defaults on AI-detected enums can mask dropped detections | FIXED | PR #173 g6 (flag defaulted bindings) |
| #80-040 | LOW | src/lib/portal/derivePackages.ts | Deposit/total NaN-safety relies on client numbers; $0 deposit no floor | FIXED | PR #173 g1 (server recompute + server min-gate) |
| #80-041 | LOW | src/app/admin/quotes/page.tsx | Admin quote list: no draft status, no creator, 500 cap, no filter/search | FIXED | PR #173 g31 |
| #80-042 | LOW | src/app/api | No health/monitoring endpoint — outages invisible | FIXED | PR #173 g30 (/api/health) |
| #80-043 | LOW | src/components/portal/snowglobe/StickyBottomBar.tsx | Sticky Approve bar: no max-width guard, long totals can clip CTA on 320px | OPEN | — |
| #80-044 | LOW | src/app/api/quotes/[id]/approve/route.ts | Double-approve race: read-then-write idempotency (TOCTOU), double notifications | FIXED | PR #173 g1 |
| #80-045 | LOW | src/app/api/integrations/homeworks/signed/route.ts | /signed webhook secret compared with non-timing-safe !== | FIXED | PR #173 g21 |
| #80-046 | LOW | src/lib/rateLimit.ts | Rate limiter trusts first x-forwarded-for value (spoofable key) | OPEN | — (re-verified 2026-07-02: getIp still reads first XFF) |
| #80-047 | LOW | src/lib/design/seedFromAnalysis.ts | derivePxPerFoot ignores winterWonderland lines — WW-only drawings get no scale | FIXED | PR #173 g16 (WW calibration) |
| #80-048 | LOW | src/app/api/integrations/homeworks/signed/route.ts | /signed accepts 'signed' event for any quote, no prior-state precondition | UNKNOWN | #173 g21 made idempotency atomic; precondition coverage unverified |
| #80-049 | LOW | src/app/portal/portal-snowglobe.css | Hero 100svh + min-height:640px clips short landscape phones | OPEN | — (re-verified 2026-07-02: still present) |
| #80-050 | LOW | src/app/photos/[...path]/route.ts | /photos/[...path] is an unvalidated open redirect | FIXED | PR #173 g28 (path validation) |
| #80-051 | LOW | src/app/api/corrections/[id]/route.ts (+training/references) | Missing UUID validation → Postgres 22P02 surfaced as 404/500 | FIXED | PR #173 g4 (training/references); corrections routes since removed |
| #80-052 | LOW | src/lib/photoAnalysis.ts | User-controlled houseStyleHint concatenated raw into the system prompt | FIXED | PR #173 g14 (cap hint) |
| #80-053 | LOW | src/app/api/integrations/homeworks/send/route.ts | home.works integration live with no kill switch + stale-doc contradiction | OPEN | — |
| #80-054 | LOW | src/app/api/integrations/highlevel/attach/route.ts | attach swallows DB write-back failure and still reports success | FIXED | PR #173 g20 (linked:false) |
| #80-055 | LOW | src/app/api/quote/route.ts | Weak quoteId regex matches non-UUID strings, mis-routing save vs update | FIXED | PR #173 g3 |
| #80-056 | LOW | src/lib/portal/derivePackages.ts | effectiveTaxRate divides by per-quote taxableAmount — near-zero inflates rate | FIXED | PR #173 g18 (canonical rate) |
| #80-057 | LOW | src/app/portal/[quoteId]/page.tsx | No 'this isn't my house / something's wrong' path — customer dead-ends | OPEN | — (explicitly scoped OUT of #173 g12) |
| #80-058 | LOW | src/lib/fewShot.ts | Few-shot ranking silently degrades similarity→recency with no staff signal | FIXED | PR #173 g15 |
| #80-059 | LOW | src/app/customers/[contactId]/page.tsx | notFound() branch = GHL contact-id enumeration oracle | FIXED | PR #222 (page now behind auth) |
| #80-060 | LOW | src/components/portal/dark/Gallery.tsx | Lightbox high-res swap Unsplash-only — broken/low-res zoom on real photos | FIXED | PR #173 g24 |
| #80-061 | LOW | src/app/api/integrations/homeworks/signed/route.ts | /signed check-then-update TOCTOU — concurrent Zapier retries double-fire | FIXED | PR #173 g21 (atomic) |
| #80-062 | LOW | src/app/api/integrations/homeworks/* | Shelved home.works inbound + outbound webhooks remain fully wired/active | OPEN | — |
| #80-063 | LOW | src/app/api/quote/route.ts | Quote input arrays accepted unbounded and unvalidated element-wise | FIXED | PR #173 g3 |
| #80-064 | LOW | src/app/api/quotes/[id]/approve/route.ts | Approve accepts arbitrary selectedItemIds, no validation vs quote's line items | FIXED | PR #173 g1 (drops unknown/tampered ids — verified in live code) |
| #80-065 | LOW | src/lib/customUploads.ts | Uploaded SVGs in public bucket served via /photos — stored-XSS vector | FIXED | PR #173 g28 (SVG blocked) |
| #80-066 | LOW | src/lib/photoAnalysis.ts | Analyzer JSON trusted as PhotoAnalysisResult without validation | FIXED | PR #173 g14 (coerce scalars) |
| #80-067 | LOW | src/lib/pricing/pricingEngine.ts | Spritzer quantity collapses stakes into one un-splittable portal toggle | OPEN | — |
| #80-068 | LOW | src/app/api/quotes/[id]/send/route.ts | Send endpoint has no admin auth — UUID alone triggers CRM moves + messages | FIXED | PR #222 (verified: requireOperator in route) |
| #80-069 | LOW | src/app/admin/quotes/page.tsx | No manual-review gate/oversight signal before a quote is customer-approvable | OPEN | — |
| #80-070 | LOW | src/app/api/quotes/[id]/approve/route.ts | Pre-ValorPay approve→payment handoff has no integrity controls | UNKNOWN | Valor since shipped (flag + webhook + #309 deposit reconciliation); original framing outdated — re-audit under current flow |
| #80-071 | LOW | src/components/portal/snowglobe/InteractiveHero.tsx | pt-safe/pb-safe classes are undefined no-ops | OPEN | — (re-verified 2026-07-02: still undefined) |
| #80-072 | LOW | src/components/portal/snowglobe/StickyBottomBar.tsx | Approve label 'Opening' misrepresents a network-bound, failing-able request | FIXED | PR #173 g10 |
| #80-073 | LOW | src/lib/design/seedFromAnalysis.ts | Garland run length uses box WIDTH only — undercounts angled/vertical runs | FIXED | PR #173 g16 (longer-axis run) |
| #80-074 | LOW | src/lib/portal/derivePackages.ts | Early-install discount can exceed subtotal → negative taxable/total | FIXED | PR #152 (discount clamp) |
| #80-075 | LOW | src/app/api/quotes/[id]/approve/route.ts | Selected item ids not validated against the quote's actual line items | FIXED | PR #173 g1 (dup of #80-064) |
| #80-076 | LOW | src/lib/pricing/pricingEngine.ts | autoRooflineChoice 'pick the larger' tie-break keeps the smaller on a tie | OPEN | — |
| #80-077 | LOW | src/app/api/analyze-address/route.ts | No caching of geocode/Street View/satellite per address | OPEN | — |
| #80-078 | LOW | src/lib/pricing/test.ts | Stale tax rate (8.625%) + auto-minimum assumptions in dev pricing script | FIXED | PR #173 g25 |
| #80-079 | LOW | src/app/api/** | No structured logging, request IDs, or alerting — console.* only | OPEN | — |
| #80-080 | LOW | src/app/api/quotes/[id]/approve/route.ts | installDiscountUsd accepted with no upper bound | FIXED | PR #152 (+#173 g3) |
| #80-081 | LOW | src/lib/portal/derivePackages.ts | effectiveTaxRate re-derives rate by division — per-quote drift on package cards | FIXED | PR #173 g18 |
| #80-082 | LOW | src/lib/embeddings.ts | Claude vision + Voyage embedding fetches have no timeout | OPEN | — (re-verified 2026-07-02: no AbortController) |
| #80-083 | LOW | src/lib/trainingExamples.ts | Bias note recomputed from full final_scene on every analyze call | OPEN | — |
| #80-084 | LOW | src/app/api/quotes/[id]/approve/route.ts | Customer notifications best-effort — approved customer may never be told | FIXED | PR #173 (notify marker) |
| #80-085 | LOW | src/lib/design/seedFromAnalysis.ts | Mini-area density fixed visual constant vs stringCount price; column seeds drop area | UNKNOWN | #173 g16 clamped seeded stringCount; column-area part unverified |
| #80-086 | LOW | src/app/api/settings/route.ts | settings PUT silently swallows malformed colors/render input, reports success | FIXED | PR #173 g13 |
| #80-087 | LOW | src/lib/photoAnalysis.ts | normalizeLines auto-rescale can misfire on a single out-of-range point | FIXED | PR #173 g14 (median-scale) |
| #80-088 | LOW | src/app/api/quotes/route.ts | deleteAllQuotes guarded only by static shared header | FIXED | PR #173 g29 + #222 |
| #80-089 | LOW | src/app/api/analyze-address/route.ts | hasStreetView runs serially before the parallel image fetch | OPEN | — |
| #80-090 | LOW | src/app/api/designs/[id]/route.ts | Design base-photo + full data retrievable by any UUID (IDOR on house photos) | FIXED | PR #222 (verified: requireOperator on designs/[id]) |
| #80-091 | LOW | src/app/api/quotes/route.ts | Admin/webhook secrets compared with non-constant-time !== | FIXED | PR #173 g21 (+moot for admin secret after #222) |
| #80-092 | LOW | src/lib/pricing/pricingEngine.ts | Flat discount can drive subtotal/tax/total negative (no clamp) | FIXED | PR #152 |
| #80-093 | LOW | src/components/portal/dark/GoogleReviews.tsx | Carousels tap-only on touch — no swipe; Reviews dots 10px targets | OPEN | — |
| #80-094 | LOW | src/app/api/quotes/[id]/approve/route.ts | Customer can approve a quote that was never sent (no quote_sent_at gate) | UNKNOWN | PR #300 added an /approve status-gate (declined/cancelled); whether it requires SENT unverified |
| #80-095 | LOW | src/lib/integrations/highlevel.ts | Duplicate-opportunity: find-or-create matches OPEN cards only → second card | FIXED | PR #173 g19 |
| #80-096 | LOW | src/lib/integrations/highlevel.ts | GHL raw contact record only stripped in one consumer; toCrmContact attaches it | FIXED | PR #173 g19 (redact by default) |
| #80-097 | LOW | src/lib/portal/adapter.ts | Empty-quote portal opens approvable-looking but is a soft dead-end | FIXED | PR #173 g12 |
| #80-098 | LOW | src/lib/rateLimit.ts | Per-IP rate limit on CRM routes bypassable via XFF spoofing | FIXED | PR #222 (CRM routes now authed; XFF key weakness itself still open → #80-046) |
| #80-099 | LOW | src/components/portal/dark/LightColorPicker.tsx | Swatch chips fall short of the 44px tap target | FIXED | PR #173 g23 |
| #80-100 | LOW | src/lib/quotes.ts | Customer PII persisted with sentinel defaults — over-collection, no consent/retention boundary | OPEN | — (#229 cron exists but dormant; sentinels unaddressed) |
| #80-101 | LOW | src/app/api/analyze-address/route.ts | No Google quota/cost ceiling — dependency failures surface as 502 + raw message | FIXED | PR #173 g30 (raw-leak part; no quota ceiling added) |
| #80-102 | MEDIUM | src/components/quote/QuoteBuilder.tsx:1036-1038 | Calculate/Send/training-capture price the STALE scene when flushSave rejects _(gap)_ | OPEN | — |
| #80-103 | MEDIUM | src/components/design/editor-core/editor.ts:1304-1316 | Editor autosave silently drops billable geometry edit on save failure _(gap)_ | FIXED | PR #173 g8 |
| #80-104 | MEDIUM | src/lib/design/projectScene.ts:220-231 | All-excluded design resurrects staff-excluded per-unit items via legacy fallback _(gap)_ | FIXED | PR #173 g6 |
| #80-105 | MEDIUM | src/components/quote/QuoteBuilder.tsx:1056-1057 | runQuote wipes valid savedQuoteId on transient failure → silent Send no-op + dup row _(gap)_ | OPEN | — |
| #80-106 | MEDIUM | src/components/design/editor-core/yardstick.ts:60-63 | In-editor yardstick scale uses box WIDTH only — vertical reference inflates measurements _(gap)_ | FIXED | PR #173 g7 (axis-aware) |
| #80-107 | LOW | next.config.ts | No HTTP security headers (CSP, HSTS, XFO, Referrer-Policy, XCTO) _(gap)_ | PARTIAL | PR #152 (baseline headers; **CSP deferred**) |
| #80-108 | LOW | src/components/design/editor-core/editor.ts:4769 | destroy()/tab-switch flush fire-and-forget — last edit lost on navigate-away _(gap)_ | FIXED | PR #173 g8 (teardown flush recovery) |
| #80-109 | LOW | src/components/portal/dark/SatelliteRoofView.tsx | Bare-UUID portal token leaks via Referer (no Referrer-Policy) _(gap)_ | FIXED | PR #152 (Referrer-Policy header) |

**#80 counts (109):** FIXED 80 · PARTIAL 3 (#80-020, #80-036, #80-107) · UNKNOWN 4 (#80-048, #80-070, #80-085, #80-094) · OPEN 22.

### Supabase advisor items (not in the 109 — from the ledger's #80/#81 security callout)

| id | sev | file/area | summary | status | via |
|---|---|---|---|---|---|
| #80-ADV-1 | WARN | Supabase (trigger fns) | Mutable `search_path` on trigger functions | OPEN | — (ledger: optional low/WARN hardening) |
| #80-ADV-2 | WARN | Supabase (extensions) | `vector` extension installed in `public` schema | OPEN | — |
| #80-ADV-3 | WARN | Supabase Auth | Leaked-password protection off | OPEN | — |
| #80-ADV-4 | INFO | Supabase (all 14 tables) | "RLS enabled, no policy" notices ×14 | ACCEPTED | intentional for the service-role-only data model (ledger, S15) |

## #83 pipeline audit (PR #300)

Naldo's 24-agent #83 Jobber-pipeline audit (S20, 2026-07-01) → 8 trial-blocker bugs, all TDD-fixed + refute-verified in PR #300, LIVE.

| id | sev | file/area | summary | status | via |
|---|---|---|---|---|---|
| #83-001 | CRITICAL | quote send/resend flow | changes_requested → resend dead-end (quote could not be re-sent after change request) | FIXED | PR #300 |
| #83-002 | HIGH | /api/quotes/[id]/approve | /approve had no status gate — declined/cancelled quotes were re-approvable | FIXED | PR #300 |
| #83-003 | HIGH | portal loader/adapter | Portal rendered approve+pay UI on dead (declined/cancelled) quotes | FIXED | PR #300 |
| #83-004 | HIGH | invoices (tax override) | Tax override un-paid a paid invoice | FIXED | PR #300 |
| #83-005 | HIGH | Valor balance webhook | Cancelled-invoice balance webhook resurrected the cancelled invoice | FIXED | PR #300 |
| #83-006 | HIGH | dashboard queries (Naldo #6) | Cancelled orders counted as booked revenue | FIXED | PR #300 |
| #83-007 | MEDIUM | invoices breakdown | Invoice breakdown didn't reconcile (line items vs totals) | FIXED | PR #300 |
| #83-008 | MEDIUM | amend route | Amend re-synced a stale `paid_at` | FIXED | PR #300 |

**#83 counts (8):** FIXED 8. _(Severity labels here are approximate — Naldo's log labels only #83-001 explicitly ("CRITICAL"); the rest are seeded from the trial-blocker framing. File/area is coarse — dedupe on the behavior summary.)_

## S17–S19 review dispositions

Adversarial-review + device-round findings with recorded dispositions (Jason's sessions S17–S19, 2026-07-01/02). Partial seeding — only findings specific enough to dedupe against; S18's un-enumerated "accepted the low pre-launch ones" (across the #107/#52/#108 reviews) are NOT itemized here and may legitimately resurface.

| id | sev | file/area | summary | status | via |
|---|---|---|---|---|---|
| #R17-001 | LOW | #102 custom $/ft (pricingEngine/QuoteBuilder) | Stale `*CustomRate` field kept when Difficulty dropdown returns to a preset — degrades to preset rate | ACCEPTED | S17 #102 review disposition |
| #R17-002 | LOW | #104 EditablePrice (builder) | "custom · was $X" chip misleading on builder reopen | FIXED | PR #295 |
| #R17-003 | LOW | #104 price overrides (engine) | Stale line-item price override after the underlying line changes/vanishes = KEEP + FLAG (not auto-drop) | ACCEPTED | S17 #104 locked decision |
| #R17-004 | LOW | #104 (builder) | Custom-row + no-design-row click-to-edit price | DEFERRED | S17 (custom items already editable in their section) |
| #R18-001 | MEDIUM | #107 fullYule ceiling (pricingEngine) | Ceiling must be Math.max true-max — a #104 override could invert gingerbread-vs-santas | FIXED | PR #298 (pre-merge review fix) |
| #R18-002 | LOW | #107 GHL deposit webhook | monetaryValue pushed without `>0` guard | FIXED | PR #298 (pre-merge review fix) |
| #R18-003 | LOW | #52 training-example editor | stringCount edits unclamped → clamp ≤500 | FIXED | PR #304 (pre-merge review fix) |
| #R18-004 | LOW | #52 training-example editor | Curtain edits labeled "stored · not yet AI-trained"; curtain analyzer vocabulary consciously NOT taught | ACCEPTED | S18 decision (teaching curtains = separate future task) |
| #R18-005 | LOW | #52 training UI (pieces-derived read-only panel) | Curtain edit not echoed in the read-only pieces panel — flagged + tagged, not fully reconciled | OPEN | — (S18 close note) |
| #R18-006 | HIGH | /training/new + QuoteBuilder (railing type) | Railing type-widen left 2 stale narrow consumers (`as`-cast laundered) — /training/new ship-blocker | FIXED | PR #303 (pre-merge review fix) |
| #R18-007 | LOW | #108 railing AI (live) | Live AI railing-DETECTION on a real railing house unverified at ship | DEFERRED | still on the NEXT list at S19 close |
| #R19-001 | MEDIUM | sceneLinks twin-expansion / photo-tag chips | Twin-expansion leaked twin ids into the photo-tag chip lookup — canonical rows mis-tagged | FIXED | #13 CP2 fix round (device catch) |
| #R19-002 | MEDIUM | garland TRACE mode (editor-core) | TRACE-mode commit path was the 1-of-14 item-creation site missing the photoId stamp — traced garland landed on photo 1 | FIXED | commit 95c1580 (#13 CP3 fix round) |
| #R19-003 | LOW | portal hero (multi-photo strip) | Hero thumbnail strip placement — moved BELOW the big price per Jason's sketch | FIXED | PR #323 + fix round |
| #R19-004 | LOW | #13 extra photos (AI) | Extra photos are MANUAL-only: no AI analysis, no cross-photo dedup — staff disambiguate via draw-vs-stamp | ACCEPTED | S19 locked decision |
| #R19-005 | LOW | portal "Every angle, lit up" gallery | Gallery placement is a 🧪 trial — kept after device review, final verdict awaits real-customer feel | ACCEPTED | S19 (trial; revisit) |
| #R19-006 | LOW | #54 completed-install analyzer | Pre-fill from stored design + operator known-numbers flywheel (council's bigger prize) | DEFERRED | → ledger #109 |
| #R19-007 | LOW | training_houses schema | House Style / Scale Anchor / Didn't Install DB columns kept nullable after UI removal (#53) | ACCEPTED | S19 (legacy rows) |

**S17–S19 counts (18):** FIXED 8 · ACCEPTED 6 · DEFERRED 3 · OPEN 1.

---

## Wave 1 dispositions (#110 money core, 2026-07-04)

> Full findings + evidence in `AUDIT-2026-07.md` (Wave 1). Recorded here so later waves
> touching money-core files don't re-report. 79 findings: 1 CRIT / 4 HIGH / 19 MED / 55 LOW.

**FIXED — merged to master `1e65602` (PRs #329/#330/#331/#334/#336):**
W1-001 (CRIT, invoices.ts — bill agreed selection total) · W1-002/003 (quote route: canonical minilight types, booked re-price 409) · W1-004 (amend delta on agreed basis) · W1-005 (adapter filter by stable id) · W1-007/011/014/016/017/018/022/023 (status-guard/race) · W1-009/015/021/024 (close-invoice guard, pay-stamp race, valor timeout, discount clamp) · W1-027/050 (parallel notifications) · W1-043 (convert-to-job clamp) · W1-063 (dead Passage.js deleted) · W1-064 (shared round2). **= 23 fix-nows.**

**FIX-LATER — #110 W1 tail:** **FIXED S21 (2026-07-04, master `13ba733`, PRs #402/#403/#404):** W1-006 (double-charge record+email+log) · W1-008 (cancel-refund record+email+log) · W1-010 + W1-013 (money-path tests) · W1-020 (GHL knob). **W1-019 was ALREADY FIXED** (W2-031+W4-016+W4-033, S20). **STILL OPEN:** W1-012 (auto-charge blocker — VALOR-AUTOCHARGE doc, gated on Jason/Valor) · W1-068 (job line_items filter — cosmetic, Naldo's jobs.ts → hand to Naldo).

**ACCEPTED (LOW hygiene/docs-drift, not fixed) + known-open carried:** the remaining ~49 LOWs
(consistency nits, docs-drift incl. W1-040 which resolved ledger UNKNOWN #80-094 as intentional)
— see the Wave 1 LOW table in `AUDIT-2026-07.md`. Known-open re-confirmed: W1-073 (= #80-076
autoRoofline tie), W1-074 (multi-spritzer single line).

**REFUTED (11):** dropped in adversarial verify — not real; not carried.

---

## Wave 3 dispositions (#110 dense files, 2026-07-04)

> Full findings + evidence in `AUDIT-2026-07.md` (Wave 3). Recorded so later waves touching
> `editor.ts` / `QuoteBuilder.tsx` / `training/new` don't re-report. 30 findings: 3 HIGH / 15 MED / 11 LOW, **0 refuted**.

**FIXED — merged to master `3ed2a6f` (PRs #369 editor / #370 QuoteBuilder / #371 training):**
W3-001 (HIGH, footage null-preserve refs) · W3-002+W3-030 (HIGH, clone strips groupId/linkedToId) · W3-003 (HIGH, breakdown filters by stable id — W1-005 sibling) · W3-004 (**closes #80-105**) · W3-005 (rooflineChoice revert) · W3-006 (**closes #80-102 capture half**) · W3-007 (flip-axis scheduleSave) · W3-008 (doSave saveSeq — UI-race) · W3-009 (isMiniArea centroid/shift) · W3-010 (billing-link surface match) · W3-011 (stamp-disarm) · W3-013 (railing box formula) · W3-014 (per-photo markup) · W3-015 (breakdownLinked useMemo). **= 16 fix-nows.** editor.ts shared hunks relayed to design-tool `main` `8673a68`.

**FEED-#29 (editor restyle spec seed, `docs/audit/EDITOR-29-SPEC-SEED.md`) — NOT fixed (frozen file):**
W3-017 (renderEditor one-function) · W3-018 (renderSidebar god-fn) · W3-019 (9× renderSelected triad) · W3-020 (mousedown god-fn) · W3-026 (redrawCanvas dispatch) · W3-027 (9× bake* dup) · W3-028 (monolithic ToolState).

**FIX-LATER — ledger backlog (#110 W3 tail), NOT yet fixed:**
W3-008 server-reorder half (self-heals; in-flight guard deferred in frozen editor.ts) · **#80-102 runQuote/Send flush-swallow** (non-capture half, out of W3 dispositioned scope) · training per-photo calibration (feetPerUnit stays whole-house).

**ACCEPTED (11 LOW → ledger, not fixed):** W3-012 (deleteSelected memberIds prune) · W3-016 (setDifficulty rule untestable) · W3-021 (removePhoto activeIdx) · W3-022 (stake line mislabel, cosmetic) · W3-023 (dead active*Lines aliases) · W3-024 (training detection-box JSX dup) · W3-025 (string-count formula dup) · W3-029 (training test-gap) · W3-026/027/028 (also feed-#29).

---

## Wave 6 dispositions (#110 routes + cross-cutting, 2026-07-04)

> Full findings + evidence in `AUDIT-2026-07.md` (Wave 6). 18 findings: 2 HIGH / 7 MED / 9 LOW, **0 refuted**.
> The #81 auth perimeter itself is sound (no bypass); the security findings are allowlist omissions that fail closed.
> **Audited disposition-only S21 (2026-07-04); FIXED S21 (2026-07-04 resume)** — Jason chose fix-all-HIGH/MED+cheap-LOW.

**FIXED — merged to master `ce7632f` (PRs #394 auth / #395 designs+obs, vitest 2146):**
- **HIGH:** W6-002 (designs/[id]/photos getDesign→404 before upload) · W6-GAP-1 (login `rateLimitResponse`).
- **Auth allowlist go-live cluster:** W6-001 (/api/health) · W6-005 (GET /api/quotes/[id] via a GET-only `method` param) · W6-008 (**option a**: allowlist + `requireOperator` removed + `is_test===true`→403 pre-mutation boundary). INERT until AUTH_GATE_ENABLED flips.
- **Observability:** W6-003 (valor auto-PO fail log) · W6-009 (homeworks dup-send surfaced) · W6-010 (jobs/cancel quote-status surfaced). Additive; W6-003/010 route-level, Naldo-concern → loop Naldo.
- **Test-gaps:** W6-004 (login/logout) · W6-006 (middleware) · W6-011 (designs/[id]) · W6-016 (interested) · W6-017 (hotkeys). **LOW:** W6-014 (comment) · W6-015 (NaN guard).

**HELD — PR #396 (SHARED files, Naldo reviews first):** W6-012 (eslint/vitest `.claude/**` ignore — the worktree-pollution gate gotcha, fixed at tooling level).

**DEFERRED:** W6-013 (middleware→proxy Next.js 16 convention rename — its own task).

**HAND-TO-NALDO:** W6-007 — 6 event/permanent money engines never audited → money-lens pass in `AUDIT-2026-07-NALDO-HANDOFF.md`. **Manifest generator FIXED** (assigns event/permanent/agreedTotal/money → W1; regenerated, exit 0).
