// My Day read (row 466, the Telegram door). Always scoped to the crew member
// holding the session cookie: there is no way to read another crew member's day
// here, and no money field exists on the surface at all.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cookieGet, resolveCrewCaller, getMyDay } = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  resolveCrewCaller: vi.fn(),
  getMyDay: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/auth/crewSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/crewSession')>();
  return { ...actual, resolveCrewCaller };
});
vi.mock('@/lib/crew/myDay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/crew/myDay')>();
  return { ...actual, getMyDay };
});

import { GET } from './route';

const MEMBER = { id: 'crew-1', displayName: 'Field Crew One' };

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue({ value: 'cookie-value' });
  resolveCrewCaller.mockResolvedValue({ ok: true, member: MEMBER });
  getMyDay.mockResolvedValue([
    { assignmentId: 'a-1', jobId: 'job-1', jobNumber: 1046, status: 'scheduled', address: '123 Birch Hill Rd' },
  ]);
});

describe('GET /api/crew/today', () => {
  it('returns the session crew member their own day', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.crewMember).toEqual(MEMBER);
    expect(body.items).toHaveLength(1);
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('asks for the day of the SESSION crew member, never an id from the request', async () => {
    await GET();
    expect(getMyDay).toHaveBeenCalledWith('crew-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('401s with no session cookie at all', async () => {
    cookieGet.mockReturnValue(undefined);
    resolveCrewCaller.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMyDay).not.toHaveBeenCalled();
  });

  it.each([
    ['inactive', 403],
    ['unlinked', 403],
    ['no_crew_row', 403],
  ])('refuses a %s crew session with %i and reads nothing', async (reason, status) => {
    resolveCrewCaller.mockResolvedValue({ ok: false, reason });
    const res = await GET();
    expect(res.status).toBe(status);
    expect(getMyDay).not.toHaveBeenCalled();
  });

  it('never returns a money field', async () => {
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toMatch(/cents|rate|pay|wage/i);
  });
});
