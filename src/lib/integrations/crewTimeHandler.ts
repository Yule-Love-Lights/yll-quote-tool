import { getCrewMemberByTelegramUserId } from '@/lib/crewMembers';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { clockIn, clockOut, getOpenShift } from '@/lib/shifts';
import { endBreak, getOpenBreak, startBreak } from '@/lib/shiftBreaks';
import { arriveAtJob, departFromJob, getOpenSegment } from '@/lib/jobSegments';
import { getJob, setJobStatus } from '@/lib/jobs';
import { canTransition } from '@/lib/jobStatus';
import {
  CREW_HELP_TEXT,
  isDepartMissingReason,
  parseCrewTimeCommand,
  type CrewTimeCommand,
} from '@/lib/integrations/crewTimeCommands';

/**
 * Executes crew time commands from the Telegram bot against the canonical ledger.
 *
 * IDENTITY COMES FROM THE SENDER, NEVER THE MESSAGE. The crew member is resolved
 * from `crew_members.telegram_user_id`, so there is no way to type your way into
 * clocking somebody else in. (The HTTP routes do the same thing via the session.)
 *
 * Every reply is written for someone on a roof holding a phone in one hand:
 * short, concrete, and it always says what state they are now in. A reply that
 * just says "OK" leaves them unsure whether the punch landed, and an unsure crew
 * member punches again.
 */

export type CrewTimeOutcome = { handled: false } | { handled: true; reply: string };

const SOURCE = 'telegram' as const;

/** Job lookup by the human-facing Job # rather than a uuid nobody carries. */
async function findJobByNumber(jobNumber: number) {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data, error } = await db
    .from('jobs')
    .select('id, job_number, status')
    .eq('job_number', jobNumber)
    .maybeSingle();
  if (error) {
    console.error('crewTime: job lookup failed:', error.message);
    return null;
  }
  return (data as unknown as { id: string; job_number: number; status: string } | null) ?? null;
}

function timeOfDay(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Handle a message if it is a crew time command.
 *
 * Returns `{ handled: false }` for anything else, so the normal bot dispatch
 * continues untouched — this runs BEFORE the LLM tool layer precisely so pay
 * actions never depend on a model's interpretation.
 */
export async function handleCrewTimeMessage(
  telegramUserId: string,
  text: string,
): Promise<CrewTimeOutcome> {
  const command = parseCrewTimeCommand(text);

  // A depart with no usable reason: coach rather than guess, and rather than
  // falling through to the LLM which might "helpfully" pick one.
  if (!command && isDepartMissingReason(text)) {
    return {
      handled: true,
      reply:
        'Which reason? Reply with one of: depart weather · depart access · depart materials · depart other.\n' +
        'If the job is finished, send: done',
    };
  }

  if (!command) return { handled: false };
  if (command.kind === 'help') return { handled: true, reply: CREW_HELP_TEXT };

  const crew = await getCrewMemberByTelegramUserId(telegramUserId);
  if (!crew) {
    return {
      handled: true,
      reply:
        'I do not have you set up on the time clock yet. Ask the office to link your Telegram to your crew profile.',
    };
  }
  if (!crew.active) {
    return { handled: true, reply: 'Your crew profile is not active. Ask the office.' };
  }

  try {
    return { handled: true, reply: await execute(command, crew.id, crew.displayName) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('crewTime: command failed:', message);
    // Never a raw stack: the crew member needs to know whether their time was
    // recorded, not what threw.
    return {
      handled: true,
      reply: 'That did not go through. Try again, and tell the office if it keeps failing.',
    };
  }
}

async function execute(
  command: CrewTimeCommand,
  crewMemberId: string,
  displayName: string,
): Promise<string> {
  switch (command.kind) {
    case 'clock_in': {
      const existing = await getOpenShift(crewMemberId);
      if (existing) {
        return `Already clocked in since ${timeOfDay(existing.clockInAt)}.`;
      }
      const shift = await clockIn(crewMemberId, SOURCE);
      return `Clocked in at ${timeOfDay(shift.clockInAt)}. Have a good one, ${displayName}.`;
    }

    case 'clock_out': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'You are not clocked in.';
      // clockOut auto-closes an open break and an open job segment, so say so
      // rather than letting them wonder whether they left something running.
      const hadBreak = await getOpenBreak(shift.id);
      const hadSegment = await getOpenSegment(shift.id);
      const closed = await clockOut(shift.id, crewMemberId, SOURCE);
      const extras: string[] = [];
      if (hadBreak) extras.push('your break was closed');
      if (hadSegment) extras.push('your open job was closed and flagged for the office');
      const tail = extras.length ? ` (${extras.join(', ')})` : '';
      return `Clocked out at ${timeOfDay(closed.clockOutAt ?? new Date().toISOString())}${tail}.`;
    }

    case 'break_start': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'Clock in first, then start your break.';
      const running = await getOpenBreak(shift.id);
      if (running) return `Already on break since ${timeOfDay(running.startedAt)}.`;
      const brk = await startBreak(shift.id, crewMemberId, SOURCE);
      return `Break started at ${timeOfDay(brk.startedAt)}. Breaks are unpaid — send "back" when you return.`;
    }

    case 'break_end': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'You are not clocked in.';
      const running = await getOpenBreak(shift.id);
      if (!running) return 'You are not on a break.';
      const ended = await endBreak(running.id, crewMemberId, SOURCE);
      return `Back at ${timeOfDay(ended.endedAt ?? new Date().toISOString())}. Welcome back.`;
    }

    case 'arrive': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'Clock in first, then arrive at the job.';
      const onBreak = await getOpenBreak(shift.id);
      if (onBreak) return 'You are on a break. Send "back" first, then arrive.';
      const job = await findJobByNumber(command.jobNumber);
      if (!job) return `I cannot find job #${command.jobNumber}.`;
      const segment = await arriveAtJob(shift.id, crewMemberId, job.id, SOURCE);
      return `At job #${command.jobNumber} since ${timeOfDay(segment.arrivedAt)}.`;
    }

    case 'depart': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'You are not clocked in.';
      const open = await getOpenSegment(shift.id);
      if (!open) return 'You are not at a job right now.';
      await departFromJob(open.id, crewMemberId, command.reason, SOURCE);
      return `Left the job — recorded as ${command.reason.replace('_', ' ')}. Not marked finished.`;
    }

    case 'complete': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'You are not clocked in.';
      const open = await getOpenSegment(shift.id);
      if (!open) return 'You are not at a job right now.';

      // Time first, status second: if the status move fails the hours are still
      // recorded, which is the half that pays someone.
      await departFromJob(open.id, crewMemberId, 'completed', SOURCE);

      const job = await getJob(open.jobId);
      const label = job?.job_number ? `#${job.job_number}` : 'the job';
      if (!job) return `Finished ${label}. Time recorded; the office will update its status.`;
      if (job.status === 'installed') return `Finished ${label}. Already marked installed.`;
      if (!canTransition(job.status, 'installed')) {
        return `Finished ${label}. Time recorded; the office will update its status (currently ${job.status}).`;
      }
      const updated = await setJobStatus(job.id, 'installed');
      return updated
        ? `Finished ${label} — marked installed. Nice work.`
        : `Finished ${label}. Time recorded; the office will update its status.`;
    }

    case 'status': {
      const shift = await getOpenShift(crewMemberId);
      if (!shift) return 'Not clocked in.';
      const [brk, seg] = await Promise.all([getOpenBreak(shift.id), getOpenSegment(shift.id)]);
      const lines = [`Clocked in since ${timeOfDay(shift.clockInAt)}.`];
      if (brk) lines.push(`On break since ${timeOfDay(brk.startedAt)}.`);
      if (seg) {
        const job = await getJob(seg.jobId);
        const label = job?.job_number ? `#${job.job_number}` : 'a job';
        lines.push(`At job ${label} since ${timeOfDay(seg.arrivedAt)}.`);
      }
      if (!brk && !seg) lines.push('Not at a job right now.');
      return lines.join('\n');
    }

    // `help` is handled before identity resolution.
    default:
      return CREW_HELP_TEXT;
  }
}
