import { describe, expect, it } from "vitest";
import { retainExplicitCustomMedalAwards } from "../src/composables/customMedalAwards";

describe("retainExplicitCustomMedalAwards", () => {
  it("removes Core's implicit Honorable award from object medal maps", () => {
    const awards = new Map([
      ["freshman", [
        { medalType: "Gold", maxRank: 6 },
        { medalType: "Silver", maxRank: 18 },
        { medalType: "Bronze", maxRank: 36 },
        { medalType: "Honorable", maxRank: 1_061_109_567 },
      ]],
    ]);

    retainExplicitCustomMedalAwards(
      { freshman: { gold: 6, silver: 12, bronze: 18 } },
      awards,
    );

    expect(awards.get("freshman")?.map(award => award.medalType)).toEqual([
      "Gold",
      "Silver",
      "Bronze",
    ]);
  });

  it("does not change the ccpc string preset", () => {
    const awards = new Map([
      ["official", [
        { medalType: "Gold" },
        { medalType: "Silver" },
        { medalType: "Bronze" },
        { medalType: "Honorable" },
      ]],
    ]);

    retainExplicitCustomMedalAwards("ccpc", awards);

    expect(awards.get("official")?.map(award => award.medalType)).toEqual([
      "Gold",
      "Silver",
      "Bronze",
      "Honorable",
    ]);
  });
});
