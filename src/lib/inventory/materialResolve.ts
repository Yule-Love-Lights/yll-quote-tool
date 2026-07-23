// src/lib/inventory/materialResolve.ts
// STAFF TEXT-OPS MATERIAL RESOLUTION (text-ops bot Phase 2). A crew member
// closes out a job by texting or speaking plain English — "job 142 done, used
// 2 boxes of C9 warm white and 30 clips" — and an LLM extracts rough lines
// like { item: "C9 warm white", qty: 2 }. Those human phrases have to become
// real SKUs before anything touches on-hand stock, and the catalog is ~877
// rows — far too many to hand an LLM, and a wrong SKU silently corrupts the
// warehouse count. So resolution here is fully DETERMINISTIC (string/token
// matching only, never fuzzy/edit-distance) and REFUSES rather than guesses
// whenever more than one candidate is plausible.
//
// The key shortcut: the job being closed out already has its own projected
// bill of materials (jobMaterials — usually a handful of skus, vs. the full
// catalog). A crew member is almost always naming something off THAT list, so
// every tier checks jobMaterials before falling back to the full catalog.

import { toQty } from './onHand';

export type RawMaterialLine = { item: string; qty: number };
export type ResolvedMaterial = { sku: string; name: string; qty: number; matchedOn: 'job' | 'catalog' };
export type MaterialResolution = {
  resolved: ResolvedMaterial[];
  /** Lines that could not be resolved CONFIDENTLY. Never guessed. */
  unresolved: { item: string; qty: number; reason: 'no-match' | 'ambiguous' }[];
};

type Candidate = { sku: string; name: string };
type Source = 'job' | 'catalog';

// Tier-3 noise words: unit-of-measure and filler words a crew member says but
// that carry no product identity ("2 boxes OF C9 warm white" -> "C9 warm
// white"). Fixed list per spec, not a stopword library.
const NOISE_TOKENS = new Set([
  'box', 'boxes', 'bag', 'bags', 'case', 'cases', 'pack', 'packs', 'roll', 'rolls',
  'of', 'a', 'an', 'the', 'some', 'and', 'plus', 'used', 'spare', 'extra',
]);

// case-insensitive, trimmed equality key for tiers 1-2 (exact sku / exact name).
function exactKey(s: string): string {
  return s.trim().toLowerCase();
}

// lowercase, strip punctuation, collapse whitespace -> word tokens (tier 3).
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// The crew phrase's significant tokens for the token-subset tier: noise words
// dropped per the fixed list above, PLUS bare digit tokens ("2", "30"). A raw
// LLM extraction can leave the quantity phrase inside `item` even though qty
// is already captured separately in RawMaterialLine.qty ("2 boxes of C9 warm
// white" alongside qty: 2) — a standalone number is never part of a product's
// identity, so it would only ever produce accidental digit collisions against
// a sku like "20009-SPK", never a genuine match.
function significantTokens(item: string): string[] {
  return tokenize(item).filter((t) => !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

type TierOutcome =
  | { kind: 'resolved'; sku: string; name: string; matchedOn: Source }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

// Evaluate one match predicate against one candidate list. Zero matches ->
// 'none' (caller falls through to the next source/tier). Exactly one match,
// OR several matches that all share one sku (e.g. a duplicated catalog row)
// -> 'resolved'. More than one DISTINCT sku -> 'ambiguous' — refuse, don't guess.
function evaluateSource(
  candidates: Candidate[],
  predicate: (c: Candidate) => boolean,
  matchedOn: Source,
): TierOutcome {
  const matches = candidates.filter(predicate);
  if (matches.length === 0) return { kind: 'none' };
  const distinctSkus = new Set(matches.map((m) => exactKey(m.sku)));
  if (distinctSkus.size === 1) {
    const winner = matches[0];
    return { kind: 'resolved', sku: winner.sku, name: winner.name, matchedOn };
  }
  return { kind: 'ambiguous' };
}

// One resolution tier: jobMaterials first, catalog only if jobMaterials had
// ZERO matches (an ambiguous jobMaterials result stops here — it does not
// fall through to the catalog, since that couldn't un-confuse which job item
// was meant).
function runTier(
  predicate: (c: Candidate) => boolean,
  jobMaterials: Candidate[],
  catalog: Candidate[],
): TierOutcome {
  const jobResult = evaluateSource(jobMaterials, predicate, 'job');
  if (jobResult.kind !== 'none') return jobResult;
  return evaluateSource(catalog, predicate, 'catalog');
}

function resolveOneLine(
  item: string,
  jobMaterials: Candidate[],
  catalog: Candidate[],
): TierOutcome {
  const key = exactKey(item);

  // Tier 1: exact sku.
  let outcome = runTier((c) => exactKey(c.sku) === key, jobMaterials, catalog);
  if (outcome.kind !== 'none') return outcome;

  // Tier 2: exact name.
  outcome = runTier((c) => exactKey(c.name) === key, jobMaterials, catalog);
  if (outcome.kind !== 'none') return outcome;

  // Tier 3: normalized-token subset. A phrase with no significant tokens left
  // (e.g. "a box of the some") is 'no-match' outright — an empty token list
  // would otherwise vacuously match every candidate.
  const tokens = significantTokens(item);
  if (tokens.length === 0) return { kind: 'none' };
  const candidateTokens = (c: Candidate) => new Set([...tokenize(c.name), ...tokenize(c.sku)]);
  return runTier(
    (c) => {
      const candTokens = candidateTokens(c);
      return tokens.every((t) => candTokens.has(t));
    },
    jobMaterials,
    catalog,
  );
}

export function resolveMaterialLines(
  lines: RawMaterialLine[],
  jobMaterials: { sku: string; name: string }[],
  catalog: { sku: string; name: string }[],
): MaterialResolution {
  const resolvedBySku = new Map<string, ResolvedMaterial>();
  const unresolved: { item: string; qty: number; reason: 'no-match' | 'ambiguous' }[] = [];

  for (const line of lines) {
    const qty = toQty(line.qty);
    const outcome = resolveOneLine(line.item, jobMaterials, catalog);

    if (outcome.kind === 'resolved') {
      const key = exactKey(outcome.sku);
      const existing = resolvedBySku.get(key);
      if (existing) {
        existing.qty += qty; // duplicate sku across lines: sum, keep the FIRST matchedOn
      } else {
        resolvedBySku.set(key, { sku: outcome.sku, name: outcome.name, qty, matchedOn: outcome.matchedOn });
      }
    } else {
      unresolved.push({ item: line.item, qty, reason: outcome.kind === 'ambiguous' ? 'ambiguous' : 'no-match' });
    }
  }

  return { resolved: [...resolvedBySku.values()], unresolved };
}
