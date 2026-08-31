'use client';

// Call-notes drawer for the quote builder (Naldo's ask, 2026-08-31): a
// collapsed-by-default panel that slides in from the right, showing the
// same call summaries + tasks the /customers/[contactId] page already
// renders, so a rep editing a quote can check "did the customer mention
// anything specific?" without leaving the builder.
//
// Self-contained on purpose: QuoteBuilder.tsx is an 8000+ line file under
// active, careful review, so this owns its own open/closed state and its
// own fetch, and the builder needs exactly one import + one JSX line to
// use it. Fixed-position, rendered as a sibling of the builder's centered
// column, so it can never affect that column's layout or width.
//
// Fetches over GET /api/calls/customer-notes rather than importing
// getCallNotesForCustomer directly — that function pulls in the
// server-only Supabase client, which must never reach a client bundle
// (the S18 lesson this repo has been burned by before). Only the TYPES
// are imported from customerCallNotes.ts, via `import type`, which is
// erased at compile time and carries no runtime code into the bundle.

import { useEffect, useRef, useState } from 'react';
import type { CustomerCallNote, CustomerCallNoteStatus } from '@/lib/calls/customerCallNotes';

const NOTE_STATUS_LABEL: Record<Exclude<CustomerCallNoteStatus, 'posted'>, string> = {
  pending: 'Not yet in HighLevel',
  quarantined: 'Failed to post to HighLevel',
};

function fmtCalledAt(iso: string | null): string {
  if (!iso) return 'unknown time';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function QuoteBuilderCallNotesDrawer({ ghlContactId }: { ghlContactId: string | null }) {
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<CustomerCallNote[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Tracks which contact id the current `calls` state was fetched for, so a
  // re-pick invalidates the stale list even while the drawer stays open,
  // and so opening the drawer twice for the same contact doesn't re-fetch.
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !ghlContactId) return;
    if (loadedForRef.current === ghlContactId) return;
    let cancelled = false;
    setLoadError(false);
    fetch(`/api/calls/customer-notes?hlContactId=${encodeURIComponent(ghlContactId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: { calls?: CustomerCallNote[] }) => {
        if (cancelled) return;
        loadedForRef.current = ghlContactId;
        setCalls(data.calls ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
      });
    return () => { cancelled = true; };
  }, [open, ghlContactId]);

  // A re-pick while the drawer is CLOSED must still invalidate the cache —
  // otherwise reopening after picking a different contact would show the
  // previous contact's calls for one render before the effect above catches
  // up (or not at all, if the id briefly matches a prior fetch by coincidence).
  useEffect(() => {
    if (loadedForRef.current !== ghlContactId) {
      loadedForRef.current = null;
      setCalls(null);
    }
  }, [ghlContactId]);

  if (!ghlContactId) return null; // No contact picked yet — nothing to show, no button either.

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 top-24 z-40 rounded-full border bg-white shadow-md px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        style={{ borderColor: 'var(--op-border, #e5e7eb)' }}
        aria-expanded={open}
        aria-controls="quote-builder-call-notes-drawer"
      >
        📞 Call notes
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Call notes">
          {/* Backdrop — click to close, same as every other overlay in this file. */}
          <div className="absolute inset-0 bg-black/20" onClick={() => setOpen(false)} />

          <div
            id="quote-builder-call-notes-drawer"
            className="relative h-full w-full max-w-sm bg-white shadow-xl overflow-y-auto"
          >
            <div className="sticky top-0 flex items-center justify-between border-b bg-white px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-900">Call notes</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="p-4 flex flex-col gap-3">
              {loadError && (
                <p className="text-sm text-red-600">Could not load call notes. Try again in a moment.</p>
              )}
              {!loadError && calls === null && (
                <p className="text-sm text-gray-500">Loading…</p>
              )}
              {!loadError && calls !== null && calls.length === 0 && (
                <p className="text-sm text-gray-500">No calls on record for this customer yet.</p>
              )}
              {calls?.map((call) => {
                const badgeLabel = call.noteStatus === 'posted' ? null : NOTE_STATUS_LABEL[call.noteStatus];
                return (
                  <div key={call.transcriptId} className="rounded border border-gray-200 p-3">
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <span className="text-xs text-gray-500">{fmtCalledAt(call.calledAt)}</span>
                      {badgeLabel && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                          {badgeLabel}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-900">{call.summary}</p>
                    {call.tasks.length > 0 && (
                      <ul className="mt-2 flex flex-col gap-0.5">
                        {call.tasks.map((task, i) => (
                          <li key={i} className="text-xs text-gray-500">
                            • {task.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
