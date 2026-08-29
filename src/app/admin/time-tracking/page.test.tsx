// Per-population gate tests for /admin/time-tracking (ops hub workstream A):
// admin renders the page, any other role is redirected server-side. Mirrors
// the fail-closed pattern /admin/fleet/clocks uses (getSessionRole, #1046).
// The admin gate is negative-controlled at write time: removing the redirect
// fails exactly the non-admin test, restored.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { getSessionRoleMock, redirectMock, listTimeExceptionsMock, listActiveCrewMembersMock } =
  vi.hoisted(() => ({
    getSessionRoleMock: vi.fn(),
    redirectMock: vi.fn((path: string) => {
      // Real next/navigation redirect throws; the sentinel keeps that contract
      // so the page body after the gate never runs for a redirected caller.
      throw new Error(`REDIRECT:${path}`);
    }),
    listTimeExceptionsMock: vi.fn(),
    listActiveCrewMembersMock: vi.fn(),
  }));

vi.mock('@/lib/auth/sessionRole', () => ({ getSessionRole: getSessionRoleMock }));
vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  // OperatorShell renders OperatorNav, which calls useRouter.
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/opsTimeExceptions', () => ({
  DEFAULT_STALE_SEGMENT_HOURS: 12,
  listTimeExceptions: listTimeExceptionsMock,
}));
vi.mock('@/lib/crewMembers', () => ({ listActiveCrewMembers: listActiveCrewMembersMock }));

import TimeTrackingPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  listTimeExceptionsMock.mockResolvedValue({ exceptions: [], errors: [] });
  listActiveCrewMembersMock.mockResolvedValue([]);
});

describe('/admin/time-tracking — admin-only gate', () => {
  it('renders the page for an admin', async () => {
    getSessionRoleMock.mockResolvedValue('admin');
    const html = renderToStaticMarkup(await TimeTrackingPage());
    expect(html).toContain('Time tracking');
    expect(html).toContain('Time exceptions');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('redirects a plain operator to the homepage before rendering anything', async () => {
    getSessionRoleMock.mockResolvedValue('operator');
    await expect(TimeTrackingPage()).rejects.toThrow('REDIRECT:/');
    expect(listTimeExceptionsMock).not.toHaveBeenCalled();
  });

  it('redirects when the role is unknown (signed out, unconfigured — fail closed)', async () => {
    getSessionRoleMock.mockResolvedValue(null);
    await expect(TimeTrackingPage()).rejects.toThrow('REDIRECT:/');
  });
});

describe('/admin/time-tracking — content wiring', () => {
  it('feeds the exceptions and active crew names into the section', async () => {
    getSessionRoleMock.mockResolvedValue('admin');
    listTimeExceptionsMock.mockResolvedValue({
      exceptions: [
        {
          type: 'stale_open_segment',
          shiftId: 's1',
          crewMemberId: 'c1',
          rowId: 'seg1',
          openedAt: '2026-08-28T12:00:00.000Z',
          detail: 'Segment open 14h on an open shift.',
        },
      ],
      errors: [],
    });
    listActiveCrewMembersMock.mockResolvedValue([{ id: 'c1', displayName: 'Marco' }]);
    const html = renderToStaticMarkup(await TimeTrackingPage());
    expect(html).toContain('Possible missed tap');
    expect(html).toContain('Marco');
  });
});
