// Fix round 2 (MED): replyOutcome had zero test coverage before this — the
// exact gap the delta-verify review flagged. Pure-function test only, same
// no-jsdom convention as this directory's other component test files (see
// InWorksSection.test.tsx's own header note — no jsdom/testing-library
// dependency exists in this repo).

import { describe, it, expect } from 'vitest';
import { replyOutcome } from './ReplyComposer';

describe('replyOutcome (fix round 2)', () => {
  it('is "resolved" when resolved is true (the ordinary case)', () => {
    expect(replyOutcome({ resolved: true })).toBe('resolved');
  });

  it('is "resolved" when resolved is omitted — back-compat with an older cached response shape', () => {
    expect(replyOutcome({})).toBe('resolved');
  });

  it('is "refused" when resolved is false AND refused is true — a genuine CAS refusal', () => {
    expect(replyOutcome({ resolved: false, refused: true })).toBe('refused');
  });

  it('is "error" when resolved is false AND refused is false — a real failure, not a lost race', () => {
    expect(replyOutcome({ resolved: false, refused: false })).toBe('error');
  });

  it('is "error" when resolved is false and refused is omitted — fails toward NOT assuming a benign refusal', () => {
    expect(replyOutcome({ resolved: false })).toBe('error');
  });
});
