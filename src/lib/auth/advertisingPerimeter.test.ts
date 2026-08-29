// The reachability matrix the audit doc (section 12) says this code base
// never had, for the ADVERTISING namespaces specifically: one route per
// namespace, asserted per population, at the pure operatorGate layer the
// proxy consumes. Kept in its own file so it composes with (rather than
// edits) proxy.test.ts / operatorGate.test.ts, which a concurrent PR owns.

import { describe, expect, it } from 'vitest';

import { isAdvertisingPath, isCrewPath, isPublicPath } from '@/lib/auth/operatorGate';

describe('advertising surface reachability matrix', () => {
  const workerPage = '/advertising';
  const workerApi = '/api/advertising/placements';
  const adminPage = '/admin/advertising';
  const adminApi = '/api/admin/advertising/review';

  it('logged-out: every advertising surface is private (proxy default-denies)', () => {
    expect(isPublicPath(workerPage)).toBe(false);
    expect(isPublicPath(workerApi, 'POST')).toBe(false);
    expect(isPublicPath(adminPage)).toBe(false);
    expect(isPublicPath(adminApi, 'POST')).toBe(false);
  });

  it('advertising session: confined TO the worker surface — admin review is OUTSIDE it', () => {
    // The proxy 403s an advertising session on any non-advertising path, so
    // membership here IS reachability for that population.
    expect(isAdvertisingPath(workerPage)).toBe(true);
    expect(isAdvertisingPath(workerApi)).toBe(true);
    expect(isAdvertisingPath('/api/advertising/earnings')).toBe(true);
    expect(isAdvertisingPath('/api/advertising/placements/x/resubmit')).toBe(true);
    // The admin door is deliberately under /api/admin/advertising, NOT
    // /api/advertising/admin: the prefix match below would have let an
    // advertising session through the perimeter to the review routes.
    expect(isAdvertisingPath(adminPage)).toBe(false);
    expect(isAdvertisingPath(adminApi)).toBe(false);
    // And nothing about the operator surface is theirs.
    expect(isAdvertisingPath('/')).toBe(false);
    expect(isAdvertisingPath('/customers')).toBe(false);
    expect(isAdvertisingPath('/api/dashboard/activity')).toBe(false);
  });

  it('crew markers never overlap the advertising surface', () => {
    expect(isCrewPath(workerPage)).toBe(false);
    expect(isCrewPath(workerApi)).toBe(false);
  });

  it('operator/admin sessions pass the perimeter here, so the ROUTE layer is the gate — pinned by the route tests', () => {
    // The proxy admits any authenticated non-crew, non-advertising session to
    // these paths; getAdvertisingCaller then 403s them (worker routes), and
    // requireAdmin gates the admin routes. This test documents the division
    // of labor; the 403s themselves are asserted in each route's own test.
    expect(isPublicPath(workerApi, 'POST')).toBe(false); // not public ≠ operator-usable
  });
});
