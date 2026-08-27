import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AssignmentRefusedError,
  assignCrewToJob,
  computeDayCapacity,
  getSchedule,
  isCalendarDate,
  listUnscheduledJobs,
  unassignCrewFromJob,
  type ScheduledJob,
} from './scheduling';

// ─── Row 300: the four DB functions were untested ──────────────────────────
// A tiny chainable stub: each from(table) call consumes the next programmed
// response for that table, and every builder method records itself so tests
// can assert what was (or was NOT) attempted. The chain is thenable, because
// getSchedule/listUnscheduledJobs await the builder directly (no maybeSingle).

type DbResp = { data: unknown; error: { code?: string; message: string } | null };
type Chain = Record<string, (...args: unknown[]) => Chain> & {
  maybeSingle: () => Promise<DbResp>;
  then: (res: (v: DbResp) => unknown, rej?: (e: unknown) => unknown) => Promise<unknown>;
  calls: Array<[string, unknown[]]>;
};

function chain(resp: DbResp): Chain {
  const calls: Array<[string, unknown[]]> = [];
  const p = { calls } as unknown as Chain;
  for (const m of ['select', 'insert', 'delete', 'eq', 'gte', 'lte', 'in', 'not', 'order']) {
    (p as Record<string, unknown>)[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return p;
    };
  }
  p.maybeSingle = () => Promise.resolve(resp);
  p.then = (res, rej) => Promise.resolve(resp).then(res, rej);
  return p;
}

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));

/** Queue of responses per table, consumed in call order. */
function makeDb(queues: Record<string, Chain[]>) {
  const client = {
    from: (table: string) => {
      const q = queues[table];
      if (!q || !q.length) throw new Error(`unexpected query on ${table}`);
      return q.shift()!;
    },
  };
  dbRef.current = client;
  return queues;
}

const FIELD_CREW: DbResp = { data: { id: 'crew-1', active: true, is_office: false }, error: null };
const ASSIGNMENT_ROW = { id: 'a1', job_id: 'j1', crew_member_id: 'crew-1', assigned_date: '2026-08-27' };

beforeEach(() => {
  dbRef.current = null;
});

describe('assignCrewToJob (rows 356 + 300)', () => {
  it('assigns an active field crew member and maps the row to camelCase', async () => {
    makeDb({
      crew_members: [chain(FIELD_CREW)],
      job_assignments: [chain({ data: ASSIGNMENT_ROW, error: null })],
    });
    const got = await assignCrewToJob('j1', 'crew-1', '2026-08-27');
    expect(got).toEqual({ id: 'a1', jobId: 'j1', crewMemberId: 'crew-1', assignedDate: '2026-08-27' });
  });

  it('row 356: REFUSES an office staff id at the WRITE, without touching job_assignments', async () => {
    const queues = makeDb({
      crew_members: [chain({ data: { id: 'crew-9', active: true, is_office: true }, error: null })],
      job_assignments: [chain({ data: ASSIGNMENT_ROW, error: null })],
    });
    const err = await assignCrewToJob('j1', 'crew-9', '2026-08-27').then(
      () => null,
      e => e as Error,
    );
    expect(err).toBeInstanceOf(AssignmentRefusedError);
    expect(err?.message).toMatch(/Office staff/);
    // The insert queue was never consumed — the refusal happened BEFORE the write.
    expect(queues.job_assignments).toHaveLength(1);
  });

  it('row 356: refuses an inactive member and an unknown id, each before any write', async () => {
    const q1 = makeDb({
      crew_members: [chain({ data: { id: 'crew-2', active: false, is_office: false }, error: null })],
      job_assignments: [chain({ data: ASSIGNMENT_ROW, error: null })],
    });
    await expect(assignCrewToJob('j1', 'crew-2', '2026-08-27')).rejects.toThrow(/inactive/);
    expect(q1.job_assignments).toHaveLength(1);

    const q2 = makeDb({
      crew_members: [chain({ data: null, error: null })],
      job_assignments: [chain({ data: ASSIGNMENT_ROW, error: null })],
    });
    await expect(assignCrewToJob('j1', 'nope', '2026-08-27')).rejects.toThrow(/Unknown crew member/);
    expect(q2.job_assignments).toHaveLength(1);
  });

  it('row 300: the 23505 double-click race recovers by returning the EXISTING row (the clockIn sibling pattern)', async () => {
    makeDb({
      crew_members: [chain(FIELD_CREW)],
      job_assignments: [
        chain({ data: null, error: { code: '23505', message: 'duplicate key' } }),
        chain({ data: ASSIGNMENT_ROW, error: null }),
      ],
    });
    const got = await assignCrewToJob('j1', 'crew-1', '2026-08-27');
    expect(got).toEqual({ id: 'a1', jobId: 'j1', crewMemberId: 'crew-1', assignedDate: '2026-08-27' });
  });

  it('a non-23505 insert error throws with the message', async () => {
    makeDb({
      crew_members: [chain(FIELD_CREW)],
      job_assignments: [chain({ data: null, error: { code: '23503', message: 'fk violation' } })],
    });
    await expect(assignCrewToJob('j1', 'crew-1', '2026-08-27')).rejects.toThrow(/fk violation/);
  });

  it('rejects a malformed date before touching anything', async () => {
    dbRef.current = { from: () => { throw new Error('should not query'); } };
    await expect(assignCrewToJob('j1', 'crew-1', '08/27/2026')).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('unassignCrewFromJob (row 300)', () => {
  it('true when a row was removed, false when nothing matched', async () => {
    makeDb({ job_assignments: [chain({ data: [{ id: 'a1' }], error: null })] });
    await expect(unassignCrewFromJob('j1', 'crew-1', '2026-08-27')).resolves.toBe(true);
    makeDb({ job_assignments: [chain({ data: [], error: null })] });
    await expect(unassignCrewFromJob('j1', 'crew-1', '2026-08-27')).resolves.toBe(false);
  });

  it('throws on a delete error', async () => {
    makeDb({ job_assignments: [chain({ data: null, error: { message: 'boom' } })] });
    await expect(unassignCrewFromJob('j1', 'crew-1', '2026-08-27')).rejects.toThrow(/boom/);
  });
});

describe('getSchedule (row 300)', () => {
  it('groups assignments by day and job, splitting hours across the crew', async () => {
    makeDb({
      job_assignments: [
        chain({
          data: [
            { id: 'a1', job_id: 'j1', crew_member_id: 'c1', assigned_date: '2026-08-27' },
            { id: 'a2', job_id: 'j1', crew_member_id: 'c2', assigned_date: '2026-08-27' },
          ],
          error: null,
        }),
      ],
      jobs: [
        chain({
          data: [
            { id: 'j1', job_number: 1001, status: 'to_schedule', budgeted_hours: 8, labor_revenue_cents: 10000, rates_are_placeholder: false },
          ],
          error: null,
        }),
      ],
    });
    const got = await getSchedule('2026-08-27', '2026-08-27');
    expect(got.errors).toEqual([]);
    expect(got.jobsByDate['2026-08-27']).toEqual([
      expect.objectContaining({ jobId: 'j1', jobNumber: 1001, crewMemberIds: ['c1', 'c2'] }),
    ]);
    expect(got.days[0]?.perCrew).toEqual({ c1: 4, c2: 4 });
  });

  it('surfaces a job-lookup error instead of swallowing it (a partial read must not look empty)', async () => {
    makeDb({
      job_assignments: [
        chain({ data: [{ id: 'a1', job_id: 'j1', crew_member_id: 'c1', assigned_date: '2026-08-27' }], error: null }),
      ],
      jobs: [chain({ data: null, error: { message: 'job scan died' } })],
    });
    const got = await getSchedule('2026-08-27', '2026-08-27');
    expect(got.errors.join(' ')).toMatch(/job scan died/);
    // The assignment still renders (status 'unknown', hours null) rather than vanishing.
    expect(got.jobsByDate['2026-08-27']).toHaveLength(1);
  });

  it('rejects malformed bounds without querying', async () => {
    dbRef.current = { from: () => { throw new Error('should not query'); } };
    const got = await getSchedule('bad', '2026-08-27');
    expect(got.errors).toEqual(['Dates must be YYYY-MM-DD']);
  });
});

describe('listUnscheduledJobs (row 300)', () => {
  it('excludes jobs already assigned on/after the date and tags placeholder hours', async () => {
    makeDb({
      job_assignments: [chain({ data: [{ job_id: 'j-assigned' }], error: null })],
      jobs: [
        chain({
          data: [
            { id: 'j-assigned', job_number: 1, status: 'to_schedule', budgeted_hours: 8, labor_revenue_cents: 1000, rates_are_placeholder: false },
            { id: 'j-open', job_number: 2, status: 'to_schedule', budgeted_hours: 6, labor_revenue_cents: 2000, rates_are_placeholder: true },
          ],
          error: null,
        }),
      ],
    });
    const got = await listUnscheduledJobs('2026-08-27');
    expect(got.jobs.map(j => j.jobId)).toEqual(['j-open']);
    expect(got.jobs[0]).toMatchObject({ hoursArePlaceholder: true, budgetedHours: 6 });
  });

  it('an assignment-scan error returns the error, never a confident empty list', async () => {
    makeDb({ job_assignments: [chain({ data: null, error: { message: 'scan died' } })] });
    const got = await listUnscheduledJobs('2026-08-27');
    expect(got.errors.join(' ')).toMatch(/scan died/);
    expect(got.jobs).toEqual([]);
  });
});

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  jobId: 'j1',
  jobNumber: 1001,
  status: 'scheduled',
  budgetedHours: 8,
  hoursArePlaceholder: false,
  crewMemberIds: ['a'],
  ...over,
});

describe('isCalendarDate', () => {
  it('accepts real calendar dates', () => {
    expect(isCalendarDate('2026-08-18')).toBe(true);
    expect(isCalendarDate('2026-02-28')).toBe(true);
  });

  it('rejects malformed or impossible dates', () => {
    for (const v of ['2026-8-18', '18-08-2026', '2026-13-01', '2026-02-30', '', 'today']) {
      expect(isCalendarDate(v)).toBe(false);
    }
  });
});

describe('computeDayCapacity — the derivation the plan insists be stated', () => {
  it('splits a job evenly across the crew assigned to it', () => {
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 12, crewMemberIds: ['a', 'b', 'c'] }),
    ]);
    expect(cap.perCrew).toEqual({ a: 4, b: 4, c: 4 });
    expect(cap.unassignedHours).toBe(0);
  });

  it('adds up across several jobs for the same person', () => {
    const cap = computeDayCapacity('2026-08-18', [
      job({ jobId: 'j1', budgetedHours: 8, crewMemberIds: ['a', 'b'] }),
      job({ jobId: 'j2', budgetedHours: 6, crewMemberIds: ['a'] }),
    ]);
    expect(cap.perCrew.a).toBe(10); // 4 + 6
    expect(cap.perCrew.b).toBe(4);
  });

  it('reports a job with NOBODY assigned as unassigned load, not as zero', () => {
    // A day with 40 unassigned hours is not an empty day, and this is the whole
    // reason unassignedHours is its own number.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 40, crewMemberIds: [] }),
    ]);
    expect(cap.perCrew).toEqual({});
    expect(cap.unassignedHours).toBe(40);
  });

  it('counts jobs with NO estimate rather than treating them as zero hours', () => {
    // A day full of unestimated jobs must not look free.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: null, crewMemberIds: ['a'] }),
      job({ jobId: 'j2', budgetedHours: null, crewMemberIds: [] }),
    ]);
    expect(cap.jobsWithoutEstimate).toBe(2);
    expect(cap.perCrew).toEqual({});
    expect(cap.unassignedHours).toBe(0);
  });

  it('flags when ANY contributing job used placeholder rates', () => {
    // The guardrail reaching its first real consumer: the number is still shown
    // (it is the best planning shape available) but never as a real one.
    const clean = computeDayCapacity('2026-08-18', [job({ hoursArePlaceholder: false })]);
    expect(clean.anyPlaceholderHours).toBe(false);

    const tainted = computeDayCapacity('2026-08-18', [
      job({ hoursArePlaceholder: false }),
      job({ jobId: 'j2', hoursArePlaceholder: true }),
    ]);
    expect(tainted.anyPlaceholderHours).toBe(true);
  });

  it('does not flag placeholder for a job that has no estimate at all', () => {
    // No number means nothing to mistrust; that is jobsWithoutEstimate's job.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: null, hoursArePlaceholder: true }),
    ]);
    expect(cap.anyPlaceholderHours).toBe(false);
    expect(cap.jobsWithoutEstimate).toBe(1);
  });

  it('handles an empty day', () => {
    const cap = computeDayCapacity('2026-08-18', []);
    expect(cap).toEqual({
      date: '2026-08-18',
      perCrew: {},
      unassignedHours: 0,
      jobsWithoutEstimate: 0,
      anyPlaceholderHours: false,
    });
  });

  it('keeps fractional shares rather than rounding a planning figure', () => {
    // Planning stays float on purpose. Payout math lives elsewhere and stays in
    // integer seconds; mixing the two is how an estimate becomes a pay input.
    const cap = computeDayCapacity('2026-08-18', [
      job({ budgetedHours: 10, crewMemberIds: ['a', 'b', 'c'] }),
    ]);
    expect(cap.perCrew.a).toBeCloseTo(3.3333, 3);
  });

  it('the parts account for the whole day of estimated work', () => {
    const jobs = [
      job({ jobId: 'j1', budgetedHours: 12, crewMemberIds: ['a', 'b'] }),
      job({ jobId: 'j2', budgetedHours: 5, crewMemberIds: [] }),
    ];
    const cap = computeDayCapacity('2026-08-18', jobs);
    const assigned = Object.values(cap.perCrew).reduce((s, h) => s + h, 0);
    expect(assigned + cap.unassignedHours).toBe(17);
  });
});
