import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  StaffNotesList,
  buildStaffNoteSubmission,
  canSubmitStaffNote,
  loadStaffNotes,
  mergeStaffNote,
  oldestStaffNoteCursor,
  staffNotesPageQuery,
  mergeStaffNotes,
  postStaffNote,
} from './StaffNotesPanel';

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const NOTE = {
  id: '44444444-4444-4444-8444-444444444444',
  quoteId: QUOTE_ID,
  body: 'Gate code is in the lockbox.',
  createdBy: '22222222-2222-4222-8222-222222222222',
  createdByLabel: 'Naldo',
  createdAt: '2026-08-21T14:00:00.000Z',
};

describe('StaffNotesList — the older-notes control (row 373)', () => {
  it('offers a way to READ the older notes, not just a note that they exist', () => {
    const html = renderToStaticMarkup(
      <StaffNotesList notes={[NOTE]} loading={false} hasMore onLoadMore={() => {}} />,
    );
    expect(html).toContain('Show older notes');
  });

  it('renders no control when the page holds every note', () => {
    const html = renderToStaticMarkup(<StaffNotesList notes={[NOTE]} loading={false} />);
    expect(html).not.toContain('Show older notes');
  });

  it('disables the control while an older page is in flight', () => {
    const html = renderToStaticMarkup(
      <StaffNotesList notes={[NOTE]} loading={false} hasMore loadingMore onLoadMore={() => {}} />,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('Loading…');
  });
});

describe('staff-note transport', () => {
  it('loads only the quote-scoped internal route', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ notes: [NOTE], hasMore: false }), { status: 200 }),
    );

    await expect(loadStaffNotes(QUOTE_ID, fetcher)).resolves.toEqual({ notes: [NOTE], hasMore: false });
    expect(fetcher).toHaveBeenCalledWith(`/api/quotes/${QUOTE_ID}/staff-notes`, { cache: 'no-store' });
  });

  // ── Row 373: paging transport ─────────────────────────────────────────────
  it('sends the page cursor as both halves, url-encoded', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ notes: [], hasMore: false }), { status: 200 }),
    );

    await loadStaffNotes(QUOTE_ID, fetcher, { createdAt: NOTE.createdAt, id: NOTE.id });

    expect(fetcher).toHaveBeenCalledWith(
      `/api/quotes/${QUOTE_ID}/staff-notes?beforeCreatedAt=${encodeURIComponent(NOTE.createdAt)}&beforeId=${NOTE.id}`,
      { cache: 'no-store' },
    );
  });

  // An old server (or a garbled body) that omits the flag must leave the
  // "Show older notes" button AVAILABLE. An extra click costs nothing; a
  // wrongly-hidden button hides notes, which is the whole point of this row.
  it('assumes there may be more when the response omits hasMore', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ notes: [NOTE] }), { status: 200 }));
    await expect(loadStaffNotes(QUOTE_ID, fetcher)).resolves.toEqual({ notes: [NOTE], hasMore: true });
  });

  it('builds the next-page cursor from the OLDEST loaded note, and nothing from an empty list', () => {
    const older = { ...NOTE, id: 'older-id', createdAt: '2026-08-20T09:00:00.000Z' };
    expect(oldestStaffNoteCursor([NOTE, older])).toEqual({ createdAt: older.createdAt, id: older.id });
    expect(oldestStaffNoteCursor([])).toBeNull();
    expect(staffNotesPageQuery(null)).toBe('');
  });

  it('posts the exact body and idempotency key', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ note: NOTE, duplicate: false }), { status: 201 }),
    );

    await expect(postStaffNote(QUOTE_ID, NOTE.body, REQUEST_ID, fetcher)).resolves.toEqual(NOTE);
    expect(fetcher).toHaveBeenCalledWith(`/api/quotes/${QUOTE_ID}/staff-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: NOTE.body, clientRequestId: REQUEST_ID }),
    });
  });
});

describe('staff-note retry state', () => {
  it('reuses the request id for the same failed draft and replaces it after an edit', () => {
    const ids = [REQUEST_ID, '55555555-5555-4555-8555-555555555555'];
    const makeId = vi.fn(() => ids.shift()!);
    const first = buildStaffNoteSubmission(null, 'First note', makeId);
    const retry = buildStaffNoteSubmission(first, 'First note', makeId);
    const edited = buildStaffNoteSubmission(first, 'Edited note', makeId);

    expect(retry).toEqual(first);
    expect(edited.clientRequestId).not.toBe(first.clientRequestId);
    expect(makeId).toHaveBeenCalledTimes(2);
  });

  it('deduplicates the returned note and keeps newest-first ordering', () => {
    const older = { ...NOTE, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-08-20T14:00:00.000Z' };
    expect(mergeStaffNote([older, NOTE], NOTE)).toEqual([NOTE, older]);
  });

  it('merges a late initial load without erasing a note returned by an early submit', () => {
    const loadedEarlier = {
      ...NOTE,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-08-20T14:00:00.000Z',
    };
    expect(mergeStaffNotes([NOTE], [loadedEarlier])).toEqual([NOTE, loadedEarlier]);
  });

  it('does not allow a submission during the initial load or another save', () => {
    expect(canSubmitStaffNote('Ready', true, false)).toBe(false);
    expect(canSubmitStaffNote('Ready', false, true)).toBe(false);
    expect(canSubmitStaffNote('Ready', false, false)).toBe(true);
    expect(canSubmitStaffNote('   ', false, false)).toBe(false);
  });
});

describe('staff-note UI', () => {
  it('labels notes as staff-only and renders author, time, and text', () => {
    const html = renderToStaticMarkup(<StaffNotesList notes={[NOTE]} loading={false} />);
    expect(html).toContain('Gate code is in the lockbox.');
    expect(html).toContain('Naldo');
    expect(html).toContain('Staff only');
  });

  it('is wired to the same quote timeline on quote, job, and invoice pages', () => {
    const root = process.cwd();
    const quotePage = readFileSync(resolve(root, 'src/app/admin/quotes/[id]/page.tsx'), 'utf8');
    const jobPage = readFileSync(resolve(root, 'src/app/admin/jobs/[id]/page.tsx'), 'utf8');
    const invoicePage = readFileSync(resolve(root, 'src/app/admin/invoices/[id]/page.tsx'), 'utf8');

    expect(quotePage).toContain('<StaffNotesPanel key={id} quoteId={id} />');
    expect(jobPage).toContain('<StaffNotesPanel key={data.job.quote_id} quoteId={data.job.quote_id} />');
    expect(invoicePage).toContain('<StaffNotesPanel key={inv.quote_id} quoteId={inv.quote_id} />');
  });
});
