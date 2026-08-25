// The light colour/pattern a customer actually approved, as an operator-facing
// label (row 362).
//
// This lived as a private helper inside the admin quote detail page, which is
// why the colour was visible on exactly ONE internal screen. It is the frozen,
// customer-approved choice, and it decides what the crew physically installs —
// so the job page, the invoice, and the customer profile all need to show the
// same thing, from the same function, or they will drift.
//
// Reads the APPROVAL snapshot's customerSelection, never a live browsing
// selection: what matters downstream is what the customer committed to, not
// what they were last clicking through on the portal.

import { getColorScheme, CUSTOM_SCHEME_ID, type ColorScheme } from './colorSchemes';

export type ChosenColorSelection = {
  colorSchemeId?: string;
  customPattern?: string[];
};

/**
 * The label, or null when the quote has no approved colour to show yet.
 *
 * null (rather than a placeholder string) so each caller decides how absence
 * reads on its own surface — a quote that was never approved has no colour,
 * which is different from one deliberately left on the designer's pick.
 *
 * `activeSchemes` is threaded through for permanent quotes, which carry their
 * own scheme list; omit it and the shared list is used, exactly as the quote
 * detail page did before this was extracted.
 */
export function chosenLightColorLabel(
  sel: ChosenColorSelection | undefined | null,
  activeSchemes?: ColorScheme[],
): string | null {
  if (!sel) return null;
  const hasCustomPattern = Array.isArray(sel.customPattern) && sel.customPattern.length > 0;
  // A custom pattern wins over the scheme id: when staff hand-pick colours the
  // stored scheme id can still read 'custom' OR carry a stale scheme, and the
  // pattern is the thing that actually renders.
  if (sel.colorSchemeId === CUSTOM_SCHEME_ID || hasCustomPattern) return 'Custom pattern';
  if (sel.colorSchemeId) return getColorScheme(sel.colorSchemeId, activeSchemes).label;
  return null;
}

/** Convenience for the surfaces that hold a raw approval_snapshot. */
export function chosenLightColorLabelFromSnapshot(
  approvalSnapshot: unknown,
  activeSchemes?: ColorScheme[],
): string | null {
  if (!approvalSnapshot || typeof approvalSnapshot !== 'object') return null;
  const sel = (approvalSnapshot as { customerSelection?: ChosenColorSelection }).customerSelection;
  return chosenLightColorLabel(sel, activeSchemes);
}
