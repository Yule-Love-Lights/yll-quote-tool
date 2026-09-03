// A photo queued in a previous session comes back to life when the capture
// screen reopens (Naldo, 2026-08-31: offline durability for the field
// capture app). These tests pin the one hard call in that process: a photo
// that was mid-upload when the app died is genuinely ambiguous, since we
// cannot tell from here whether the server got it before the tab closed.
// Guessing wrong either drops paid work (never resend) or pays twice for
// one photo (resend a landed one), so the rule is to never guess: only a
// plain "we know this failed" status resumes on its own.

import { describe, expect, it } from 'vitest';
import {
  describeRestoredBanner,
  isTerminalStoredStatus,
  reconcileStoredPhoto,
  sortRestoredNewestFirst,
} from './photoQueueRestore';

describe('reconcileStoredPhoto', () => {
  it('a photo that was mid-upload when the app died comes back held, not resumed: we do not know if it landed', () => {
    const decision = reconcileStoredPhoto({ status: 'uploading' });
    expect(decision.status).toBe('failed');
    expect(decision.autoResume).toBe(false);
    expect(decision.error).toMatch(/may have already/i);
  });

  it('a photo that was waiting to retry resumes on its own: the last known attempt already failed cleanly', () => {
    const decision = reconcileStoredPhoto({ status: 'waiting', error: 'No connection.' });
    expect(decision).toEqual({ status: 'waiting', autoResume: true, error: 'No connection.' });
  });

  it('a photo already held for the worker to retry stays held, with its own reason kept', () => {
    const decision = reconcileStoredPhoto({ status: 'failed', error: 'This photo is too large even after compression.' });
    expect(decision).toEqual({
      status: 'failed',
      autoResume: false,
      error: 'This photo is too large even after compression.',
    });
  });

  it('a waiting photo with no reason recorded still resumes, with no reason to show', () => {
    const decision = reconcileStoredPhoto({ status: 'waiting' });
    expect(decision).toEqual({ status: 'waiting', autoResume: true, error: undefined });
  });
});

describe('isTerminalStoredStatus', () => {
  it('an uploaded record is terminal: it already landed and already got paid', () => {
    expect(isTerminalStoredStatus('uploaded')).toBe(true);
  });

  it('a discarded record is terminal: the worker threw it away on purpose', () => {
    expect(isTerminalStoredStatus('discarded')).toBe(true);
  });

  it('uploading, waiting, and failed are all still pending work', () => {
    expect(isTerminalStoredStatus('uploading')).toBe(false);
    expect(isTerminalStoredStatus('waiting')).toBe(false);
    expect(isTerminalStoredStatus('failed')).toBe(false);
  });
});

describe('sortRestoredNewestFirst', () => {
  it('orders newest capturedAt first, matching how a fresh shot is added to the live queue', () => {
    const a = { id: 'a', capturedAt: 100 };
    const b = { id: 'b', capturedAt: 300 };
    const c = { id: 'c', capturedAt: 200 };
    expect(sortRestoredNewestFirst([a, b, c]).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the array it was given', () => {
    const input = [{ id: 'a', capturedAt: 1 }, { id: 'b', capturedAt: 2 }];
    const before = input.map((x) => x.id);
    sortRestoredNewestFirst(input);
    expect(input.map((x) => x.id)).toEqual(before);
  });

  it('an empty list stays empty', () => {
    expect(sortRestoredNewestFirst([])).toEqual([]);
  });
});

describe('describeRestoredBanner', () => {
  it('nothing restored means no banner at all', () => {
    expect(describeRestoredBanner([])).toBeNull();
  });

  it('one photo resuming on its own, said in the singular', () => {
    const text = describeRestoredBanner([{ autoResume: true }]);
    expect(text).toContain('1 photo');
    expect(text).not.toContain('1 photos');
    expect(text).toMatch(/sending again/i);
  });

  it('several photos resuming, said in the plural', () => {
    const text = describeRestoredBanner([{ autoResume: true }, { autoResume: true }, { autoResume: true }]);
    expect(text).toContain('3 photos');
    expect(text).toMatch(/sending again/i);
  });

  it('a photo that may have already gone through gets its own plain warning', () => {
    const text = describeRestoredBanner([{ autoResume: false }]);
    expect(text).toMatch(/may have already/i);
    expect(text).not.toMatch(/sending again/i);
  });

  it('a mix of both says both, so nothing is hidden from the worker', () => {
    const text = describeRestoredBanner([{ autoResume: true }, { autoResume: false }]);
    expect(text).toMatch(/sending again/i);
    expect(text).toMatch(/may have already/i);
  });
});
