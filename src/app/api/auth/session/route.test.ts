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
});
