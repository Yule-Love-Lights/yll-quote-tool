'use client';

// Campaign detail (Simple Crew replica): a full-bleed map behind a draggable
// sheet with Description | Photos tabs, day-grouped photo cards (author,
// timestamp + address, big photo, note), and its own bottom nav — Map,
// Capture, My photos. Admin mode adds what Simple Crew never had: the money
// actions (Accept pays the stamped rate, Reject asks why) and duplicate
// flags on each card.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { BackIcon, DotsIcon, CameraIcon, MapFoldIcon, PersonIcon, PinIcon } from './icons';
import PlacementMap from './PlacementMap';
import { dollars, SC } from './ui';
import { etDayKey } from '@/lib/dashboard/inbox/normalize';
import { splitDuplicateSignals } from '@/components/admin/advertising/duplicateSignals';

export type DetailPlacement = {
  id: string;
  workerId: string;
  workerName?: string;
  kind: 'yard_sign' | 'door_hanger';
  status: 'pending' | 'accepted' | 'rejected' | 'resubmitted';
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  createdAt: string;
  suggestedAddress: string | null;
  rejectionReason: string | null;
  workerNote: string | null;
  acceptedRateCents: number | null;
  voidedAt?: string | null;
  voidReason?: string | null;
  photoUrl: string | null;
  duplicates?: { id: string; status: string; workerName: string; reasons: string[] }[];
};

type Campaign = { id: string; name: string; kind: string; notes?: string | null; rateCents?: number };

const STATUS_CHIP: Record<DetailPlacement['status'], { text: string; bg: string; fg: string }> = {
  pending: { text: 'Pending', bg: '#F1EAD8', fg: '#3A423C' },
  resubmitted: { text: 'Resubmitted', bg: '#FDF3DF', fg: '#8a6d1f' },
  accepted: { text: 'Accepted', bg: '#E4F2E8', fg: '#2E7D4F' },
  rejected: { text: 'Rejected', bg: '#FBE7E7', fg: '#B3383F' },
};

export default function CampaignDetailScreen({
  mode,
  campaign,
  placementsUrl,
  backHref,
  captureHref,
  reviewUrl,
}: {
  mode: 'worker' | 'admin';
  campaign: Campaign;
  placementsUrl: string;
  backHref: string;
  captureHref: string;
  /** admin only: the review POST endpoint. */
  reviewUrl?: string;
}) {
  const [tab, setTab] = useState<'description' | 'photos'>('photos');
  const [view, setView] = useState<'map' | 'photos'>('map');
  const [placements, setPlacements] = useState<DetailPlacement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(placementsUrl);
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load photos.');
          return;
        }
        const body = (await res.json()) as { placements: DetailPlacement[] };
        if (cancelled) return;
        setPlacements(body.placements);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load photos.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [placementsUrl, tick]);

  const act = async (payload: Record<string, unknown>, id: string) => {
    if (!reviewUrl) return;
    setBusy(id);
    try {
      const res = await fetch(reviewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Action failed.');
      } else {
        setError(null);
        // Clear the draft only when the action LANDED — a transient failure
        // must not force the admin to retype the reason (staff lens MED).
        setRejecting((r) => (r === id ? null : r));
        setReasons((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      reload();
    } catch {
      setError('Action failed. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    const byDay = new Map<string, DetailPlacement[]>();
    for (const p of placements) {
      const day = etDayKey(new Date(p.capturedAt ?? p.createdAt));
      byDay.set(day, [...(byDay.get(day) ?? []), p]);
    }
    const todayKey = etDayKey(new Date());
    return [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, items]) => ({
        day,
        label: day === todayKey ? 'Today' : new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        items,
      }));
  }, [placements]);

  const markers = placements
    .filter((p) => p.lat !== null && p.lng !== null)
    .map((p) => ({
      id: p.id,
      lat: p.lat!,
      lng: p.lng!,
      status: p.status,
      label: p.suggestedAddress ?? undefined,
    }));

  const fmtStamp = (p: DetailPlacement) => {
    const when = new Date(p.capturedAt ?? p.createdAt);
    const stamp = when.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/New_York',
    });
    return p.suggestedAddress ? `${stamp}, ${p.suggestedAddress}` : stamp;
  };

  return (
    <div className="flex min-h-[100svh] flex-col" style={{ background: SC.bg }}>
      {/* map layer (map view) or spacer (photos view) */}
      {view === 'map' ? (
        <div className="relative h-[42svh]">
          <PlacementMap markers={markers} height="100%" />
          <a
            href={backHref}
            aria-label="Back"
            className="absolute left-4 top-[max(env(safe-area-inset-top),14px)] z-[500] flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-md"
            style={{ color: SC.text }}
          >
            <BackIcon size={22} />
          </a>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),14px)]">
          <a
            href={backHref}
            aria-label="Back"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white shadow-md"
            style={{ color: SC.text }}
          >
            <BackIcon size={22} />
          </a>
        </div>
      )}

      {/* sheet */}
      <div className="relative z-10 -mt-4 flex-1 rounded-t-3xl bg-white pb-28">
        <div className="mx-auto mt-2 h-1.5 w-12 rounded-full" style={{ background: '#D9D1BC' }} />
        <div className="px-5 pt-3">
          <h1 className="text-2xl font-bold" style={{ color: SC.text }}>
            {campaign.name}
          </h1>
          <div className="mt-2 flex gap-6 border-b" style={{ borderColor: '#EFE9D8' }}>
            {(['description', 'photos'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="flex items-center gap-2 pb-2 text-lg capitalize"
                style={
                  tab === t
                    ? { color: SC.text, boxShadow: `inset 0 -2.5px 0 ${SC.primary}`, fontWeight: 600 }
                    : { color: SC.muted }
                }
              >
                {t}
                {t === 'photos' && (
                  <span className="rounded-full px-2 py-0.5 text-sm" style={{ background: '#F1EBDB', color: SC.muted }}>
                    {placements.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="mx-5 mt-3 rounded-xl bg-red-50 px-4 py-2 text-sm" style={{ color: SC.danger }}>
            {error}
          </p>
        )}

        {tab === 'description' ? (
          <div className="px-5 py-4 text-base" style={{ color: SC.text }}>
            <p>{campaign.notes?.trim() || 'No description yet.'}</p>
            {mode === 'admin' && campaign.rateCents !== undefined && (
              <p className="mt-3" style={{ color: SC.muted }}>
                Pays {dollars(campaign.rateCents)} per accepted photo, stamped at acceptance.
              </p>
            )}
          </div>
        ) : (
          <div className="px-4 py-3">
            {groups.length === 0 && !error && (
              <p className="px-2 py-6 text-center" style={{ color: SC.muted }}>
                No photos yet.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.day} className="mb-2">
                <div className="flex items-center gap-3 px-1 py-2">
                  <span className="text-xl font-bold" style={{ color: SC.text }}>
                    {g.label}
                  </span>
                  <span className="rounded-full px-3 py-1 text-sm" style={{ background: '#F1EBDB', color: SC.muted }}>
                    {g.items.length} photos
                  </span>
                </div>
                {g.items.map((p) => (
                  <div key={p.id} className="mb-4 overflow-hidden rounded-2xl border bg-white shadow-sm" style={{ borderColor: '#EFE9D8' }}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <span
                        className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-semibold"
                        style={{ background: '#F1EAD8', color: SC.muted }}
                      >
                        {(p.workerName ?? 'W').slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-lg font-semibold" style={{ color: SC.text }}>
                          {p.workerName ?? 'You'}
                        </span>
                        <span className="block truncate text-sm" style={{ color: SC.muted }}>
                          {fmtStamp(p)}
                        </span>
                      </span>
                      <span
                        className="rounded-full px-2.5 py-1 text-xs font-medium"
                        style={
                          p.voidedAt
                            ? { background: '#ECEAE4', color: SC.muted }
                            : { background: STATUS_CHIP[p.status].bg, color: STATUS_CHIP[p.status].fg }
                        }
                      >
                        {p.voidedAt ? 'Voided' : STATUS_CHIP[p.status].text}
                        {p.status === 'accepted' && p.acceptedRateCents !== null && ` · ${dollars(p.acceptedRateCents)}`}
                      </span>
                      <DotsIcon size={20} className="shrink-0" />
                    </div>
                    {p.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                      <img src={p.photoUrl} alt="Placement proof" className="max-h-[420px] w-full object-cover" />
                    ) : (
                      <div className="flex h-40 items-center justify-center" style={{ background: '#F1EBDB', color: SC.muted }}>
                        photo unavailable
                      </div>
                    )}
                    <div className="px-4 py-3">
                      {p.workerNote && (
                        <p className="mb-2 text-base" style={{ color: SC.text }}>
                          {p.workerNote}
                        </p>
                      )}
                      {p.status === 'rejected' && p.rejectionReason && (
                        <p className="mb-2 text-sm" style={{ color: SC.danger }}>
                          {p.rejectionReason}
                        </p>
                      )}
                      {mode === 'admin' && (p.duplicates?.length ?? 0) > 0 && (() => {
                        // Split by signal strength (ops suggestions round): a
                        // busy worker's every sign matches its same-day
                        // siblings, so worker-day-only matches collapse to a
                        // count instead of drowning the real location and
                        // address hits.
                        const { strong, weakCount } = splitDuplicateSignals(p.duplicates!);
                        const parts = strong.map((d) => `${d.workerName} (${d.reasons.join(', ')})`);
                        if (weakCount > 0) parts.push(`${weakCount} more from the same worker that day`);
                        return (
                          <div className="mb-2 rounded-xl px-3 py-2 text-sm" style={{ background: '#FDF3DF', color: '#8a6d1f' }}>
                            Possible duplicates, your call: {parts.join(' · ')}
                          </div>
                        );
                      })()}
                      {mode === 'admin' && !p.voidedAt && (p.status === 'pending' || p.status === 'resubmitted') && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy === p.id}
                            onClick={() => void act({ action: 'accept', placementId: p.id }, p.id)}
                            className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                            style={{ background: SC.ok }}
                          >
                            Accept (pays the rate)
                          </button>
                          <button
                            type="button"
                            disabled={busy === p.id}
                            onClick={() => {
                              const reason = window.prompt(
                                'Void this placement? It will stop counting for pay, allotments and stock. Why? (required, permanent record)',
                              );
                              if (reason && reason.trim()) {
                                void act({ action: 'void', placementId: p.id, reason: reason.trim() }, p.id);
                              }
                            }}
                            className="rounded-full border px-4 py-2 text-sm disabled:opacity-50"
                            style={{ borderColor: '#DCD4BE', color: SC.muted }}
                          >
                            Void…
                          </button>
                          {rejecting === p.id ? (
                            <>
                              <input
                                autoFocus
                                value={reasons[p.id] ?? ''}
                                onChange={(e) => setReasons((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                placeholder="Why? The worker sees this."
                                className="min-w-0 flex-1 rounded-full border px-3 py-2 text-sm"
                                style={{ borderColor: '#DCD4BE' }}
                              />
                              <button
                                type="button"
                                disabled={busy === p.id || !(reasons[p.id] ?? '').trim()}
                                onClick={() =>
                                  void act({ action: 'reject', placementId: p.id, reason: (reasons[p.id] ?? '').trim() }, p.id)
                                }
                                className="rounded-full px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                                style={{ background: SC.danger }}
                              >
                                Reject
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setRejecting(p.id)}
                              className="rounded-full border px-4 py-2 text-sm"
                              style={{ borderColor: '#DCD4BE', color: SC.text }}
                            >
                              Reject…
                            </button>
                          )}
                        </div>
                      )}
                      {mode === 'worker' && p.status === 'rejected' && !p.voidedAt && (
                        <ResubmitButton placementId={p.id} onDone={reload} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the detail screen's own bottom nav: Map | Capture | My photos */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex items-start justify-around border-t px-2 pb-[max(env(safe-area-inset-bottom),10px)] pt-2"
        style={{ background: '#fff', borderColor: '#EDE6D2' }}
      >
        <DetailNavButton
          label="Map"
          active={view === 'map'}
          onClick={() => {
            setView('map');
            setTab('photos');
          }}
          icon={<MapFoldIcon size={24} />}
        />
        <a href={captureHref} className="flex flex-col items-center gap-1 px-4 py-1" style={{ color: '#3A423C' }}>
          <CameraIcon size={24} />
          <span className="text-sm">Capture</span>
        </a>
        <DetailNavButton
          label={mode === 'worker' ? 'My photos' : 'Photos'}
          active={view === 'photos'}
          onClick={() => {
            setView('photos');
            setTab('photos');
          }}
          icon={<PersonIcon size={24} />}
        />
      </nav>

      {/* map pin hint */}
      {view === 'map' && markers.length === 0 && (
        <p className="pointer-events-none fixed left-1/2 top-[20svh] z-20 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">
          <PinIcon size={14} className="mr-1 inline" /> No GPS points yet
        </p>
      )}
    </div>
  );
}

function DetailNavButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-2xl px-4 py-1"
      style={active ? { color: SC.primary, background: '#F1EAD8' } : { color: '#3A423C' }}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

function ResubmitButton({ placementId, onDone }: { placementId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/advertising/placements/${placementId}/resubmit`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not resubmit.');
        return;
      }
      onDone();
    } catch {
      setError('Could not resubmit. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void resubmit()}
        className="rounded-full border px-4 py-2 text-sm disabled:opacity-50"
        style={{ borderColor: '#DCD4BE', color: SC.text }}
      >
        {busy ? 'Sending…' : 'Ask for another look'}
      </button>
      {error && (
        <p className="mt-1 text-xs" style={{ color: SC.danger }}>
          {error}
        </p>
      )}
    </div>
  );
}
