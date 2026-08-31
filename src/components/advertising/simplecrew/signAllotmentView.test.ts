// Pins the parser against what the ADMIN ISSUANCES ROUTE actually returns.
// The route is driven here with mocked data-layer deps so the payload is the
// real one, not a hand-copied guess: if either side renames the key, this
// test fails instead of the screen silently rendering nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireAdmin, listAdvertisingWorkers, getWorkerSignBalance, issueSigns, listIssuances } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listAdvertisingWorkers: vi.fn(),
  getWorkerSignBalance: vi.fn(),
  issueSigns: vi.fn(),
  listIssuances: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/supabaseServer')>();
  return { ...actual, requireAdmin };
});
vi.mock('@/lib/advertising/workers', () => ({ listAdvertisingWorkers }));
vi.mock('@/lib/advertising/signIssuances', () => ({ getWorkerSignBalance, issueSigns, listIssuances }));

import { GET } from '@/app/api/admin/advertising/issuances/route';
import { parseAllotments } from './signAllotmentView';

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-1', email: null, role: 'admin', name: null } });
  listAdvertisingWorkers.mockResolvedValue([
    { id: 'w1', displayName: 'Joe Signs', active: true, isTest: false },
    { id: 'w2', displayName: 'Test Rig', active: true, isTest: true },
  ]);
  getWorkerSignBalance.mockImplementation(async (id: string) => ({
    workerId: id,
    issuedTotal: id === 'w1' ? 50 : 5,
    signsUsed: id === 'w1' ? 38 : 1,
    remaining: id === 'w1' ? 12 : 4,
  }));
});

describe('parseAllotments against the real route payload', () => {
  it('reads the rows the route actually emits, and drops test workers', async () => {
    const res = await GET({ nextUrl: { searchParams: new URLSearchParams() } } as never);
    expect(res.status).toBe(200);
    const rows = parseAllotments(await res.json());
    expect(rows).toEqual([
      { workerId: 'w1', displayName: 'Joe Signs', active: true, issuedTotal: 50, signsUsed: 38, remaining: 12 },
    ]);
  });
});

describe('parseAllotments failure handling', () => {
  it('an unusable body is null, never an empty list: no crew and a broken read are different facts', () => {
    expect(parseAllotments(null)).toBeNull();
    expect(parseAllotments({})).toBeNull();
    expect(parseAllotments({ workers: [] })).toBeNull();
    expect(parseAllotments({ balances: [{ displayName: 'no id' }] })).toBeNull();
  });

  it('a genuinely empty roster is an empty list, not a failure', () => {
    expect(parseAllotments({ balances: [] })).toEqual([]);
  });
});
