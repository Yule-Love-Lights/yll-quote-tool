// Fix round 3 (Finding LOW, PR #926): the ⚠️ cue on a cancel response was
// gated on `refundNeeded` only, so the new stockNeedsAttention flag (fired
// whenever cancel leaves a stock-reversal caveat for a human, most notably
// the PENDING_STOCK_SNAPSHOT refusal note) didn't draw the eye on this
// generic action menu (backs cancel on 4 admin surfaces). This repo has no
// jsdom/testing-library setup, so this covers the extracted pure message
// builder directly (same pattern as ColorRequestPanel.test.tsx).

import { describe, expect, it } from 'vitest';
import { cancelAlertMessage } from './PipelineActionsMenu';

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
