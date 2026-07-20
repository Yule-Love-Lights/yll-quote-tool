// Tests for POST /api/leads/partial (partial / abandoned-form lead capture).
// Covers: the no-usable-contact skip, honeypot, a fresh insert (sync_status
// 'partial', consent false), the captureId update path (+ fall-through to insert
// when the id doesn't match a partial row), the insert rate limit, the GHL
// no-drip sync being best-effort (never surfaces), and CORS. Supabase + the
// partial GHL sync are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const sync = vi.hoisted(() => ({
  syncPartialLeadToGhl: vi.fn(async () => ({ status: 'synced', ghlContactId: 'contact-1' })),
  isHighLevelConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/leads/partialLead', () => ({ syncPartialLeadToGhl: sync.syncPartialLeadToGhl }));
vi.mock('@/lib/integrations/highlevel', () => ({ isHighLevelConfigured: sync.isHighLevelConfigured }));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST, OPTIONS } from './route';

// Fake Supabase. Query shapes the route makes:
//   update: .update(row).eq().eq().select('id').maybeSingle()  → { data: updateData|null, error }
//   count:  .select('id',{count,head}).eq().eq().gte()          → { count, error }  (via then)
//   insert: .insert(row).select('id').single()                 → { data:{id}, error }
//   write-back: .update({...}).eq('id', rowId)                 → { error } (via then)
function makeSb(
  opts: {
    updateData?: { id: string } | null;
    updateError?: { message: string } | null;
    insertData?: { id: string };
    insertError?: { message: string } | null;
    count?: number;
    countError?: { message: string } | null;
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  // Every filter applied, as [column, value] pairs. Recorded (not discarded)
  // because the update path's `sync_status='partial'` filter is a SECURITY
  // control — it is what stops a leaked captureId mutating a real synced lead —
  // and a mock that swallows its arguments asserts nothing about it.
  const filters: Array<[string, unknown]> = [];
  let mode: 'insert' | 'update' | 'count' | null = null;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: (_cols: string, selOpts?: { count?: string; head?: boolean }) => {
      if (selOpts?.head) mode = 'count';
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      inserted.push(payload);
      return builder;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      updated.push(payload);
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return builder;
    },
    in: (col: string, vals: unknown) => {
      filters.push([col, vals]);
      return builder;
    },
    gte: () => builder,
    single: async () => ({ data: opts.insertData ?? { id: 'partial-new' }, error: opts.insertError ?? null }),
    maybeSingle: async () => ({ data: opts.updateData ?? null, error: opts.updateError ?? null }),
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'count') resolve({ data: null, count: opts.count ?? 0, error: opts.countError ?? null });
      else resolve({ data: null, error: null }); // plain write-back update
      mode = null;
    },
  });
  return { client: builder, inserted, updated, filters };
}

function makeReq(
  body: unknown,
  opts: { origin?: string | null; ip?: string | null } = {},
): NextRequest {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    text: async () => text,
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === 'origin') return opts.origin ?? null;
        if (n === 'x-forwarded-for') return opts.ip ?? '203.0.113.9';
        return null;
      },
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  sync.syncPartialLeadToGhl.mockResolvedValue({ status: 'synced', ghlContactId: 'contact-1' });
  sync.isHighLevelConfigured.mockReturnValue(true);
});

describe('POST /api/leads/partial', () => {
  it('skips (200, no save, no GHL) when there is no usable contact handle', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    const res = await POST(makeReq({ name: 'Jane Only' }));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe('no-contact');
    expect(inserted).toHaveLength(0);
    expect(sync.syncPartialLeadToGhl).not.toHaveBeenCalled();
  });

  it('honeypot (with a real contact handle): saves a spam row for recovery, never GHL', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    const res = await POST(makeReq({ email: 'maybe-real@example.com', phone: '5551234567', company: 'Acme' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // saved (not silently dropped) so a password-manager false positive is recoverable
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.sync_status).toBe('spam');
    expect(inserted[0]!.sync_error).toBe('honeypot');
    expect(inserted[0]!.email).toBe('maybe-real@example.com');
    expect(sync.syncPartialLeadToGhl).not.toHaveBeenCalled();
  });

  it('honeypot with no usable contact: 200, nothing saved (pure bot junk)', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    const res = await POST(makeReq({ name: 'x', company: 'Acme' }));
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
    expect(sync.syncPartialLeadToGhl).not.toHaveBeenCalled();
  });

  it('inserts a partial row (sync_status partial, consent false) and syncs no-drip', async () => {
    const { client, inserted } = makeSb({ insertData: { id: 'row-9' } });
    sbRef.current = client;
    const res = await POST(
      makeReq({ name: 'Jane Smith', email: 'jane@example.com', phone: '+16315550100', service: 'permanent' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.id).toBe('row-9');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.sync_status).toBe('partial');
    expect(inserted[0]!.consent).toBe(false);
    expect(inserted[0]!.email).toBe('jane@example.com');
    expect(sync.syncPartialLeadToGhl).toHaveBeenCalledTimes(1);
  });

  it('stores email as empty string for a phone-only partial (NOT NULL columns)', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    await POST(makeReq({ phone: '631-555-0100' }));
    expect(inserted[0]!.email).toBe('');
    expect(inserted[0]!.phone).toBe('631-555-0100');
  });

  it('updates the existing row when captureId matches a partial row (no insert)', async () => {
    const { client, inserted, updated, filters } = makeSb({ updateData: { id: 'cap-1' } });
    sbRef.current = client;
    const res = await POST(
      makeReq({ captureId: 'cap-1', name: 'Jane', email: 'jane@example.com', phone: '5551234567' }),
    );
    const json = await res.json();
    expect(json.id).toBe('cap-1');
    expect(inserted).toHaveLength(0);
    // first update = the row upsert; a later update = the GHL write-back
    expect(updated[0]!.sync_status).toBe('partial');
    // Both filters must be applied. The sync_status one is the security control:
    // without it a leaked/guessed captureId could mutate a real synced lead.
    // Asserted explicitly because deleting it would otherwise pass every test.
    expect(filters).toContainEqual(['id', 'cap-1']);
    expect(filters).toContainEqual(['sync_status', 'partial']);
  });

  it('caps CALLS per IP, so the captureId update path cannot bypass the limit', async () => {
    // The insert cap counts ROWS and an UPDATE creates none, so it can never see
    // this path. Left uncapped, the id handed back in the response was a
    // permanent ticket: re-post it as captureId forever, and every call drove a
    // fresh GHL contact upsert against a shared per-location quota.
    const ip = '198.51.100.77';
    const skipped: Array<string | undefined> = [];
    for (let i = 0; i < 125; i++) {
      const { client } = makeSb({ updateData: { id: 'cap-1' } });
      sbRef.current = client;
      const res = await POST(
        makeReq({ captureId: 'cap-1', email: `a${i}@example.com`, phone: '5551234567' }, { ip }),
      );
      skipped.push((await res.json()).skipped);
    }
    expect(skipped[0]).toBeUndefined(); // a real fill still goes through
    expect(skipped[124]).toBe('rate-limited'); // the loop does not
  });

  it('counts spam rows toward the insert cap (the honeypot is not a cheaper way in)', async () => {
    const { client, filters } = makeSb({ count: 0 });
    sbRef.current = client;
    await POST(makeReq({ email: 'jane@example.com', phone: '5551234567' }, { ip: '198.51.100.78' }));
    expect(filters).toContainEqual(['sync_status', ['partial', 'spam']]);
  });

  it('falls through to insert when captureId does not match a partial row', async () => {
    const { client, inserted } = makeSb({ updateData: null, insertData: { id: 'row-new' } });
    sbRef.current = client;
    const res = await POST(
      makeReq({ captureId: 'stale-id', email: 'jane@example.com', phone: '5551234567' }),
    );
    expect((await res.json()).id).toBe('row-new');
    expect(inserted).toHaveLength(1);
  });

  it('rate-limits the insert path (200 skipped, no insert, no GHL)', async () => {
    const { client, inserted } = makeSb({ count: 40 });
    sbRef.current = client;
    const res = await POST(makeReq({ email: 'jane@example.com', phone: '5551234567' }));
    expect((await res.json()).skipped).toBe('rate-limited');
    expect(inserted).toHaveLength(0);
    expect(sync.syncPartialLeadToGhl).not.toHaveBeenCalled();
  });

  it('does not call GHL when HighLevel is not configured, but records why on the row', async () => {
    sync.isHighLevelConfigured.mockReturnValue(false);
    const { client, updated } = makeSb({ insertData: { id: 'row-2' } });
    sbRef.current = client;
    const res = await POST(makeReq({ email: 'jane@example.com', phone: '5551234567' }));
    expect((await res.json()).id).toBe('row-2');
    expect(sync.syncPartialLeadToGhl).not.toHaveBeenCalled();
    // the row isn't left silently untagged with no explanation
    expect(updated.some((u) => u.sync_error === 'HighLevel not configured')).toBe(true);
  });

  it('never surfaces a GHL failure — the row is saved and it still answers 200', async () => {
    sync.syncPartialLeadToGhl.mockRejectedValue(new Error('ghl down'));
    const { client } = makeSb({ insertData: { id: 'row-3' } });
    sbRef.current = client;
    const res = await POST(makeReq({ email: 'jane@example.com', phone: '5551234567' }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('returns CORS headers for an allowed origin', async () => {
    const { client } = makeSb({ insertData: { id: 'row-4' } });
    sbRef.current = client;
    const res = await POST(
      makeReq({ email: 'jane@example.com', phone: '5551234567' }, { origin: 'https://yulelovelights.com' }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://yulelovelights.com');
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await OPTIONS(makeReq({}, { origin: 'https://www.yulelovelights.com' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.yulelovelights.com');
  });
});
