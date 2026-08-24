'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { StaffNote } from '@/lib/staffNotes';

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

export async function loadStaffNotes(quoteId: string, fetcher: Fetcher = fetch): Promise<StaffNote[]> {
  const response = await fetcher(`/api/quotes/${quoteId}/staff-notes`, { cache: 'no-store' });
  const payload = await responseBody(response);
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Could not load notes');
  if (!Array.isArray(payload.notes)) throw new Error('Could not load notes');
  return payload.notes as StaffNote[];
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
}: {
  notes: StaffNote[];
  loading: boolean;
  // Staff-lens MED: without this, a failed FETCH rendered the same
  // "No internal notes yet." as a genuinely empty timeline, so a staffer could
  // trust an empty panel on a quote that actually has notes they needed to see.
  loadFailed?: boolean;
  onRetry?: () => void;
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
      pendingSubmissionRef.current = null;
      void loadStaffNotes(quoteId)
        .then((loaded) => {
          if (!cancelled && generation === loadGenerationRef.current) {
            setNotes((current) => mergeStaffNotes(current, loaded));
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
