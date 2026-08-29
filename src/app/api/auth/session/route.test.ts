// Tests for GET /api/auth/session (ledger #347). Must report the REAL session
// state via getOperator() directly — never through the dormancy-aware
// requireOperator() — so it stays truthful even while the gate is deliberately
// off (AUTH_GATE_ENABLED=false). getOperator mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getOperatorMock } = vi.hoisted(() => ({
  getOperatorMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ getOperator: getOperatorMock }));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/session', () => {
  it('reports signedIn: true when getOperator resolves an operator', async () => {
    getOperatorMock.mockResolvedValue({ id: 'u1', email: 'a@x.com', role: 'operator', name: null });
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.signedIn).toBe(true);
  });

  it('reports signedIn: false when there is no session', async () => {
    getOperatorMock.mockResolvedValue(null);
    const res = await GET();
    const json = await res.json();
    expect(json.signedIn).toBe(false);
  });

  // Ops hub workstream A slice 2: the caller's own role rides along so the
  // shared nav can gate the admin-only View-as control without a second
  // request. Role is only ever the caller's own, and only when signed in.
  it("includes the caller's role when signed in", async () => {
    getOperatorMock.mockResolvedValue({ id: 'u1', email: 'a@x.com', role: 'admin', name: null });
    const res = await GET();
    const json = await res.json();
    expect(json).toEqual({ signedIn: true, role: 'admin' });

    getOperatorMock.mockResolvedValue({ id: 'u2', email: 'b@x.com', role: 'operator', name: null });
    const json2 = await (await GET()).json();
    expect(json2).toEqual({ signedIn: true, role: 'operator' });
  });

  it('never includes a role when signed out', async () => {
    getOperatorMock.mockResolvedValue(null);
    const json = await (await GET()).json();
    expect(json).toEqual({ signedIn: false });
  });
});
