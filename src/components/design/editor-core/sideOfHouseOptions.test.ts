import { describe, it, expect } from "vitest";
import { sideOfHouseOptions } from "./sideOfHouseOptions";

// #103/#249: unit coverage for the shared Side-of-House option lookup that
// both the post-hoc "Edit Strand" #sel-side-of-house dropdown and the
// permanent-only pre-draw quick-tag section (editor.ts) delegate to, so the
// two pickers can't drift apart.
describe("sideOfHouseOptions", () => {
  it("returns the four homeowner-facing sides, front/back/left/right in order", () => {
    expect(sideOfHouseOptions()).toEqual([
      ["front", "Front"],
      ["back", "Back"],
      ["left", "Left"],
      ["right", "Right"],
    ]);
  });

  it("is stable across calls (no shared-reference mutation risk)", () => {
    const a = sideOfHouseOptions();
    const b = sideOfHouseOptions();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
