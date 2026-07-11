// Permanent Bistro Lighting (#117) — bridge a stored bistro quote's inputs onto
// the pure BOM engine. Operator-facing ordering only; materials NEVER touch the
// customer price (that's the flat $/ft + $/pole in permanentBistro/pricing.ts).
// Pure: no DB/UI/I-O. Mirrors src/lib/permanent/bomFromQuote.ts.

import type { PermanentBistroInputFields } from './types';
import { buildBistroBom, type BistroBom, type BistroBomInput } from './bom';

// Untyped-DB-JSON clamp: a count that isn't a positive finite number reads 0
// (mirrors permanentBomFromQuote's `count` helper).
const count = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

/** Map the stored bistro runs + pole count onto the BOM engine input. */
export function bistroBomInputFromFields(p: PermanentBistroInputFields): BistroBomInput {
  const bistro = Array.isArray(p.bistro) ? p.bistro : [];
  return {
    runs: bistro
      .filter((b) => b && Number.isFinite(b.footage) && b.footage > 0)
      .map((b) => b.footage),
    poles: count(p.poles),
  };
}

/**
 * Build the BOM straight from a quote's stored inputs. Returns null when the
 * quote isn't a permanent-bistro quote (no `permanentBistro` block) OR the job
 * is empty (no footage, no poles) so callers can render nothing. `costOverrides`
 * (SKU → wholesale) lets a live inventory_catalog price feed in.
 */
export function bistroBomFromQuote(
  inputs: { permanentBistro?: PermanentBistroInputFields } | null | undefined,
  costOverrides?: ReadonlyMap<string, number>,
): BistroBom | null {
  const p = inputs?.permanentBistro;
  if (!p) return null;
  const bomInput = bistroBomInputFromFields(p);
  if (bomInput.runs.length === 0 && bomInput.poles === 0) return null;
  return buildBistroBom(bomInput, costOverrides);
}
