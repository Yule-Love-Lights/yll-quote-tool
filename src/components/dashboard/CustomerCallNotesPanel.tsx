// Customer profile call-notes panel (Naldo's ask, 2026-08-30 — "make the
// customer notes also show up in their customer profile in the quote
// tool"). Server component, matching CustomerReferralPanel's shape: fetches
// its own data, renders a card in src/app/customers/[contactId]/page.tsx's
// visual language.
//
// Shows the SAME content that goes to HighLevel's note and internal
// comment (composeCallNote in noteBody.ts) — a summary paragraph and the
// tasks, per call, newest first — so a rep never has to open HighLevel to
// see what a call was about. Voicemails are included on purpose, same
// ruling as the HighLevel note; do not add a junk filter here without
// checking first.

import { getCallNotesForCustomer } from '@/lib/calls/customerCallNotes';
import { formatPromisedAt } from '@/lib/calls/noteBody';

function fmtCalledAt(iso: string | null): string {
  if (!iso) return 'unknown time';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function CustomerCallNotesPanel({ ghlContactId }: { ghlContactId: string | null }) {
  const calls = await getCallNotesForCustomer(ghlContactId);
  if (calls.length === 0) return null; // No call history yet — nothing to show, no empty card either.

  return (
    <section
      className="rounded-lg border mt-6"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Call notes</h2>

      <div className="px-4 pb-4 flex flex-col gap-4">
        {calls.map(call => (
          <div key={call.transcriptId} className="rounded border p-3" style={{ borderColor: 'var(--op-border)' }}>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{fmtCalledAt(call.calledAt)}</span>
              {!call.posted && (
                <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
                  Not yet in HighLevel
                </span>
              )}
            </div>
            <p className="text-sm" style={{ color: 'var(--op-text)' }}>{call.summary}</p>
            {call.tasks.length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5">
                {call.tasks.map((task, i) => {
                  const when = formatPromisedAt(task.promisedAt);
                  return (
                    <li key={i} className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
                      • {task.detail}{when ? ` (by ${when})` : ''}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
