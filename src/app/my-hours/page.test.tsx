// Per-population gate tests for /my-hours — the staff self-view (time-tracking
// plan phase 4).
//
// The thing under test is not "does it render": it is WHOSE rows it renders
// and what it refuses. Three properties, each with its own block below:
//
//   1. the crew id comes from the SESSION and there is no way to ask for
//      another one — a query string naming someone else changes nothing;
//   2. every refusal reason gets its own named state, and an unlinked login
//      never falls through to an empty table that reads as "you worked no
//      hours";
//   3. the admin controls are ABSENT from the markup, not hidden, and no pay
//      figure is read at all.
//
// The identity gate is negative-controlled at write time: feeding the query
// string's id to loadPersonTime instead of the session's fails the second
// test alone, restored.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { getOfficeClockCallerMock, loadPersonTimeMock, redirectMock } = vi.hoisted(() => ({
  getOfficeClockCallerMock: vi.fn(),
  loadPersonTimeMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    // Real next/navigation redirect throws; the sentinel keeps that contract
    // so the page body after the gate never runs for a redirected caller.
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('@/lib/auth/officeClock', () => ({ getOfficeClockCaller: getOfficeClockCallerMock }));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  // OperatorShell renders OperatorNav, which calls useRouter.
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/personHours', async () => {
  const actual = await vi.importActual<typeof import('@/lib/personHours')>('@/lib/personHours');
  return { ...actual, loadPersonTime: loadPersonTimeMock };
});

import MyHoursPage from './page';

const ME = { crewMemberId: 'crew-me', authUserId: 'auth-me', displayName: 'Khaye' };

function personTime(overrides: Record<string, unknown> = {}) {
  return {
    person: { id: 'crew-me', displayName: 'Khaye', active: true, isOffice: true, baseRateCents: 0 },
    range: '30',
    days: [],
    totalSeconds: 0,
    shiftCount: 0,
    openShift: null,
    autoClosed: { count: 0, seconds: 0 },
    audit: [],
    auditPartial: false,
    settlementsReadable: false,
    asOf: '2026-09-03T12:00:00.000Z',
    errors: [],
    ...overrides,
  };
}

const A_SHIFT = {
  id: 'shift-1',
  clockInAt: '2026-09-01T13:00:00.000Z',
  clockOutAt: '2026-09-01T21:00:00.000Z',
  paidSeconds: 8 * 3600,
  breakSeconds: 0,
  source: 'office',
  closeSource: 'office',
  manualBy: null,
  removable: true,
  settlementId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  getOfficeClockCallerMock.mockResolvedValue({ ok: true, caller: ME });
  loadPersonTimeMock.mockResolvedValue(personTime());
});

describe('/my-hours — whose hours', () => {
  it('reads the hours of the SESSION caller', async () => {
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('My hours');
    expect(html).toContain('Khaye');
    expect(loadPersonTimeMock).toHaveBeenCalledWith('crew-me', '30');
  });

  it('ignores an id in the query string — there is no way to ask for anyone else', async () => {
    await MyHoursPage({
      searchParams: Promise.resolve({ crewMemberId: 'crew-someone-else', id: 'crew-someone-else' }),
    });
    expect(loadPersonTimeMock).toHaveBeenCalledTimes(1);
    expect(loadPersonTimeMock.mock.calls[0][0]).toBe('crew-me');
  });

  it('honours a valid range and falls back to 30 days on a junk one', async () => {
    await MyHoursPage({ searchParams: Promise.resolve({ range: '7' }) });
    expect(loadPersonTimeMock.mock.calls[0][1]).toBe('7');
    loadPersonTimeMock.mockClear();
    await MyHoursPage({ searchParams: Promise.resolve({ range: 'everything' }) });
    expect(loadPersonTimeMock.mock.calls[0][1]).toBe('30');
  });
});

describe('/my-hours — it fails closed with a named state', () => {
  it('sends a signed-out caller away before reading anything', async () => {
    getOfficeClockCallerMock.mockResolvedValue({ ok: false, reason: 'unauthenticated' });
    await expect(MyHoursPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT:/');
    expect(loadPersonTimeMock).not.toHaveBeenCalled();
  });

  it('tells an unlinked login it is unlinked, rather than showing it no hours', async () => {
    getOfficeClockCallerMock.mockResolvedValue({ ok: false, reason: 'unlinked' });
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('not linked to your staff record');
    // The dangerous near-miss: an empty hours table under this login would
    // read as "you worked nothing", which is a different and false claim.
    expect(html).not.toContain('No shifts in this range');
    expect(loadPersonTimeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['is_crew', 'Crew clock in and out through Telegram'],
    ['is_advertising', 'Advertising logins do not clock in'],
    ['inactive', 'has been deactivated'],
    ['unconfigured', 'could not be reached'],
  ])('names the %s refusal in its own words', async (reason, phrase) => {
    getOfficeClockCallerMock.mockResolvedValue({ ok: false, reason });
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain(phrase);
    expect(loadPersonTimeMock).not.toHaveBeenCalled();
  });

  it('says the record could not be read when the person comes back null', async () => {
    loadPersonTimeMock.mockResolvedValue(personTime({ person: null, errors: ['shifts: boom'] }));
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('could not be read');
    expect(html).toContain('shifts: boom');
  });
});

describe('/my-hours — no controls and no money', () => {
  it('renders a real shift with none of the admin controls in the markup', async () => {
    loadPersonTimeMock.mockResolvedValue(
      personTime({
        days: [{ day: '2026-09-01', paidSeconds: 8 * 3600, shifts: [A_SHIFT] }],
        totalSeconds: 8 * 3600,
        shiftCount: 1,
      }),
    );
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    // The shift itself IS shown.
    expect(html).toContain('8h 00m');
    // ABSENT, not hidden: no edit form, no remove button, no pay panel, and
    // no dollar sign anywhere on the page.
    // Matched against the real control markup: the admin button is labelled
    // "Edit", so an assertion against "Edit times" would have passed whether
    // or not the button was there.
    expect(html).not.toContain('>Edit</button>');
    expect(html).not.toContain('>Remove</button>');
    // Hours only: the page reads the settlement STATE but never an amount,
    // so no currency may appear anywhere on it.
    expect(html).not.toContain('$');
    // And it says where a wrong time actually gets fixed, so a screen with no
    // controls does not just read as broken.
    expect(html).toContain('Ask the office to correct it');
  });

  it('tells the person when the midnight sweep closed a shift for them', async () => {
    loadPersonTimeMock.mockResolvedValue(
      personTime({
        days: [
          {
            day: '2026-09-01',
            paidSeconds: 14 * 3600,
            shifts: [{ ...A_SHIFT, closeSource: 'system', paidSeconds: 14 * 3600 }],
          },
        ],
        totalSeconds: 14 * 3600,
        shiftCount: 1,
        autoClosed: { count: 1, seconds: 14 * 3600 },
      }),
    );
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('tell the office what time you really stopped');
    // The row's own badge is in the same voice.
    expect(html).toContain('tell the office what time you stopped');
    // The admin page's wording, which is about a third person, must not reach
    // the page the person themselves reads.
    expect(html).not.toContain('ask them what time they stopped');
  });

  it('stops the SUMMARY nagging once every swept shift has been corrected', async () => {
    // The row badge and the summary line say the same thing in two places, so
    // fixing one and not the other leaves the page contradicting itself: a
    // corrected shift reading "since corrected" under a banner still telling
    // the person to report it. The probe that caught this gap: forcing the
    // call to action back on failed NOTHING until this test existed.
    loadPersonTimeMock.mockResolvedValue(
      personTime({
        days: [
          {
            day: '2026-09-01',
            paidSeconds: 8 * 3600,
            shifts: [{ ...A_SHIFT, closeSource: 'system', manualBy: 'Naldo (naldo@x.com)' }],
          },
        ],
        totalSeconds: 8 * 3600,
        shiftCount: 1,
        autoClosed: { count: 1, seconds: 8 * 3600 },
      }),
    );
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));

    // The FACT stays — those hours were entered, not clocked.
    expect(html).toContain('closed by the midnight sweep');
    // The instruction goes.
    expect(html).not.toContain('tell the office what time you really stopped');
  });
});

describe('/my-hours — what has been paid for', () => {
  const paid = { ...A_SHIFT, id: 'shift-paid', settlementId: 'settlement-1' };
  const unpaid = { ...A_SHIFT, id: 'shift-unpaid', paidSeconds: 5 * 3600 };

  function withBoth(over: Record<string, unknown> = {}) {
    return personTime({
      settlementsReadable: true,
      days: [{ day: '2026-09-01', paidSeconds: 13 * 3600, shifts: [paid, unpaid] }],
      totalSeconds: 13 * 3600,
      shiftCount: 2,
      ...over,
    });
  }

  it('splits the hours into paid and not yet paid, in HOURS and never a figure', async () => {
    loadPersonTimeMock.mockResolvedValue(withBoth());
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('5h 00m');
    expect(html).toContain('not paid yet');
    expect(html).toContain('8h 00m');
    expect(html).toContain('already paid');
    expect(html).toContain('Paid');
    // The whole point of the constraint: overtime has no agreed formula, so
    // an amount here would be a number nobody has agreed is owed.
    expect(html).not.toContain('$');
  });

  it('says NOTHING about payment when the settlement read failed', async () => {
    loadPersonTimeMock.mockResolvedValue(
      withBoth({ settlementsReadable: false, errors: ['settlements: boom'] }),
    );
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));

    // The dangerous fallback: treating an unreadable answer as "unpaid" tells
    // someone they are owed for hours they have already been paid for.
    expect(html).not.toContain('not paid yet');
    expect(html).not.toContain('already paid');
    expect(html).not.toContain('>Paid<');
    expect(html).toContain('could not be read just now');
  });

  it('counts a shift still running in neither total', async () => {
    const open = { ...A_SHIFT, id: 'shift-open', clockOutAt: null, paidSeconds: 2 * 3600 };
    loadPersonTimeMock.mockResolvedValue(
      withBoth({
        days: [{ day: '2026-09-01', paidSeconds: 15 * 3600, shifts: [paid, unpaid, open] }],
        openShift: { clockInAt: '2026-09-01T13:00:00.000Z', source: 'office' },
      }),
    );
    const html = renderToStaticMarkup(await MyHoursPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('counted in neither');
    // 5h unpaid, not 7h: the open shift is not waiting to be paid, it is
    // still being worked.
    expect(html).toContain('5h 00m');
  });
});
