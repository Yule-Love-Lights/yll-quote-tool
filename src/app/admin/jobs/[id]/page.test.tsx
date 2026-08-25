// Fix round 3 (Finding LOW, PR #926): the ⚠️ cue on a cancel response was
// gated on `refundNeeded` only, so the new stockNeedsAttention flag (fired
// whenever cancel leaves a stock-reversal caveat for a human, most notably
// the PENDING_STOCK_SNAPSHOT refusal note) didn't draw the eye. This repo has
// no jsdom/testing-library setup, so this covers the extracted pure message
// builder directly (same pattern as ColorRequestPanel.test.tsx).

import { describe, expect, it } from 'vitest';
import { cancelActionMessage } from './page';

describe('cancelActionMessage', () => {
  it('reports "Already cancelled." regardless of any other field', () => {
    expect(cancelActionMessage({ alreadyCancelled: true, refundNeeded: true, note: 'x' })).toBe(
      'Already cancelled.',
    );
  });

  it('shows no ⚠️ cue when nothing needs attention', () => {
    expect(cancelActionMessage({ note: 'No payment was taken — nothing to refund.' })).toBe(
      'Order cancelled. No payment was taken — nothing to refund.',
    );
  });

  it('cues on refundNeeded (the original behavior)', () => {
    expect(
      cancelActionMessage({ refundNeeded: true, note: 'A payment was already taken — issue the refund manually in Valor.' }),
    ).toBe('⚠️ Order cancelled. A payment was already taken — issue the refund manually in Valor.');
  });

  it('cues on stockNeedsAttention even when no refund is owed (the fix round 3 gap)', () => {
    const note =
      "This job was prepped, but the per-job stock_deductions snapshot failed to save right after prep (a transient error) — nothing was automatically returned to stock. Prep normally logs what it took to job_stock_movements (reason: 'prep') for this job — check there first. That log is best-effort, so if it has no rows for this job, reconcile against the job's materials list instead.";
    expect(cancelActionMessage({ refundNeeded: false, stockNeedsAttention: true, note })).toBe(
      `⚠️ Order cancelled. ${note}`,
    );
  });

  it('cues when either flag is set (both true doesn\'t double the cue)', () => {
    const msg = cancelActionMessage({ refundNeeded: true, stockNeedsAttention: true, note: 'x' });
    expect(msg).toBe('⚠️ Order cancelled. x');
    expect(msg.match(/⚠️/g)).toHaveLength(1);
  });
});
