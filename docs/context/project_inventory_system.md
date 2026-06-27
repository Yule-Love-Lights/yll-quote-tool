---
name: project-inventory-system
description: "Inventory system epic (#82) — full vision capture: warehouse on-hand stock, design→materials list projection, the YLL clip-rules engine, the job pipeline (Kanban), ordering, and the WhatsApp bot. Living planning doc. BLOCKED on Naldo's input before decomposing into sub-tasks."
metadata:
  node_type: memory
  type: project
---

# Inventory System — planning & vision (#82)

> **STATUS: 🟢 BUILDING (Naldo S8 / 2026-06-27).** Unblocked — the open questions were answered (brainstorm → the decision-locked `docs/superpowers/specs/2026-06-27-inventory-82-design.md`, which supersedes §10 below) and slices are shipping. **DONE/MERGED:** 1a catalog (Thunder CSV → 831 SKUs) · 1b bindings (data layer + `/inventory/bindings` editor + `/inventory/overrides`). **PR'd, pending Naldo merge:** 1c on-hand table (`/inventory` Stock, #193) · 2a per-unit materials projector (#195). **= Slice 1 (catalog+bindings+on-hand) DONE + half of Slice 2 (materials engine) DONE.** Binding vocabulary + autofills were reshaped per Naldo's product feedback (Mini Lights catalog-derived; per-size wreath/garland base+bow+fee; spritzer color×size+pole; Permanent deferred → #88). **NEXT = Slice 2b** (roofline bulbs/wire + clip-rules engine) — needs the shared `roofFeature` tag + relay (**Jason**: `docs/superpowers/specs/2026-06-27-inventory-82-slice2b-jason-heads-up.md`). **Living doc.** *(Sections below are the original Jason-S14 vision capture; the design spec is the current decision-locked source of truth.)*
>
> **Plan of record (Jason S14):** capture everything here now + push to master so **Naldo can pull it and answer the open questions on his end**. Once Naldo answers, we (a) finalize the clip rules + stock model, then (b) decompose #82 into sub-tasks (phases below) and start building.
>
> **Terminology (Jason prefers plain English — use these):** "materials list" = the per-job parts list (industry term: *BOM / bill of materials*). "first version / Phase 1" = the smallest useful shippable slice (*MVP*). "stock item" = one distinct trackable inventory item-variant (*SKU*).

---

## 1. Goal / why
Build out the `/inventory` section (today a stub) into the system that:
1. **Knows what materials every booked job needs** — auto-derived from the customer's design (bulbs, socket wire, clips by type, stakes, wreaths/garland, consumables).
2. **Tracks what YLL has on hand** in the warehouse, so a booked job can be checked against stock → "do we have it, or order more?"
3. **Moves each job through a fulfillment pipeline** (order → pick up → prep → ready for install) the way GHL moves opportunities through stages — but on OUR tool, with the cards being **jobs**, not customers.
4. Eventually: **automates the ops loop** via a WhatsApp group + bot (card moves, stock updates) and supplier ordering (PDF/email → later AI auto-order).

The payoff: the moment a customer pays their deposit, a work order with their design, satellite view, and exact materials list appears in inventory automatically — and staff just move it down the board.

## 2. The big picture — 7 components
| # | Component | First version? |
|---|---|---|
| A | **Inventory On Hand** — warehouse stock table (the left wireframe). Warehouse staff do an initial count; then it's the live stock source of truth. | ✅ Phase 1 |
| B | **Materials-list projection** — each design run/item → raw materials (bulbs+color, socket wire by foot, clips by type, stakes, consumables). Extends the existing design→line-item pricing projection. | ✅ Phase 1 |
| C | **Clip-rules engine** — maps a roof **feature** (gutter/peak/shingle/ridge/…) → the correct clip per the YLL hierarchy (§3). | ✅ Phase 1 (needs §3 locked) |
| D | **Job → Inventory pipeline** — the Stages Kanban (right wireframe): cards = **jobs** (own ID), 4 stages, auto-created on **deposit-paid**, carrying customer/address/job-type + design + satellite + materials list. Manual card-dragging in Phase 1. | ✅ Phase 1 (manual moves) |
| E | **Ordering** — accumulate "to be ordered" jobs → export a **PDF / email draft** to the supplier. | ✅ Phase 1 (export); later: AI auto-order |
| F | **WhatsApp bot** — a group chat (Jason, Naldo, warehouse) + a bot that reads it and moves cards / updates stock. | ⏳ Later phase |
| G | **Stock comparison** — job materials list vs on-hand → order-vs-prepare decision; decrement on prep. | ⏳ Phase 2 |

## 3. The YLL clip hierarchy (KEYSTONE — ⚠️ NALDO TO REVIEW + VERIFY before we lock it)
> **⚠️ This whole section is Jason's draft from memory and MUST be reviewed + verified by Naldo before the clip-rules engine is built — it's the keystone of the whole materials list.** There are two internal conflicts flagged below that only Naldo can resolve.

**Hard rules (never violate):**
- **Windows:** YLL does **not** do window lighting. Never in any quote.
- **C7 clips:** YLL does **not** use C7 clips. Reference only, never in a quote.
- **Metal surfaces:** **no magnet clips** — use **magnetic socket wire**; **flag for Naldo review**, don't auto-output a clip.

**Usage hierarchy (do NOT treat all clips as equal — strict primary/backup/special):**
- **Shingles:** PRIMARY = **Shingle Tab** (White/Black). BACKUP = **C9 Flex Clip** (note: Flex makes the bulb face UP; shingles want bulbs OUT → backup only). SPECIAL-ONLY = C9 Tuff Tab, C9 Wedge Clip, C9 V-Clip, All-in-One, Pro C9 Clip Plus, C9 Tuff 90.
- **Gutters:** PRIMARY = **C9 Flex Clip** (White/Black). SPECIAL-ONLY = C9 Gutter Clip / V2, Chip Clip C9, Gutter Guard Clip / Light Links, Pro C9 Clip Plus.
- **Flat / commercial:** ALWAYS **both Parapet Clip AND Shingle Tab** together (two-part system, always quote both).
- **Pathway:** **Pathway Ground Stake** (Black/Green) — C9/C7 wire run along pathways/driveways.
- **Spritzers:** **Metal Stakes** (4'/5'/6') — a separate product category, **not a clip**.
- Ground stakes as a general "clip" category are **rarely** used by YLL.

**Draft roof-feature → default-clip table (⚠️ NALDO TO VERIFY — resolve the 2 conflicts):**
| Roof feature / surface | Default clip (draft) | ⚠️ Issue for Naldo |
|---|---|---|
| Front gutter line | **Flex Clip OR Tuff Tab?** | **CONFLICT:** hierarchy says gutter→Flex Clip (primary); but Jason's workflow + example say gutter line→"tuff clip" (bills "100 tuff clips"). Which is the default? Is "tuff clip" = "C9 Tuff Tab"? |
| Peak | Shingle Tab | confirm |
| Side / shingle | Shingle Tab | "sides are always shingles" |
| Ridge (top middle) | **"ridge clip" = ???** | **UNDEFINED:** workflow says ridge→"ridge clip", but no "ridge clip" exists in the hierarchy. What product is it? |
| Pathway | Pathway Ground Stake | is this the same as the "stake clips" in the stake-lighting example? |
| Spritzer | Metal Stake (4/5/6 ft) | separate product, not a clip |
| Flat / commercial | Parapet Clip + Shingle Tab (both) | confirm |
| Metal | Magnetic socket wire (no clip) | flag Naldo, don't auto-output |
| Windows / C7 | NEVER | hard rules |

**Proposed engine behavior (Phase 1):** pick the **PRIMARY default per feature**, and let staff **override to a special-scenario clip per run** from a dropdown. The full special-scenario rules get defined by Naldo over time; we don't need to enumerate them all to ship.

## 4. The materials list (design → materials projection)
**The idea (from Jason's dump):** as we estimate via the design/quote tool + satellite, the tool already measures each run/item. Each run then projects into its raw materials. Examples Jason gave:
- 100 ft warm-white **front gutter** roofline → 100 ft socket wire + 100 warm-white C9 bulbs + 100 clips (clip type per §3).
- 50 ft **side** (no gutter) → all shingle tabs.
- 50 ft **blue ridge** → 50 ridge clips + 50 ft socket wire + 50 blue bulbs.
- **Stake lighting** (lights in the grass) → socket wire + bulbs (color) + stake clips.
- **Spritzers / wreaths / garland** → auto-export their materials too.

**Grounding (code findings, S14):**
- **Bulbs, socket-wire footage, and color are already derivable** from the existing design data (the design carries footage + bulb color + per-item billed specs, and already projects to line items for pricing). So that half of the materials list is mostly *wiring up an existing projection*, not new capture.
- **The clip half needs new data.** Today the design only tags a run's surface as `santas-roofline` (front), `gingerbread` (sides+ridge), `winter-wonderland`, plus item tags (bush/tree/column/railing) — and now **`stake-lighting`** (Naldo, recent). These are **pricing categories, NOT the physical roof feature** (gutter vs peak vs shingle vs ridge) the clip logic needs. **So a real sub-task = add a per-run "surface/feature" attribute** (gutter / peak / shingle / ridge / pathway / flat / metal), populated by **AI detection where possible + a staff dropdown per run to set/override** — exactly the "clip input on the roof lights" Jason anticipated. ⚠️ Whether AI-detect is reliable enough or staff-input is the primary path = open (see §10).
- **Shared editor core:** if the per-run feature/clip attribute lives on the scene/strand, that's a **shared-editor-core change → relay to the design tool** (same byte-identical relay discipline as #63/#71/#73).

## 5. Booking → inventory: the trigger
- **Trigger (CONFIRMED, Jason S14):** the **job + materials list are created when the customer PAYS THE DEPOSIT** — not earlier (not at quote-sent or approved-but-unpaid). YLL already has deposit-paid live (the **#38 Valor webhook** is the real "booked" signal), so the inventory hook attaches there.
- The materials list is computed from the **approved selection snapshot** (the items the customer actually chose), not the original full quote.
- **The work order** (what lands in inventory per job): customer info, **house design**, **satellite view**, job type, and the **materials list**. Staff/AI only — **never shown to the customer.**
- The full materials list must be **exportable as a PDF** (and/or email draft) to send to a supplier or the warehouse.

## 6. The pipeline (Stages tab) — Kanban, cards = JOBS
> **NOT a new GHL pipeline.** We build a GHL-*style* stage/card board on OUR `/inventory` page. Reference = the GHL "Christmas Lights" opportunities board (stages across the top, cards in each).
- **Card = a Job.** Title = **Job ID** (⚠️ **Job ID ≠ Quote ID** — jobs get their own separate ID, linked to the source quote — CONFIRMED Jason S14). Card info: customer name, address, job type (**Holiday / Permanent / Event**). More fields TBD.
- **Stages (Jason's draft):** 1) **Material Has To Be Ordered** · 2) **Material Ordered, Awaiting Pickup** · 3) **Material Has To Be Prepared** · 4) **Material Prepared And Ready For Install**.

**Flow A — material IN STOCK:** deposit paid → check stock → in stock → card → **"Material Has To Be Prepared"** + send WhatsApp message → warehouse preps + reacts/replies on WhatsApp → card → **"Material Prepared And Ready For Install."**

**Flow B — material NEEDS ORDERING:** deposit paid → check stock → not in stock → **"Material Has To Be Ordered"** → after a few jobs accumulate, send the order (button → PDF/email draft to supplier; later → AI auto-orders on supplier site) → jobs → **"Material Ordered, Awaiting Pickup"** → on pickup, WhatsApp "[Order#] picked up" → on-hand stock updated with the picked-up items → the waiting jobs → **"Material Has To Be Prepared"** → WhatsApp reaction → **"Material Prepared And Ready For Install."**

## 7. WhatsApp bot + ordering (⏳ LATER phases — heaviest + most external)
- **WhatsApp group** (Jason, Naldo, warehouse) + a **bot** that reads the chat and updates job cards / on-hand stock accordingly (e.g. "[Order#] picked up" → update stock + advance cards; a prep confirmation → advance to "Ready for install").
- **Recommendation (Claude):** **defer both the WhatsApp bot and AI auto-ordering** to later phases — they're the most complex, most fragile, most external-dependency-heavy pieces. Ship the manual core first (manual card moves + PDF export), then automate.
- **Feasibility flag (for when we build it):** the WhatsApp Business Cloud API's support for reading emoji **reactions** is limited/unreliable — a **reply keyword** ("prepped [JobID]", "[Order#] picked up") is a far more dependable trigger than "react to move the card." Decide reaction-vs-reply then.

## 8. Inventory On Hand (warehouse stock)
- Warehouse staff (Jason's "warehouse girl," in the next few weeks) do an **initial count**; thereafter it's the live stock table, and every booked job checks against it.
- **What she's counting (Jason S14):** amount + type of each **clip**, amount + **color** of **bulbs**, **feet of wire**, **wreaths by size + decorated/non-decorated**, etc.
- **Per-item fields to track** (qty only? + reorder point / cost / supplier / storage location?) = **⚠️ ask Naldo** (Jason: "he'll know").
- **Stock decrement timing (Jason S14):** on-hand is **decremented only when material is PREPPED for a job** (not reserved at booking) — ⚠️ **confirm with Naldo.**

## 9. Confirmed decisions (Jason, S14 — don't re-ask)
- **Trigger = deposit-paid** (the #38 Valor webhook), materials list from the **approved selection snapshot**.
- **Job ID ≠ Quote ID** — jobs are their own entity with their own ID, linked to the quote.
- **Stock decremented only when material is prepped** for a job (⚠️ Naldo to confirm).
- **Materials list is staff/AI-only**, never customer-facing; must export to **PDF**.
- **Defer** the WhatsApp bot + AI auto-ordering to later phases (Claude rec, Jason on board).
- This is a **baseline, not set in stone** — Jason explicitly wants better/more-efficient approaches where they exist.

## 10. ⚠️ OPEN QUESTIONS FOR NALDO (the point of this push — Naldo, please answer)
1. **The clip table (§3) — review + verify the whole thing.** Specifically resolve: (a) **front gutter line → Flex Clip or Tuff Tab?** (hierarchy vs workflow conflict; and is "tuff clip" = "C9 Tuff Tab"?); (b) **what is a "ridge clip"?** (used for ridges in the workflow but absent from the hierarchy — which product/SKU?); (c) is the pathway "Pathway Ground Stake" the same thing as the "stake clips" in the stake-lighting example?
2. **Per-stock-item fields** — beyond quantity, what do we track per item? Reorder point (low-stock alert)? Cost? Supplier? Storage location? Anything else?
3. **Phasing / first version** — does shipping the core first (on-hand table + auto materials list + PDF export + the Kanban with manual card moves) and adding WhatsApp/AI-ordering later make sense, or is a specific piece needed sooner?
4. **Stock decrement** — confirm decrement happens only when material is **prepped** (vs reserved at booking).
5. **Feature detection** — for the per-run roof feature (gutter/peak/shingle/ridge), is **staff input** (a dropdown per run) acceptable as the reliable path with AI as an assist, or do you want AI to fully auto-detect?
6. **Catch-all** — Jason notes there are specifics here he doesn't know that Naldo does; Naldo, flag anything in this doc that's wrong/missing.

## 11. Grounding — what exists vs net-new (code findings, S14)
- ✅ **Exists:** `/inventory` page (stub, "Coming soon"); the dashboard "Inventory" nav (#58); the design→line-item **projection** for pricing (the base to extend for materials); the design's footage + bulb-color + per-item billed specs (→ bulbs/wire/color); **deposit-paid** webhook (#38, the trigger); GHL conversations (SMS/email) infra; **Stake Lighting** as a first-class design item w/ surface tag (Naldo, recent).
- 🆕 **Net-new:** the materials projection (clips/stakes/consumables layer); the **per-run roof-feature attribute** (+ AI detect / staff dropdown — likely a **shared-editor-core change → relay**); the on-hand stock table + data model (new Supabase tables); the Job entity (own ID) + the Kanban board UI; the stock-comparison logic; PDF export; [later] WhatsApp + ordering.

## 12. Proposed phasing + decomposition (DRAFT — finalize after Naldo's input, then split #82 into these)
> Each sub-task should be **independently shippable** (own PR, gates green) and **dependency-ordered**. Numbers TBD when we split (e.g. #82a/#82b… or fresh numbers).
- **Phase 1 — the useful core:**
  - **1a** On-Hand stock table + data model (manual CRUD + the warehouse count). *(Depends on: Naldo's per-item fields.)*
  - **1b** Per-run roof-feature attribute on the design (AI detect + staff dropdown) — shared-editor-core + **relay**. *(Depends on: clip table locked.)*
  - **1c** Materials-list projection (design → bulbs/wire/clips/stakes/consumables) + the clip-rules engine. *(Depends on 1b + §3.)*
  - **1d** Job entity (own ID) + auto-create on deposit-paid + the work order (design/satellite/materials).
  - **1e** Stages Kanban UI (cards=jobs, 4 stages, manual drag).
  - **1f** Materials-list **PDF/email export.**
- **Phase 2 — the stock loop:** stock comparison (job list vs on-hand → order-vs-prepare), decrement-on-prep, low-stock/reorder.
- **Phase 3 — automation:** WhatsApp group + bot (card moves + stock updates); supplier ordering (PDF → AI auto-order).

> Related: [[project_quote_tool]] (current state), [[project_integration]] (the design→projection foundation this builds on), [[task_ledger]] (#82). Design-tool relay discipline (for 1b): same as #63/#71/#73.
