const EXPLICIT_CUSTOM_MEDAL_TYPES = new Set(["Gold", "Silver", "Bronze"]);

/**
 * XCPCIO Core appends an unbounded Honorable award to every object medal map.
 * Object maps are explicit thresholds, so retain only the requested G/S/B awards.
 */
export function retainExplicitCustomMedalAwards<T extends { medalType: string }>(
  medal: unknown,
  awards: Map<string, T[]> | undefined,
): void {
  if (medal === null || typeof medal !== "object" || Array.isArray(medal) || awards === undefined) {
    return;
  }

  for (const [group, groupAwards] of awards) {
    awards.set(group, groupAwards.filter(award => EXPLICIT_CUSTOM_MEDAL_TYPES.has(award.medalType)));
  }
}
