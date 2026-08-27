// Fix round 3 (Finding LOW, PR #926): the ⚠️ cue on a cancel response was
// gated on `refundNeeded` only, so the new stockNeedsAttention flag (fired
// whenever cancel leaves a stock-reversal caveat for a human, most notably
// the PENDING_STOCK_SNAPSHOT refusal note) didn't draw the eye on this
// generic action menu (backs cancel on 4 admin surfaces). This repo has no
// jsdom/testing-library setup, so this covers the extracted pure message
// builder directly (same pattern as ColorRequestPanel.test.tsx).

import { describe, expect, it } from 'vitest';
import { cancelAlertMessage, staleSelectionConfirmMessage } from './PipelineActionsMenu';

describe('cancelAlertMessage', () => {
  it('returns null when there is no note (mirrors the old `if (body.note) alert(...)` gate)', () => {
    expect(cancelAlertMessage({})).toBeNull();
    expect(cancelAlertMessage({ refundNeeded: true })).toBeNull();
  });

  it('shows no ⚠️ cue when nothing needs attention', () => {
    expect(cancelAlertMessage({ note: 'No payment was taken — nothing to refund.' })).toBe(
      'Order cancelled. No payment was taken — nothing to refund.',
    );
  });

  it('cues on refundNeeded (the original behavior)', () => {
    expect(cancelAlertMessage({ refundNeeded: true, note: 'issue the refund manually in Valor.' })).toBe(
      '⚠️ Order cancelled. issue the refund manually in Valor.',
    );
  });

  it('cues on stockNeedsAttention even when no refund is owed (the fix round 3 gap)', () => {
    const note = 'the per-job snapshot failed to save — reconcile on-hand manually.';
    expect(cancelAlertMessage({ refundNeeded: false, stockNeedsAttention: true, note })).toBe(
      `⚠️ Order cancelled. ${note}`,
    );
  });
});

// Row 324 fix round (admin lens MED): staleSelectionConfirmMessage must never
// present a STAFF-preselected browsing_selection as the customer's own
// choice, and must still warn either way (the portal reseeds from it
// regardless of who set it — see the pipeline route's comment).
describe('staleSelectionConfirmMessage', () => {
  const CUSTOMER_SEL = { packageId: 'B', itemCount: 2, savedAt: '2026-08-01T00:00:00Z', staffSet: false };
  const STAFF_SEL = { packageId: 'B', itemCount: 2, savedAt: '2026-08-01T00:00:00Z', staffSet: true };

  it('says "this customer has a saved selection from before declined" for a genuine customer edit', () => {
    expect(staleSelectionConfirmMessage(CUSTOMER_SEL, 'declined')).toContain(
      'this customer has a saved selection from before declined',
    );
  });

  it('says "the quote went abandoned" for the abandoned status wording', () => {
    expect(staleSelectionConfirmMessage(CUSTOMER_SEL, 'abandoned')).toContain(
      'this customer has a saved selection from before the quote went abandoned',
    );
  });

  it('says "a starting selection your team set" — never "the customer chose" — for a staff-preselected selection, on EITHER status', () => {
    const declined = staleSelectionConfirmMessage(STAFF_SEL, 'declined');
    const abandoned = staleSelectionConfirmMessage(STAFF_SEL, 'abandoned');
    expect(declined).toContain('this customer has a starting selection your team set');
    expect(abandoned).toContain('this customer has a starting selection your team set');
    expect(declined).not.toContain('saved selection from before');
    expect(abandoned).not.toContain('saved selection from before');
  });

  it('still warns (never suppresses) for a staff-set selection — the portal reseeds from it regardless of who set it', () => {
    expect(staleSelectionConfirmMessage(STAFF_SEL, 'declined')).toMatch(/Send will reopen their portal on it/);
  });

  it('describes a lettered package and item count identically for both staffSet values', () => {
    const customItems = { packageId: 'D', itemCount: 3, savedAt: null, staffSet: false };
    const staffItems = { ...customItems, staffSet: true };
    expect(staleSelectionConfirmMessage(customItems, 'declined')).toContain('3 custom items');
    expect(staleSelectionConfirmMessage(staffItems, 'declined')).toContain('3 custom items');
  });
});
