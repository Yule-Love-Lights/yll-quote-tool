import { describe, it, expect } from 'vitest';
import { outboundClearsRow, rowsClearedByOutbound } from './outboundClearsContact';

const CALLED = new Date('2026-09-01T13:41:00.000Z');
const base = {
  id: 'r1',
  status: 'unresponded',
  lastMessageAt: new Date('2026-08-17T17:31:00.000Z'),
  lastInboundAt: new Date('2026-08-17T17:31:00.000Z'),
};

describe('outboundClearsRow', () => {
  it('clears the row we answered elsewhere, which is the whole point', () => {
    // Susan's case exactly: her 17 August email, our 1 September reply on a
    // different thread.
    expect(outboundClearsRow(base, { at: CALLED })).toBe(true);
  });

  it('REFUSES when the customer wrote again after we reached out', () => {
    // The guard that matters. This person is waiting on us right now, and this
    // row is the only thing that says so.
    const wroteBack = { ...base, lastInboundAt: new Date('2026-09-02T09:00:00.000Z') };
    expect(outboundClearsRow(wroteBack, { at: CALLED })).toBe(false);
  });

  it('refuses when they wrote back at the SAME instant, rather than racing them', () => {
    expect(outboundClearsRow({ ...base, lastInboundAt: CALLED }, { at: CALLED })).toBe(false);
  });

  it('refuses an outbound that predates the row, which cannot have answered it', () => {
    const later = { ...base, lastMessageAt: new Date('2026-09-02T00:00:00.000Z') };
    expect(outboundClearsRow(later, { at: CALLED })).toBe(false);
  });

  it('refuses a row with no clock rather than guessing it is finished', () => {
    expect(outboundClearsRow({ ...base, lastMessageAt: null }, { at: CALLED })).toBe(false);
  });

  it('leaves a decision a person already made', () => {
    for (const status of ['handled', 'dismissed', 'completed']) {
      expect(outboundClearsRow({ ...base, status }, { at: CALLED })).toBe(false);
    }
  });

  it('never re-clears the row this very touch wrote', () => {
    expect(outboundClearsRow(base, { at: CALLED, originItemId: 'r1' })).toBe(false);
    expect(outboundClearsRow(base, { at: CALLED, originItemId: 'other' })).toBe(true);
  });

  it('clears a row the customer never wrote on, since there is nobody waiting', () => {
    expect(outboundClearsRow({ ...base, lastInboundAt: null }, { at: CALLED })).toBe(true);
  });
});

describe('rowsClearedByOutbound', () => {
  it('takes the answered rows and leaves the one still waiting', () => {
    const rows = [
      { ...base, id: 'answered' },
      { ...base, id: 'still-waiting', lastInboundAt: new Date('2026-09-02T09:00:00.000Z') },
      { ...base, id: 'handled-already', status: 'handled' },
    ];
    expect(rowsClearedByOutbound(rows, { at: CALLED })).toEqual(['answered']);
  });

  it('returns nothing rather than throwing on an empty list', () => {
    expect(rowsClearedByOutbound([], { at: CALLED })).toEqual([]);
  });
});
