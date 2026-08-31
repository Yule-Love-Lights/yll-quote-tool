'use client';

// The calls-ingest pipeline view (calls_merge_plan_2026-08.md slice S2):
// last-sync time, counts by status, the last 50 recordings with status/
// skip_reason/outcome, and a "Process next batch" button. Talks to
// GET /api/calls/status and POST /api/calls/process. Style follows this
// repo's other admin debug surfaces (GeocodeFixRow's card/button classes)
// rather than the copilot's zinc/amber palette.
//
// S6 adds an "Extract commitments" button (POST /api/calls/extract) plus
// the commitment status counts + extraction progress GET /api/calls/status
// now returns. The section renders nothing (not an error banner) when
// `commitments` comes back null -- that means call_commitments isn't
// migrated yet, which is a normal, expected state before Naldo applies it,
// same posture as the top-level "not migrated" banner below.

import { useCallback, useEffect, useState } from 'react';

type Recording = {
  id: string;
  ghlContactId: string | null;
  direction: string | null;
  calledAt: string | null;
  durationSeconds: number | null;
  status: 'pending' | 'processing' | 'transcribed' | 'skipped' | 'failed';
  skipReason: string | null;
  transcriptId: string | null;
  lastError: string | null;
  outcome: string | null;
  createdAt: string;
};

type Counts = { pending: number; processing: number; transcribed: number; skipped: number; failed: number };

type CommitmentCounts = { open: number; cleared: number; done: number; dismissed: number; expired: number };
type ExtractionProgress = {
  pending: number;
  neverAttempted: number;
  retrying: number;
  extracted: number;
  quarantined: number;
};
type CommitmentSummary = { counts: CommitmentCounts; extraction: ExtractionProgress } | null;

// Post-call HighLevel note progress. Null means the note columns are not
// migrated yet, in which case the section renders nothing at all rather
// than an error, same posture as the commitments section.
type NoteSummary = {
  posted: number;
  pending: number;
  skipped: number;
  quarantined: number;
  untraceable: number;
  commented: number;
  lastPostedAt: string | null;
  lastFailureCode: string | null;
} | null;

type CallsResponse = {
  configured: boolean;
  migrated?: boolean;
  reason?: string;
  error?: string;
  lastSyncedAt?: string | null;
  counts?: Counts;
  recordings?: Recording[];
  commitments?: CommitmentSummary;
  notes?: NoteSummary;
};

type ExtractResponse = {
  configured: boolean;
  migrated?: boolean;
  reason?: string;
  error?: string;
  done?: number;
  skipped?: number;
  failed?: number;
  refused?: number;
  quarantined?: number;
  tasksCreated?: number;
};

const bannerClass = 'rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900';
const errorBannerClass = 'rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700';

function statusColor(status: Recording['status']): string {
  if (status === 'transcribed') return 'var(--brand-evergreen-3)';
  if (status === 'failed') return '#b91c1c';
  if (status === 'processing') return '#1d4ed8';
  if (status === 'skipped') return '#6b7280';
  return '#b45309'; // pending
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 flex flex-col gap-1">
      <span className="text-xs font-medium uppercase text-gray-500">{label}</span>
      <span className="text-2xl font-semibold text-gray-900">{value}</span>
    </div>
  );
}

export function CallsView() {
  const [data, setData] = useState<CallsResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');
  const [processing, setProcessing] = useState(false);
  const [processMessage, setProcessMessage] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractMessage, setExtractMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch('/api/calls/status')
      .then(res => res.json())
      .then((json: CallsResponse) => {
        setData(json);
        setStatus('done');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onProcessBatch() {
    setProcessing(true);
    setProcessMessage(null);
    try {
      const res = await fetch('/api/calls/process', { method: 'POST' });
      const json = await res.json();
      if (json.error) {
        setProcessMessage(json.error);
        return;
      }
      if (json.migrated === false || json.configured === false) {
        setProcessMessage(json.reason ?? 'Could not process the batch.');
        return;
      }
      setProcessMessage(`Processed ${json.done} transcribed, ${json.skipped} skipped, ${json.failed} failed.`);
      await load();
    } catch {
      setProcessMessage('Could not process the batch.');
    } finally {
      setProcessing(false);
    }
  }

  async function onExtractCommitments() {
    setExtracting(true);
    setExtractMessage(null);
    try {
      const res = await fetch('/api/calls/extract', { method: 'POST' });
      const json = (await res.json()) as ExtractResponse;
      if (json.error) {
        setExtractMessage(json.error);
        return;
      }
      if (json.migrated === false || json.configured === false) {
        setExtractMessage(json.reason ?? 'Could not extract commitments.');
        return;
      }
      setExtractMessage(
        `Extracted ${json.done} done, ${json.skipped} skipped, ${json.failed} failed, ${json.refused} refused, ${json.quarantined} quarantined -- ${json.tasksCreated} task(s) created.`,
      );
      await load();
    } catch {
      setExtractMessage('Could not extract commitments.');
    } finally {
      setExtracting(false);
    }
  }

  if (status === 'loading') return <p className="text-sm text-gray-500">Loading…</p>;
  if (status === 'error') return <div className={errorBannerClass}>Could not load calls.</div>;

  if (!data?.migrated) {
    return <div className={bannerClass}>{data?.reason ?? 'Run migrations/2026-08-29-call-ingest.sql first.'}</div>;
  }
  if (data.error) {
    return <div className={errorBannerClass}>{data.error}</div>;
  }

  const counts = data.counts ?? { pending: 0, processing: 0, transcribed: 0, skipped: 0, failed: 0 };
  const recordings = data.recordings ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onProcessBatch}
          disabled={processing}
          className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          style={{ background: 'var(--brand-evergreen-3)' }}
        >
          {processing ? 'Processing…' : 'Process next batch'}
        </button>
        <span className="text-sm text-gray-500">
          {data.lastSyncedAt ? `Last synced ${new Date(data.lastSyncedAt).toLocaleString()}` : 'Never synced yet'}
        </span>
        {processMessage && <span className="text-sm text-gray-500">{processMessage}</span>}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Pending" value={counts.pending} />
        <StatTile label="Processing" value={counts.processing} />
        <StatTile label="Transcribed" value={counts.transcribed} />
        <StatTile label="Skipped" value={counts.skipped} />
        <StatTile label="Failed" value={counts.failed} />
      </div>

      {data.commitments && (
        <div className="flex flex-col gap-3 border-t border-gray-200 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onExtractCommitments}
              disabled={extracting}
              className="rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--brand-evergreen-3)' }}
            >
              {extracting ? 'Extracting…' : 'Extract commitments'}
            </button>
            {extractMessage && <span className="text-sm text-gray-500">{extractMessage}</span>}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatTile label="Open" value={data.commitments.counts.open} />
            <StatTile label="Cleared" value={data.commitments.counts.cleared} />
            <StatTile label="Done" value={data.commitments.counts.done} />
            <StatTile label="Dismissed" value={data.commitments.counts.dismissed} />
            <StatTile label="Expired" value={data.commitments.counts.expired} />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:max-w-2xl">
            <StatTile label="Never attempted" value={data.commitments.extraction.neverAttempted} />
            <StatTile label="Retrying" value={data.commitments.extraction.retrying} />
            <StatTile label="Extracted" value={data.commitments.extraction.extracted} />
            <StatTile label="Quarantined" value={data.commitments.extraction.quarantined} />
          </div>
        </div>
      )}

      {data.notes && (
        <div className="flex flex-col gap-3 border-t border-gray-200 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-700">HighLevel call notes</h2>
            <span className="text-sm text-gray-500">
              {data.notes.lastPostedAt
                ? `Last note posted ${new Date(data.notes.lastPostedAt).toLocaleString()}`
                : 'No note posted yet'}
            </span>
            {data.notes.lastFailureCode && (
              <span className="text-sm text-red-600">Last failure: {data.notes.lastFailureCode}</span>
            )}
            {data.notes.untraceable > 0 && (
              <span className="text-sm text-red-600">
                {data.notes.untraceable} posted with no HighLevel id, so they cannot be found again automatically
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:max-w-2xl">
            <StatTile label="Notes posted" value={data.notes.posted} />
            <StatTile label="Awaiting a note" value={data.notes.pending} />
            <StatTile label="Skipped" value={data.notes.skipped} />
            <StatTile label="Quarantined" value={data.notes.quarantined} />
            <StatTile label="Untraceable" value={data.notes.untraceable} />
            <StatTile label="Comments posted" value={data.notes.commented} />
          </div>
          {/* The comment feature (2026-08-30) has no backfill: every note posted
              before it shipped will show as "not commented" forever, correctly.
              Named here so this number never has to be read as a live failure
              rate without that context. */}
          <p className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
            Comments posted will always trail Notes posted: notes from before this feature shipped never get one.
            Watch for it falling behind going forward, not for it matching the total.
          </p>
        </div>
      )}

      {recordings.length === 0 ? (
        <p className="text-sm text-gray-500">No recordings synced yet.</p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
          {recordings.map(r => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold" style={{ color: statusColor(r.status) }}>
                    {r.status}
                  </span>
                  {r.outcome && r.outcome !== 'unknown' && (
                    <span className="rounded-full border border-gray-300 px-2 py-0.5 text-xs text-gray-600">
                      {r.outcome}
                    </span>
                  )}
                  {r.skipReason && <span className="text-xs text-gray-400">({r.skipReason})</span>}
                  {r.lastError && <span className="text-xs text-red-500">({r.lastError})</span>}
                </div>
                <span className="text-xs text-gray-400">
                  {r.calledAt ? new Date(r.calledAt).toLocaleString() : 'no call time'} · {formatDuration(r.durationSeconds)}
                  {r.direction ? ` · ${r.direction}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
