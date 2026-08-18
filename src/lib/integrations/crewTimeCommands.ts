import type { StoppageReason } from '@/lib/jobSegments';

/**
 * Crew time-capture commands for the Telegram bot (Flow B, Phase 2).
 *
 * ⚠️ THESE ARE PAY ACTIONS, SO THEY ARE PARSED DETERMINISTICALLY AND NEVER GO
 * THROUGH THE LLM TOOL DISPATCH. Everything else the bot does is recoverable —
 * a misread inventory count gets corrected. A misread clock-out is somebody's
 * paycheck, and "the model interpreted it that way" is not an answer a crew
 * member should ever be given about their hours. So this module is a plain
 * matcher: it either recognises the command exactly or it does not act.
 *
 * The vocabulary is deliberately short and typo-tolerant in the specific ways
 * cold, gloved hands on a roof actually produce: extra spaces, no slash, mixed
 * case, and the obvious synonyms. It is NOT fuzzy — an unrecognised message
 * returns null and falls through to the normal bot, rather than guessing at
 * something that moves money.
 */

export type CrewTimeCommand =
  | { kind: 'clock_in' }
  | { kind: 'clock_out' }
  | { kind: 'break_start' }
  | { kind: 'break_end' }
  | { kind: 'status' }
  | { kind: 'arrive'; jobNumber: number }
  | { kind: 'depart'; reason: StoppageReason }
  | { kind: 'complete' }
  | { kind: 'help' };

/** Normalize: lowercase, collapse whitespace, drop a leading slash. */
function norm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^\/+/, '');
}

const CLOCK_IN = new Set(['in', 'clockin', 'clock in', 'start', 'here', 'on']);
const CLOCK_OUT = new Set(['out', 'clockout', 'clock out', 'end', 'off', 'home']);
const BREAK_START = new Set(['break', 'lunch', 'break start', 'startbreak', 'start break']);
const BREAK_END = new Set(['back', 'endbreak', 'end break', 'break end', 'resume', '返回']);
const STATUS = new Set(['status', 'me', 'where', 'whereami', 'where am i']);
const HELP = new Set(['help', 'commands', '?']);
const COMPLETE = new Set(['done', 'complete', 'finished', 'completed']);

/**
 * Stoppage reasons, in crew words.
 *
 * `completed` is deliberately ABSENT here: finishing a job is `/done`, which
 * also advances the job's status. Allowing "depart completed" would create a
 * second, quieter path to the same claim that skips the status move, and the two
 * would drift.
 */
const REASONS: Record<string, StoppageReason> = {
  weather: 'weather',
  rain: 'weather',
  rained: 'weather',
  snow: 'weather',
  wind: 'weather',
  access: 'no_access',
  'no access': 'no_access',
  noaccess: 'no_access',
  locked: 'no_access',
  gate: 'no_access',
  dog: 'no_access',
  materials: 'materials',
  material: 'materials',
  supplies: 'materials',
  parts: 'materials',
  other: 'other',
};

export const DEPART_REASON_WORDS = Object.keys(REASONS);

/**
 * Parse a message into a crew time command, or null if it is not one.
 *
 * Returning null is the safe default and the common case: the crew group is used
 * for ordinary chatter, and only an exact match should move a time record.
 */
export function parseCrewTimeCommand(rawText: string): CrewTimeCommand | null {
  const text = norm(rawText ?? '');
  if (!text) return null;

  if (CLOCK_IN.has(text)) return { kind: 'clock_in' };
  if (CLOCK_OUT.has(text)) return { kind: 'clock_out' };
  if (BREAK_START.has(text)) return { kind: 'break_start' };
  if (BREAK_END.has(text)) return { kind: 'break_end' };
  if (STATUS.has(text)) return { kind: 'status' };
  if (HELP.has(text)) return { kind: 'help' };
  if (COMPLETE.has(text)) return { kind: 'complete' };

  // arrive <job number> — "arrive 1042", "at 1042", "job 1042"
  const arrive = text.match(/^(?:arrive|arrived|at|job|start job)\s+#?(\d{1,9})$/);
  if (arrive) {
    const jobNumber = Number(arrive[1]);
    return Number.isSafeInteger(jobNumber) && jobNumber > 0 ? { kind: 'arrive', jobNumber } : null;
  }

  // depart <reason> — the reason is REQUIRED, never defaulted.
  const depart = text.match(/^(?:depart|departed|leave|leaving|stop|stopped)\s+(.+)$/);
  if (depart) {
    const reason = REASONS[depart[1]!.trim()];
    return reason ? { kind: 'depart', reason } : null;
  }
  // A bare "depart" is NOT a command: without a reason it would either fail or
  // tempt a default, and a defaulted `completed` poisons the learning signal.
  // Returning null lets the caller answer with the reason list instead.
  if (/^(?:depart|departed|leave|leaving|stop|stopped)$/.test(text)) return null;

  return null;
}

/** True when the message LOOKS like a depart that is missing its reason. */
export function isDepartMissingReason(rawText: string): boolean {
  const text = norm(rawText ?? '');
  if (/^(?:depart|departed|leave|leaving|stop|stopped)$/.test(text)) return true;
  const m = text.match(/^(?:depart|departed|leave|leaving|stop|stopped)\s+(.+)$/);
  return m ? REASONS[m[1]!.trim()] === undefined : false;
}

export const CREW_HELP_TEXT = [
  'Time clock:',
  '  in — clock in for the day',
  '  out — clock out (also ends any open break or job)',
  '  break — start a break (unpaid)',
  '  back — end the break',
  '  arrive 1042 — arrive at job #1042',
  '  done — finished the job (marks it installed)',
  '  depart <reason> — leave without finishing',
  `      reasons: ${['weather', 'access', 'materials', 'other'].join(', ')}`,
  '  status — what am I currently on',
].join('\n');
