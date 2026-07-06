import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// getOperator is the session-based signal (inert while auth is dormant); mock it
// as a spy so the unit test controls the session AND can assert the cookie path
// short-circuits before it's consulted.
const { getOperatorMock } = vi.hoisted(() => ({
  getOperatorMock: vi.fn(async () => null as unknown),
}));
vi.mock('./supabaseServer', () => ({ getOperator: getOperatorMock }));

import { isStaffPreview, STAFF_DEVICE_COOKIE } from './staffDevice';

function reqWithCookie(value?: string): NextRequest {
  return {
    cookies: { get: (name: string) => (value != null && name === STAFF_DEVICE_COOKIE ? { value } : undefined) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorMock.mockResolvedValue(null);
});

describe('isStaffPreview', () => {
  it('is true on the staff-device cookie alone — no session needed, getOperator not consulted (the dormant-auth case)', async () => {
    expect(await isStaffPreview(reqWithCookie('1'))).toBe(true);
    expect(getOperatorMock).not.toHaveBeenCalled();
  });

  it('ignores a cookie with the wrong value (falls through to the session check)', async () => {
    expect(await isStaffPreview(reqWithCookie('0'))).toBe(false);
    expect(getOperatorMock).toHaveBeenCalledOnce();
  });

  it('falls back to the operator session when there is no cookie', async () => {
    getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'staff@x.com', role: 'operator', name: 'Sam' });
    expect(await isStaffPreview(reqWithCookie())).toBe(true);
  });

  it('is false for a real customer — no cookie, no session', async () => {
    expect(await isStaffPreview(reqWithCookie())).toBe(false);
  });
});
