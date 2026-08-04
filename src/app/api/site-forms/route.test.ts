// Tests for POST /api/site-forms (#195), the non-lead website submissions.
//
// The load-bearing assertions are the SEPARATION ones: no opportunity is ever
// created and no sales tag is ever applied, whatever the form. Everything else
// (validation, honeypot, rate limit, resume rules, fail-open alerts) mirrors
// the conventions already proven on /api/leads.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const hl = vi.hoisted(() => ({
  upsertContact: vi.fn(async (_input: unknown) => ({ contact: { id: 'contact-1' }, new: true })),
  addContactTags: vi.fn(async (_id: string, _tags: string[]) => ({})),
  createOpportunity: vi.fn(async () => ({ id: 'opp-should-not-exist' })),
  findOrCreateOpportunityForContact: vi.fn(async () => ({
    opportunity: { id: 'opp-should-not-exist' },
    created: true,
  })),
  sendEmail: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  upsertContact: hl.upsertContact,
  addContactTags: hl.addContactTags,
  createOpportunity: hl.createOpportunity,
  findOrCreateOpportunityForContact: hl.findOrCreateOpportunityForContact,
  sendEmail: hl.sendEmail,
}));

const tg = vi.hoisted(() => ({ notifyTelegramAudience: vi.fn(async () => {}) }));
vi.mock('@/lib/integrations/telegramRouting', () => ({
  notifyTelegramAudience: tg.notifyTelegramAudience,
}));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST, OPTIONS } from './route';

function makeSb(
  opts: { count?: number; insertError?: { message: string } | null; uploadError?: { message: string } | null } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const uploads: Array<{ bucket: string; path: string }> = [];
  let mode: 'count' | 'insert' | 'update' | null = null;

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
    eq: () => builder,
    gte: () => builder,
    single: async () => ({
      data: opts.insertError ? null : { id: 'sub-1' },
      error: opts.insertError ?? null,
    }),
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'count') return resolve({ data: null, count: opts.count ?? 0, error: null });
      return resolve({ data: null, error: null });
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          uploads.push({ bucket, path });
          return { error: opts.uploadError ?? null };
        },
      }),
    },
  });
  return { client: builder, inserted, updated, uploads };
}

function req(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return {
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => body,
    formData: async () => {
      throw new Error('not multipart');
    },
  } as unknown as NextRequest;
}

const NEWSLETTER = { formType: 'newsletter', formVariant: 'footer', email: 'a@b.com' };
const APPLICATION = {
  formType: 'careers',
  formVariant: 'careers-page',
  email: 'a@b.com',
  name: 'Pat Smith',
  phone: '5551110000',
  consent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  hl.upsertContact.mockResolvedValue({ contact: { id: 'contact-1' }, new: true });
  const sb = makeSb();
  sbRef.current = sb.client;
});

describe('separation from the sales pipeline', () => {
  it('creates a tagged contact and never an opportunity', async () => {
    const res = await POST(req(NEWSLETTER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(hl.upsertContact).toHaveBeenCalledTimes(1);
    expect(hl.addContactTags).toHaveBeenCalledWith('contact-1', ['newsletter-signup']);
    expect(hl.createOpportunity).not.toHaveBeenCalled();
    expect(hl.findOrCreateOpportunityForContact).not.toHaveBeenCalled();
  });

  it('never applies the sales lead tag for any form type', async () => {
    for (const formType of ['newsletter', 'careers', 'intern', 'nomination'] as const) {
      vi.clearAllMocks();
      hl.upsertContact.mockResolvedValue({ contact: { id: 'c' }, new: true });
      sbRef.current = makeSb().client;
      const body =
        formType === 'newsletter'
          ? NEWSLETTER
          : { ...APPLICATION, formType, formVariant: `${formType}-page` };
      await POST(req(body));
      const appliedTags = hl.addContactTags.mock.calls.flatMap((c) => c[1] as string[]);
      expect(appliedTags.map((t) => t.toLowerCase())).not.toContain('new lead');
      expect(hl.createOpportunity).not.toHaveBeenCalled();
    }
  });

  it('stores a nomination without ever contacting the nominee', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    await POST(
      req({
        formType: 'nomination',
        formVariant: 'hope-page',
        email: 'nominator@example.com',
        name: 'Nora Nominator',
        phone: '5551110000',
        consent: true,
        payload: {
          nomineeName: 'Ruth Neighbour',
          relationship: 'Neighbour',
          nomineeAddress: '12 Elm Street',
          nomineeEmail: 'ruth@example.com',
          nomineePhone: '5552220000',
          story: 'She does a lot for the block.',
        },
      }),
    );

    // Only the nominator is upserted.
    const contactArg = hl.upsertContact.mock.calls[0]![0] as Record<string, unknown>;
    expect(contactArg.email).toBe('nominator@example.com');
    expect(hl.upsertContact).toHaveBeenCalledTimes(1);

    // The nominee's details are stored on the row for staff, not sent to GHL.
    const row = sb.inserted[0]!;
    expect((row.payload as Record<string, string>).nomineeName).toBe('Ruth Neighbour');
  });
});

describe('validation', () => {
  it('rejects an unknown form type', async () => {
    const res = await POST(req({ formType: 'christmas', email: 'a@b.com' }));
    expect(res.status).toBe(400);
  });

  it('requires a valid email on every form', async () => {
    expect((await POST(req({ ...NEWSLETTER, email: 'nope' }))).status).toBe(400);
    expect((await POST(req({ ...NEWSLETTER, email: '' }))).status).toBe(400);
  });

  it('requires name, phone and consent on an application but not on the newsletter', async () => {
    expect((await POST(req({ ...APPLICATION, name: '' }))).status).toBe(400);
    expect((await POST(req({ ...APPLICATION, phone: '' }))).status).toBe(400);
    expect((await POST(req({ ...APPLICATION, consent: false }))).status).toBe(400);
    // Footer newsletter is email-only, exactly like the form it replaces.
    expect((await POST(req(NEWSLETTER))).status).toBe(200);
  });
});

describe('nomination completeness (review finding: browser-only validation)', () => {
  const base = {
    formType: 'nomination',
    formVariant: 'hope-page',
    email: 'nominator@example.com',
    name: 'Nora Nominator',
    phone: '5551110000',
    consent: true,
  };

  it('rejects a nomination that names nobody, even posted directly to the API', async () => {
    // The endpoint is public and CORS-open, so the browser's `required` is not
    // a guarantee. Without this, staff would get a nominator and no household.
    const res = await POST(req({ ...base, payload: { story: 'They are lovely.' } }));
    expect(res.status).toBe(400);
  });

  it('rejects when the relationship or address is missing', async () => {
    expect(
      (await POST(req({ ...base, payload: { nomineeName: 'Ruth', nomineeAddress: '1 Main St' } })))
        .status,
    ).toBe(400);
    expect(
      (await POST(req({ ...base, payload: { nomineeName: 'Ruth', relationship: 'Neighbour' } })))
        .status,
    ).toBe(400);
  });

  it('accepts a complete nomination', async () => {
    const res = await POST(
      req({
        ...base,
        payload: { nomineeName: 'Ruth', relationship: 'Neighbour', nomineeAddress: '1 Main St' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('spam handling', () => {
  it('stores a honeypot hit as spam, answers 200, and never syncs', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    const res = await POST(req({ ...NEWSLETTER, company: 'bot corp' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sb.inserted[0]!.sync_status).toBe('spam');
    expect(hl.upsertContact).not.toHaveBeenCalled();
  });

  it('does NOT silently bin a fast submission on timing alone', async () => {
    // Autofill on the one-field footer form can beat the timer. Discarding it
    // while showing "You are on the list" would lose real subscribers, so a
    // fast submit is processed and merely flagged for review.
    const sb = makeSb();
    sbRef.current = sb.client;
    const res = await POST(req({ ...NEWSLETTER, elapsedMs: 300 }));
    expect(res.status).toBe(200);
    expect(sb.inserted[0]!.sync_status).toBe('pending');
    expect((sb.inserted[0]!.payload as Record<string, string>).bot_suspect_fast_submit).toBe('300');
    expect(hl.upsertContact).toHaveBeenCalled();
  });

  it('still treats fast + honeypot as spam', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    await POST(req({ ...NEWSLETTER, elapsedMs: 300, company: 'bot corp' }));
    expect(sb.inserted[0]!.sync_status).toBe('spam');
    expect(hl.upsertContact).not.toHaveBeenCalled();
  });

  it('rate limits by IP', async () => {
    sbRef.current = makeSb({ count: 5 }).client;
    const res = await POST(req(NEWSLETTER, { 'x-real-ip': '9.9.9.9' }));
    expect(res.status).toBe(429);
  });
});

describe('fail-open contract', () => {
  it('still returns ok when the GHL sync throws', async () => {
    hl.upsertContact.mockRejectedValue(new Error('GHL down'));
    const sb = makeSb();
    sbRef.current = sb.client;
    const res = await POST(req(NEWSLETTER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sb.updated.some((u) => u.sync_status === 'error')).toBe(true);
  });

  it('still returns ok when the alert email throws', async () => {
    hl.sendEmail.mockRejectedValue(new Error('email down'));
    const res = await POST(req(NEWSLETTER));
    expect(res.status).toBe(200);
  });
});

describe('CORS', () => {
  it('allows the marketing origins and ignores anything else', async () => {
    const res = await OPTIONS({
      headers: new Headers({ origin: 'https://yulelovelights.com' }),
    } as unknown as NextRequest);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://yulelovelights.com');

    const bad = await OPTIONS({
      headers: new Headers({ origin: 'https://evil.example' }),
    } as unknown as NextRequest);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});
