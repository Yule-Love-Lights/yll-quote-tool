// Pure claim-state for the shared queue (#58 Phase 1.5). Items default to
// unclaimed (anyone can grab); an operator can claim one so the team sees who's
// on it — the "I've got this" from the shared-queue model. Assignment is stored
// on dashboard_contacts.assigned_to (you own the customer, not a single message).

export type ClaimState = 'unclaimed' | 'mine' | 'other';

export function claimState(assignedTo: string | null, currentOperator: string | null): ClaimState {
  if (!assignedTo) return 'unclaimed';
  if (currentOperator && assignedTo === currentOperator) return 'mine';
  return 'other';
}

/** A GHL-safe `handled-by-<who>` tag from an operator label (email/id). Strips
 *  punctuation (@, ., spaces) to a dash slug so the tag write doesn't fail. */
export function handledByTag(operatorLabel: string): string {
  const slug = operatorLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `handled-by-${slug || 'operator'}`;
}
