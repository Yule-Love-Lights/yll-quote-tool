import { describe, it, expect } from 'vitest';

import { actionsFor } from './ClockCard';

// The clock card's button state machine, tested without a DOM. The full fetch
// wiring is exercised by the /api/office/clock route tests; this pins the rule
// for WHICH buttons appear, which is the part a person taps.

describe('actionsFor', () => {
  it('offers only Clock in when clocked out', () => {
    const a = actionsFor({ clockedIn: false, onBreak: false });
    expect(a.map((x) => x.action)).toEqual(['in']);
  });

  it('offers Clock out and Start break when clocked in, not on break', () => {
    const a = actionsFor({ clockedIn: true, onBreak: false });
    expect(a.map((x) => x.action)).toEqual(['out', 'break-start']);
  });

  it('swaps Start break for End break while on a break', () => {
    const a = actionsFor({ clockedIn: true, onBreak: true });
    expect(a.map((x) => x.action)).toEqual(['out', 'break-end']);
    // break-start and break-end are never offered together.
    expect(a.some((x) => x.action === 'break-start')).toBe(false);
  });

  it('never offers a break control while clocked out', () => {
    const a = actionsFor({ clockedIn: false, onBreak: false });
    expect(a.some((x) => x.action.startsWith('break'))).toBe(false);
    expect(a.some((x) => x.action === 'out')).toBe(false);
  });
});
