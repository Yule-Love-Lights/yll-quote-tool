import { getSupabaseServiceClient } from '@/lib/supabase';
import type { ShiftSource } from '@/lib/shifts';
import { breakSpansForShift } from '@/lib/shiftBreaks';
import {
  ceilSeconds,
  clipAndMerge,
  envelopeMs,
  floorSeconds,
  parseMs,
  resolveNowMs,
  subtractSpans,
  totalMs,
  type OpenInterval,
  type Span,
} from '@/lib/timeSpans';

/**
 * Per-job time on the shift clock (Operations Hub Flow B).
 *
 * Arrive opens a segment, depart closes it. At most one open segment per shift,
 * enforced by the DB.
 *
 * WHY THIS IS MONEY CODE: job seconds divided into the job's `budgeted_hours`
 * is the efficiency figure the P4P pool pays on. Crediting a job with time
 * nobody spent on it inflates efficiency and overpays; losing time understates
 * it and underpays.
 *
 * THE RULE THAT MATTERS MOST: breaks PAUSE job time (contract section 4 —
 * "Break pauses job time and route collection; break end resumes the day, not
 * the job"). So job seconds are the segment spans MINUS overlapping break
 * spans. A crew member who arrives at 9:00, takes lunch 12:00-12:30, and
 * departs at 17:00 worked 7.5 hours on that job, not 8.
 */

export type EntryKind = 'install' | 'rework' | 'non_billable';

export type StoppageReason = 'completed' | 'weather' | 'no_access' | 'materials' | 'other';

export const STOPPAGE_REASONS: readonly StoppageReason[] = [
  'completed',
  'weather',
  'no_access',
  'materials',
  'other',
] as const;

export type JobSegment = {
  id: string;
  shiftId: string;
  crewMemberId: string;
  jobId: string;
  arrivedAt: string;
  departedAt: string | null;
  entryKind: EntryKind;
  stoppageReason: StoppageReason | null;
  source: ShiftSource;
  endSource: ShiftSource | null;
  /** True when a clock-out closed this rather than the crew member. Feeds the `open_segment` queue. */
  autoClosed: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  deviceTime: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  shift_id: string;
  crew_member_id: string;
  job_id: string;
  arrived_at: string;
  departed_at: string | null;
  entry_kind: EntryKind;
  stoppage_reason: StoppageReason | null;
  source: ShiftSource;
  end_source: ShiftSource | null;
  auto_closed: boolean;
  approved_by: string | null;
  approved_at: string | null;
  device_time: string | null;
  created_at: string;
  updated_at: string;
};

type ShiftGuardRow = {
  id: string;
  crew_member_id: string;
  clock_out_at: string | null;
};

const SELECT =
  'id, shift_id, crew_member_id, job_id, arrived_at, departed_at, entry_kind, stoppage_reason, ' +
  'source, end_source, auto_closed, approved_by, approved_at, device_time, created_at, updated_at';

type Db = NonNullable<ReturnType<typeof getSupabaseServiceClient>>;

function toSegment(row: Row): JobSegment {
  return {
    id: row.id,
    shiftId: row.shift_id,
    crewMemberId: row.crew_member_id,
    jobId: row.job_id,
    arrivedAt: row.arrived_at,
    departedAt: row.departed_at,
    entryKind: row.entry_kind,
    stoppageReason: row.stoppage_reason,
    source: row.source,
    endSource: row.end_source,
    autoClosed: row.auto_closed,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    deviceTime: row.device_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isOpenSegmentUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return (
    error?.code === '23505' && error.message?.includes('job_segments_one_open_per_shift') === true
  );
}

// ---------------------------------------------------------------------------
// Money math. Pure, no database.
// ---------------------------------------------------------------------------

type ShiftEnvelope = { clockInAt: string; clockOutAt: string | null };
type SegmentInterval = { jobId: string; arrivedAt: string; departedAt: string | null; entryKind?: EntryKind };
type BreakIntervalIn = { startedAt: string; endedAt: string | null };

function segmentInterval(s: SegmentInterval): OpenInterval {
  return { start: s.arrivedAt, end: s.departedAt };
}

function shiftInterval(shift: ShiftEnvelope): OpenInterval {
  return { start: shift.clockInAt, end: shift.clockOutAt };
}

/**
 * Segment spans clipped to the shift and merged, with break time removed.
 *
 * Merging first matters: two office corrections covering the same hour would
 * otherwise count that hour twice and overstate the job's actual hours, which
 * makes the crew look SLOWER than they were and cuts the efficiency they are
 * paid on.
 */
function workedSpans(
  shift: ShiftEnvelope,
  segments: ReadonlyArray<SegmentInterval>,
  breaks: ReadonlyArray<BreakIntervalIn>,
  nowMs: number,
): Span[] {
  const envelope = envelopeMs(shiftInterval(shift), nowMs);
  if (!envelope) return [];
  const merged = clipAndMerge(envelope, segments.map(segmentInterval), nowMs);
  return subtractSpans(merged, breakSpansForShift(shift, breaks, nowMs));
}

/** Total job seconds across every segment in the shift, breaks removed. */
export function jobSecondsForShift(
  shift: ShiftEnvelope,
  segments: ReadonlyArray<SegmentInterval>,
  breaks: ReadonlyArray<BreakIntervalIn>,
  nowIso?: string,
): number {
  const nowMs = resolveNowMs(nowIso);
  return floorSeconds(totalMs(workedSpans(shift, segments, breaks, nowMs)));
}

/**
 * Job seconds broken out per job id, breaks removed.
 *
 * Each job's spans are merged and break-subtracted independently, so a job
 * cannot be credited with another job's time. The per-job totals sum to at most
 * `jobSecondsForShift` — less when two segments for DIFFERENT jobs overlap,
 * which is a data error the exception queue should surface rather than
 * something this function should silently resolve.
 */
export function jobSecondsByJob(
  shift: ShiftEnvelope,
  segments: ReadonlyArray<SegmentInterval>,
  breaks: ReadonlyArray<BreakIntervalIn>,
  nowIso?: string,
): Record<string, number> {
  const nowMs = resolveNowMs(nowIso);
  const envelope = envelopeMs(shiftInterval(shift), nowMs);
  if (!envelope) return {};

  const breakSpans = breakSpansForShift(shift, breaks, nowMs);
  const byJob: Record<string, number> = {};

  for (const jobId of new Set(segments.map((s) => s.jobId))) {
    const mine = segments.filter((s) => s.jobId === jobId);
    const merged = clipAndMerge(envelope, mine.map(segmentInterval), nowMs);
    byJob[jobId] = floorSeconds(totalMs(subtractSpans(merged, breakSpans)));
  }
  return byJob;
}

/**
 * Travel seconds: paid day time that is neither job time nor break time.
 *
 * The contract's single-source rule — travel is the RESIDUAL, counted once, and
 * never also paid as a per-job BH travel allowance. Deriving it rather than
 * storing it is what makes double-counting impossible.
 *
 * `non_billable` segments are job segments for this purpose: they are accounted
 * time, so they are not travel.
 */
export function travelSecondsForShift(
  shift: ShiftEnvelope,
  segments: ReadonlyArray<SegmentInterval>,
  breaks: ReadonlyArray<BreakIntervalIn>,
  nowIso?: string,
): number {
  const nowMs = resolveNowMs(nowIso);
  const envelope = envelopeMs(shiftInterval(shift), nowMs);
  if (!envelope) return 0;

  const paidMs = envelope.end - envelope.start;
  const breakMs = totalMs(breakSpansForShift(shift, breaks, nowMs));
  const jobMs = totalMs(workedSpans(shift, segments, breaks, nowMs));

  // Envelope rounds up, everything subtracted rounds down, so travel can never
  // be negative and the four parts never over-account for the day.
  return Math.max(0, ceilSeconds(paidMs) - floorSeconds(breakMs) - floorSeconds(jobMs));
}

/**
 * The missed-tap backstop (contract section 4, v1.1.0).
 *
 * With manual punches sole-authoritative for pay, a forgotten Depart is the one
 * un-backstopped corruption path: the segment keeps accruing job time against a
 * job nobody is standing at. This flags any OPEN segment whose arrival is
 * further back than `idleGapSeconds` so the bot can nudge same-day.
 *
 * Detection only. It deliberately does NOT close anything: an automatic close
 * would invent a departure time and manual punches are authoritative (F3).
 */
export function staleOpenSegments<T extends { arrivedAt: string; departedAt: string | null }>(
  segments: ReadonlyArray<T>,
  idleGapSeconds: number,
  nowIso?: string,
): T[] {
  const nowMs = resolveNowMs(nowIso);
  const cutoff = nowMs - idleGapSeconds * 1000;

  return segments.filter((s) => {
    if (s.departedAt !== null) return false;
    const started = parseMs(s.arrivedAt);
    // An unparseable arrival is itself a data problem worth surfacing.
    if (started === null) return true;
    return started < cutoff;
  });
}

// ---------------------------------------------------------------------------
// Ledger reads and writes.
// ---------------------------------------------------------------------------

async function getOpenSegmentRow(db: Db, shiftId: string): Promise<Row | null> {
  const { data, error } = await db
    .from('job_segments')
    .select(SELECT)
    .eq('shift_id', shiftId)
    .is('departed_at', null)
    .maybeSingle();
  if (error) throw new Error(`getOpenSegment: ${error.message}`);
  return (data as unknown as Row | null) ?? null;
}

async function getSegmentRowById(db: Db, segmentId: string): Promise<Row | null> {
  const { data, error } = await db
    .from('job_segments')
    .select(SELECT)
    .eq('id', segmentId)
    .maybeSingle();
  if (error) throw new Error(`departFromJob: ${error.message}`);
  return (data as unknown as Row | null) ?? null;
}

async function getShiftGuardRow(db: Db, shiftId: string): Promise<ShiftGuardRow | null> {
  const { data, error } = await db
    .from('shifts')
    .select('id, crew_member_id, clock_out_at')
    .eq('id', shiftId)
    .maybeSingle();
  if (error) throw new Error(`arriveAtJob: ${error.message}`);
  return (data as ShiftGuardRow | null) ?? null;
}

export async function getOpenSegment(shiftId: string): Promise<JobSegment | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  try {
    const row = await getOpenSegmentRow(db, shiftId.trim());
    return row ? toSegment(row) : null;
  } catch (error) {
    console.error('getOpenSegment error:', error);
    return null;
  }
}

export async function listSegments(shiftId: string): Promise<JobSegment[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  try {
    const { data, error } = await db
      .from('job_segments')
      .select(SELECT)
      .eq('shift_id', shiftId.trim())
      .order('arrived_at', { ascending: true });
    if (error) throw new Error(`listSegments: ${error.message}`);
    return ((data as unknown as Row[] | null) ?? []).map(toSegment);
  } catch (error) {
    console.error('listSegments error:', error);
    return [];
  }
}

/**
 * Open a job segment.
 *
 * KNOWN ACCEPTED GAP, same shape as `startBreak`'s: the shift-open check is a
 * plain SELECT, not a conditional write, so a segment inserted microseconds
 * after a concurrent `clockOut` can be orphaned open. Pay self-heals (an open
 * segment clips to the recorded clock-out), the damage is visibility, and the
 * fix is the `open_segment` exception-queue sweep tracked on the same ledger
 * row as the `open_break` one.
 */
export async function arriveAtJob(
  shiftId: string,
  crewMemberId: string,
  jobId: string,
  source: ShiftSource,
  entryKind: EntryKind = 'install',
): Promise<JobSegment> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const trimmedShiftId = shiftId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();
  const trimmedJobId = jobId.trim();

  const shift = await getShiftGuardRow(db, trimmedShiftId);
  if (!shift) throw new Error(`arriveAtJob: no shift found for id ${trimmedShiftId}`);
  if (shift.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(
      `arriveAtJob: shift ${trimmedShiftId} belongs to ${shift.crew_member_id}, not ${trimmedCrewMemberId}`,
    );
  }
  if (shift.clock_out_at) {
    throw new Error(`arriveAtJob: shift ${trimmedShiftId} is already closed`);
  }

  // A double-tap or a retry on bad signal returns the segment already running,
  // rather than opening a second or moving the first one's arrival time.
  const running = await getOpenSegmentRow(db, trimmedShiftId);
  if (running) {
    if (running.job_id !== trimmedJobId) {
      // Arriving at a DIFFERENT job without departing the last one is a real
      // state error, not a retry. Refusing keeps two jobs from both being
      // credited with the same minutes.
      throw new Error(
        `arriveAtJob: shift ${trimmedShiftId} is still on job ${running.job_id}; depart it before arriving at ${trimmedJobId}`,
      );
    }
    return toSegment(running);
  }

  const { data, error } = await db
    .from('job_segments')
    .insert({
      shift_id: trimmedShiftId,
      crew_member_id: trimmedCrewMemberId,
      job_id: trimmedJobId,
      source,
      entry_kind: entryKind,
    })
    .select(SELECT)
    .maybeSingle();

  if (error) {
    if (isOpenSegmentUniqueViolation(error as { code?: string; message?: string })) {
      const winner = await getOpenSegmentRow(db, trimmedShiftId);
      if (winner) return toSegment(winner);
    }
    throw new Error(`arriveAtJob: ${error.message}`);
  }
  if (!data) throw new Error(`arriveAtJob: no row returned for shift ${trimmedShiftId}`);
  return toSegment(data as unknown as Row);
}

/**
 * Close a job segment with the reason it stopped.
 *
 * `stoppageReason` is required rather than defaulted: it ships day one and
 * cannot be backfilled, and a defaulted `completed` would quietly mark a
 * rained-out job as finished and poison the budgeted-hours learning signal.
 */
export async function departFromJob(
  segmentId: string,
  crewMemberId: string,
  stoppageReason: StoppageReason,
  source: ShiftSource,
): Promise<JobSegment> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  if (!STOPPAGE_REASONS.includes(stoppageReason)) {
    throw new Error(`departFromJob: invalid stoppage reason ${stoppageReason}`);
  }

  const trimmedSegmentId = segmentId.trim();
  const trimmedCrewMemberId = crewMemberId.trim();

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('job_segments')
    .update({ departed_at: now, stoppage_reason: stoppageReason, end_source: source })
    .eq('id', trimmedSegmentId)
    .eq('crew_member_id', trimmedCrewMemberId)
    .is('departed_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`departFromJob: ${error.message}`);
  if (data) return toSegment(data as unknown as Row);

  const row = await getSegmentRowById(db, trimmedSegmentId);
  if (!row) throw new Error(`departFromJob: no segment found for id ${trimmedSegmentId}`);
  if (row.crew_member_id !== trimmedCrewMemberId) {
    throw new Error(
      `departFromJob: segment ${trimmedSegmentId} belongs to ${row.crew_member_id}, not ${trimmedCrewMemberId}`,
    );
  }
  if (row.departed_at) {
    throw new Error(`departFromJob: segment ${trimmedSegmentId} already departed`);
  }
  throw new Error(`departFromJob: segment ${trimmedSegmentId} could not be closed`);
}

/**
 * Close whatever segment is running on a shift, at the punch time.
 *
 * ⚠️ THIS FUNCTION DOES NOT CHECK OWNERSHIP, for the same reason and with the
 * same caveat as `closeOpenBreakForShift`: its only caller is `clockOut`, which
 * establishes ownership first via a `crew_member_id`-filtered UPDATE and calls
 * this only after that UPDATE returned a row. Any new caller MUST do the same.
 *
 * The stoppage reason is forced to `other`, never `completed` — a clock-out
 * says the day ended, not that the job finished, and recording it as finished
 * would corrupt the learning signal exactly the way the reason column exists to
 * prevent. `auto_closed` marks it for the `open_segment` review queue.
 */
export async function closeOpenSegmentForShift(
  shiftId: string,
  closedAt: string,
  source: ShiftSource,
): Promise<JobSegment | null> {
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('job_segments')
    .update({
      departed_at: closedAt,
      stoppage_reason: 'other',
      end_source: source,
      auto_closed: true,
    })
    .eq('shift_id', shiftId.trim())
    .is('departed_at', null)
    .select(SELECT)
    .maybeSingle();

  if (error) throw new Error(`closeOpenSegmentForShift: ${error.message}`);
  return data ? toSegment(data as unknown as Row) : null;
}
