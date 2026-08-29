'use client';

// Admin mass upload (Naldo, 2026-08-29): backfill camera-roll photos onto a
// worker's profile when the work happened before the tool existed. Every
// photo lands instantly ACCEPTED at the campaign's current rate. GPS and
// the taken date are read out of each file (EXIF) BEFORE compression,
// because re-encoding strips them; a photo without GPS still uploads, it
// just gets no map pin. Files upload one at a time and each reports its own
// result — a failed file is listed for a manual retry, never auto-retried
// (an auto-retry loop could double-pay a photo that actually landed).

import { useEffect, useRef, useState } from 'react';

import { PrimaryButton, SC, Sheet } from './ui';

type Campaign = { id: string; name: string; kind: 'yard_sign' | 'door_hanger' };

type FileResult = {
  name: string;
  status: 'waiting' | 'uploading' | 'done' | 'failed';
  hasGps: boolean;
  error?: string;
};

export default function BulkUploadSheet({
  workerId,
  workerName,
  open,
  onClose,
  onDone,
}: {
  workerId: string;
  workerName: string;
  open: boolean;
  onClose: () => void;
  /** Called after a batch finishes with at least one success. */
  onDone: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState('');
  const [results, setResults] = useState<FileResult[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/advertising/campaigns');
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { campaigns: Campaign[] };
        if (!cancelled) setCampaigns(body.campaigns);
      } catch {
        /* the picker stays empty; upload still guards on a campaign */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const upload = async () => {
    const files = Array.from(fileRef.current?.files ?? []);
    if (!campaignId || files.length === 0 || busy) return;
    setBusy(true);
    setResults(files.map((f) => ({ name: f.name, status: 'waiting', hasGps: false })));

    const [{ default: exifr }, { downscaleForUploadAsBlob }] = await Promise.all([
      import('exifr'),
      import('@/lib/clientImage'),
    ]);

    const setAt = (i: number, patch: Partial<FileResult>) =>
      setResults((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      setAt(i, { status: 'uploading' });
      try {
        // EXIF first: compression re-encodes and strips it.
        let lat: number | null = null;
        let lng: number | null = null;
        let takenAt: string | null = null;
        try {
          const gps = await exifr.gps(file);
          if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
            lat = gps.latitude;
            lng = gps.longitude;
          }
          const meta = (await exifr.parse(file, ['DateTimeOriginal'])) as { DateTimeOriginal?: Date } | undefined;
          if (meta?.DateTimeOriginal instanceof Date && !Number.isNaN(meta.DateTimeOriginal.getTime())) {
            takenAt = meta.DateTimeOriginal.toISOString();
          }
        } catch {
          /* no EXIF is fine: upload without GPS or taken date */
        }

        const { blob } = await downscaleForUploadAsBlob(file);
        const fd = new FormData();
        fd.set('workerId', workerId);
        fd.set('campaignId', campaignId);
        if (lat !== null && lng !== null) {
          fd.set('lat', String(lat));
          fd.set('lng', String(lng));
        }
        if (takenAt) fd.set('capturedAt', takenAt);
        fd.set('photo', blob, 'backfill.jpg');

        const res = await fetch('/api/admin/advertising/placements/bulk', { method: 'POST', body: fd });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setAt(i, { status: 'failed', error: body.error ?? 'Upload failed.' });
        } else {
          setAt(i, { status: 'done', hasGps: lat !== null });
        }
      } catch {
        setAt(i, { status: 'failed', error: 'Could not read or send this file.' });
      }
    }
    setBusy(false);
    onDone();
  };

  const doneCount = results.filter((r) => r.status === 'done').length;
  const failCount = results.filter((r) => r.status === 'failed').length;
  const finished = results.length > 0 && !busy;

  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose(); }}>
      <div style={{ color: SC.text }}>
        <h2 className="text-xl font-bold">Upload photos for {workerName}</h2>
        <p className="mt-1 text-sm" style={{ color: SC.muted }}>
          Every photo lands accepted and pays the campaign rate right away. Location and the taken
          date are read from each photo when the file has them.
        </p>

        <label className="mt-4 block text-sm" style={{ color: SC.muted }}>
          Campaign
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-xl border bg-white px-4 py-3 text-lg"
            style={{ borderColor: '#DCD4BE', color: SC.text }}
          >
            <option value="">Pick a campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          disabled={busy}
          className="mt-3 w-full text-sm"
          onChange={() => setResults([])}
        />

        {results.length > 0 && (
          <div className="mt-4 max-h-56 overflow-y-auto rounded-xl border p-2 text-sm" style={{ borderColor: '#DCD4BE' }}>
            {results.map((r, i) => (
              <div key={`${r.name}-${i}`} className="flex items-center justify-between gap-2 py-1">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span style={{ color: r.status === 'failed' ? SC.danger : SC.muted }}>
                  {r.status === 'waiting' && 'waiting'}
                  {r.status === 'uploading' && 'uploading…'}
                  {r.status === 'done' && (r.hasGps ? 'done, on the map' : 'done, no location in file')}
                  {r.status === 'failed' && (r.error ?? 'failed')}
                </span>
              </div>
            ))}
          </div>
        )}

        {finished && (
          <p className="mt-3 text-sm" style={{ color: failCount > 0 ? SC.danger : SC.ok }}>
            {doneCount} uploaded and accepted{failCount > 0 ? `, ${failCount} failed (fix and re-pick just those files)` : '.'}
          </p>
        )}

        <div className="mt-5">
          <PrimaryButton disabled={busy || !campaignId} onClick={() => void upload()}>
            {busy ? `Uploading ${results.filter((r) => r.status !== 'waiting').length}/${results.length}…` : 'Upload and accept'}
          </PrimaryButton>
        </div>
      </div>
    </Sheet>
  );
}
