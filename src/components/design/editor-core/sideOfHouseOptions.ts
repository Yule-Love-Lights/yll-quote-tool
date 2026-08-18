// SHARED EDITOR CORE — keep byte-identical with the standalone design tool (relay).
//
// #103/#249: pure lookup for the four Side of House values. Reused by both the
// post-hoc "Edit Strand" selection panel's #sel-side-of-house dropdown AND the
// pre-draw "Side of House" quick-tag section (permanent bulb type only) —
// mirrors the surfaceOptions.ts precedent: one function, two call sites, so
// the two pickers can never drift apart.
//
// Lives in its own Konva-free module (same reason as surfaceOptions.ts:
// editor.ts imports Konva, which makes it unimportable in this repo's
// headless test environment) so this lookup stays unit-testable.
//
// RELAY: this option list is shared with the standalone design tool — mirror
// any change here there too (see task_ledger Stake Lighting relay note).
export function sideOfHouseOptions(): [string, string][] {
  return [
    ["front", "Front"],
    ["back", "Back"],
    ["left", "Left"],
    ["right", "Right"],
  ];
}
