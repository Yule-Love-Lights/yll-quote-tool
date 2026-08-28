import { describe, it, expect } from 'vitest';

import { parseMergeCommand, isIncompleteMergeRequest } from './mergeCommands';

describe('parseMergeCommand', () => {
  it('accepts the forms someone actually types on a phone', () => {
    for (const text of [
      'merge 1043',
      'merge #1043',
      'merge pr 1043',
      'merge PR #1043',
      '/merge 1043',
      '  Merge   1043  ',
      'MERGE 1043',
    ]) {
      expect(parseMergeCommand(text), text).toEqual({ kind: 'merge', prNumber: 1043 });
    }
  });

  it('resolves a leading-zero number rather than refusing it', () => {
    expect(parseMergeCommand('merge 007')).toEqual({ kind: 'merge', prNumber: 7 });
  });

  it('refuses a merge with no pull request number', () => {
    expect(parseMergeCommand('merge')).toBeNull();
    expect(parseMergeCommand('merge all')).toBeNull();
    expect(parseMergeCommand('merge everything')).toBeNull();
    expect(parseMergeCommand('merge the posthog one')).toBeNull();
  });

  it('refuses zero, and refuses a number too long to be a pull request', () => {
    expect(parseMergeCommand('merge 0')).toBeNull();
    // A 10-digit phone number must never read as a merge request.
    expect(parseMergeCommand('merge 6315170186')).toBeNull();
  });

  it('leaves ordinary sentences containing the word alone', () => {
    expect(parseMergeCommand('can you merge 1043 later today')).toBeNull();
    expect(parseMergeCommand('we should merge that one')).toBeNull();
    expect(parseMergeCommand('emerge 1043')).toBeNull();
  });

  it('does not fire on the crew time-clock vocabulary', () => {
    for (const text of ['in', 'out', 'break', 'back', 'done', 'status', 'help']) {
      expect(parseMergeCommand(text), text).toBeNull();
    }
  });
});

describe('isIncompleteMergeRequest', () => {
  it('is true for a merge-shaped message this parser refuses', () => {
    expect(isIncompleteMergeRequest('merge')).toBe(true);
    expect(isIncompleteMergeRequest('merge all')).toBe(true);
    expect(isIncompleteMergeRequest('merge 0')).toBe(true);
  });

  it('is false once the message parses as a real merge request', () => {
    expect(isIncompleteMergeRequest('merge 1043')).toBe(false);
  });

  it('is false for unrelated traffic, including a mid-sentence use of the word', () => {
    expect(isIncompleteMergeRequest('status')).toBe(false);
    expect(isIncompleteMergeRequest('we should merge that one')).toBe(false);
    expect(isIncompleteMergeRequest('emerge')).toBe(false);
    // "merged" is a different word; the word boundary excludes it, and always did.
    expect(isIncompleteMergeRequest('merged it already')).toBe(false);
  });

  it('is false for ordinary sentences that merely OPEN with the word', () => {
    // The reason this matcher anchors the whole string instead of matching a
    // prefix: these are things people say to each other, not merge requests,
    // and answering them turns a coaching reply into chatter. Each of these
    // DID match before the pattern was narrowed.
    expect(isIncompleteMergeRequest('merge conflict again on that branch')).toBe(false);
    expect(isIncompleteMergeRequest('merge that when you get a chance')).toBe(false);
    expect(isIncompleteMergeRequest('merge the posthog one')).toBe(false);
  });

  it('is true for a real number carrying a courtesy word, so it is coached not dropped', () => {
    // The strict parser refuses these on purpose, but the sender plainly meant
    // it, so silence would be the worst of the three possible answers.
    expect(isIncompleteMergeRequest('merge 1043 please')).toBe(true);
    expect(isIncompleteMergeRequest('merge #1043 now')).toBe(true);
    expect(isIncompleteMergeRequest('merge pr 1043 thanks')).toBe(true);
    // The digits requirement is what stops this branch re-admitting prose.
    expect(isIncompleteMergeRequest('merge conflict again')).toBe(false);
  });
});
