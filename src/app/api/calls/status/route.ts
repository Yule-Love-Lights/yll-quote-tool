// GET /api/calls/status — visibility into the calls-ingest pipeline
// (calls_merge_plan_2026-08.md slice S2): the last sync time, counts by
// status, and the most recent 50 recordings (with their outcome, once
// transcribed) for the /admin/calls page. Operator-only.
//
// S6 adds commitment status counts (open/cleared/done/dismissed/expired)
// and extraction progress (pending/extracted/quarantined, derived from
// call_transcripts' tracking columns). Both degrade to null rather than
// failing the whole response when call_commitments isn't migrated yet
// (S2's tables can be applied before S6's) -- the recordings section above
// already works without it, and the commitments section should not take it
// down.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isMissingTableError, isCallNotesSchemaUnavailable } from '@/lib/calls/errors';
import { isCommitmentsSchemaUnavailable } from '@/lib/commitments/errors';
import type { SupabaseClient } from '@supabase/supabase-js';

type CallRecordingRow = {
  id: string;
  ghl_contact_id: string | null;
  direction: string | null;
  called_at: string | null;
  duration_seconds: number | null;
  status: string;
  skip_reason: string | null;
  transcript_id: string | null;
  detail: { error?: string } | null;
  created_at: string;
};

const STATUS_KEYS = ['pending', 'processing', 'transcribed', 'skipped', 'failed'] as const;
const COMMITMENT_STATUS_KEYS = ['open', 'cleared', 'done', 'dismissed', 'expired'] as const;

type CommitmentSummary = {
  counts: Record<(typeof COMMITMENT_STATUS_KEYS)[number], number>;
  // pending stays the total (never-attempted + retrying) for backward
  // compatibility with anything already reading it; neverAttempted/
  // retrying split it so a stuck backlog (repeatedly failing with
  // 'transient_dependency_failed', which never counts toward the 3-strike
  // quarantine threshold -- see record_commitment_extraction_failure) is
  // visible as "retrying" instead of reading identically to fresh,
  // never-touched work (admin-lens LOW finding).
  extraction: { pending: number; neverAttempted: number; retrying: number; extracted: number; quarantined: number };
};

/**
 * Commitment status counts + extraction progress for the /admin/calls page
 * (S6). Returns null (not a thrown error) when call_commitments/the
 * extraction tracking columns aren't migrated yet -- this section degrades
 * independently of the call_recordings section above it.
 */
async function loadCommitmentSummary(supabase: SupabaseClient): Promise<CommitmentSummary | null> {
  const { data: commitmentRows, error: commitmentError } = await supabase
    .from('call_commitments')
    .select('status');
  if (commitmentError) {
    if (isCommitmentsSchemaUnavailable(commitmentError)) return null;
    throw commitmentError;
  }

  const counts = { open: 0, cleared: 0, done: 0, dismissed: 0, expired: 0 };
  for (const row of (commitmentRows ?? []) as { status: string }[]) {
    if ((COMMITMENT_STATUS_KEYS as readonly string[]).includes(row.status)) {
      counts[row.status as keyof typeof counts]++;
    }
  }

  const { data: transcriptRows, error: transcriptError } = await supabase
    .from('call_transcripts')
    .select('commitments_extracted_at, commitment_extraction_quarantined_at, commitment_extraction_attempts');
  if (transcriptError) {
    if (isCommitmentsSchemaUnavailable(transcriptError)) return null;
    throw transcriptError;
  }

  const extraction = { pending: 0, neverAttempted: 0, retrying: 0, extracted: 0, quarantined: 0 };
  for (const row of (transcriptRows ?? []) as {
    commitments_extracted_at: string | null;
    commitment_extraction_quarantined_at: string | null;
    commitment_extraction_attempts: number | null;
  }[]) {
    if (row.commitments_extracted_at) {
      extraction.extracted++;
    } else if (row.commitment_extraction_quarantined_at) {
      extraction.quarantined++;
    } else {
      extraction.pending++;
      if ((row.commitment_extraction_attempts ?? 0) > 0) extraction.retrying++;
      else extraction.neverAttempted++;
    }
  }

  return { counts, extraction };
}

type NoteSummary = {
  posted: number;
  pending: number;
  skipped: number;
  quarantined: number;
  lastPostedAt: string | null;
  lastFailureCode: string | null;
};

/**
 * Post-call HighLevel note progress for the /admin/calls page. Added because
 * the note phase writes its whole state onto call_transcripts and nothing
 * read it, so a batch that quietly stopped posting was invisible to staff:
 * this feature replaces a note reps wrote by hand every time, and an
 * automated replacement that can go dark without a signal is worse than the
 * manual one. Returns null (not a thrown error) when the note columns are
 * not migrated yet, so this section degrades on its own like the
 * commitments section above it.
 */
async function loadNoteSummary(supabase: SupabaseClient): Promise<NoteSummary | null> {
  const { data, error } = await supabase
    .from('call_transcripts')
    .select('ghl_note_posted_at, ghl_note_skip_reason, ghl_note_quarantined_at, ghl_note_last_failure_code');
  if (error) {
    if (isCallNotesSchemaUnavailable(error)) return null;
    throw error;
  }

  const summary: NoteSummary = {
    posted: 0, pending: 0, skipped: 0, quarantined: 0, lastPostedAt: null, lastFailureCode: null,
  };
  for (const row of (data ?? []) as {
    ghl_note_posted_at: string | null;
    ghl_note_skip_reason: string | null;
    ghl_note_quarantined_at: string | null;
    ghl_note_last_failure_code: string | null;
  }[]) {
    if (row.ghl_note_posted_at) {
      summary.posted++;
      if (!summary.lastPostedAt || row.ghl_note_posted_at > summary.lastPostedAt) {
        summary.lastPostedAt = row.ghl_note_posted_at;
      }
    } else if (row.ghl_note_quarantined_at) {
      summary.quarantined++;
    } else if (row.ghl_note_skip_reason) {
      summary.skipped++;
    } else {
      summary.pending++;
    }
    // The most recent failure reason wins; it is a hint for a human reading
    // the page, not a per-row report.
    if (row.ghl_note_last_failure_code) summary.lastFailureCode = row.ghl_note_last_failure_code;
  }

  return summary;
}

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ configured: false });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const { data: stateData, error: stateError } = await supabase
      .from('recording_sync_state')
      .select('last_synced_at')
      .eq('id', 1)
      .maybeSingle();
    if (stateError) throw stateError;

    const { data: statusRows, error: statusError } = await supabase.from('call_recordings').select('status');
    if (statusError) throw statusError;

    const counts = { pending: 0, processing: 0, transcribed: 0, skipped: 0, failed: 0 };
    for (const row of (statusRows ?? []) as { status: string }[]) {
      if ((STATUS_KEYS as readonly string[]).includes(row.status)) {
        counts[row.status as keyof typeof counts]++;
      }
    }

    const { data: recentData, error: recentError } = await supabase
      .from('call_recordings')
      .select('id, ghl_contact_id, direction, called_at, duration_seconds, status, skip_reason, transcript_id, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (recentError) throw recentError;
    const recentRows = (recentData ?? []) as CallRecordingRow[];

    const transcriptIds = recentRows.map(r => r.transcript_id).filter((id): id is string => !!id);
    let outcomeByTranscriptId = new Map<string, string>();
    if (transcriptIds.length > 0) {
      const { data: transcriptRows } = await supabase.from('call_transcripts').select('id, outcome').in('id', transcriptIds);
      outcomeByTranscriptId = new Map(
        ((transcriptRows ?? []) as { id: string; outcome: string }[]).map(t => [t.id, t.outcome]),
      );
    }

    const recordings = recentRows.map(row => ({
      id: row.id,
      ghlContactId: row.ghl_contact_id,
      direction: row.direction,
      calledAt: row.called_at,
      durationSeconds: row.duration_seconds,
      status: row.status,
      skipReason: row.skip_reason,
      transcriptId: row.transcript_id,
      lastError: row.status === 'failed' ? (row.detail?.error ?? null) : null,
      outcome: row.transcript_id ? (outcomeByTranscriptId.get(row.transcript_id) ?? null) : null,
      createdAt: row.created_at,
    }));

    const commitments = await loadCommitmentSummary(supabase);
    const notes = await loadNoteSummary(supabase);

    return NextResponse.json({
      configured: true,
      migrated: true,
      lastSyncedAt: (stateData as { last_synced_at: string | null } | null)?.last_synced_at ?? null,
      counts,
      recordings,
      commitments,
      notes,
    });
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ configured: true, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
    }
    console.error('List calls failed:', err);
    return NextResponse.json({ configured: true, error: 'Could not load calls.' }, { status: 500 });
  }
}
