'use client';

// The Campaigns tab (Simple Crew replica): big title, floating sort/search
// (+ create for admin) toolbar, and the campaign cards — name, "Last photo
// X ago", photo count and crew count with their little outline icons.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChevronRightIcon, CrewIcon, PhotoBadgeIcon, PlusIcon, SearchIcon, SortIcon } from './icons';
import { dollars, EmptyState, PrimaryButton, SC, ScreenHeader, Sheet, timeAgo, ToolbarButton } from './ui';

export type CampaignCard = {
  id: string;
  name: string;
  kind: 'yard_sign' | 'door_hanger';
  rateCents: number;
  active?: boolean;
  isTest?: boolean;
  photoCount: number;
  workerCount: number;
  lastPhotoAt: string | null;
  pendingCount?: number;
};

export default function CampaignsScreen({
  mode,
  campaignsUrl,
  detailHrefBase,
  createUrl,
}: {
  mode: 'worker' | 'admin';
  campaignsUrl: string;
  detailHrefBase: string;
  createUrl?: string;
}) {
  const [campaigns, setCampaigns] = useState<CampaignCard[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'yard_sign' | 'door_hanger'>('yard_sign');
  const [newRate, setNewRate] = useState('2.50');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(campaignsUrl);
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load campaigns. Pull to refresh.');
          return;
        }
        const body = (await res.json()) as { campaigns: CampaignCard[] };
        if (cancelled) return;
        setCampaigns(body.campaigns);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load campaigns. Check your connection.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignsUrl, tick]);

  const shown = useMemo(() => {
    const filtered = campaigns.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
    return [...filtered].sort((a, b) => {
      const at = a.lastPhotoAt ?? '';
      const bt = b.lastPhotoAt ?? '';
      return newestFirst ? bt.localeCompare(at) : at.localeCompare(bt);
    });
  }, [campaigns, search, newestFirst]);

  const create = async () => {
    setCreateError(null);
    const { dollarsToCents } = await import('@/lib/hourlyRate');
    // Pay per accepted PHOTO, any kind (Naldo 2026-08-29) — every campaign
    // carries a rate, door hangers included.
    const rateCents = dollarsToCents(newRate);
    if (rateCents === null) {
      setCreateError('Enter the pay per accepted photo in dollars, like 2.50.');
      return;
    }
    if (!window.confirm(`Create "${newName.trim()}" paying ${dollars(rateCents)} per accepted photo?`)) {
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(createUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, kind: newKind, rateCents }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setCreateError(body.error ?? 'Could not create the campaign.');
        return;
      }
      setCreateOpen(false);
      setNewName('');
      setNewRate('2.50');
      setNewKind('yard_sign');
      reload();
    } catch {
      setCreateError('Could not create the campaign. Try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-[100svh] pb-28" style={{ background: SC.bg }}>
      <ScreenHeader
        title="Campaigns"
        toolbar={
          <>
            <ToolbarButton label="Sort" onClick={() => setNewestFirst((v) => !v)}>
              <SortIcon size={22} />
            </ToolbarButton>
            <ToolbarButton label="Search" onClick={() => setSearchOpen((v) => !v)}>
              <SearchIcon size={22} />
            </ToolbarButton>
            {mode === 'admin' && (
              <ToolbarButton label="New campaign" onClick={() => setCreateOpen(true)}>
                <PlusIcon size={22} />
              </ToolbarButton>
            )}
          </>
        }
      />

      {searchOpen && (
        <div className="px-5 pb-3">
          <div className="flex items-center gap-2 rounded-full border bg-white px-4 py-3" style={{ borderColor: '#DFE3DE' }}>
            <SearchIcon size={18} className="opacity-50" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search.."
              className="w-full bg-transparent text-base outline-none"
              style={{ color: SC.text }}
            />
          </div>
        </div>
      )}

      {error && (
        <p className="mx-5 rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
          {error}
        </p>
      )}

      {loaded && shown.length === 0 && !error && (
        <EmptyState
          kind="campaigns"
          title="No Campaigns Yet"
          hint="Campaigns organize the promo work and decide what a placement is worth."
          cta={
            mode === 'admin' ? (
              <PrimaryButton onClick={() => setCreateOpen(true)}>Create New Campaign</PrimaryButton>
            ) : undefined
          }
        />
      )}

      <div className="flex flex-col gap-4 px-4">
        {shown.map((c) => (
          <a
            key={c.id}
            href={`${detailHrefBase}/${c.id}`}
            className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm"
          >
            <span className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="truncate text-2xl font-semibold" style={{ color: c.active === false ? SC.muted : SC.text }}>
                  {c.name}
                </span>
                {c.isTest && (
                  <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: SC.tint, color: SC.primary }}>
                    test
                  </span>
                )}
                {c.active === false && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs" style={{ color: SC.muted }}>
                    closed
                  </span>
                )}
                {mode === 'admin' && (c.pendingCount ?? 0) > 0 && (
                  <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: '#FDF3DF', color: '#8a6d1f' }}>
                    {c.pendingCount} to review
                  </span>
                )}
              </span>
              {c.lastPhotoAt && (
                <span className="mt-0.5 block text-base" style={{ color: SC.muted }}>
                  Last photo {timeAgo(c.lastPhotoAt)}
                </span>
              )}
              <span className="mt-1.5 flex items-center gap-4 text-base" style={{ color: SC.muted }}>
                <span className="flex items-center gap-1.5">
                  {c.photoCount} <PhotoBadgeIcon size={19} />
                </span>
                <span className="flex items-center gap-1.5">
                  {c.workerCount} <CrewIcon size={19} />
                </span>
                {mode === 'admin' && <span className="text-sm">{dollars(c.rateCents)}/photo</span>}
              </span>
            </span>
            <span className="shrink-0" style={{ color: '#B4BAB4' }}>
              <ChevronRightIcon size={22} />
            </span>
          </a>
        ))}
      </div>

      <Sheet open={createOpen} onClose={() => setCreateOpen(false)}>
        <div style={{ color: SC.text }}>
          <h2 className="text-xl font-bold">New campaign</h2>
          <label className="mt-4 block text-sm" style={{ color: SC.muted }}>
            Name
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1 w-full rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DFE3DE' }}
              placeholder="Fall yard signs"
            />
          </label>
          <div className="mt-3 flex gap-2">
            {(['yard_sign', 'door_hanger'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setNewKind(k)}
                className="flex-1 rounded-full border px-3 py-2.5 text-base font-medium"
                style={
                  newKind === k
                    ? { background: SC.primary, borderColor: SC.primary, color: '#fff' }
                    : { borderColor: '#DFE3DE', color: SC.text }
                }
              >
                {k === 'yard_sign' ? 'Yard signs' : 'Door hangers'}
              </button>
            ))}
          </div>
          <label className="mt-3 block text-sm" style={{ color: SC.muted }}>
            Pay per accepted photo ($)
            <input
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              className="mt-1 w-28 rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DFE3DE' }}
            />
          </label>
          {createError && (
            <p className="mt-3 text-sm" style={{ color: SC.danger }}>
              {createError}
            </p>
          )}
          <div className="mt-5">
            <PrimaryButton disabled={creating || !newName.trim()} onClick={() => void create()}>
              {creating ? 'Creating…' : 'Create New Campaign'}
            </PrimaryButton>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
