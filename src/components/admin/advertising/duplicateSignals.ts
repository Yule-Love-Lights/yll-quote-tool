// Pure split of duplicate candidates by signal strength (ops suggestions
// round). STRONG = a location or address reason, the ones worth a photo and
// a decision. WEAK = only "same worker, same day", which is true of every
// sign a busy worker places that day and reads as noise at volume. The
// reasons here mirror the strings findDuplicateCandidates emits; a new
// reason string lands in STRONG by default (fail loud, not silent).

export function isStrongDuplicate(reasons: string[]): boolean {
  return reasons.some((r) => r !== 'same worker, same day');
}

export function splitDuplicateSignals<T extends { reasons: string[] }>(
  duplicates: T[],
): { strong: T[]; weakCount: number } {
  const strong = duplicates.filter((d) => isStrongDuplicate(d.reasons));
  return { strong, weakCount: duplicates.length - strong.length };
}
