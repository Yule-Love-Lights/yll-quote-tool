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

  // #753 review fix: scattershot excludes curtain (invisible to #sel-ma-surface,
  // the MiniAreaItem panel — see the header comment) but keeps railing (which
  // that panel already lists, so pre-tagging it stays fully visible/editable).
  it("mini + scattershot drops curtain but keeps railing and the rest", () => {
    expect(surfaceOptionsForBulbType("mini", { scattershot: true })).toEqual([
      ["bush", "Bush"],
      ["tree", "Tree"],
      ["column", "Column"],
      ["railing", "Railing"],
    ]);
  });

  it("mini + scattershot:false is identical to omitting opts", () => {
    expect(surfaceOptionsForBulbType("mini", { scattershot: false })).toEqual(
      surfaceOptionsForBulbType("mini"),
    );
  });

  it("scattershot has no effect on c9 (already has no curtain option)", () => {
    expect(surfaceOptionsForBulbType("c9", { scattershot: true })).toEqual(
      surfaceOptionsForBulbType("c9"),
    );
  });
});
