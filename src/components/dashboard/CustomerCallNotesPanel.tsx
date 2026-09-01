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
//
// FIX ROUND (staff-lens findings): a task now shows its REAL office_tasks
// status (a completed/dismissed task reads as such, permanently, instead
// of a bare bullet that never changes) and the note badge distinguishes a
// call still waiting on the calls-note cron from one that permanently failed —
// conflating the two made a broken call look identical to a normal one.

import { getCallNotesForCustomer, type CustomerCallNoteStatus, type CustomerCallTask } from '@/lib/calls/customerCallNotes';
import { formatPromisedAt } from '@/lib/calls/noteBody';
import type { OfficeTaskStatus } from '@/lib/officeTasks';

function fmtCalledAt(iso: string | null): string {
  if (!iso) return 'unknown time';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The three-stage pipeline (sync/extract/note, vercel.json) runs every 15
// minutes, so "not yet posted" is the NORMAL state for a call from the
// last 20-25 minutes or so — the title text says that plainly rather than
// leaving a rep to guess whether something is broken.
const NOTE_STATUS: Record<Exclude<CustomerCallNoteStatus, 'posted'>, { label: string; title: string; color: string }> = {
  pending: {
    label: 'Not yet in HighLevel',
    title: 'The job that posts this to HighLevel runs every 15 minutes and has not reached this call yet. Normal for a call from the last 20-25 minutes.',
    color: 'var(--op-text-dim)',
  },
  quarantined: {
    label: 'Failed to post to HighLevel',
    title: 'This call could not be posted to HighLevel after repeated tries and will not be retried automatically. See /admin/calls.',
    color: '#b91c1c',
  },
};

const TASK_STATUS_LABEL: Record<OfficeTaskStatus, string> = {
  open: '',
  blocked: 'Blocked',
  completed: 'Done',
  dismissed: 'Dismissed',
};

function TaskRow({ task }: { task: CustomerCallTask }) {
  const when = formatPromisedAt(task.promisedAt);
  const done = task.status === 'completed' || task.status === 'dismissed';
  const statusLabel = task.status ? TASK_STATUS_LABEL[task.status] : null;
  return (
    <li
      className="text-xs"
      style={{ color: 'var(--op-text-dim)', textDecoration: done ? 'line-through' : 'none' }}
    >
      • {task.detail}{when ? ` (by ${when})` : ''}
      {statusLabel && <span className="ml-1.5 font-semibold uppercase tracking-wide text-[10px]">{statusLabel}</span>}
    </li>
  );
}

export async function CustomerCallNotesPanel({ ghlContactIds }: { ghlContactIds: string[] }) {
  const calls = await getCallNotesForCustomer(ghlContactIds);
  if (calls.length === 0) return null; // No call history yet — nothing to show, no empty card either.

  return (
    <section
      className="rounded-lg border mt-6"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Call notes</h2>

      <div className="px-4 pb-4 flex flex-col gap-4">
        {calls.map(call => {
          const badge = call.noteStatus === 'posted' ? null : NOTE_STATUS[call.noteStatus];
          return (
            <div key={call.transcriptId} className="rounded border p-3" style={{ borderColor: 'var(--op-border)' }}>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{fmtCalledAt(call.calledAt)}</span>
                {badge && (
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wide"
                    style={{ color: badge.color }}
                    title={badge.title}
                  >
                    {badge.label}
                  </span>
                )}
              </div>
              <p className="text-sm" style={{ color: 'var(--op-text)' }}>{call.summary}</p>
              {call.tasks.length > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {call.tasks.map((task, i) => <TaskRow key={i} task={task} />)}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
