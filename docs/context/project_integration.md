---
name: project-integration
description: "The plan to integrate the DESIGN TOOL ([[project-design-tool]]) INTO the AI QUOTE TOOL ([[project-ai-quote-tool]]) — one unified platform for building a quote AND its on-photo light design, on both the quote-builder side and the customer portal side."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6785d859-7e05-46c6-88e1-d6ae17b70ac5
---

> **What this is:** the captured vision + early architecture for merging Jason's two tools so a quote and its photoreal light design are built and shown in ONE place. Recorded 2026-06-05 (Session 3) from a long planning conversation + a live walkthrough of the quote tool's customer portal. **No implementation has started.** This is the groundwork doc that the eventual architecture plan builds on. Update it as ideas firm up.

Relates to: [[project-design-tool]] (the canvas/design tool, this repo) and [[project-ai-quote-tool]] (the separate Next.js + Supabase quoting app, `yll-quote-tool`).

## The core goal (Jason's words)
"Have everything in one place and avoid having to go to different platforms to make one quote." A staff member should build the quote AND the on-photo light design in the **same** app, and the customer should see/interact with that design in the portal. End product: a customer quote that includes a fully-designed picture of *their* house.

## THE architectural decision: Path B (confirmed Session 3)
Two integration paths were weighed:
- **Path A — embed-and-bridge:** drop the design editor into the quote page via iframe, keep its Fastify/SQLite backend, sync data over HTTP. Faster, but **two customer databases to keep in sync.** (Possible stepping-stone only.)
- **Path B — absorb the editor into the quote tool (CHOSEN):** extract the Konva editor as a reusable component running **inside the Next.js app**, store scenes in **Supabase alongside the quotes**. One app, one login, one customer record. Bigger lift but it's literally the thing Jason wants. **This is the end-state we're building toward.**

Implication: this tool's separate Fastify/`node:sqlite` backend and its own Clients→Projects→Designs hierarchy eventually **fold into the quote tool / Supabase**. The standalone design tool keeps existing, but the integrated copy lives in the quote app.

## Confirmed decisions (don't re-ask)
- **Unify into the quote tool (Path B).** Everything ends up in the quote tool / Supabase, one login.
- **Customer identity = the quote's customer.** A design-tool "client" IS the same entity as the quote customer / HighLevel contact. **This tool stops owning its own client list** and keys off the quote. (Kills the two-DB sync problem.)
- **The design is VISUAL-ONLY. It does NOT calculate pricing or footage.** Measurements come from the quote tool (which already measures via Street View/satellite vision OR takes manual staff input). The design tool's own feet-of-lights readout is irrelevant to the integration.
- **BUT design ⇄ line items are linked both ways:** add an item in the design (e.g. a wreath) → it adds that wreath to the quote's line items (raising the total); delete it from the design → it removes that line item (lowering the total). And on the portal, toggling a line item off hides the matching item in the design. This linkage is the heart of the integration (see below).
- **Auto-scale from the quote's measurements** is wanted: if the quote knows the roofline is X ft and it spans Y px in the photo, derive pixels-per-foot automatically. **Also keep the manual yardstick** as an override for when the roofline measurement is unreliable.
- **Reuse the quote tool's Claude Vision** (it already finds rooflines) to seed the design's roofline.
- **Phasing:** manual embedded editor FIRST, then the AI auto-design. (Auto-design is the harder, fuzzier piece and builds on the manual path.)
- **Replace the portal's AI render with our design** to save money + time (the current Gemini/FLUX render costs money and takes up to ~90s).

## Builder-side vision (the quote-building staff experience)
1. **Embedded design editor** lives on the quote-builder page (a self-contained area). Image source = either a manual upload OR the **Street View image the quote tool already pulls** (it pulls Street View + satellite from Google Maps).
2. **Auto-design first pass:** when a house is pulled, an AI uses the design tool to lay out the install as best it can — outline the roofline (seeded by the quote's vision/measurements), wrap bushes/trees, place wreaths/spritzers/garland where they'd look good. Scale auto-set from known footage (manual yardstick override available). **Not expected to be perfect.**
3. **Staff refine** the auto-design — move lights, add/delete items, adjust brightness, etc. Because items ⇄ line items are linked, refining the design updates the quote's line items + total.
4. **Auto-populate records:** pull name/email/phone/address from the quote form → create the customer (if new) → create a project → add the pulled image as a design under them. **Timing TBD** — probably once customer info is entered or once the house is pulled (to iron out).
5. **Attach to quote:** the finished design (render + the editable scene) is attached to the customer's quote so it ships when the quote is sent.

## Portal-side vision (the customer experience)
Observed the live portal in Session 3 (see "Portal as it exists today" below). The vision:
- **Replace the static hero render** with the **live design** from our tool.
- The **"What's Included" / "Build Your Own"** toggle list filters the design's scene **live**: customer toggles a bush off → that bush's lights vanish from the picture; toggles spritzers on → spritzers appear. Each line item is bound to the exact scene item(s) it controls.
- **Color selection** is a planned future portal feature → maps to per-item color in the scene.
- Customers can select items + (future) colors. They **cannot** comment, request changes, or schedule. They click **Approve** → redirected to pay.

## THE crux: line-item ⇄ scene-item linkage
For any of this to work, every **quote line item** must be tied to the **specific design scene item(s)** it controls, with a stable ID/tag mapping:
- Toggle "9ft Noble Garland" off → that exact garland disappears from the render.
- Toggle a specific "Bush – canopy wrap" off → that one bush's strand disappears.
- Add a wreath in the builder → a "Noble Wreath" line item appears on the quote.

The design's scene JSON (`{ yardsticks[], items[], brightness }`, items = discriminated union by `kind`) already holds every quoted item; the portal "build your own" interaction is essentially **a visibility filter over that scene driven by the customer's selections.** This dovetails with the already-planned **`surface` tag on items + `GET /api/designs/:id/export`** roadmap item (see [[project-ai-quote-tool]]).

## Roofline packages: Santa's Roofline vs Gingerbread (Jason's definitions)
- **Santa's Roofline** = the FRONT of the house only: roof edges/eaves + the rakes on front-facing gables.
- **Gingerbread** = Santa's Roofline **PLUS** the left & right sides of the roof **and the ridge** — so at night from the street, every roof edge reads as outlined.
- **Modeling consequence:** Gingerbread is a **superset** of Santa's Roofline, not an independent item. Represent the *whole* roof outline as strand segments and **tag each segment by package level** (front edges = "santas-roofline"; sides+ridge = "gingerbread-only"). Then Santa's-vs-Gingerbread is a **visibility filter on segments**, and the two line items behave as mutually-exclusive tiers. (Same tagging mechanism as the general line-item linkage + the `surface` tag.)

## Technical enablers we'll need
- **Headless / server-side renderer.** Today the final JPG is produced in-browser (Konva `stage.toDataURL`). For attaching/sending designs and for the automated pipeline we need to rasterize a scene onto the photo **server-side** (no browser). Overlaps with the planned `rendered_jpg_url` in the export blob.
- **Live canvas in the portal.** The hero can't stay a static image — it must be a **live render that re-renders as toggles change** (filter the scene by selected items). This is the natural home for the embedded design tool on the portal page.
- **Unified auth.** The embedded editor must not be a second login — swap this tool's Fastify session for the quote tool's auth (Supabase) — covered by Path B.
- **Auto-design pipeline (phase 2+):** vision → scene generation (locate roofline/surfaces, place items) + an auto-scale step from the quote's footage. The hardest part (finding the roofline) largely exists in the quote tool's Claude Vision already. Mitigate placement accuracy with a **render → inspect → correct loop**.

## Phasing (agreed direction)
1. **Manual embedded editor** in the quote builder (lower risk, immediately useful).
2. **Portal live-design** replacing the static render + toggle→scene filtering.
3. **AI auto-design** from the Street View image (builds on 1 & 2).
4. Polish: color selection in portal, package refinement (A/B/C/D), etc.

## Portal as it exists today (observed live, Session 3)
Quote tool runs locally (Next.js dev) at **localhost:3000** — NOTE this is the same port as this tool's Fastify API, the source of the IPv6/IPv4 port-collision we hit (see [[project-design-tool]] dev notes). Portal URL pattern: **`/portal/<quoteId>`** (test quote viewed: `4fe4936c-26fc-4ff4-b5a1-f2d4f2fc1e89`, customer "naldoven").

**Page sections, top to bottom:**
1. **Hero** — full-bleed **render of the lit house** (currently a STATIC AI-rendered/placeholder image — a past install, not the customer's real house) + "Here's your home, <name>." + price/deposit + **package picker**.
2. **Walkthrough from Naldo** — a recorded explainer video.
3. **"What's Included — line by line"** — the toggle list. Copy: "Toggle anything off to remove it and we'll update your total automatically."
4. **Optional add-ons** — Rush install +$150, Premium takedown +$150 (checkboxes).
5. **Order summary** — Subtotal / Tax / Total / Deposit today (50%) + a **$1,000 season minimum** gate ("add $X more to approve").
6. **Marketing/trust** — guarantees ("Your protection"), "What happens next" (4 steps), About, Google reviews (4.9★, 187), Completed work, Giving-back, FAQ, "Text Naldo" contact.

**Packages (hero "TAP TO RE-ILLUMINATE"):** Tier A *Classic Glow* $597.44 · Tier B *Full Festive* $711.49 (most popular) · Tier C *The Full Yule* $1,357.81 · Custom *Build Your Own*. Selecting a tier sets which line items are on. **A/B/C/D are NOT meaningfully configured yet** — Jason says don't worry about them for now; refine later.

**Line items observed (Full Festive preset)** — these map ~1:1 to design-tool item kinds:
| Portal line item | Price | State | Design-tool item |
|---|---|---|---|
| Santa's Roofline | $550 | INCLUDED | strand (front roofline) |
| Gingerbread | $1,250 | OFF | strand (front + sides + ridge) |
| Bush – canopy wrap, 1 string ×3 | $35 ea | INCLUDED | strand (mini-light wrap) |
| 24" Spritzer | $95 | OFF | spritzer |
| 30" Noble Wreath – With Bow | $305 | OFF | wreath (withBow) |
| 9ft Noble Garland – With Bow | $195 | OFF | garland |

**Confirmed live behavior (tested by toggling the Spritzer, then reverted):** toggling an item updates the line item + subtotal/tax/total + deposit + the "$X to minimum" instantly; manually toggling switches the tier label to **"Build Your Own"** and does NOT snap back to a named tier even if contents match. **The hero render did NOT change when toggling** — confirming it's a fixed image today. *(That static image is exactly what our live design replaces.)*

## Open questions / to iron out
- **Timing** of customer/project/design auto-creation (on info-entry vs. on Street-View-pull).
- Exact **ID/tag scheme** linking a quote line item ↔ its scene item(s) (and how add/remove in the builder creates/removes line items + prices them — the design doesn't know prices, so the quote side owns the price when an item is added).
- How **Gingerbread/Santa's** mutual-exclusivity is enforced in both the line items and the segment tagging.
- Street View **perspective/scale** reliability for auto-scale; fallback to manual yardstick.
- Whether to store **only the render** or **render + editable scene** against the quote (almost certainly both — scene for editing, render for display/sending).
- Migration of this tool's editor into Next.js (build tooling, Konva in React, teardown/mount).

## More to come
Jason flagged this is a baseline, not the full spec — "more ideas will pop up as we develop." Portal-side details beyond the above may expand. Append here as they do.

## Resolved design decisions (Session 3, 2026-06-05 — cross-assistant convergence)
The line-item ⇄ scene-item contract, converged between the two tool assistants. These are DECIDED; the next artifact is the formal data-contract doc written from them. (Supersedes the earlier working "round-2 refinement" notes.)

1. **Cardinality = SETS.** A line item maps to a SET of scene-item-ids (not 1:1). Discrete items are 1-element sets; the quote tool already emits per-instance line items (each bush/tree/wreath its own line). Roofline = one tier line item ↔ many tagged segments.

2. **TWO projection rules (the core of the contract):**
   - **Per-unit items → projection-from-SCENE.** Scene is the master item list; line item = group tagged scene instances by type → count → price book. Geometry/scale is irrelevant to their price (mini-lights per string; wreaths/spritzers/garland per item). The "design is visual-only" tension fully dissolves here.
   - **Roofline → projection-from-MEASUREMENT.** Price = `santasFootage` / `gingerbreadFootage` × difficulty rate ($8/$10/$12 per ft) — owned by the MEASUREMENT (vision/manual), NOT the scene's pixels. The scene owns only the **visual + the toggle binding** (front segments vs sides+ridge segments). Both are **co-derived from the same vision pass → born consistent**; a staff VISUAL tweak to the roofline intentionally does NOT reprice (to change price, edit the measurement — already supported). By design, not drift.

3. **Roofline = a tier ENUM, not two independent toggles.** Valid states `none | santas | gingerbread`. Gingerbread is a SUPERSET of Santa's (front + sides + ridge), so "Gingerbread on / Santa's off" and "both on" are invalid. Model as a single tier enum (enforces mutual-exclusivity + superset at the data level) even though the portal RENDERS it as two line-item rows. ✅ **Already exists on the quote side:** `QuoteResult.rooflineChoice: 'santas' | 'gingerbread' | 'none'` (Phase 1) + the portal already treats the two as mutually-exclusive line items (Phase 2). So this isn't new modeling — the design just binds its segments to the existing enum. Discrete items stay independent **included-flags**.

4. **Portal selection state** = per-unit `included` flags + the roofline tier enum.

5. **Phase-4 tags = the shared roofline language (the real de-risk).** The quote AI already classifies front gutter = Santa's, sides+ridge = Gingerbread, and the engine already splits `santasFootage` vs `gingerbreadFootage`. The roofline binding is mostly **associating that existing split with the scene's segment tags** — minimal new modeling. The hardest-priced item is the most-aligned.

6. **The "core inversion" is BOUNDED.** Projection-from-scene only inverts the **discrete items** (the simpler half). The **roofline keeps the existing measurement → pricing-engine flow untouched** — it just gains a scene-segment visual binding via the shared front/sides tags. The scary part (re-plumbing the roofline through the scene) does NOT happen.

Also carried over (still agreed): **headless renderer deferrable** via `stage.toDataURL()` → Supabase Storage at save/approve (true headless only at Phase-4 auto-design); **bake linkage + `included` into the Phase-1 schema** so Phase 2 isn't a migration; **freeze/retire the standalone editor once ported** (React canonical, don't dual-maintain); **port effort** = per-item Konva renderers are portable, `editor.ts` controller is the real work, `renderEditor → destroy()` is the React-lifecycle seam.

**Next artifact:** write the data-contract doc (the keystone) from the above; Phase 1 starts from it.

## Phase 1 — BUILDING (Session 4, 2026-06-05) · branch `jason/integration-phase1`
Jason said GO on #27 Phase 1 (manual embedded editor + scene storage; NO price-linking [Phase 2], NO portal changes [Phase 2], NO AI [Phase 3]).

**Decisions this session (Jason):**
- **Design is INDEPENDENT** (own id; optional quote link set on "Calculate Quote") — so a design can be built BEFORE the quote is saved (his vision: pull Street View → photo into the editor → [later] AI auto-design → staff edit → links to the quote), and even with NO quote (future standalone design site). Amends data-contract §3.
- **Port = copy the working editor over** (NOT a react-konva rewrite), structured for re-syncing → eventual **shared package** both apps install. The "freeze the editor after one copy" idea is **OFF** — the design tool keeps evolving in both places (Jason may host it standalone). For now: clean self-contained core + one small connector (storage adapter), so re-copying a design-tool update = overwrite core, leave the connector.
- Jason **declined** the DB connection-string access for now (tired) → migrations applied by hand in the Supabase SQL editor.

**✅ Shipped S4 (the backend half):** `designs` table + private bucket (applied); `src/lib/designs.ts`; routes `POST /api/designs` (create + seed photo), `GET|PUT /api/designs/[id]` (load / save scene + link quote), `POST /api/designs/[id]/photo`. Gates green; smoke-tested live end-to-end.

**Design-tool AI reply (cross-assistant convergence on the shared core):**
- Confirmed the storage-agnostic shared-core → shared-package direction. `client/src/api.ts` is canonical for the types; **vendor the TYPES + guards, drop their Fastify `fetch` client** (it goes away under Path B).
- Proposed **`EditorStorage` adapter interface** (the single seam): `loadDesign(id)` · `saveScene(id, patch)` · `uploadPhoto(file)` · `listUploads/createUpload/deleteUpload` · `getColors()` · `getDefaults()`. Quote tool implements it over Supabase (my routes already map to it); design tool keeps the Fastify impl.
- **`assets.ts`** hard-codes `/items/...` for the wreath/garland/bow PNGs → needs a **configurable asset base** (different URL per app).
- Proposed **byte-identical `editor-core/`** folder (both repos): `types.ts · guards.ts · storage.ts` (adapter INTERFACE, no impl) `· colors.ts · assets.ts` (base-URL config) `· renderers/` (bulb, strand, wreath, bow, garland, spritzer, text, custom, pole, yardstick) `· engine.ts` (framework-neutral controller: scene state, selection, undo, mutations + clean API/events). App-specific (outside core): the adapter impl, asset hosting, and the **panels/shell** (React+Tailwind for us, vanilla for them).

**✅ RESOLVED (S4, Jason): Option B for Phase 1.** Wrap the whole vanilla editor (its own panels included) in a React shell — fast, low-risk, = the "copy it over" we agreed (mount via the `renderEditor → destroy()` seam + storage swap). The headless `editor-core` split (Option A — share canvas/renderers/engine, each app builds its own React/Tailwind panels) is the *eventual* shared-package shape, deferred.
- **Jason's explicit follow-on = ledger task #29:** after the Option-B drop-in, do a **cohesion pass** — restyle the editor's side panels in the quote tool's look. Functionally identical to the user; it's a rebuild of the controls wired to the (by-then) shared engine, NOT a reskin — so it's the Option-A work, done once, later. (Mechanics of why: improvements to the shared engine flow through our buttons automatically; brand-new features need a new button from us; a deliberate engine-command change needs a matching button tweak — kept rare by the agreed engine-command contract.)
- Design tool suggested **co-authoring a tiny spec for the adapter interface + engine API** (like the data contract) to lock those two boundaries. Do this when we tackle the headless `editor-core`/#29, not needed for the Phase-1 Option-B drop-in.

## NOT doing yet (Phase 1 scope guard)
Still OUT of Phase 1: price-linking/projection (Phase 2), portal live-design + toggle→scene filter (Phase 2), AI auto-design (Phase 3), headless `editor-core` refactor/shared package (later), custom-uploads library + editable palette + Settings page (deferred — use built-in defaults).

## Phase 2 plan + Step-3 decisions (confirmed with Naldo, Session 4)
**Phase 2 = the portal live-design**, built in 3 steps (smallest-risk first):
- **Step 1 — Show the real design on the portal.** Render the linked design's scene on the customer portal hero, replacing the static placeholder/Gemini render. Pure rendering; no pricing/builder changes. **Jason said GO toward Step 1** (start when he says go). ⮕ NEXT.
- **Step 2 — Toggles filter the picture.** Wire the "What's Included" toggles so toggling a line item hides/shows its scene item(s). Price already updates today; this makes the picture match.
- **Step 3 — Design drives the items** (the items model below). Most powerful + most invasive; built after the model is settled (it now is).

**Items model — DECIDED (Jason + Naldo): Option-1 + Option-2 HYBRID.**
- **Standard items (roofline, mini-lights, wreaths, spritzers, garland) → driven by the DESIGN** (the master list). One source per item type ⇒ the double-count bug can't happen. The design item-buttons for these go away once Step 3 lands (you add them by drawing).
- **PLUS a "custom / manual line item" feature (the Option-2 escape hatch)** — staff set name + price + description; it shows on the quote AND the portal but is NOT tied to the design. Covers the ~5% special/niche quotes. Build LATER (not needed for Steps 1–2); but design the line-item model to allow "a line item with no design item" from the start (mirror of the contract's "scene item with no line item" graceful case).
- **Roofline** stays **measurement-driven** (footage × rate) — the ONE exception (design's own measurements are unreliable; design just shows it).
- **Mini-lights** are design-driven but priced by a **staff-typed strand count × rate** (NOT length; hidden per-strand cost). Each bush/tree/column/railing = ONE instance = one priced unit + one portal line item + one toggle.

**Mini-light editor tool — DECIDED = Approach B (place an area), enhanced** (a NEW editor item type; build in the SHARED editor → coordinate with the design-tool AI):
- Place a **mini-light area** two ways: (a) **resizable box** (fast default), or (b) **draw/trace an enclosed shape** around a bush/column/railing outline (auto-closed on finish, so the user never has to seal it perfectly). The area fills with single mini-lights.
- **Density** control (slider/buttons) = **VISUAL ONLY** (sparse↔packed); does NOT affect price. Price = the staff-typed **strand count**.
- Flow: place area → set density (looks) → type strand count (price) → it's one bush/column/etc.
- **Railings — DECIDED (Jason):** railings will **NOT** use box/shape (they're linear, not an area). They still use mini-lights, so they need a **GROUPING mechanism** — draw the strand coverage, select it, group as one "railing" unit (a strand count + one line item + one toggle). So minis have BOTH: the **place-an-area tool** (box/shape) for bushes/trees/columns AND a **group-the-drawn-strands** mechanism for railings (and any hand-drawn coverage). Both produce the same thing: one instance = one priced unit = one portal toggle.

## ⭐ FULL PROJECTION — ✅ BUILT S5 (was "Step 3"; Option 2 — DECIDED S4)
> **✅ DONE & MERGED (Session 5, PR `jason/integration-projection`):** the whole loop A1→D + **A2**. **B** `projectScene.ts` (scene→per-unit inputs + linkage). **C1** engine `customLineItems` + `/api/quote` server-side projection. **C3a** builder custom-items + `designId`. **A1** vendored the gated Quote-binding editor (per-item surface/included + billed `quote*` panels). **D** portal toggle-filter (`sceneLinks.ts` + `hiddenSceneItemIds` + `render-readonly` hide). **A2** = v0.4 `MiniAreaItem`/`MiniGroupItem`/`MiniBilling`/`groupId` types + projection skip-logic + the **Scattershot** mini-area editor tool (box draw + color fill) + **railing/column** billing at the standard **$35/string** (no wrap style; only trees vary canopy/trunk) + railing **grouping** (≥2 strands → one `MiniGroupItem` → one "Railing – N strings"). Cores byte-identical with the design tool (hash-verified), zero `[yll]`. **Cemented decisions:** linkage = "live from design"; per-instance; **drawn size is VISUAL-ONLY → billed spec in staff-set `quote*` fields**; custom items have qty; no-design quotes keep manual entry (2a); railing/column = canopy rate. Data contract → **v0.4**. **NEXT (Jason's sequence): #31 edit-existing-quote → #33 roofline picture-toggle + #28 bow → #8/Phase 3 AI auto-design.** **Deferred:** roofline portal PICTURE-toggle (#33 — needs c9 strands tagged santas/gingerbread); editor cohesion restyle (#29); portal color picker (#10); headless renderer.

**Decision (Jason, S4):** do the WHOLE binding/projection as one chunk (Option 2 — "Full projection now"). The items-model workflow is **CEMENTED** (post-Naldo) — do NOT re-litigate it. This is the heart of the integration: the design becomes the master list for standard items, linking design ⇄ line items, which unlocks BOTH the price-linking AND the portal toggle→filter. (Session 4 hit ~80% context after deciding this — wrap + start fresh in Session 5.)

### ⚠️ THE KEY FINDING (from the Step-2 recon — WHY the filter needs this)
The portal toggle→filter (the old "Step 2") CANNOT be done without this projection:
- **Line items are FORM-derived.** `src/lib/portal/adapter.ts` `buildLineItems(result)` turns the pricing engine's `result.lineItems` (from the quote FORM inputs) into `PortalLineItem`s with ids = **`{kind}-{idx}`** (per-kind counter: `spritzer-0`, `wreath-0`, `bush-0`…); roofline is special-cased to stable ids **`roofline-santas`/`roofline-gingerbread`** (the mutually-exclusive group via `PortalRoofline`).
- **`SelectionContext`** (`src/components/portal/SelectionContext.tsx`) tracks **`selectedItemIds: Set<string>` of LINE-ITEM ids**; `toggleItem(id)` adds/removes a line-item id; price = sum of selected line items.
- **Scene items are DESIGN-derived** with their OWN ids and **NO `surface` tags** (the vendored editor never sets `surface`/`included` — the fields exist on the type but are always undefined).
- ⇒ Line items ↔ scene items = **separate id-spaces, NO mapping, scene untagged.** A toggle has no way to know which drawn item to hide. The projection is what creates the link.

### Build sub-steps (all together, but sequence internally A→D; gate after each)
- **A — Tag the design's items (the binding) + the new mini-light tool.** Editor work — **SHARED with the design tool → coordinate w/ design-tool AI** (and apply the pending editor-core comment cleanup here: the exact 4-line `numRays` comment + strip the `[yll]` markers). Each scene item gets a **`surface`** tag (`santas-roofline | gingerbread | winter-wonderland | bush | tree | column | railing? | null`); for the roofline the operator marks which c9 strands are Santa's (front) vs Gingerbread (sides+ridge). Plus the **mini-light area tool** (box / enclosed auto-closed shape + density-VISUAL-ONLY + staff strand count) and the **railing grouping** mechanism. Set **`included`** (default true) too. Per data-contract §4: mini `stringCount`/`wrapStyle`, garland `lengthFt`/`withBow`/`tier`, wreath `tier`.
- **B — The projection (scene → line items).** A pure lib fn (new, e.g. `src/lib/design/projectScene.ts`): group the **included** scene items by category → priced line items via `BUSINESS_RULES`, per data-contract §5 table. **Per-unit items project from the SCENE** (count / `stringCount` / `lengthFt`); **roofline projects from the MEASUREMENT** (`santasFootage`/`gingerbreadFootage`/`winterWonderlandFootage` × difficulty rate — the scene's roofline strands are visual + toggle binding ONLY, never pixel-measured). Unit-test it.
- **C — Wire into the builder (the invasive part).** The design drives the per-unit line items (wreaths/spritzers/minis/garland) — those form item-buttons go away; you add by drawing. Roofline stays measurement-driven. Plus the **custom/manual line-item escape hatch** (staff name+price+description; on quote+portal; NOT tied to the design). The line-item model must allow BOTH "a line item with no scene item" (custom) AND "a scene item with no line item" (unmapped: text/custom/perm/bistro/pole/standalone-bow, per §2).
- **D — The portal filter (EASY, last).** Make `render-readonly.ts`/`DesignCanvas` render only **`included`** scene items + re-render on selection change. Wire `SelectionContext` so toggling a line item flips `included` on its mapped scene item(s) (B/C provide the link). Roofline: the existing mutually-exclusive `roofline-santas`/`roofline-gingerbread` toggle → which roofline strands are included (tier enum `none|santas|gingerbread`). **#10 portal color picker + "What's Included" rework UNPARK here.**

### Pointers / already-true facts (don't re-discover)
- READ [[project_integration_data_contract.md]] — §5 mapping table, §7 two projection rules, §8 roofline enum, §9 portal selection, §4 binding fields.
- `QuoteResult.rooflineChoice` (`none|santas|gingerbread`) + the footage split already exist (#7). `BUSINESS_RULES` in `src/lib/pricing/pricingEngine.ts` has mini rates (canopy $35 / trunk $45), wreath/spritzer/garland prices, roofline rates ($8/10/12).
- `surface`/`included` + per-item binding fields already exist (unset) on the SceneItem type (`src/lib/design/sceneTypes.ts`) — the editor (A) needs to SET them.
- ⚠️ Big + invasive (builder pricing flow + the shared editor). Branch off master; A→D; gate each; verify with Jason; coordinate editor changes with the design-tool AI.
