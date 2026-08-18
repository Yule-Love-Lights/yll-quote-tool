# #202 decor size presets (S/M/L) — DESIGN-TOOL RELAY hunks

> Durable capture of the `editor-core/` changes to mirror byte-identical into
> the standalone design tool (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`),
> per the standing relay convention in `task_ledger.md`.
>
> Generated from the REAL diff, not transcribed by hand.

## Provenance

- Branch: `jason/202-decor-size-presets`
- Base: `11ce167f142bf8ea5be4c261614259271d23d8f1`
- Head: `dda4fb9c9c0eed286b017ea3196aa31875ce5a33`
- Covers the original relabel AND the post-review fix round (off-preset visibility).

## Target-repo facts (verified read-only during the fix round)

- `client/src/pages/editor.ts` is still byte-identical to the pre-#202 state —
  **neither the relabel nor the fix round has been relayed yet.**
- The design tool has **no test infra** (no vitest/jest in either package.json):
  `sizePresets.test.ts` is quote-tool-only, do NOT relay it.
- `client/src/styles/main.css` carries the same `.spacing-row { display:flex;
  flex-wrap:wrap }`, so the fix round's 4th (off-preset) button wraps safely there too.
- Sibling modules there are imported as `../editor/<name>` from `pages/editor.ts`,
  so the natural home is `client/src/editor/sizePresets.ts`. Inlining instead is
  a judgment call for whoever applies it — there is no test-driven need to split there.

## NOT relayed (quote-tool only)

- `sizePresets.test.ts` (no test infra in the target).
- `src/lib/design/sceneTypes.ts` comment updates (not a vendored file).

## Verbatim diff (editor-core only)

```diff
diff --git a/src/components/design/editor-core/editor.ts b/src/components/design/editor-core/editor.ts
index 14699824..7829c656 100644
--- a/src/components/design/editor-core/editor.ts
+++ b/src/components/design/editor-core/editor.ts
@@ -19,16 +19,52 @@ import { renderMiniArea } from "./miniArea";
 import { preloadAssets } from "./assets";
 import { renderYardstick, pxPerFoot, yardstickLabel } from "./yardstick";
 import { DEFAULT_KEYMAP, resolveAction, type KeyMap } from "./keymap";
+import {
+  WREATH_SIZES,
+  BOW_SIZES,
+  GARLAND_SIZES,
+  SPRITZER_SIZES,
+  POLE_HEIGHTS,
+  sizePresetLabel,
+  formatRawSize,
+  offPresetSizeSuffix,
+} from "./sizePresets";
 
 // Default real-world width for newly-placed custom uploads — about 3 feet,
 // big enough to spot on the photo, small enough to resize down with the
 // Transformer if needed. Aspect is preserved from the natural image.
 const DEFAULT_CUSTOM_WIDTH_IN = 36;
 
-// Pole height options (in inches) and labels (in feet for the UI).
-const POLE_HEIGHTS = [96, 120, 144, 180] as const;
 type PoleBaseType = PoleItem["baseType"];
 
+// Renders a Size/Height quick-pick row's buttons (#202 F1): the 3 kept
+// presets from `options`, PLUS -- when `values` is a single value that isn't
+// one of them -- a 4th button showing the real stored number, marked active.
+// That 4th button is how an off-preset item (an old design's dropped tier,
+// a stale saved default loaded via applyDefaultsForCurrentType, or anything
+// reached via the resize handles) stays visible, labeled, and clickable-back-
+// to within the session, instead of the row rendering three unlit buttons
+// with no indication of the item's actual size. Every button also gets a
+// `title` with the real number, so hovering any preset confirms its exact
+// inches/feet.
+// `values` mirrors offPresetSizeSuffix (pass [tool.xSizeIn] for a single new-
+// item value, or a bulk-edit panel's uniq'd `sharedSize`/`sharedHeight` --
+// a mixed multi-select is `values.length > 1`, which gets no 4th button
+// since there's no one number to show). `attr` picks the data attribute the
+// existing click handlers already read (data-s for decor, data-h for poles)
+// -- this only changes what's rendered into the row, not how clicks are
+// wired: each render site's `querySelectorAll("#<row-id> button")` already
+// wires every button in the container, this 4th one included.
+function sizeButtons(options: readonly number[], values: number[], attr: "data-s" | "data-h", unit: "in" | "ft" = "in"): string {
+  const isActive = (v: number) => values.length === 1 && values[0] === v;
+  const preset = options
+    .map((v) => `<button ${attr}="${v}" class="${isActive(v) ? "active" : ""}" title="${formatRawSize(v, unit)}">${sizePresetLabel(options, v)}</button>`)
+    .join("");
+  if (values.length !== 1 || sizePresetLabel(options, values[0]) !== null) return preset;
+  const raw = formatRawSize(values[0], unit);
+  return preset + `<button ${attr}="${values[0]}" class="active" title="${raw}">${raw}</button>`;
+}
+
 const BULB_TYPES: { id: BulbType; label: string }[] = [
   { id: "c9", label: "C9" },
   { id: "permanent", label: "Permanent" },
@@ -117,11 +153,6 @@ type ToolState = {
   poleBaseType: PoleBaseType;
 };
 
-const WREATH_SIZES = [24, 36, 48, 60];
-const BOW_SIZES = [12, 18, 24, 36, 48];
-const GARLAND_SIZES = [6, 9, 12, 18, 24];
-const SPRITZER_SIZES = [16, 24, 36, 48];
-
 export async function renderEditor(
   root: HTMLElement,
   designId: string,
@@ -1526,9 +1557,9 @@ export async function renderEditor(
         <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">None for permanent in-ground installs or attaching to existing poles/buildings.</div>
       </section>
       <section>
-        <h3>Height</h3>
+        <h3>Height${offPresetSizeSuffix(POLE_HEIGHTS, [tool.poleHeightIn], "ft")}</h3>
         <div class="spacing-row" id="pole-heights">
-          ${POLE_HEIGHTS.map((h) => `<button data-h="${h}" class="${tool.poleHeightIn === h ? "active" : ""}">${h / 12} ft</button>`).join("")}
+          ${sizeButtons(POLE_HEIGHTS, [tool.poleHeightIn], "data-h", "ft")}
         </div>
       </section>
       ${(() => {
@@ -1741,9 +1772,9 @@ export async function renderEditor(
       </section>
       ${tool.decorType === "wreath" ? `
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(WREATH_SIZES, [tool.wreathSizeIn])}</h3>
         <div class="spacing-row" id="wreath-sizes">
-          ${WREATH_SIZES.map((s) => `<button data-s="${s}" class="${tool.wreathSizeIn === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(WREATH_SIZES, [tool.wreathSizeIn], "data-s")}
         </div>
       </section>
       <section>
@@ -1765,9 +1796,9 @@ export async function renderEditor(
       </section>
       ` : tool.decorType === "bow" ? `
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(BOW_SIZES, [tool.bowSizeIn])}</h3>
         <div class="spacing-row" id="bow-sizes">
-          ${BOW_SIZES.map((s) => `<button data-s="${s}" class="${tool.bowSizeIn === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(BOW_SIZES, [tool.bowSizeIn], "data-s")}
         </div>
       </section>
       <section>
@@ -1775,9 +1806,9 @@ export async function renderEditor(
       </section>
       ` : tool.decorType === "garland" ? `
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(GARLAND_SIZES, [tool.garlandSizeIn])}</h3>
         <div class="spacing-row" id="garland-sizes">
-          ${GARLAND_SIZES.map((s) => `<button data-s="${s}" class="${tool.garlandSizeIn === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(GARLAND_SIZES, [tool.garlandSizeIn], "data-s")}
         </div>
         <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Thickness of the greenery rope on the photo.</div>
       </section>
@@ -1797,9 +1828,9 @@ export async function renderEditor(
       </section>
       ` : `
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(SPRITZER_SIZES, [tool.spritzerSizeIn])}</h3>
         <div class="spacing-row" id="spritzer-sizes">
-          ${SPRITZER_SIZES.map((s) => `<button data-s="${s}" class="${tool.spritzerSizeIn === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(SPRITZER_SIZES, [tool.spritzerSizeIn], "data-s")}
         </div>
         <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Diameter of the radial spray on the photo.</div>
       </section>
@@ -2848,9 +2879,9 @@ export async function renderEditor(
         </button></section>`;
       })()}
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(WREATH_SIZES, sharedSize)}</h3>
         <div class="spacing-row" id="sel-wreath-sizes">
-          ${WREATH_SIZES.map((s) => `<button data-s="${s}" class="${sharedSize.length === 1 && sharedSize[0] === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(WREATH_SIZES, sharedSize, "data-s")}
         </div>
       </section>
       <section>
@@ -2978,9 +3009,9 @@ export async function renderEditor(
         </button></section>`;
       })()}
       <section>
-        <h3>Size (in)</h3>
+        <h3>Size${offPresetSizeSuffix(BOW_SIZES, sharedSize)}</h3>
         <div class="spacing-row" id="sel-bow-sizes">
-          ${BOW_SIZES.map((s) => `<button data-s="${s}" class="${sharedSize.length === 1 && sharedSize[0] === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(BOW_SIZES, sharedSize, "data-s")}
         </div>
       </section>
       <section style="display:flex;gap:6px">
@@ -3046,9 +3077,9 @@ export async function renderEditor(
         </button></section>`;
       })()}
       <section>
-        <h3>Size (in)${sharedSize.length > 1 ? " — mixed" : ""}</h3>
+        <h3>Size${sharedSize.length > 1 ? " — mixed" : offPresetSizeSuffix(GARLAND_SIZES, sharedSize)}</h3>
         <div class="spacing-row" id="sel-garland-sizes">
-          ${GARLAND_SIZES.map((s) => `<button data-s="${s}" class="${sharedSize.length === 1 && sharedSize[0] === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(GARLAND_SIZES, sharedSize, "data-s")}
         </div>
         <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Thickness of the greenery rope.</div>
       </section>
@@ -3202,9 +3233,9 @@ export async function renderEditor(
         </button></section>`;
       })()}
       <section>
-        <h3>Size (in)${sharedSize.length > 1 ? " — mixed" : ""}</h3>
+        <h3>Size${sharedSize.length > 1 ? " — mixed" : offPresetSizeSuffix(SPRITZER_SIZES, sharedSize)}</h3>
         <div class="spacing-row" id="sel-spritzer-sizes">
-          ${SPRITZER_SIZES.map((s) => `<button data-s="${s}" class="${sharedSize.length === 1 && sharedSize[0] === s ? "active" : ""}">${s}"</button>`).join("")}
+          ${sizeButtons(SPRITZER_SIZES, sharedSize, "data-s")}
         </div>
       </section>
       <section>
@@ -3858,9 +3889,9 @@ export async function renderEditor(
         </div>
       </section>
       <section>
-        <h3>Height${sharedHeight.length > 1 ? " (mixed)" : ""}</h3>
+        <h3>Height${sharedHeight.length > 1 ? " (mixed)" : offPresetSizeSuffix(POLE_HEIGHTS, sharedHeight, "ft")}</h3>
         <div class="spacing-row" id="sel-pole-heights">
-          ${POLE_HEIGHTS.map((h) => `<button data-h="${h}" class="${sharedHeight.length === 1 && sharedHeight[0] === h ? "active" : ""}">${h / 12} ft</button>`).join("")}
+          ${sizeButtons(POLE_HEIGHTS, sharedHeight, "data-h", "ft")}
         </div>
       </section>
       <section style="display:flex;gap:6px">
diff --git a/src/components/design/editor-core/sizePresets.test.ts b/src/components/design/editor-core/sizePresets.test.ts
new file mode 100644
index 00000000..f83be3a5
--- /dev/null
+++ b/src/components/design/editor-core/sizePresets.test.ts
@@ -0,0 +1,131 @@
+import { describe, it, expect } from "vitest";
+import {
+  WREATH_SIZES,
+  BOW_SIZES,
+  GARLAND_SIZES,
+  SPRITZER_SIZES,
+  POLE_HEIGHTS,
+  sizePresetLabel,
+  formatRawSize,
+  offPresetSizeSuffix,
+} from "./sizePresets";
+
+// The pre-#202 preset supersets (editor.ts's old 4/5-value arrays) + each
+// type's pre-existing tool-default value (editor.ts ToolState defaults /
+// toolDefaults.ts DEFAULT_TOOL_DEFAULTS — unchanged by this task). Used below
+// to lock two invariants: the new arrays only keep values that already
+// existed, and the exact default a newly-placed item gets is still offered.
+const LEGACY = {
+  wreath: { superset: [24, 36, 48, 60], current: WREATH_SIZES, default: 36 },
+  bow: { superset: [12, 18, 24, 36, 48], current: BOW_SIZES, default: 24 },
+  garland: { superset: [6, 9, 12, 18, 24], current: GARLAND_SIZES, default: 12 },
+  spritzer: { superset: [16, 24, 36, 48], current: SPRITZER_SIZES, default: 24 },
+  pole: { superset: [96, 120, 144, 180], current: POLE_HEIGHTS, default: 120 },
+} as const;
+
+describe("decor/pole size presets — shape", () => {
+  for (const [type, { superset, current, default: def }] of Object.entries(LEGACY)) {
+    it(`${type}: collapses to exactly 3 strictly ascending values, no duplicate tiers, drawn from the original preset list`, () => {
+      expect(current).toHaveLength(3);
+      // Strictly ascending (and therefore no duplicates) -- NOT just
+      // non-decreasing. A stable sort of e.g. [24, 36, 36] equals itself, so
+      // a `toEqual([...current].sort(...))` check would silently PASS a
+      // dropped tier (two buttons rendering the same value, one Small/Medium/
+      // Large label lost) instead of catching it. (#202 F2)
+      for (let i = 1; i < current.length; i++) {
+        expect(current[i]).toBeGreaterThan(current[i - 1]);
+      }
+      for (const v of current) expect(superset).toContain(v);
+    });
+
+    it(`${type}: keeps its pre-existing tool default so a newly-placed item's size is unchanged`, () => {
+      expect(current).toContain(def);
+    });
+  }
+});
+
+describe("sizePresetLabel", () => {
+  it("labels each of the 3 kept values Small / Medium / Large in position order", () => {
+    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[0])).toBe("Small");
+    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[1])).toBe("Medium");
+    expect(sizePresetLabel(WREATH_SIZES, WREATH_SIZES[2])).toBe("Large");
+  });
+
+  it("works the same for the const-asserted pole array", () => {
+    expect(sizePresetLabel(POLE_HEIGHTS, 96)).toBe("Small");
+    expect(sizePresetLabel(POLE_HEIGHTS, 120)).toBe("Medium");
+    expect(sizePresetLabel(POLE_HEIGHTS, 180)).toBe("Large");
+  });
+
+  // The round-trip guarantee: an off-preset stored sizeIn/heightIn (a dropped
+  // legacy preset like wreath's old 48", or an arbitrary value only reachable
+  // via the anchor-resize handles) must NOT be coerced onto the nearest tier.
+  // It comes back null — the caller shows no button active and leaves the
+  // stored number exactly as it was — proving this module performs no
+  // snapping/clamping of its own.
+  describe("non-preset values are never snapped to a tier", () => {
+    it("a dropped legacy preset (wreath's old 48\") reports no tier and is left unmatched", () => {
+      const droppedLegacyValue = 48;
+      expect(WREATH_SIZES).not.toContain(droppedLegacyValue); // confirms it really was dropped
+      expect(sizePresetLabel(WREATH_SIZES, droppedLegacyValue)).toBeNull();
+      // The value itself is untouched by the lookup — a pure function can't
+      // mutate its argument, but assert the identity explicitly so this test
+      // documents the "never coerced" contract rather than just "no crash".
+      expect(droppedLegacyValue).toBe(48);
+    });
+
+    it("an arbitrary hand-resized value (never any version's preset) reports no tier", () => {
+      const handResizedValue = 51.5;
+      for (const options of [WREATH_SIZES, BOW_SIZES, GARLAND_SIZES, SPRITZER_SIZES, POLE_HEIGHTS]) {
+        expect(sizePresetLabel(options, handResizedValue)).toBeNull();
+      }
+      expect(handResizedValue).toBe(51.5); // still exactly what was stored
+    });
+
+    it("zero and negative inputs (never valid sizes) also report no tier, without throwing", () => {
+      expect(() => sizePresetLabel(WREATH_SIZES, 0)).not.toThrow();
+      expect(sizePresetLabel(WREATH_SIZES, 0)).toBeNull();
+      expect(sizePresetLabel(WREATH_SIZES, -36)).toBeNull();
+    });
+  });
+});
+
+// #202 F1 (fix round): formatRawSize + offPresetSizeSuffix are the pure
+// pieces behind "show the real number when it isn't a kept preset" -- editor.ts
+// uses them for the section-header suffix and the 4th "you are here" button.
+describe("formatRawSize", () => {
+  it("formats an inches value with a trailing inch mark, defaulting to the 'in' unit", () => {
+    expect(formatRawSize(48)).toBe('48"');
+    expect(formatRawSize(48, "in")).toBe('48"');
+  });
+
+  it("formats a feet value (pole heightIn / 12) with a trailing ' ft'", () => {
+    expect(formatRawSize(144, "ft")).toBe("12 ft"); // a dropped legacy pole tier
+  });
+
+  it("rounds to 1 decimal and drops a trailing .0, for both units", () => {
+    // A hand-resize drag scales the stored size by an arbitrary Transformer
+    // ratio (bakeTransformInto* in editor.ts) -- rarely a round number.
+    expect(formatRawSize(41.38287, "in")).toBe('41.4"');
+    expect(formatRawSize(100, "ft")).toBe("8.3 ft"); // 100 / 12 = 8.3333...
+    expect(formatRawSize(36.001, "in")).toBe('36"'); // rounds away a near-zero remainder, no stray ".0"
+  });
+});
+
+describe("offPresetSizeSuffix", () => {
+  it("returns \"\" when the single shared value IS a kept preset (the active button already shows it)", () => {
+    for (const v of WREATH_SIZES) expect(offPresetSizeSuffix(WREATH_SIZES, [v])).toBe("");
+    expect(offPresetSizeSuffix(POLE_HEIGHTS, [120], "ft")).toBe("");
+  });
+
+  it("returns the em-dash raw-size suffix when the single shared value is off-preset", () => {
+    expect(offPresetSizeSuffix(WREATH_SIZES, [48])).toBe(' — 48"'); // dropped legacy tier
+    expect(offPresetSizeSuffix(POLE_HEIGHTS, [144], "ft")).toBe(" — 12 ft"); // dropped legacy pole tier
+    expect(offPresetSizeSuffix(WREATH_SIZES, [41.5])).toBe(' — 41.5"'); // hand-resized, never any preset
+  });
+
+  it("returns \"\" for a mixed multi-select or an empty selection -- no single number to show", () => {
+    expect(offPresetSizeSuffix(WREATH_SIZES, [24, 48])).toBe(""); // mixed: caller renders its own "— mixed" text
+    expect(offPresetSizeSuffix(WREATH_SIZES, [])).toBe("");
+  });
+});
diff --git a/src/components/design/editor-core/sizePresets.ts b/src/components/design/editor-core/sizePresets.ts
new file mode 100644
index 00000000..3485e09a
--- /dev/null
+++ b/src/components/design/editor-core/sizePresets.ts
@@ -0,0 +1,83 @@
+// Small / Medium / Large size presets for decor items + poles (#202).
+//
+// `sizeIn` (wreath/bow/garland/spritzer) and `heightIn` (pole) are VISUAL ONLY
+// — see sceneTypes.ts. The inch/foot-labeled presets these buttons used to show
+// (e.g. 24"/36"/48"/60") misled staff into thinking they set the billed size;
+// the real billed spec lives in the separate staff-set `quoteSize`/
+// `quoteLength` fields the projection actually reads (projectScene.ts). Poles
+// have no quote binding at all but get the same relabel — their sizes are
+// equally aesthetic-only (Jason, #202).
+//
+// Each array below keeps exactly 3 of the type's ORIGINAL preset values — the
+// smallest, the pre-existing tool default (now "Medium"), and the largest —
+// so a newly-placed item's default stays visually identical to before this
+// relabel. Odd/in-between sizes (an old design's dropped preset, or anything
+// reached via the anchor-resize handles) are real numbers that stay exactly as
+// stored; this module never snaps/coerces them — `sizePresetLabel` returns
+// null for a value that isn't one of `options` rather than guessing the
+// nearest tier, so none of the 3 PRESET buttons render active for it. (#202
+// F1 below adds a 4th button for exactly this case, so the value stays
+// visible/active/clickable — it just isn't coerced onto one of the 3 tiers.)
+//
+// Split out from `editor.ts` (same reason as yardstick-scale.ts: a small pure
+// module the Konva-orchestrating file can import, and this repo can actually
+// unit-test without loading Konva).
+//
+// #202 F1 (fix round after the four-lens review): trimming to 3 presets also
+// removed the LAST place an off-preset item's real number was visible in the
+// UI — an old design's dropped tier, or anything reached via the anchor-
+// resize handles, rendered as three unlit buttons with no way to confirm
+// what the item actually was. `formatRawSize` + `offPresetSizeSuffix` below
+// are the pure, testable pieces of that fix: editor.ts uses them to show the
+// real number in the section header, and to add a 4th "you are here" button
+// alongside the 3 presets (still never snapping/coercing the stored value).
+
+export const WREATH_SIZES = [24, 36, 60]; // was [24, 36, 48, 60]; 36 = unchanged tool default (Medium)
+export const BOW_SIZES = [12, 24, 48]; // was [12, 18, 24, 36, 48]; 24 = unchanged tool default (Medium)
+export const GARLAND_SIZES = [6, 12, 24]; // was [6, 9, 12, 18, 24]; 12 = unchanged tool default (Medium)
+export const SPRITZER_SIZES = [16, 24, 48]; // was [16, 24, 36, 48]; 24 = unchanged tool default (Medium)
+export const POLE_HEIGHTS = [96, 120, 180] as const; // was [96, 120, 144, 180] as const; 120 = unchanged tool default (Medium)
+
+const TIER_LABELS = ["Small", "Medium", "Large"] as const;
+
+// The Small/Medium/Large label for `value` within `options` (position-based:
+// options[0] → Small, options[1] → Medium, options[2] → Large). Returns null
+// when `value` isn't a member of `options` — see the file header for why an
+// off-preset value must not be mapped onto the nearest tier.
+export function sizePresetLabel(options: readonly number[], value: number): string | null {
+  const i = options.indexOf(value);
+  return i === -1 ? null : (TIER_LABELS[i] ?? null);
+}
+
+// Rounds to 1 decimal place and drops a trailing ".0" (48 -> 48, 41.38287 ->
+// 41.4). Every value this module formats came either from a kept preset
+// (already a clean integer) or from a hand-resize drag (`bakeTransformInto*`
+// in editor.ts, which scales the stored size by an arbitrary Transformer
+// ratio with no rounding) — so an off-preset value is often NOT a round
+// number, and printing it unrounded can run to a dozen+ decimal digits.
+function round1(n: number): number {
+  return Math.round(n * 10) / 10;
+}
+
+// Formats a raw stored value for display when it doesn't match a kept preset
+// (see sizePresetLabel) -- e.g. "48"" for wreath/bow/garland/spritzer, or
+// "10 ft" for poles. Poles are labeled in feet everywhere else in this UI
+// (h / 12); this keeps that same convention, just rounded for display (an
+// off-preset pole height need not be a multiple of 12).
+export function formatRawSize(value: number, unit: "in" | "ft" = "in"): string {
+  return unit === "ft" ? `${round1(value / 12)} ft` : `${round1(value)}"`;
+}
+
+// Header suffix for a Size/Height section (#202 F1): when `values` is
+// exactly one shared value that ISN'T one of the 3 kept presets, returns
+// " — 48"" (or " — 10 ft" for poles) so an off-preset item's panel explains
+// its real size instead of showing three unlit buttons with no indication
+// why. Returns "" when the value IS a kept preset (its button already shows
+// the label) or when `values` isn't a single defined value -- 0 items, or a
+// multi-select whose items disagree (mixed); callers render their own mixed
+// text for that case, same as before this change.
+export function offPresetSizeSuffix(options: readonly number[], values: number[], unit: "in" | "ft" = "in"): string {
+  if (values.length !== 1) return "";
+  const [value] = values;
+  return sizePresetLabel(options, value) === null ? ` — ${formatRawSize(value, unit)}` : "";
+}
```
