// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #249: pure lookup for which Surface (billing-category tag) options are
// valid for a given bulb type. Reused by both the post-hoc "Edit Strand"
// selection panel's #sel-surface dropdown AND the pre-draw "Surface" quick-tag
// section, so the two pickers can never drift apart — mirrors the #203
// isLineDrawContext precedent (drawContext.ts): one function, two call sites.
//
// #753 review fix: `curtain` is excluded whenever `scattershot` is true.
// Scattershot commits a MiniAreaItem (an area fill), and that item's own
// post-hoc edit panel (#sel-ma-surface, editor.ts) never offered `curtain` as
// an option — pre-tagging a scattershot area with it would bake a
// `surface: "curtain"` value onto an item whose own panel could never show or
// correct it (it would render "— none (untagged) —" despite being billed).
// `railing` is NOT excluded: #sel-ma-surface already lists it, so a
// pre-tagged scattershot "Railing" area is fully visible/correctable there —
// that combination isn't new or broken, just less common than authoring a
// railing as grouped strands.
//
// Lives in its own Konva-free module (same reason as drawContext.ts: editor.ts
// imports Konva, which makes it unimportable in this repo's headless test
// environment) so this lookup stays unit-testable.
//
// RELAY: this option list is shared with the standalone design tool — mirror
// any change here there too (see task_ledger Stake Lighting relay note).
export function surfaceOptionsForBulbType(
  bulbType: "c9" | "mini" | "permanent" | "bistro",
  opts?: { scattershot?: boolean },
): [string, string][] {
  if (bulbType === "c9") {
    return [
      ["santas-roofline", "Santa's Roofline"],
      ["gingerbread", "Gingerbread"],
      ["winter-wonderland", "Winter Wonderland"],
      ["stake-lighting", "Stake Lighting"],
    ];
  }
  if (bulbType === "mini") {
    const all: [string, string][] = [
      ["bush", "Bush"],
      ["tree", "Tree"],
      ["column", "Column"],
      ["railing", "Railing"],
      ["curtain", "Curtain"],
    ];
    return opts?.scattershot ? all.filter(([v]) => v !== "curtain") : all;
  }
  // permanent / bistro: no surface tag today (permanent uses sideOfHouse
  // instead; bistro isn't quoted by surface at all).
  return [];
}
