'use client';

// #167 P1 slice 2 — the operator's trigger for the archive imagery fetch.
//
// The Google Maps key only exists in the deployed environment, so this batch
// cannot be run from a dev checkout or a script — it runs here, on a click.
// Deliberately minimal: counters, a button, and an honest per-property result
// list. Slice 3 grows THIS page into the full review queue (grouped property
// cards with the night photos, "Trace this house" into /training/new, and a
// needs-identification lane for the rows with no address); everything here is
// meant to be built on rather than thrown away.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { TrainingRowsSkeleton } from '../TrainingRowsSkeleton';

type Status = {
  properties: { total: number; withImagery: number; failed: number; pending: number };
  photos: { total: number; pending: number; readyToTrace: number; excluded: number; other: number };
  needsAddress: number;
  googleMapsConfigured: boolean;
};

type PropertyResult = {
  addressKey: string;
  address: string;
  photos: number;
  ok: boolean;
  satelliteRef?: string;
  streetViewRef?: string | null;
  error?: string;
};

type Run = {
  attempted: number;
  fetched: number;
  failed: number;
  remaining: number;
  stoppedOnDeadline: boolean;
  results: PropertyResult[];
};

type QueuePhoto = { id: string; title: string | null; nightPhotoUrl: string | null };

type QueueProperty = {
  addressKey: string;
  address: string;
  photoCount: number;
  photos: QueuePhoto[];
  satelliteUrl: string | null;
  streetViewUrl: string | null;
  satelliteFeetPerPixel: number | null;
  satelliteW: number | null;
  satelliteH: number | null;
  promotedTrainingHouseId: string | null;
};

type NeedsIdRow = {
  id: string;
  title: string | null;
  nightPhotoUrl: string | null;
  resolvedName: string | null;
  reviewerNotes: string | null;
};

type Queue = { properties: QueueProperty[]; needsIdentification: NeedsIdRow[]; remaining: number };

export default function ArchiveImageryPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      // Counters and queue are two endpoints but one screen — fetch together so
      // the page can't render "12 ready to trace" above an empty queue.
      const [statusRes, queueRes] = await Promise.all([
        fetch('/api/training/archive/imagery'),
        fetch('/api/training/archive/queue'),
      ]);
      const data = await statusRes.json();
      if (!statusRes.ok) throw new Error(data.error ?? 'Failed to load the archive queue');
      setStatus(data as Status);

      const queueData = await queueRes.json();
      if (!queueRes.ok) throw new Error(queueData.error ?? 'Failed to load the trace queue');
      setQueue(queueData as Queue);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the archive queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Match /training: defer so the loading-state update isn't dispatched
    // synchronously inside the effect. Microtasks flush before paint.
    queueMicrotask(refresh);
  }, []);

  const fetchBatch = async (retryFailed: boolean) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/training/archive/imagery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryFailed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Fetch failed');
      setRun(data as Run);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setRunning(false);
      // Counters move on every run — reread them rather than deriving from the
      // run summary, so what the page shows is what the table actually holds.
      refresh();
    }
  };

  // Both queue actions are the same shape: POST, then re-read rather than
  // patching local state, so what's on screen is what the table holds.
  // Returns the error message (or null on success) so the CARD that fired the
  // action can show it inline — a lost race surfaced only in the page-top
  // banner reads as "nothing happened" from card #30 of an 80-card grind
  // (S51 wrap review, staff lens). The banner is kept as a secondary surface.
  const queueAction = async (body: Record<string, unknown>, failMessage: string): Promise<string | null> => {
    setError(null);
    try {
      const res = await fetch('/api/training/archive/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? failMessage);
      await refresh();
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : failMessage;
      setError(message);
      return message;
    }
  };

  const p = status?.properties;
  const canFetch = !!status?.googleMapsConfigured && !running && (p?.pending ?? 0) > 0;

  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <SettingsSubNav active="training" />

        <div className="flex justify-between items-start mb-6 gap-4 flex-wrap">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Archive Review Queue</h1>
            <p className="text-sm text-gray-500 mt-1 max-w-2xl">
              Past installs from the photo archive. Each property needs its daytime satellite fetched before
              anyone can trace it — the archive photos are night shots of the finished job, useful as reference
              but not something you can measure on.
            </p>
          </div>
          <Link
            href="/training"
            className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
          >
            Training Database
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {/* Same skeleton the route's loading.tsx shows (row 332, mirrors
            #171b) — was a bare "Loading…" line, which made the route-transition
            skeleton morph into something sparser before morphing again into the
            real content once the client-side GET fetch resolved. */}
        {loading && !status && <TrainingRowsSkeleton />}

        {status && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <Stat label="Properties" value={p!.total} hint={`${status.photos.total} archive photos`} />
              <Stat label="Imagery ready" value={p!.withImagery} hint="ready to trace" />
              <Stat label="Awaiting fetch" value={p!.pending} hint="no satellite yet" />
              {/* Deliberately NOT `failed + needsAddress`: those are different
                  units — failed counts PROPERTIES whose address wouldn't
                  geocode, needsAddress counts individual PHOTO rows with no
                  address at all (there's no key to group them by). Summing them
                  produced a number that was neither, and double-reported the
                  photo rows the banner below already explains. */}
              <Stat label="Bad address" value={p!.failed} hint="properties to correct" />
            </div>

            {!status.googleMapsConfigured && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-800 mb-4">
                This environment has no Google Maps key, so imagery can&apos;t be fetched here. Run it on the
                deployed app.
              </div>
            )}

            <div className="flex gap-2 flex-wrap mb-6">
              <button
                onClick={() => fetchBatch(false)}
                disabled={!canFetch}
                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
              >
                {running ? 'Fetching…' : `Fetch imagery (${p!.pending} left)`}
              </button>
              {p!.failed > 0 && (
                <button
                  onClick={() => fetchBatch(true)}
                  disabled={running || !status.googleMapsConfigured}
                  className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
                >
                  Retry {p!.failed} failed
                </button>
              )}
            </div>

            {p!.pending === 0 && p!.failed === 0 && p!.total > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800 mb-6">
                Every property has its imagery. Tracing is next.
              </div>
            )}

          </>
        )}

        {/* Needs identification. These rows have no address at ALL, so the
            imagery worker can never claim them — they sit in 'pending' forever
            until a human looks at the night photo and says which house it is.
            Rendered above the trace queue because it is blocking work, and the
            count is small. */}
        {queue && queue.needsIdentification.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">
              Needs identifying ({queue.needsIdentification.length})
            </h2>
            <p className="text-xs text-gray-500 mb-3 max-w-2xl">
              No address to look up — a customer link with no address typed, or a name we never found in the
              CRM. Look at the photo, then type the address. It goes back in line for imagery on the next fetch.
            </p>
            <div className="space-y-3">
              {queue.needsIdentification.map(row => (
                <NeedsIdCard
                  key={row.id}
                  row={row}
                  onIdentify={address => queueAction({ action: 'identify', id: row.id, address }, 'Could not save that address')}
                  onExclude={() => queueAction({ action: 'exclude', id: row.id }, 'Could not exclude that photo')}
                />
              ))}
            </div>
          </div>
        )}

        {/* The trace queue itself: one card per PROPERTY, not per photo. */}
        {queue && queue.properties.length > 0 && (
          <div className="mb-8">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">
              Ready to trace ({queue.remaining} left)
            </h2>
            <p className="text-xs text-gray-500 mb-3 max-w-2xl">
              Trace the roofline on the daytime satellite. The night photos are what was actually installed —
              reference, not something to measure on.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {queue.properties.map(prop => (
                <PropertyCard
                  key={prop.addressKey}
                  property={prop}
                  onExclude={() => queueAction(
                    { action: 'excludeProperty', addressKey: prop.addressKey },
                    'Could not remove that property',
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {queue && queue.properties.length === 0 && queue.needsIdentification.length === 0 && !loading && (
          <p className="text-sm text-gray-500 mb-8">Nothing in the trace queue yet — fetch imagery first.</p>
        )}

        {run && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 text-sm text-gray-700">
              <strong>{run.fetched} fetched</strong>
              {run.failed > 0 && <span className="text-red-700"> · {run.failed} failed</span>}
              {run.remaining > 0 && <span className="text-gray-500"> · {run.remaining} still to go</span>}
              {run.stoppedOnDeadline && (
                <span className="text-gray-500"> · stopped on the time limit, click again to continue</span>
              )}
            </div>
            <ul className="divide-y divide-gray-100">
              {run.results.map((r) => (
                <li key={r.addressKey} className="px-4 py-3 text-sm">
                  <div className="flex items-start gap-2">
                    <span className={r.ok ? 'text-green-600' : 'text-red-600'}>{r.ok ? '✓' : '✗'}</span>
                    <div className="min-w-0">
                      <div className="text-gray-900 break-words">{r.address}</div>
                      <div className="text-xs text-gray-500">
                        {r.photos} photo{r.photos === 1 ? '' : 's'}
                        {r.ok && r.streetViewRef == null && ' · no Street View available'}
                      </div>
                      {r.error && <div className="text-xs text-red-700 mt-1 break-words">{r.error}</div>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}

/**
 * A row nobody can trace until a human names the house. The night photo IS the
 * evidence, so when it hasn't been copied into the bucket yet we say so plainly
 * rather than rendering an empty frame the operator can't act on.
 */
function NeedsIdCard({
  row,
  onIdentify,
  onExclude,
}: {
  row: NeedsIdRow;
  onIdentify: (address: string) => Promise<string | null>;
  onExclude: () => Promise<string | null>;
}) {
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    if (!address.trim() || saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      setLocalError(await onIdentify(address));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 flex gap-4 flex-col sm:flex-row">
      <div className="w-full sm:w-40 shrink-0">
        {row.nightPhotoUrl ? (
          <img
            src={row.nightPhotoUrl}
            alt={row.title ?? 'Archive night photo'}
            className="w-full h-32 object-cover rounded border border-gray-200"
          />
        ) : (
          <div className="w-full h-32 rounded border border-dashed border-gray-300 bg-gray-50 flex items-center justify-center text-center px-2">
            <span className="text-xs text-gray-500">Photo not copied from Drive yet</span>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-900 break-words">
          {row.resolvedName ?? row.title ?? 'Unidentified'}
        </div>
        {row.title && row.resolvedName && (
          <div className="text-xs text-gray-500 break-words">{row.title}</div>
        )}
        {row.reviewerNotes && (
          <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap break-words">{row.reviewerNotes}</p>
        )}

        <div className="flex gap-2 mt-3 flex-wrap">
          <input
            className="flex-1 min-w-[12rem] border border-gray-300 rounded-md px-3 py-2 text-sm"
            value={address}
            onChange={e => setAddress(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            placeholder="123 Main St, Smithtown, NY"
          />
          <button
            onClick={submit}
            disabled={!address.trim() || saving}
            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
          >
            {saving ? 'Saving…' : 'Save address'}
          </button>
          <button
            onClick={async () => setLocalError(await onExclude())}
            disabled={saving}
            className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 text-gray-700 font-medium text-sm px-3 py-2 rounded-md"
          >
            Not an install
          </button>
        </div>
        {localError && <p className="text-xs text-red-700 mt-2">{localError}</p>}
      </div>
    </div>
  );
}

/** One card per property — a house's angles are photos of ONE job, not N jobs. */
function PropertyCard({ property, onExclude }: { property: QueueProperty; onExclude: () => Promise<string | null> }) {
  const traced = !!property.promotedTrainingHouseId;
  const nightPhotos = property.photos.filter(p => p.nightPhotoUrl);
  const [localError, setLocalError] = useState<string | null>(null);

  return (
    <div className={`bg-white border rounded-lg overflow-hidden ${traced ? 'border-gray-200 opacity-60' : 'border-gray-200'}`}>
      <div className="aspect-video bg-gray-100 relative">
        {property.satelliteUrl ? (
          <img src={property.satelliteUrl} alt={property.address} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">
            No satellite yet
          </div>
        )}
        {traced && (
          <span className="absolute top-2 right-2 bg-green-600 text-white text-xs font-medium px-2 py-1 rounded">
            Traced
          </span>
        )}
      </div>

      <div className="p-4">
        <div className="text-sm font-medium text-gray-900 break-words">{property.address}</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {property.photoCount} archive photo{property.photoCount === 1 ? '' : 's'}
          {property.satelliteFeetPerPixel != null && property.satelliteW != null && (
            <> · {(property.satelliteFeetPerPixel * property.satelliteW).toFixed(0)} ft across</>
          )}
          {!property.streetViewUrl && ' · no Street View'}
        </div>

        {nightPhotos.length > 0 && (
          <div className="flex gap-1 mt-3 overflow-x-auto">
            {nightPhotos.map(photo => (
              <img
                key={photo.id}
                src={photo.nightPhotoUrl!}
                alt={photo.title ?? 'Archive night photo'}
                title={photo.title ?? undefined}
                className="h-14 w-14 object-cover rounded border border-gray-200 shrink-0"
              />
            ))}
          </div>
        )}

        <div className="mt-3">
          {traced ? (
            // No /training/[id] detail route exists — the list page is the only
            // place a saved house renders, so that is where this goes. A
            // per-house href here 404'd (caught in the S51 wrap review).
            <Link
              href="/training"
              className="inline-block bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              View in training list
            </Link>
          ) : (
            <div className="flex gap-2 flex-wrap items-center">
              <Link
                href={`/training/new?archive=${encodeURIComponent(property.addressKey)}`}
                className={`inline-block font-medium text-sm px-4 py-2 rounded-md ${
                  property.satelliteUrl
                    ? 'bg-green-600 hover:bg-green-700 text-white'
                    : 'bg-gray-200 text-gray-500 pointer-events-none'
                }`}
              >
                Trace this house
              </Link>
              {/* Without this a bad or duplicate property sits in the queue
                  forever, inflating the remaining count staff are grinding
                  down, with tracing it the only way to make it go away. */}
              <button
                onClick={async () => {
                  if (confirm(
                    `Remove ${property.address} from the queue?\n\n`
                    + `This drops all ${property.photoCount} of its photos and cannot be undone from this app — `
                    + `restoring it needs a database edit.`,
                  )) {
                    setLocalError(await onExclude());
                  }
                }}
                className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-3 py-2 rounded-md"
              >
                Not an install
              </button>
            </div>
          )}
          {localError && <p className="text-xs text-red-700 mt-2">{localError}</p>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
    </div>
  );
}
