// The builder-side free-spritzer notice is a thin render over
// summarizeFreeSpritzers, so what is worth pinning is the DECISION it makes
// from a set of labels: show nothing, show a count, or warn that no number
// could be read. The repo has no component-test infrastructure for the builder
// (AGENTS.md), so these exercise the same pure function the component calls
// with the same inputs it receives.

import { describe, it, expect } from 'vitest';
import { summarizeFreeSpritzers } from '@/lib/portal/freeSpritzers';

/** Mirrors the component's own branching, from labels to what staff are told. */
function noticeFor(labels: string[], suppressed: boolean): 'hidden' | 'suppressed' | 'count' | 'no-number' {
  const summary = summarizeFreeSpritzers(labels);
  if (!summary.present) return 'hidden';
  if (suppressed) return 'suppressed';
  return summary.count === null ? 'no-number' : 'count';
}

describe('the builder notice, from the labels staff type', () => {
  it('says nothing on an ordinary quote', () => {
    expect(noticeFor(["Santa's Roofline Display Package", '16" LED Spritzers ×3'], false)).toBe('hidden');
  });

  it('shows the count the customer will see', () => {
    const labels = ["Santa's Roofline Display Package · 6 FREE Spritzers!"];
    expect(noticeFor(labels, false)).toBe('count');
    expect(summarizeFreeSpritzers(labels).count).toBe(6);
  });

  it('warns when the label promises spritzers but states no number', () => {
    expect(noticeFor(['Free Spritzers, our gift to you'], false)).toBe('no-number');
  });

  it('tells staff when the notice is switched off for this quote', () => {
    expect(noticeFor(["Santa's Roofline Display Package · 6 FREE Spritzers!"], true)).toBe('suppressed');
  });

  it('stays hidden for a quote whose free gift is not spritzers', () => {
    expect(noticeFor(['16" LED Spritzers, 2 Free Wreaths Included'], false)).toBe('hidden');
  });

  it('reads a renamed label, since the customer reads the rename too', () => {
    // The component passes labels through resolveLineItemLabel first, so a
    // staff rename that ADDS the promise must be picked up here.
    expect(noticeFor(['Roofline package, 4 FREE Spritzers'], false)).toBe('count');
    expect(summarizeFreeSpritzers(['Roofline package, 4 FREE Spritzers']).count).toBe(4);
  });
});
