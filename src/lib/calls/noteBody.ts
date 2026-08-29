// Composes the internal note that lands on a customer's HighLevel contact
// after one of their calls (Naldo's ask, 2026-08-29). Pure on purpose: the
// note body is the only part of this feature a staff member actually reads,
// so it is worth being able to assert its exact shape in a test without a
// database or an API in the way.
//
// The body carries exactly two things, in this order, per the approved
// scope: the call summary, then the tasks that came out of that call. No
// metadata line and no transcript dump, both declined deliberately.

const NOTE_TIME_ZONE = 'America/New_York';

export type NoteCommitment = {
  kind: string;
  detail: string;
  promised_at: string | null;
};

export type ComposeCallNoteInput = {
  summary: string;
  commitments: NoteCommitment[];
};

/**
 * Renders a promised instant as the wall clock a Long Island staffer reads,
 * e.g. "Wed Aug 26 at 7:00 PM". Returns null for a missing or unparseable
 * value so a bad timestamp degrades to a task with no time rather than
 * printing "Invalid Date" into the CRM.
 */
export function formatPromisedAt(promisedAt: string | null): string | null {
  if (!promisedAt) return null;
  const at = new Date(promisedAt);
  if (Number.isNaN(at.getTime())) return null;

  // Intl renders this as "Wed, Aug 26"; the comma is dropped so the line
  // reads as one plain phrase inside a sentence-shaped bullet.
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: NOTE_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(at).replace(/,/g, '');
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: NOTE_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);

  return `${day} at ${time}`;
}

/**
 * The house voice rule forbids em dashes in anything we publish, and this
 * text is written by a model and then shown to staff, so the rule is
 * enforced here rather than hoped for in a prompt. A comma is the
 * replacement the rule itself names.
 */
function stripEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, ', ');
}

// Timed tasks first, in time order, then the untimed ones in the order they
// came out of the extractor. A staffer scanning the note wants "what is due
// and when" before "what else was promised".
function orderCommitments(commitments: NoteCommitment[]): NoteCommitment[] {
  const timed = commitments
    .filter(c => formatPromisedAt(c.promised_at) !== null)
    .sort((left, right) => (left.promised_at ?? '').localeCompare(right.promised_at ?? ''));
  const untimed = commitments.filter(c => formatPromisedAt(c.promised_at) === null);
  return [...timed, ...untimed];
}

export function composeCallNote(input: ComposeCallNoteInput): string {
  const summary = stripEmDashes(input.summary).trim();
  // A note with no summary would be worse than no note: it would look like
  // the call had nothing in it. The caller records a failure instead.
  if (!summary) throw new Error('Refusing to compose a call note with an empty summary.');

  const lines: string[] = [
    'Call summary (added automatically from the call recording)',
    '',
    summary,
    '',
  ];

  const commitments = orderCommitments(input.commitments);
  if (commitments.length === 0) {
    lines.push('No follow-up tasks came out of this call.');
  } else {
    lines.push('Tasks from this call:');
    for (const commitment of commitments) {
      const detail = stripEmDashes(commitment.detail).trim();
      const when = formatPromisedAt(commitment.promised_at);
      lines.push(when ? `- ${detail} (by ${when})` : `- ${detail}`);
    }
  }

  return lines.join('\n');
}
