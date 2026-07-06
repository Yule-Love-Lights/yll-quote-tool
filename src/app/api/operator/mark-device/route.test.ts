import { describe, it, expect } from 'vitest';
import { POST } from './route';
import { STAFF_DEVICE_COOKIE } from '@/lib/auth/staffDevice';

describe('POST /api/operator/mark-device', () => {
  it('sets the staff-device cookie for a year, httpOnly', async () => {
    const res = await POST();
    const json = await res.json();
    expect(json.ok).toBe(true);

    const cookie = res.cookies.get(STAFF_DEVICE_COOKIE);
    expect(cookie?.value).toBe('1');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    // ~1 year (allow any positive long-lived maxAge).
    expect(cookie?.maxAge).toBeGreaterThan(60 * 60 * 24 * 300);
  });
});
