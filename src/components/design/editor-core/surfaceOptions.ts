// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #249: pure lookup for which Surface (billing-category tag) options are
// valid for a given bulb type. Reused by both the post-hoc "Edit Strand"
// selection panel's #sel-surface dropdown AND the pre-draw "Surface" quick-tag
// section, so the two pickers can never drift apart — mirrors the #203
// isLineDrawContext precedent (drawContext.ts): one function, two call sites.
//
// Lives in its own Konva-free module (same reason as drawContext.ts: editor.ts
// imports Konva, which makes it unimportable in this repo's headless test
// environment) so this lookup stays unit-testable.
//
// RELAY: this option list is shared with the standalone design tool — mirror
// any change here there too (see task_ledger Stake Lighting relay note).
export function surfaceOptionsForBulbType(
  bulbType: "c9" | "mini" | "permanent" | "bistro",
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
    return [
      ["bush", "Bush"],
      ["tree", "Tree"],
      ["column", "Column"],
      ["railing", "Railing"],
      ["curtain", "Curtain"],
    ];
  }
  // permanent / bistro: no surface tag today (permanent uses sideOfHouse
  // instead; bistro isn't quoted by surface at all).
  return [];
}
