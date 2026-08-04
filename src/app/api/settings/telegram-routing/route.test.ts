// Settings → Telegram routing API — the operator gate and the GET/PUT shapes.
// requireOperator is mocked with a flippable spy (the real one is a no-op
// unless AUTH_GATE_ENABLED='true'): these routes read/write a BUSINESS-WIDE
// notification-routing setting, so the denied path must short-circuit before
// any Telegram or Supabase work. Telegram + routing IO seams are mocked; the
// route's own body validation runs for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperator, allowedChats, getChatTitle, getTelegramRouting, putTelegramRouting } =
  vi.hoisted(() => ({
    requireOperator: vi.fn<() => Promise<NextResponse | null>>(async () => null),
    allowedChats: vi.fn(() => ['-100', '200']),
    getChatTitle: vi.fn(async (id: string) => (id === '-100' ? 'Jobs Crew' : null)),
    getTelegramRouting: vi.fn(async () => null),
    putTelegramRouting: vi.fn(async (v: unknown) => v),
  }));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator }));
vi.mock('@/lib/integrations/telegram', () => ({ allowedChats, getChatTitle }));
vi.mock('@/lib/integrations/telegramRouting', () => ({ getTelegramRouting, putTelegramRouting }));

import { GET, PUT } from './route';

function makeReq(rawBody: string): NextRequest {
  return { json: async () => JSON.parse(rawBody) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue(null);
  allowedChats.mockReturnValue(['-100', '200']);
  getChatTitle.mockImplementation(async (id: string) => (id === '-100' ? 'Jobs Crew' : null));
  getTelegramRouting.mockResolvedValue(null);
  putTelegramRouting.mockImplementation(async (v: unknown) => v);
});

describe('GET /api/settings/telegram-routing', () => {
  it('returns the denied response and does NO work when the operator gate rejects', async () => {
    requireOperator.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(allowedChats).not.toHaveBeenCalled();
    expect(getTelegramRouting).not.toHaveBeenCalled();
  });

  it('returns each allowlisted chat with its best-effort title plus the stored routing', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chats: [
        { id: '-100', title: 'Jobs Crew' },
        { id: '200', title: null },
      ],
      routing: null,
    });
  });
});

describe('PUT /api/settings/telegram-routing', () => {
  it('returns the denied response and never saves when the operator gate rejects', async () => {
    requireOperator.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await PUT(makeReq('{"leads":["-100"]}'));
    expect(res.status).toBe(401);
    expect(putTelegramRouting).not.toHaveBeenCalled();
  });

  it('400s on a non-object body without saving', async () => {
    const res = await PUT(makeReq('[1,2,3]'));
    expect(res.status).toBe(400);
    expect(putTelegramRouting).not.toHaveBeenCalled();
  });

  it('400s on malformed JSON without saving', async () => {
    const res = await PUT({ json: async () => JSON.parse('{nope') } as unknown as NextRequest);
    expect(res.status).toBe(400);
    expect(putTelegramRouting).not.toHaveBeenCalled();
  });

  it('saves a routing object and echoes the sanitized result', async () => {
    putTelegramRouting.mockResolvedValue({ leads: ['-100'], jobs: [], inventory: [], ops: [] });
    const res = await PUT(makeReq('{"leads":["-100"]}'));
    expect(res.status).toBe(200);
    expect(putTelegramRouting).toHaveBeenCalledWith({ leads: ['-100'] });
    expect(await res.json()).toEqual({ leads: ['-100'], jobs: [], inventory: [], ops: [] });
  });

  it('500s with the error message when the save throws', async () => {
    putTelegramRouting.mockRejectedValue(new Error('invalid telegram routing'));
    const res = await PUT(makeReq('{"leads":["-100"]}'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('invalid telegram routing');
  });
});
