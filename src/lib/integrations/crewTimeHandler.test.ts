import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Shift = { id: string; clockInAt: string; clockOutAt: string | null } | null;
type Brk = { id: string; startedAt: string; endedAt: string | null } | null;
type Seg = { id: string; jobId: string; arrivedAt: string } | null;

const { state } = vi.hoisted(() => ({
  state: {
    current: {
      crew: { id: 'crew-1', displayName: 'SonSon', active: true } as
        | { id: string; displayName: string; active: boolean }
        | null,
      shift: null as Shift,
      brk: null as Brk,
      seg: null as Seg,
      job: null as { id: string; job_number: number; status: string } | null,
      calls: [] as string[],
      statusSet: [] as string[],
      throwOn: null as string | null,
    },
  },
}));

vi.mock('@/lib/crewMembers', () => ({
  getCrewMemberByTelegramUserId: async () => state.current.crew,
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: state.current.job, error: null }) }),
      }),
    }),
  }),
}));

vi.mock('@/lib/shifts', () => ({
  getOpenShift: async () => state.current.shift,
  clockIn: async () => {
    state.current.calls.push('clockIn');
    if (state.current.throwOn === 'clockIn') throw new Error('boom');
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    return state.current.shift;
  },
  clockOut: async () => {
    state.current.calls.push('clockOut');
    return { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: '2026-08-18T21:00:00Z' };
  },
}));

vi.mock('@/lib/shiftBreaks', () => ({
  getOpenBreak: async () => state.current.brk,
  startBreak: async () => {
    state.current.calls.push('startBreak');
    return { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
  },
  endBreak: async () => {
    state.current.calls.push('endBreak');
    return { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: '2026-08-18T16:30:00Z' };
  },
}));

vi.mock('@/lib/jobSegments', () => ({
  getOpenSegment: async () => state.current.seg,
  arriveAtJob: async () => {
    state.current.calls.push('arriveAtJob');
    return { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
  },
  departFromJob: async (_id: string, _crew: string, reason: string) => {
    state.current.calls.push(`departFromJob:${reason}`);
    return { id: 'g1' };
  },
}));

vi.mock('@/lib/jobs', () => ({
  getJob: async () => state.current.job,
  setJobStatus: async (_id: string, to: string) => {
    state.current.statusSet.push(to);
    return { id: 'job-uuid', status: to };
  },
}));

beforeEach(() => {
  state.current = {
    crew: { id: 'crew-1', displayName: 'SonSon', active: true },
    shift: null,
    brk: null,
    seg: null,
    job: { id: 'job-uuid', job_number: 1042, status: 'scheduled' },
    calls: [],
    statusSet: [],
    throwOn: null,
  };
});

afterEach(() => vi.restoreAllMocks());

import { handleCrewTimeMessage } from './crewTimeHandler';

const say = (text: string) => handleCrewTimeMessage('tg-1', text);

describe('it only handles actual commands', () => {
  it('leaves ordinary chatter to the normal bot', async () => {
    for (const t of ['anyone got a ladder', 'the customer wants blue', 'ok']) {
      expect(await say(t)).toEqual({ handled: false });
    }
  });
});

describe('identity comes from the sender', () => {
  it('refuses an unlinked Telegram user rather than guessing who they are', async () => {
    state.current.crew = null;
    const out = await say('in');
    expect(out).toMatchObject({ handled: true });
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('do not have you set up');
    expect(state.current.calls).toEqual([]);
  });

  it('refuses an inactive crew member', async () => {
    state.current.crew = { id: 'crew-1', displayName: 'X', active: false };
    const out = await say('in');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('not active');
    expect(state.current.calls).toEqual([]);
  });
});

describe('clock in / out', () => {
  it('clocks in and confirms the time', async () => {
    const out = await say('in');
    expect(state.current.calls).toContain('clockIn');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toMatch(/Clocked in at/);
  });

  it('does not double-clock-in, and says since when', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    const out = await say('in');
    expect(state.current.calls).not.toContain('clockIn');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Already clocked in');
  });

  it('refuses clock out when not clocked in', async () => {
    const out = await say('out');
    expect(state.current.calls).not.toContain('clockOut');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toBe('You are not clocked in.');
  });

  it('TELLS them what the clock-out also closed, rather than leaving it silent', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    state.current.brk = { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    const out = await say('out');
    if (out.handled) {
      expect(out.reply).toContain('break was closed');
      expect(out.reply).toContain('flagged for the office');
    }
  });
});

describe('breaks', () => {
  it('requires a clock-in first', async () => {
    const out = await say('break');
    expect(state.current.calls).not.toContain('startBreak');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Clock in first');
  });

  it('starts a break and says it is unpaid', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    const out = await say('lunch');
    expect(state.current.calls).toContain('startBreak');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('unpaid');
  });

  it('does not start a second break', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    state.current.brk = { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
    const out = await say('break');
    expect(state.current.calls).not.toContain('startBreak');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Already on break');
  });

  it('ends a break only when one is running', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    const none = await say('back');
    if (none.handled) expect(none.reply).toBe('You are not on a break.');

    state.current.brk = { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
    await say('back');
    expect(state.current.calls).toContain('endBreak');
  });
});

describe('arrive / depart / done', () => {
  beforeEach(() => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
  });

  it('refuses to arrive while on a break', async () => {
    state.current.brk = { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
    const out = await say('arrive 1042');
    expect(state.current.calls).not.toContain('arriveAtJob');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('on a break');
  });

  it('refuses an unknown job number', async () => {
    state.current.job = null;
    const out = await say('arrive 9999');
    expect(state.current.calls).not.toContain('arriveAtJob');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('cannot find job #9999');
  });

  it('arrives at a real job', async () => {
    const out = await say('arrive 1042');
    expect(state.current.calls).toContain('arriveAtJob');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('#1042');
  });

  it('departs with the reason, and says it is NOT finished', async () => {
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    const out = await say('depart rain');
    expect(state.current.calls).toContain('departFromJob:weather');
    expect(state.current.statusSet).toEqual([]);
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Not marked finished');
  });

  it('coaches a depart with no reason instead of guessing one', async () => {
    const out = await say('depart');
    expect(state.current.calls).toEqual([]);
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Which reason?');
  });

  it('done departs as completed AND marks the job installed', async () => {
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    const out = await say('done');
    expect(state.current.calls).toContain('departFromJob:completed');
    expect(state.current.statusSet).toEqual(['installed']);
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('marked installed');
  });

  it('records the time even when the job cannot legally become installed', async () => {
    // Time first, status second: the half that pays someone still lands.
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    state.current.job = { id: 'job-uuid', job_number: 1042, status: 'cancelled' };
    const out = await say('done');
    expect(state.current.calls).toContain('departFromJob:completed');
    expect(state.current.statusSet).toEqual([]);
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Time recorded');
  });

  it('does not re-install an already-installed job', async () => {
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    state.current.job = { id: 'job-uuid', job_number: 1042, status: 'installed' };
    const out = await say('done');
    expect(state.current.statusSet).toEqual([]);
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Already marked installed');
  });
});

describe('status', () => {
  it('says plainly when not clocked in', async () => {
    const out = await say('status');
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toBe('Not clocked in.');
  });

  it('reports break and job together', async () => {
    state.current.shift = { id: 's1', clockInAt: '2026-08-18T12:00:00Z', clockOutAt: null };
    state.current.brk = { id: 'b1', startedAt: '2026-08-18T16:00:00Z', endedAt: null };
    state.current.seg = { id: 'g1', jobId: 'job-uuid', arrivedAt: '2026-08-18T13:00:00Z' };
    const out = await say('status');
    if (out.handled) {
      expect(out.reply).toContain('Clocked in since');
      expect(out.reply).toContain('On break since');
      expect(out.reply).toContain('#1042');
    }
  });
});

describe('unaddressed group messages do not get replied to', () => {
  // A crew group is full of people saying "done" and "back" to each other. The
  // bot answers ONLY when spoken to; replying to a non-crew member's chatter
  // broke that contract and spammed the group.
  it('stays silent for a NON-crew sender who did not address the bot', async () => {
    state.current.crew = null;
    const out = await handleCrewTimeMessage('tg-stranger', 'done', { addressed: false });
    expect(out).toEqual({ handled: false });
  });

  it('DOES explain itself when a non-crew sender addresses the bot directly', async () => {
    // A real crew member whose Telegram is unlinked deserves to be told why.
    state.current.crew = null;
    const out = await handleCrewTimeMessage('tg-stranger', 'done', { addressed: true });
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('do not have you set up');
  });

  it('still works for a real crew member who did not address the bot', async () => {
    // The whole reason capture runs ahead of the gate: "in" is how crew talk.
    state.current.shift = null;
    const out = await handleCrewTimeMessage('tg-1', 'in', { addressed: false });
    expect(out.handled).toBe(true);
    expect(state.current.calls).toContain('clockIn');
  });
});

describe('failures never leak a stack to a crew member', () => {
  it('gives a plain retry message', async () => {
    state.current.throwOn = 'clockIn';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await say('in');
    if (out.handled) {
      expect(out.reply).toContain('did not go through');
      expect(out.reply).not.toContain('boom');
    }
    spy.mockRestore();
  });
});
