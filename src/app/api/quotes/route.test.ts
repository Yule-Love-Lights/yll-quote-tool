// Tests for the admin bulk-delete guard on DELETE /api/quotes (audit fix
// g29-route). The full-PII wipe must require BOTH the admin secret AND an
// explicit confirmation header — the secret alone (leaked / forged / CSRF)
// must not be enough to drop the whole table. Supabase + the data layer mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { deleteAllQuotes } = vi.hoisted(() => ({
  deleteAllQuotes: vi.fn(async () => 3),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/quotes', () => ({
  deleteAllQuotes,
  listQuotes: vi.fn(async () => []),
}));

import { DELETE } from './route';

const SECRET = 'test-admin-secret';
const CONFIRM = 'DELETE ALL QUOTES';

function makeReq(headers: Record<string, string>): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_SECRET = SECRET;
});

describe('DELETE /api/quotes — bulk wipe guard', () => {
  it('401s without the admin secret (never touches the data layer)', async () => {
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': CONFIRM }));
    expect(res.status).toBe(401);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('428s when the secret is present but the confirmation header is missing', async () => {
    const res = await DELETE(makeReq({ 'x-admin-secret': SECRET }));
    expect(res.status).toBe(428);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('428s when the confirmation header value is wrong', async () => {
    const res = await DELETE(
      makeReq({ 'x-admin-secret': SECRET, 'x-confirm-delete-all': 'yes' }),
    );
    expect(res.status).toBe(428);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('deletes only with BOTH the secret and the exact confirmation phrase', async () => {
    const res = await DELETE(
      makeReq({ 'x-admin-secret': SECRET, 'x-confirm-delete-all': CONFIRM }),
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.deleted).toBe(3);
    expect(deleteAllQuotes).toHaveBeenCalledOnce();
  });
});
