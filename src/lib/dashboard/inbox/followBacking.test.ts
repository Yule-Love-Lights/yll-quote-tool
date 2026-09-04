import { describe, it, expect } from 'vitest';
import {
  followBackingOf,
  followBackingLabel,
  showsFollowBackingMarker,
  DEFAULT_FOLLOWED_VIA,
} from './followBacking';

describe('followBackingOf', () => {
  it('counts a recorded call as backing', () => {
    expect(followBackingOf('call')).toBe('backed');
  });

  it('counts a message this tool sent as backing, which was Naldo\'s call', () => {
    // A reply is corroborated BY CONSTRUCTION: the message exists. Treating it
    // as unbacked would mark a staffer who texted the customer as having done
    // nothing, which is the one outcome most likely to read as simply wrong.
    expect(followBackingOf('reply')).toBe('backed');
  });

  it('says a bare button click is unbacked', () => {
    expect(followBackingOf('manual')).toBe('unbacked');
  });

  it('says UNKNOWN, not unbacked, for a stamp written before the column existed', () => {
    // The distinction this whole feature rests on. A null row is one the
    // migration deliberately did not backfill; calling it unbacked would
    // invent a claim about work that may well have happened.
    expect(followBackingOf(null)).toBe('unknown');
    expect(followBackingOf(undefined)).toBe('unknown');
  });

  it('says UNKNOWN for a value nothing here recognises, so a stranger never accuses', () => {
    expect(followBackingOf('carrier_pigeon')).toBe('unknown');
    expect(followBackingOf('')).toBe('unknown');
  });
});

describe('followBackingLabel', () => {
  it('speaks only about the RECORD, never about what the person did', () => {
    // "No call or text on record" is checkable and true of every call made
    // from a personal phone. "Nobody called" would be an accusation the system
    // has no way to support.
    const label = followBackingLabel('manual');
    expect(label).toBe('No call or text on record');
    expect(label!.toLowerCase()).not.toContain('nobody');
    expect(label!.toLowerCase()).not.toContain('did not');
  });

  it('says nothing at all when something backs the stamp', () => {
    expect(followBackingLabel('call')).toBeNull();
    expect(followBackingLabel('reply')).toBeNull();
  });

  it('says nothing for an unknown stamp, so old rows stay quiet', () => {
    expect(followBackingLabel(null)).toBeNull();
  });
});

describe('showsFollowBackingMarker', () => {
  it('marks only the unbacked row', () => {
    expect(showsFollowBackingMarker('manual')).toBe(true);
    for (const via of ['call', 'reply', null, undefined, 'nonsense']) {
      expect(showsFollowBackingMarker(via as string | null)).toBe(false);
    }
  });
});

describe('DEFAULT_FOLLOWED_VIA', () => {
  it('is manual, so a future caller that says nothing cannot claim it was backed', () => {
    expect(DEFAULT_FOLLOWED_VIA).toBe('manual');
    expect(followBackingOf(DEFAULT_FOLLOWED_VIA)).toBe('unbacked');
  });
});
