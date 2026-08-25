'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { StaffNote, StaffNoteCursor, StaffNotesPage } from '@/lib/staffNotes';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type StaffNoteSubmission = {
  body: string;
  clientRequestId: string;
};

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Row 373: the query string for the next page, or '' for the first one.
 *  Exported so the cursor arithmetic is unit-testable without a fetch. Both
 *  halves ride together — a cursor missing either one is not a cursor. */
export function staffNotesPageQuery(before: StaffNoteCursor | null): string {
  if (!before) return '';
  return `?beforeCreatedAt=${encodeURIComponent(before.createdAt)}&beforeId=${encodeURIComponent(before.id)}`;
}

/** Row 373: the cursor for the page AFTER the ones already loaded — the OLDEST
 *  note held, since the list runs newest-first. Null when nothing is loaded. */
export function oldestStaffNoteCursor(notes: StaffNote[]): StaffNoteCursor | null {
  const oldest = notes[notes.length - 1];
  return oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null;
}

export async function loadStaffNotes(
  quoteId: string,
  fetcher: Fetcher = fetch,
  before: StaffNoteCursor | null = null,
): Promise<StaffNotesPage> {
  const response = await fetcher(`/api/quotes/${quoteId}/staff-notes${staffNotesPageQuery(before)}`, {
    cache: 'no-store',
  });
  const payload = await responseBody(response);
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Could not load notes');
  if (!Array.isArray(payload.notes)) throw new Error('Could not load notes');
  // Row 373: an absent/garbled flag means "assume there could be more" — an
  // over-eager "Show older notes" button is a wasted click, while a wrongly
  // absent one hides notes, which is the failure this row exists to avoid.
  return { notes: payload.notes as StaffNote[], hasMore: payload.hasMore !== false };
}

export async function postStaffNote(
  quoteId: string,
  body: string,
  clientRequestId: string,
  fetcher: Fetcher = fetch,
): Promise<StaffNote> {
  const response = await fetcher(`/api/quotes/${quoteId}/staff-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, clientRequestId }),
  });
  const payload = await responseBody(response);
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Could not save note');
  if (!payload.note || typeof payload.note !== 'object') throw new Error('Could not save note');
  return payload.note as StaffNote;
}

export function buildStaffNoteSubmission(
  previous: StaffNoteSubmission | null,
  body: string,
  makeId: () => string = () => crypto.randomUUID(),
): StaffNoteSubmission {
  if (previous?.body === body) return previous;
  return { body, clientRequestId: makeId() };
}

export function mergeStaffNote(notes: StaffNote[], note: StaffNote): StaffNote[] {
  return mergeStaffNotes(notes, [note]);
}

export function mergeStaffNotes(notes: StaffNote[], incoming: StaffNote[]): StaffNote[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  for (const note of incoming) byId.set(note.id, note);
  return [...byId.values()].sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime || b.id.localeCompare(a.id);
  });
}

export function canSubmitStaffNote(draft: string, loading: boolean, saving: boolean): boolean {
  return !!draft.trim() && !loading && !saving;
}

function formatNoteTime(value: string): string {
  return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function StaffNotesList({
  notes,
  loading,
  loadFailed = false,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  notes: StaffNote[];
  loading: boolean;
  // Staff-lens MED: without this, a failed FETCH rendered the same
  // "No internal notes yet." as a genuinely empty timeline, so a staffer could
  // trust an empty panel on a quote that actually has notes they needed to see.
  loadFailed?: boolean;
  onRetry?: () => void;
  /** Row 373: older notes exist beyond the loaded page. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  return (
    <div aria-live="polite">
      <span className="inline-block mb-3 rounded bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
        Staff only
      </span>
      {loading ? (
        <p className="text-sm text-gray-500">Loading notes…</p>
      ) : loadFailed && notes.length === 0 ? (
        <div role="alert" className="text-sm text-red-700">
          <p>Could not load notes. This quote may still have notes that are not shown.</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700"
            >
              Try again
            </button>
          )}
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-gray-500">No internal notes yet.</p>
      ) : (
        <ol className="max-h-80 space-y-3 overflow-y-auto">
          {notes.map((note) => (
            <li key={note.id} className="border-t border-gray-100 pt-3 first:border-0 first:pt-0">
              <p className="whitespace-pre-wrap text-sm text-gray-800">{note.body}</p>
              <p className="mt-1 text-xs text-gray-500">
                {note.createdByLabel} · {formatNoteTime(note.createdAt)}
              </p>
            </li>
          ))}
          {/* Row 373: the page is capped, so the older notes have to be
              REACHABLE, not merely acknowledged — a "there are more" line with
              no way to read them would hide notes exactly like the empty-panel
              bug this component already fixed once. Sits inside the scroll
              list, at the bottom, where the oldest note is. */}
          {hasMore && (
            <li className="border-t border-gray-100 pt-3">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore || !onLoadMore}
                className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Show older notes'}
              </button>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

export function StaffNotesPanel({ quoteId }: { quoteId: string }) {
  const [notes, setNotes] = useState<StaffNote[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Row 373: older notes exist past the loaded page, and whether a "Show older
  // notes" fetch is in flight.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pendingSubmissionRef = useRef<StaffNoteSubmission | null>(null);
  const loadGenerationRef = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGenerationRef.current;
    queueMicrotask(() => {
      if (cancelled) return;
      setNotes([]);
      setDraft('');
      setLoading(true);
      setSaving(false);
      setError(null);
      setLoadFailed(false);
      setHasMore(false);
      setLoadingMore(false);
      pendingSubmissionRef.current = null;
      void loadStaffNotes(quoteId)
        .then((page) => {
          if (!cancelled && generation === loadGenerationRef.current) {
            setNotes((current) => mergeStaffNotes(current, page.notes));
            setHasMore(page.hasMore);
          }
        })
        .catch((err) => {
          if (!cancelled && generation === loadGenerationRef.current) {
            setError(err instanceof Error ? err.message : 'Could not load notes');
            setLoadFailed(true);
          }
        })
        .finally(() => {
          if (!cancelled && generation === loadGenerationRef.current) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [quoteId, reloadKey]);

  // Row 373: fetch the page BELOW what is loaded, keyed off the oldest note
  // held. Guarded on the same generation ref as the initial load, so a click
  // that lands as the panel switches quotes cannot append the old quote's
  // notes into the new one's list.
  const loadMore = async () => {
    if (loadingMore) return;
    const cursor = oldestStaffNoteCursor(notes);
    if (!cursor) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loadStaffNotes(quoteId, fetch, cursor);
      if (generation !== loadGenerationRef.current) return;
      setNotes((current) => mergeStaffNotes(current, page.notes));
      setHasMore(page.hasMore);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      // Deliberately does NOT clear hasMore: the older notes still exist, the
      // fetch just failed, so the button must stay available to retry.
      setError(err instanceof Error ? err.message : 'Could not load older notes');
    } finally {
      if (generation === loadGenerationRef.current) setLoadingMore(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!canSubmitStaffNote(draft, loading, saving)) return;
    const submittedQuoteId = quoteId;
    const submission = buildStaffNoteSubmission(pendingSubmissionRef.current, body);
    pendingSubmissionRef.current = submission;
    setSaving(true);
    setError(null);
    try {
      const note = await postStaffNote(submittedQuoteId, submission.body, submission.clientRequestId);
      setNotes((current) => mergeStaffNote(current, note));
      setDraft('');
      pendingSubmissionRef.current = null;
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Internal notes</h2>
      <p className="mb-3 mt-1 text-xs text-gray-500">Shared across this quote, its job, and its invoice.</p>
      <StaffNotesList
        notes={notes}
        loading={loading}
        loadFailed={loadFailed}
        onRetry={() => setReloadKey((n) => n + 1)}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />
      <form onSubmit={submit} className="mt-4 border-t border-gray-100 pt-4">
        <label htmlFor={`staff-note-${quoteId}`} className="mb-1 block text-sm font-medium text-gray-700">
          Add an internal note
        </label>
        <p className="mb-1 text-xs text-gray-500">
          Notes are permanent. They cannot be edited or deleted once added.
        </p>
        <textarea
          id={`staff-note-${quoteId}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          rows={3}
          disabled={loading || saving}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 disabled:bg-gray-50"
        />
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSubmitStaffNote(draft, loading, saving)}
          className="mt-2 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Add note'}
        </button>
      </form>
    </section>
  );
}
