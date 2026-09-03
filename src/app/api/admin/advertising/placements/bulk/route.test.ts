// The bulk route is a thin admin gate over handleBulkAcceptedSubmit (which
// carries its own suite in bulkSubmit.test.ts); these tests pin the gate:
// no admin, no upload; no worker, no upload; the resolved worker and the
// ADMIN'S id (never anything from the body) reach the handler.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdmin, getAdvertisingWorker, handleBulkAcceptedSubmit } = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getAdvertisingWorker: vi.fn(),
  handleBulkAcceptedSubmit: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin }));
vi.mock('@/lib/advertising/workers', () => ({ getAdvertisingWorker }));
vi.mock('@/lib/advertising/captureSubmit', () => ({ handleBulkAcceptedSubmit }));

import { POST } from './route';

const WORKER = { id: 'worker-1', displayName: 'Joe', authUserId: null, active: false, isTest: false, createdAt: 'x', updatedAt: 'x' };

function makeReq(fields: Record<string, string>): NextRequest {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { formData: async () => fd } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdmin.mockResolvedValue({ operator: { id: 'admin-9', email: null, role: 'admin', name: null } });
  getAdvertisingWorker.mockResolvedValue(WORKER);
  handleBulkAcceptedSubmit.mockResolvedValue(NextResponse.json({ placement: { id: 'p1' } }, { status: 201 }));
});

describe('POST /api/admin/advertising/placements/bulk', () => {
  it('refuses without an admin session', async () => {
    requireAdmin.mockResolvedValue({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const res = await POST(makeReq({ workerId: 'worker-1' }));
    expect(res.status).toBe(401);
    expect(handleBulkAcceptedSubmit).not.toHaveBeenCalled();
  });

  it('404s an unknown worker before anything uploads', async () => {
    getAdvertisingWorker.mockResolvedValue(null);
    const res = await POST(makeReq({ workerId: 'ghost' }));
    expect(res.status).toBe(404);
    expect(handleBulkAcceptedSubmit).not.toHaveBeenCalled();
  });

  it('400s a missing workerId', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it('delegates with the RESOLVED worker (inactive allowed: backfill predates the tool) and the admin session id', async () => {
    const res = await POST(makeReq({ workerId: 'worker-1' }));
    expect(res.status).toBe(201);
    expect(handleBulkAcceptedSubmit).toHaveBeenCalledTimes(1);
    const [, worker, adminId] = handleBulkAcceptedSubmit.mock.calls[0];
    expect(worker).toBe(WORKER);
    expect(adminId).toBe('admin-9');
  });
});
