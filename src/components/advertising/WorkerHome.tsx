'use client';

// Advertising worker home — mobile-first capture + earnings + my placements.
// Money display rule: earned = the STAMPED rates on accepted yard signs;
// pending = an ESTIMATE at each campaign's current rate. Door hangers are
// recorded but never priced (Naldo's ruling — pay excluded until he approves
// a rule), and the UI says so instead of showing $0.00 mysteriously.

import { useCallback, useEffect, useRef, useState } from 'react';

import { downscaleForUploadAsBlob, MULTIPART_SIZE_LIMIT_BYTES } from '@/lib/clientImage';

type Campaign = { id: string; name: string; rateCents: number };

type Placement = {
  id: string;
  kind: 'yard_sign' | 'door_hanger';
  status: 'pending' | 'accepted' | 'rejected' | 'resubmitted';
  suggestedAddress: string | null;
  rejectionReason: string | null;
  acceptedRateCents: number | null;
  capturedAt: string | null;
  createdAt: string;
  photoUrl: string | null;
};

type Earnings = {
  total: { pendingEstimatedCents: number; acceptedEarnedCents: number };
  byWeek: Array<{ weekStart: string; pendingEstimatedCents: number; acceptedEarnedCents: number }>;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<Placement['status'], { text: string; cls: string }> = {
  pending: { text: 'Pending review', cls: 'bg-white/10 text-[#C9D3CB]' },
  resubmitted: { text: 'Resubmitted', cls: 'bg-white/10 text-[#C9D3CB]' },
  accepted: { text: 'Accepted', cls: 'bg-[#2E4A38] text-[#9FD3AE]' },
  rejected: { text: 'Rejected', cls: 'bg-[#4A2E2E] text-[#E5736F]' },
};

export default function WorkerHome() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [campaignId, setCampaignId] = useState('');
  const [kind, setKind] = useState<'yard_sign' | 'door_hanger'>('yard_sign');
  const [photo, setPhoto] = useState<File | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM: number | null } | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitOk, setSubmitOk] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Reload by bumping the tick — the effect owns every setState (the
  // ClockCard load-on-mount idiom, which the react lint rule accepts).
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cRes, pRes, eRes] = await Promise.all([
          fetch('/api/advertising/campaigns'),
          fetch('/api/advertising/placements'),
          fetch('/api/advertising/earnings'),
        ]);
        if (cancelled) return;
        if (!cRes.ok || !pRes.ok || !eRes.ok) {
          setLoadError(
            cRes.status === 401 || pRes.status === 401
              ? 'Your session expired. Reload this page to sign in again.'
              : 'Could not load your data. Pull to refresh or try again.',
          );
          return;
        }
        const c = (await cRes.json()) as { campaigns: Campaign[] };
        const p = (await pRes.json()) as { placements: Placement[] };
        const e = (await eRes.json()) as { summary: Earnings };
        if (cancelled) return;
        setCampaigns(c.campaigns);
        setPlacements(p.placements);
        setEarnings(e.summary);
        setLoadError(null);
        setCampaignId((prev) => prev || c.campaigns[0]?.id || '');
      } catch {
        if (!cancelled) setLoadError('Could not load your data. Check your connection and try again.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const captureLocation = () => {
    setGpsError(null);
    if (!navigator.geolocation) {
      setGpsError('This phone does not report location. Ask the office for help.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        });
        setLocating(false);
      },
      () => {
        setGpsError('No GPS fix. Allow location access for this site and try again.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSubmitOk(null);
    if (!photo) {
      setSubmitError('Take a photo of the sign in place first.');
      return;
    }
    if (!gps) {
      setSubmitError('Tap "Use my location" so we know where the sign stands.');
      return;
    }
    setSubmitting(true);
    try {
      // Downscale on the phone before uploading (the #186 pattern every other
      // photo path here uses): a raw camera photo is often 4-8MB and would
      // 413 at Vercel's ~4.5MB body cap before our route could even answer.
      const { blob, mediaType } = await downscaleForUploadAsBlob(photo);
      if (blob.size > MULTIPART_SIZE_LIMIT_BYTES) {
        setSubmitError('That photo is too large even after compression. Retake it at a smaller size.');
        return;
      }
      const fd = new FormData();
      fd.set('campaignId', campaignId);
      fd.set('kind', kind);
      fd.set('lat', String(gps.lat));
      fd.set('lng', String(gps.lng));
      if (gps.accuracyM !== null) fd.set('accuracyM', String(gps.accuracyM));
      fd.set('capturedAt', new Date().toISOString());
      fd.set('photo', blob, mediaType === 'image/png' ? 'proof.png' : 'proof.jpg');
      const res = await fetch('/api/advertising/placements', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSubmitError(body.error ?? 'Could not submit. Try again.');
        return;
      }
      setSubmitOk(kind === 'yard_sign' ? 'Sign submitted for review.' : 'Door hangers submitted for review.');
      setPhoto(null);
      setGps(null);
      if (photoInputRef.current) photoInputRef.current.value = '';
      reload();
    } catch {
      setSubmitError('Could not submit. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const [resubmitting, setResubmitting] = useState<string | null>(null);
  const [resubmitError, setResubmitError] = useState<{ id: string; message: string } | null>(null);

  const resubmit = async (id: string) => {
    setResubmitting(id);
    setResubmitError(null);
    try {
      const res = await fetch(`/api/advertising/placements/${id}/resubmit`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResubmitError({ id, message: body.error ?? 'Could not resubmit. Check your connection and try again.' });
        return;
      }
      reload();
    } catch {
      setResubmitError({ id, message: 'Could not resubmit. Check your connection and try again.' });
    } finally {
      setResubmitting(null);
    }
  };

  const selectedRate = campaigns.find((c) => c.id === campaignId)?.rateCents ?? null;

  return (
    <main className="mx-auto flex min-h-[100svh] w-full max-w-lg flex-col gap-6 bg-[#0B140F] px-4 py-6 text-[#F4EFE6]">
      <header>
        <h1 className="text-xl font-semibold">Yard signs</h1>
        <p className="text-sm text-[#C9D3CB]">Place it, photograph it, submit it. Pay lands when the office accepts it.</p>
      </header>

      {loadError && <p className="rounded-lg bg-[#4A2E2E] px-4 py-3 text-sm text-[#E5736F]">{loadError}</p>}

      {earnings && (
        <section className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-[#C9D3CB]">Earned (accepted)</p>
            <p className="text-2xl font-semibold">{dollars(earnings.total.acceptedEarnedCents)}</p>
          </div>
          <div className="rounded-xl bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-[#C9D3CB]">Pending (estimate)</p>
            <p className="text-2xl font-semibold">{dollars(earnings.total.pendingEstimatedCents)}</p>
          </div>
          {earnings.byWeek.length > 0 && (
            <div className="col-span-2 rounded-xl bg-white/5 p-4">
              <p className="mb-2 text-xs uppercase tracking-wide text-[#C9D3CB]">By week</p>
              <ul className="flex flex-col gap-1 text-sm">
                {earnings.byWeek.slice(-4).map((w) => (
                  <li key={w.weekStart} className="flex justify-between">
                    <span className="text-[#C9D3CB]">Week of {w.weekStart}</span>
                    <span>
                      {dollars(w.acceptedEarnedCents)}
                      {w.pendingEstimatedCents > 0 && (
                        <span className="text-[#C9D3CB]"> (+{dollars(w.pendingEstimatedCents)} pending)</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl bg-white/5 p-4">
        <h2 className="font-semibold">Submit a placement</h2>

        <label className="text-sm text-[#C9D3CB]" htmlFor="campaign">Campaign</label>
        <select
          id="campaign"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          className="min-h-[48px] rounded-lg border border-white/15 bg-[#0B140F] px-3 text-base"
          required
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind('yard_sign')}
            className={`min-h-[44px] flex-1 rounded-full border px-3 text-sm font-medium ${kind === 'yard_sign' ? 'border-[#E8B862] bg-[#E8B862] text-[#0B140F]' : 'border-white/15 text-[#C9D3CB]'}`}
          >
            Yard sign
          </button>
          <button
            type="button"
            onClick={() => setKind('door_hanger')}
            className={`min-h-[44px] flex-1 rounded-full border px-3 text-sm font-medium ${kind === 'door_hanger' ? 'border-[#E8B862] bg-[#E8B862] text-[#0B140F]' : 'border-white/15 text-[#C9D3CB]'}`}
          >
            Door hangers
          </button>
        </div>
        {selectedRate !== null && (
          <p className="text-sm text-[#C9D3CB]">
            This campaign pays {dollars(selectedRate)} per accepted photo.
          </p>
        )}

        <label className="text-sm text-[#C9D3CB]" htmlFor="photo">Proof photo</label>
        <input
          id="photo"
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          className="text-sm"
          required
        />

        <button
          type="button"
          onClick={captureLocation}
          disabled={locating}
          className="min-h-[48px] rounded-lg border border-white/15 px-4 text-sm font-medium text-[#C9D3CB] disabled:opacity-60"
        >
          {locating ? 'Getting location…' : gps ? `Location captured (±${Math.round(gps.accuracyM ?? 0)}m). Tap to refresh` : 'Use my location'}
        </button>
        {gpsError && <p className="text-sm text-[#E5736F]">{gpsError}</p>}

        {submitError && <p className="text-sm text-[#E5736F]">{submitError}</p>}
        {submitOk && <p className="text-sm text-[#9FD3AE]">{submitOk}</p>}

        <button
          type="submit"
          disabled={submitting || campaigns.length === 0}
          className="min-h-[48px] rounded-full bg-[#E8B862] px-6 font-semibold text-[#0B140F] disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Submit for review'}
        </button>
        {campaigns.length === 0 && !loadError && (
          <p className="text-sm text-[#C9D3CB]">No open campaign right now. Check with the office.</p>
        )}
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">My placements</h2>
        {placements.length === 0 && <p className="text-sm text-[#C9D3CB]">Nothing submitted yet.</p>}
        {placements.map((p) => (
          <div key={p.id} className="flex gap-3 rounded-xl bg-white/5 p-3">
            {p.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, remote loader not configured for this bucket
              <img src={p.photoUrl} alt="Proof" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
            ) : (
              <div className="h-16 w-16 shrink-0 rounded-lg bg-white/10" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_LABEL[p.status].cls}`}>
                  {STATUS_LABEL[p.status].text}
                </span>
                <span className="text-xs text-[#C9D3CB]">
                  {p.kind === 'yard_sign' ? 'Yard sign' : 'Door hangers'}
                </span>
              </div>
              <p className="truncate text-sm">{p.suggestedAddress ?? 'Location recorded'}</p>
              {p.status === 'accepted' && p.acceptedRateCents !== null && (
                <p className="text-sm text-[#9FD3AE]">{dollars(p.acceptedRateCents)} earned</p>
              )}
              {p.status === 'rejected' && (
                <>
                  {p.rejectionReason && <p className="text-sm text-[#E5736F]">{p.rejectionReason}</p>}
                  <button
                    type="button"
                    disabled={resubmitting === p.id}
                    onClick={() => void resubmit(p.id)}
                    className="self-start rounded-full border border-white/15 px-3 py-1 text-xs text-[#C9D3CB] disabled:opacity-60"
                  >
                    {resubmitting === p.id ? 'Sending…' : 'Ask for another look'}
                  </button>
                  {resubmitError?.id === p.id && (
                    <p className="text-xs text-[#E5736F]">{resubmitError.message}</p>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </section>
    </main>
  );
}
