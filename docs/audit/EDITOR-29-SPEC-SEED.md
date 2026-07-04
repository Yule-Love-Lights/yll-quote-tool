# Editor restyle (#29) — structural spec seed (from #110 Wave 3)

> **Source:** the 7 `feed-#29` refactor findings from the #110 Wave-3 dense-file audit
> (`editor.ts`, baseline `cef6ab6`, 2026-07-04). Per audit decision 2, `editor.ts` is
> **refactor-frozen & relay-locked** (byte-parity with the standalone design tool), so this
> audit recorded its structural findings **COARSE** — a structure map + hotspot list that
> **survives drift**, not line-level prescriptions. This doc is #29's starting spec; the
> fine-grained pass happens when #29 actually starts (and is **council-worthy** per the plan
> for any L-sized cut). Line spans are `@cef6ab6` and indicative — re-confirm against live
> code when #29 begins.
>
> **Scope guard:** `editor.ts` also relays byte-identical to the design tool. A #29 restyle is
> a JOINT structural change to editor-core — coordinate with the design-tool side before
> cutting, and decide up front whether #29 relays or forks the two apps. (Bug fixes still
> relay; a structural split is a different contract.)

## The core structural problem (one sentence)

`editor.ts` is **one 5,291-line async function** (`renderEditor`, ~L122→L5234 ≈ 99% of the
file) with ~120 nested inner functions and ~40 closure-scoped state vars and no internal
module boundaries — so every responsibility (state, viewport, gestures, rendering, per-type
panels, save queue) shares one scope and the **same 9-way item-type list is re-enumerated in
3+ independent places that can silently drift apart** (this drift is exactly what produced
several Wave-3 *bugs* — e.g. the mini-area paste gap W3-009 and the clone-orphan gaps
W3-002/030 exist because per-type handling is copy-pasted, not registry-driven).

## Hotspot list (the cuts, roughly highest-payoff first)

1. **Per-item-type REGISTRY** — the highest-leverage cut. One descriptor table keyed by item
   type `{ predicate, renderer, bakeFn, sidebarBuilder, cssClass, cloneSanitizer }` that
   `redrawCanvas`, the `mousedown` fan-out, and `renderSelected*` all iterate **once**,
   instead of the three independent 9-way `if/else`/filter cascades today. Kills a whole class
   of drift bugs. _(W3-026 redraw dispatch ~L645/688-732 · W3-020 mousedown fan-out
   ~L4613-4807 · W3-019 the 9 `renderSelected<Type>Sidebar` ~L2763-3840.)_
2. **Collapse the 9 `bakeTransformInto<Type>` fns** (~L977-1219, ~250 lines) into one generic
   `bakeGroupTransform(group, itemId, fieldMapper)` + 9 tiny per-type field mappers. Same
   skeleton today (read Konva x/y/scale/rotation → clear transform → immutably patch the scene
   item → `scheduleSave()+commit()`), differing only in the type-specific field patch. Feeds
   the registry's `bakeFn`. _(W3-027.)_
3. **Split the god-function `renderSidebar`** (~L1439-2207, ~770 lines) into independent
   per-category panel builders (lights · decor×4 sub-types · text · custom · poles), each
   taking `(tool, mutate)` and composed by a thin top-level `renderSidebar`. Feeds the
   registry's `sidebarBuilder`. _(W3-018.)_
4. **Factor the `select-all / duplicate(+20px) / delete` triad** re-implemented in all 9
   `renderSelected<Type>Sidebar` into one `wireSelectAllDuplicateDelete(sb, {allOfType, sel})`
   helper (or fold into the registry panel builder). ~15-25 lines × 9 today. **Note:** the
   duplicate path is where W3-002/030 lived — the shared helper must carry the clone-sanitizer
   (strip `groupId`/`linkedToId`) so it can't regress per-type. _(W3-019.)_
5. **Extract a gesture state-machine** (`idle→drawing→dragging→marqueeing→stamping→panning`)
   with one mode-keyed dispatch table, replacing the flat ~15-guard `mousedown`/`mousemove`/
   `mouseup` sequences that each re-branch per mode AND per item type. _(W3-020.)_
6. **`ToolState` → discriminated union** keyed by category (+ decor sub-type), instead of one
   flat ~46-field object (~L69-115) every category reads/writes. Makes
   `applyDefaultsForCurrentType`'s category `if/else` (~L5116-5196) and `renderSidebar`'s
   switch an exhaustive match. _(W3-028.)_
7. **Overall module split** (the umbrella — W3-017): once 1-6 exist, `renderEditor`'s natural
   module seams are (a) a **state container** with an explicit interface, (b) **viewport**
   (zoom/pan/fit/tint) → `viewport.ts`, (c) the **gesture controller** (from #5), (d) the
   **render registry** (from #1), (e) **panel builders** (from #3/#4), (f) the **save queue**
   (`scheduleSave`/`doSave`/`flushSave` — note the Wave-3 bugs W3-007/008 live here; #29 should
   land the save-seq/guard cleanly rather than patch-on-patch).

## Cross-refs

- Wave-3 **bug** findings that are symptoms of this structure (fixed in the W3 fix wave, but
  #29 should make them structurally impossible): W3-002/030 (clone keeps groupId/linkedToId),
  W3-009 (paste omits MiniArea), W3-007 (one mutation handler forgot `scheduleSave`), W3-008
  (no save-seq guard), W3-020's parallel 9-way lists.
- Ledger: #29 (editor restyle) · #110 (this audit) · the standing editor-core relay convention.
