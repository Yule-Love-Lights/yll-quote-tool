# Inventory #82 — Slice 2b: design-tool RELAY handoff (roof-feature tag)

> **Status: ✅ RELAY DONE (Jason S14, 2026-06-29) — mirrored into the standalone design tool at `6f9a775`** (pushed to their main; verified byte-identical on disk, tsc clean). See the `task_ledger.md` relay callout.
> Slice 2b shipped on the quote-tool side in branch `naldo/inventory-2b-roof-feature`. The
> design-tool repo (`C:\Users\Jason\Desktop\YuleLoveLights\Claude`) is **not present on Naldo's
> machine**, so the byte-identical relay could not be done in that session (same situation as #63's
> first pass). Apply the two hunks below to the design tool to keep the editor cores in sync, then
> record the relay commit in `task_ledger.md` (like the Stake Lighting / Cool White / #63 / #71 / #73
> relay notes).

## Why
The clip-rules engine (Slice 2 materials) maps a **physical roof feature** → clip SKU. No such
attribute existed on the scene — `surface` is a *billing* category, not the physical attachment.
Slice 2b adds an additive + optional `roofFeature` to `StrandItem` plus a "Roof feature" dropdown in
the editor's Quote-binding panel. Additive + optional ⇒ core geometry stays byte-identical; design-tool
data without it is just "unset".

## Hunk 1 — scene types (design tool's `StrandItem` / scene-types module)
Add the `RoofFeature` type next to `Surface`/`Tier`/`WrapStyle`:

```ts
export type RoofFeature = 'gutter' | 'peak' | 'side' | 'ridge' | 'pathway' | 'flat' | 'metal';
```

Add the field to `StrandItem` (alongside `groupId`):

```ts
  roofFeature?: RoofFeature | null;
```

## Hunk 2 — `client/src/pages/editor.ts` (the canonical editor)
All three regions are **byte-identical** with the quote tool's `editor-core/editor.ts` (verbatim below).

**2a — type import.** Add `type RoofFeature` to the existing scene-types import (the import *path*
differs between repos — that line is already a known vendor divergence — but the symbol list matches):

```ts
… type DrawingStyle, type Surface, type RoofFeature, type Tier, type WrapStyle, …
```

**2b — options + selected-state**, inside the Quote-binding `${opts.showQuoteBinding ? (() => { … })()`
IIFE, immediately after the `surfaceOpts` tuple and before `const sSurface = …`:

```ts
        // RELAY: roof-feature options are shared with the standalone design tool —
        // mirror any change there too (#82 Slice 2b clip-feature tag). Shown only
        // for c9 roofline runs; drives the inventory clip-SKU selection.
        const isC9Roofline = sharedBulbType.length === 1 && sharedBulbType[0] === "c9";
        const roofFeatureOpts: [string, string][] = [
          ["gutter", "Gutterline"],
          ["peak", "Peak (gable, no gutter)"],
          ["side", "Side (shingles)"],
          ["ridge", "Ridge (apex)"],
          ["pathway", "Pathway / stake"],
          ["flat", "Flat / commercial"],
          ["metal", "Metal roof (flag)"],
        ];
        const sRoofFeature = uniq(sel.map((s) => s.roofFeature ?? ""));
```

**2c — render block**, in the returned template right after the Surface `<select>` ternary (the
`… nothing to tag.</div>`} line) and before `${wrapSurface ? \``:

```ts
        ${isC9Roofline ? `
        <label style="display:block;margin-top:8px;margin-bottom:2px;font-size:11px;color:var(--text-dim)">Roof feature</label>
        <select id="sel-roof-feature" class="yardstick-select">
          <option value="">${sRoofFeature.length > 1 ? "— mixed —" : "— none —"}</option>
          ${roofFeatureOpts.map(([v, l]) => `<option value="${v}" ${sRoofFeature.length === 1 && sRoofFeature[0] === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <div style="margin-top:4px;font-size:11px;color:var(--text-dim)">Clip type for the materials list. Metal = no clip (flag for staff). No window/C7 lighting.</div>
        ` : ""}
```

**2d — change handler**, in the `if (opts.showQuoteBinding) { … }` block right after the
`#sel-surface` change listener:

```ts
      const roofSel = sb.querySelector("#sel-roof-feature") as HTMLSelectElement | null;
      roofSel?.addEventListener("change", () => {
        updateSelected((s) => ({ ...s, roofFeature: roofSel.value ? (roofSel.value as RoofFeature) : null }));
      });
```

## After applying
- `npx tsc` clean on the design tool, then commit + push to its main.
- Record the relay commit hash in `task_ledger.md` (the #82 row + a "DESIGN-TOOL RELAY DONE" note),
  matching the convention used for Stake Lighting (`c4206e9`) / Cool White (`d2389df`) / #63 (`28230bf`).
- The quote-tool side carries no other relay — the clip engine (`clipRules.ts`, roofline materials in
  `materialsProjection.ts`) that reads this attribute is YLL-only.
