// Coverage for the junk-gate port (calls_merge_plan_2026-08.md slice S2).
// The yll-call-copilot repo has no dedicated test file for this module (it
// is exercised indirectly through ringcentral.test.ts and pipeline.test.ts)
// — this is fresh coverage for the ported module itself.

import { describe, it, expect } from 'vitest';
import { isAutomatedTurn, junkReasonFromTurns } from './junk';

describe('junkReasonFromTurns', () => {
  it('flags a single-speaker call (voicemail with nobody replying) as junk', () => {
    const turns = [
      { speaker: '0', text: 'please leave a message after the tone and someone will call you back' },
    ];
    expect(junkReasonFromTurns(turns)).toBe('single_speaker');
  });

  it('flags a too-short two-speaker exchange as junk', () => {
    const turns = [
      { speaker: '0', text: 'hello' },
      { speaker: '1', text: 'hi' },
    ];
    expect(junkReasonFromTurns(turns)).toBe('too_short');
  });

  it('flags a call where one whole speaker channel is nothing but IVR phrases', () => {
    const turns = [
      { speaker: '0', text: 'the person you are calling is protected please leave a message after the tone' },
      { speaker: '1', text: 'press 1 to continue or press pound to repeat this message' },
    ];
    expect(junkReasonFromTurns(turns)).toBe('automated_speaker');
  });

  it('is not junk for a real two-way conversation with enough words', () => {
    const turns = [
      {
        speaker: '0',
        text: 'hi there this is a real conversation about holiday lights for your home this season',
      },
      { speaker: '1', text: 'great, tell me more about pricing and scheduling please' },
    ];
    expect(junkReasonFromTurns(turns)).toBeNull();
  });
});

describe('isAutomatedTurn', () => {
  it('is true for a bare-digits readout', () => {
    expect(isAutomatedTurn('51, 685 071 66.')).toBe(true);
  });

  it('is true for an IVR phrase regardless of punctuation noise', () => {
    expect(isAutomatedTurn('Thanks, please. Stay on the line.')).toBe(true);
  });

  it('is false for ordinary speech', () => {
    expect(isAutomatedTurn('I would like a quote for my house please')).toBe(false);
  });

  it('is false for an empty turn', () => {
    expect(isAutomatedTurn('   ')).toBe(false);
  });
});
