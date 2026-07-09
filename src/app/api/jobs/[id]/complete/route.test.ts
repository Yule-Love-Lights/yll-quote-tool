// Tests for POST /api/jobs/[id]/complete (#83): advance the job to
// requires_invoicing + auto-create its invoice; settle when the deposit covers
// the total. Operator-gated; the auth gate + data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJob, setJobStatus, createInvoiceFromJob, setInvoiceStatus, requireOperatorMock, sbRef, hl } =
  vi.hoisted(() => ({
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    createInvoiceFromJob: vi.fn(),
    setInvoiceStatus: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
    sbRef: { current: null as unknown },
    hl: {
      configured: { value: false },
      updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
      findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    },
  }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ createInvoiceFromJob, setInvoiceStatus }));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  updateOpportunity: hl.updateOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const INVOICE = {
  id: 'inv-1',
  invoice_number: 1000,
  total: 1000,
  deposit_applied: 500,
  balance: 500,
  credit_note: 0,
  status: 'draft' as const,
};

// A minimal from().select().eq().maybeSingle() chain for the quote row the
// installed-stage GHL move reads (the shared moveQuoteCardToInstalled in
// src/lib/integrations/ghlQuoteCard.ts).
function makeQuoteSb(quote: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: quote, error: null }),
  });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  // Default: setJobStatus echoes the target status so the advance helper threads.
  setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to }));
  createInvoiceFromJob.mockResolvedValue(INVOICE);
  setInvoiceStatus.mockResolvedValue({ ...INVOICE, status: 'paid' });
  hl.configured.value = false;
  sbRef.current = makeQuoteSb(null);
});

describe('POST /api/jobs/[id]/complete', () => {
  it('401s when the operator gate denies — never touches the data layer', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('400s on an invalid job id', async () => {
    const res = await POST(req, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('404s when the job does not exist', async () => {
    getJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('400s when the job is cancelled', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'cancelled' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(400);
    expect(createInvoiceFromJob).not.toHaveBeenCalled();
  });

  it('advances to_schedule → installed → requires_invoicing and creates the invoice (balance > 0, not settled)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' });
    const res = await POST(req, ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenNthCalledWith(1, ID, 'installed');
    expect(setJobStatus).toHaveBeenNthCalledWith(2, ID, 'requires_invoicing');
    expect(createInvoiceFromJob).toHaveBeenCalledWith(ID);
    expect(json).toMatchObject({ ok: true, settled: false });
    expect(json.invoice).toMatchObject({ balance: 500, status: 'draft' });
    expect(setInvoiceStatus).not.toHaveBeenCalled();
  });

  it('does not re-advance a job already at requires_invoicing', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    // setJobStatus only ever called for the (later) done transition, never to advance.
    expect(setJobStatus).not.toHaveBeenCalledWith(ID, 'installed');
  });

  it('settles paid + closes the job when the deposit covers the total (balance ≤ 0)', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    createInvoiceFromJob.mockResolvedValueOnce({ ...INVOICE, balance: 0, status: 'draft' });
    const res = await POST(req, ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'paid');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
    expect(json).toMatchObject({ ok: true, settled: true });
    expect(json.invoice.status).toBe('paid');
  });

  it('409s when the job has no quote to invoice', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    createInvoiceFromJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
  });
});

describe('POST /api/jobs/[id]/complete — GHL installed-stage card move (#GHL pipeline sync)', () => {
  beforeEach(() => {
    hl.configured.value = true;
    // The real setJobStatus returns the FULL updated row (quote_id included);
    // thread it through here so moveInstalledOpportunity(current.quote_id) sees it.
    setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to, quote_id: 'quote-1' }));
  });

  it('moves the card to Installed once the job FIRST transitions to installed (holiday)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      highlevel_contact_id: 'contact_1',
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: 'aa6263d6-20bb-4b65-bd8c-23b75831716b',
    });
  });

  it('a permanent job\'s quote moves the card to the PERMANENT pipeline\'s Installed stage', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_perm',
      highlevel_contact_id: 'contact_1',
      service_type: 'permanent',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_perm', {
      pipelineStageId: 'b2192f2e-eee9-4a1b-9749-4f458f007c55',
    });
  });

  it('looks up the card via the contact when no opportunity id is linked', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    hl.findOpportunityForContact.mockResolvedValueOnce({ id: 'found_opp' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: null,
      highlevel_contact_id: 'contact_1',
      service_type: 'event',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.findOpportunityForContact).toHaveBeenCalledWith('contact_1', 'YfCi5jy8Alc3oD5AfXmV');
    expect(hl.updateOpportunity).toHaveBeenCalledWith('found_opp', {
      pipelineStageId: '3375d0d6-0c1d-4e22-a40e-1430a771afc3',
    });
  });

  it('never CREATES a card — no opportunity and no contact match means no GHL call at all', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: null,
      highlevel_contact_id: null,
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('never touches GHL for a TEST quote', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      highlevel_contact_id: 'contact_1',
      service_type: 'holiday',
      is_test: true,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not re-move the card when the job was already installed before this call', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'installed', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does NOT fail job completion when the GHL stage move throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: 'quote-1' });
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('GHL installed stage move failed'),
      expect.anything(),
    );
    err.mockRestore();
  });

  it('is a no-op when the job carries no quote_id', async () => {
    // Override this describe's default (which threads quote_id through) back to
    // a quote_id-less row, so the advance genuinely carries none through.
    setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to }));
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});
