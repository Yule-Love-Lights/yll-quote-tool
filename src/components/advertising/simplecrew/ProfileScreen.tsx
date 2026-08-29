'use client';

// The worker profile tab (Simple Crew replica): avatar, name, email, the
// Photos Feed / Map View pill toggle, photos grouped by campaign with the
// GPS Location chip — plus OUR money strip (earned at the stamped rates,
// pending as an estimate), which Simple Crew never had.

import { useEffect, useMemo, useState } from 'react';

import PlacementMap from './PlacementMap';
import { dollars, PillToggle, SC, timeAgo, EmptyState } from './ui';

type Placement = {
  id: string;
  campaignId: string;
  kind: 'yard_sign' | 'door_hanger';
  status: 'pending' | 'accepted' | 'rejected' | 'resubmitted';
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  createdAt: string;
  suggestedAddress: string | null;
  rejectionReason: string | null;
  acceptedRateCents: number | null;
  photoUrl: string | null;
};

type Campaign = { id: string; name: string };

type Earnings = { total: { pendingEstimatedCents: number; acceptedEarnedCents: number } };

export default function ProfileScreen({ displayName, email }: { displayName: string; email: string | null }) {
  const [view, setView] = useState<'feed' | 'map'>('feed');
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [pRes, cRes, eRes] = await Promise.all([
          fetch('/api/advertising/placements'),
          fetch('/api/advertising/campaigns'),
          fetch('/api/advertising/earnings'),
        ]);
        if (cancelled) return;
        if (pRes.ok) setPlacements(((await pRes.json()) as { placements: Placement[] }).placements);
        if (cRes.ok) setCampaigns(((await cRes.json()) as { campaigns: Campaign[] }).campaigns);
        if (eRes.ok) setEarnings(((await eRes.json()) as { summary: Earnings }).summary);
      } catch {
        /* cards render what loaded */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const campaignName = useMemo(() => new Map(campaigns.map((c) => [c.id, c.name])), [campaigns]);

  const groups = useMemo(() => {
    const byCampaign = new Map<string, Placement[]>();
    for (const p of placements) byCampaign.set(p.campaignId, [...(byCampaign.get(p.campaignId) ?? []), p]);
    return [...byCampaign.entries()];
  }, [placements]);

  const markers = placements
    .filter((p) => p.lat !== null && p.lng !== null)
    .map((p) => ({ id: p.id, lat: p.lat!, lng: p.lng!, status: p.status, label: p.suggestedAddress ?? undefined }));

  return (
    <div className="min-h-[100svh] pb-28" style={{ background: SC.bg }}>
      <div className="flex flex-col items-center px-5 pt-[max(env(safe-area-inset-top),40px)]">
        <span
          className="flex h-28 w-28 items-center justify-center rounded-full text-4xl font-semibold"
          style={{ background: '#E4E7E3', color: '#9AA29B' }}
        >
          {displayName.slice(0, 1)}
        </span>
        <h1 className="mt-4 text-3xl font-bold" style={{ color: SC.text }}>
          {displayName}
        </h1>
        {email && (
          <p className="mt-1 text-lg" style={{ color: SC.muted }}>
            {email}
          </p>
        )}
      </div>

      {earnings && (
        <div className="mx-5 mt-5 flex gap-3">
          <div className="flex-1 rounded-2xl bg-white p-3 text-center shadow-sm">
            <p className="text-xs uppercase tracking-wide" style={{ color: SC.muted }}>
              Earned
            </p>
            <p className="text-xl font-bold" style={{ color: SC.text }}>
              {dollars(earnings.total.acceptedEarnedCents)}
            </p>
          </div>
          <div className="flex-1 rounded-2xl bg-white p-3 text-center shadow-sm">
            <p className="text-xs uppercase tracking-wide" style={{ color: SC.muted }}>
              Pending (est.)
            </p>
            <p className="text-xl font-bold" style={{ color: SC.text }}>
              {dollars(earnings.total.pendingEstimatedCents)}
            </p>
          </div>
        </div>
      )}

      <div className="mx-5 mt-5">
        <PillToggle
          options={[
            { value: 'feed', label: 'Photos Feed' },
            { value: 'map', label: 'Map View' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      {view === 'map' ? (
        <div className="mt-4 overflow-hidden">
          <PlacementMap markers={markers} height="52svh" />
        </div>
      ) : (
        <div className="mt-3 px-5">
          {loaded && placements.length === 0 && (
            <EmptyState
              kind="photos"
              title="No Photos Yet"
              hint="There are no photos yet. You can capture first photos from the camera tab below."
            />
          )}
          {placements.length > 0 && (
            <p className="py-2 text-lg font-semibold" style={{ color: SC.text }}>
              {placements.length} {placements.length === 1 ? 'photo' : 'photos'}
            </p>
          )}
          {groups.map(([campaignId, items]) => (
            <div key={campaignId} className="mb-4">
              <div className="flex items-baseline justify-between py-1">
                <span>
                  <span className="block text-xs uppercase tracking-wide" style={{ color: SC.muted }}>
                    Campaign
                  </span>
                  <span className="text-xl font-semibold" style={{ color: SC.text }}>
                    {campaignName.get(campaignId) ?? 'Campaign'}
                  </span>
                </span>
                <span className="text-base" style={{ color: SC.muted }}>
                  {timeAgo(items[0]?.capturedAt ?? items[0]?.createdAt ?? null)}
                </span>
              </div>
              {items.map((p) => (
                <div key={p.id} className="relative mb-3 overflow-hidden rounded-2xl bg-white shadow-sm">
                  {p.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                    <img src={p.photoUrl} alt="Placement" className="max-h-[420px] w-full object-cover" />
                  ) : (
                    <div className="flex h-40 items-center justify-center" style={{ background: '#F0F2EF', color: SC.muted }}>
                      photo unavailable
                    </div>
                  )}
                  {p.lat !== null && (
                    <span className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-sm text-white">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                      </svg>
                      GPS Location
                    </span>
                  )}
                  <div className="flex items-center justify-between px-4 py-2.5">
                    <span className="truncate text-sm" style={{ color: SC.muted }}>
                      {p.suggestedAddress ?? 'Location recorded'}
                    </span>
                    <StatusChip p={p} />
                  </div>
                  {p.status === 'rejected' && p.rejectionReason && (
                    <p className="px-4 pb-3 text-sm" style={{ color: SC.danger }}>
                      {p.rejectionReason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusChip({ p }: { p: Placement }) {
  const map = {
    pending: { text: 'Pending', bg: '#EFF1EE', fg: '#3A423C' },
    resubmitted: { text: 'Resubmitted', bg: '#FDF3DF', fg: '#8a6d1f' },
    accepted: { text: p.acceptedRateCents !== null ? `Accepted · ${dollars(p.acceptedRateCents)}` : 'Accepted', bg: '#E4F2E8', fg: '#2E7D4F' },
    rejected: { text: 'Rejected', bg: '#FBE7E7', fg: '#B3383F' },
  }[p.status];
  return (
    <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: map.bg, color: map.fg }}>
      {map.text}
    </span>
  );
}
