import { describe, it, expect } from "vitest";
import { surfaceOptionsForBulbType } from "./surfaceOptions";

// #249: unit coverage for the shared Surface-option lookup that both the
// post-hoc "Edit Strand" #sel-surface dropdown and the pre-draw quick-tag
// section (editor.ts) delegate to, so the two pickers can't drift apart.
describe("surfaceOptionsForBulbType", () => {
  it("c9 gets the four roofline billing categories", () => {
    expect(surfaceOptionsForBulbType("c9")).toEqual([
      ["santas-roofline", "Santa's Roofline"],
      ["gingerbread", "Gingerbread"],
      ["winter-wonderland", "Winter Wonderland"],
      ["stake-lighting", "Stake Lighting"],
    ]);
  });

  it("mini gets the five wrap/area surfaces", () => {
    expect(surfaceOptionsForBulbType("mini")).toEqual([
      ["bush", "Bush"],
      ["tree", "Tree"],
      ["column", "Column"],
      ["railing", "Railing"],
      ["curtain", "Curtain"],
    ]);
  });

  it("permanent has no surface tag (sideOfHouse covers it instead)", () => {
    expect(surfaceOptionsForBulbType("permanent")).toEqual([]);
  });

  it("bistro has no surface tag", () => {
    expect(surfaceOptionsForBulbType("bistro")).toEqual([]);
  });
});
