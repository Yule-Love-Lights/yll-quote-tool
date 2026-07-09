'use client';

// #141 — review UI for permanent-lighting training examples (the Permanent tab
// on /training/examples). Mirrors the holiday tab's list/expand/exclude/delete
// shape, but v1-minimal: no corrections editor (that's v2) — just a readonly
// detail view (satellite + street overlays, footage/corners context, raw JSON).

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  PermanentTrainingExampleListItem,
  PermanentTrainingExampleRow,
} from '@/lib/permanent/trainingExamples';
import AnnotatedPhoto from '@/components/training/AnnotatedPhoto';

const FRONT = '#ef4444'; // red
const LEFT = '#3b82f6'; // blue
const RIGHT = '#f59e0b'; // amber
const BACK = '#22c55e'; // green

const SIDE_COLORS: Record<'front' | 'left' | 'right' | 'back', string> = {
  front: FRONT,
  left: LEFT,
  right: RIGHT,
  back: BACK,
};

function sideCounts(lines: PermanentTrainingExampleListItem['final_satellite_lines']) {
  return {
    front: lines?.front?.length ?? 0,
    left: lines?.left?.length ?? 0,
    right: lines?.right?.length ?? 0,
    back: lines?.back?.length ?? 0,
  };
}

export default function PermanentExamplesTab() {
  const [items, setItems] = useState<PermanentTrainingExampleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PermanentTrainingExampleRow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const detailReqRef = useRef(0);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/permanent-training-examples');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    queueMicrotask(refresh);
  }, []);

  const expand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      setDetailError(null);
      return;
    }
    const reqId = ++detailReqRef.current;
    setExpandedId(id);
    setDetail(null);
    setDetailError(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/permanent-training-examples/${id}`);
      const data = await res.json().catch(() => ({}));
      if (reqId !== detailReqRef.current) return; // superseded — ignore
      if (res.ok) setDetail(data.example as PermanentTrainingExampleRow);
      else setDetailError(data.error ?? `Failed to load (${res.status})`);
    } catch (err) {
      if (reqId === detailReqRef.current) {
        setDetailError(err instanceof Error ? err.message : 'Failed to load');
      }
    } finally {
      if (reqId === detailReqRef.current) setLoadingDetail(false);
    }
  };

  const toggleExcluded = async (item: PermanentTrainingExampleListItem) => {
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/permanent-training-examples/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded: !item.excluded }),
      });
      if (res.ok) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, excluded: !item.excluded } : i)));
      } else {
        alert('Update failed');
      }
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this training example? The AI will stop learning from it.')) return;
    const res = await fetch(`/api/permanent-training-examples/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
      refresh();
    } else {
      alert('Delete failed');
    }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div>
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-500">Loading…</p>}

      {!loading && items.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-gray-500">No permanent training examples captured yet.</p>
          <p className="text-xs text-gray-400 mt-2">
            Send a permanent quote to the customer (or click &ldquo;Save as training example&rdquo; on the
            quote page) and it shows up here.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {items.map((ex) => {
          const isOpen = expandedId === ex.id;
          const counts = sideCounts(ex.final_satellite_lines);
          return (
            <div
              key={ex.id}
              className={`bg-white border rounded-lg overflow-hidden ${ex.excluded ? 'border-amber-300 opacity-70' : 'border-gray-200'}`}
            >
              <div className="w-full p-3 flex items-center justify-between gap-4">
                <button onClick={() => expand(ex.id)} className="flex-1 min-w-0 text-left hover:opacity-80">
                  <div className="text-xs text-gray-500 flex gap-2 items-center flex-wrap">
                    {fmtDate(ex.created_at)}
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ex.source === 'auto-send' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                      {ex.source === 'auto-send' ? 'auto · sent' : 'manual'}
                    </span>
                    {ex.excluded && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700">
                        excluded from AI
                      </span>
                    )}
                    {ex.has_street && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">
                        street photo
                      </span>
                    )}
                    {ex.has_analysis && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">
                        AI analysis
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-900 mt-0.5 truncate">
                    {ex.address ?? '(no address)'}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    F <strong>{counts.front}</strong> · L <strong>{counts.left}</strong> · R <strong>{counts.right}</strong> · B{' '}
                    <strong>{counts.back}</strong> traced run(s)
                    {ex.notes && <> · <em>&ldquo;{ex.notes}&rdquo;</em></>}
                  </div>
                </button>
                <div className="flex gap-3 flex-shrink-0 items-center text-xs">
                  <button onClick={() => expand(ex.id)} className="text-blue-600 hover:underline">
                    {isOpen ? '▼ Hide' : '▶ View'}
                  </button>
                  <button
                    onClick={() => toggleExcluded(ex)}
                    disabled={busyId === ex.id}
                    className="text-amber-600 hover:underline disabled:opacity-50"
                  >
                    {ex.excluded ? 'Re-include' : 'Exclude'}
                  </button>
                  <button onClick={() => remove(ex.id)} className="text-red-500 hover:underline">
                    Delete
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-gray-200 p-3 bg-gray-50">
                  {loadingDetail && <p className="text-xs text-gray-500">Loading photos…</p>}
                  {detailError && (
                    <p className="text-xs text-red-600">Couldn&rsquo;t load this example: {detailError}</p>
                  )}
                  {detail && detail.id === ex.id && <PermanentExampleDetail example={detail} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PermanentExampleDetail({ example }: { example: PermanentTrainingExampleRow }) {
  const lines = example.final_satellite_lines;
  const streetRuns = example.final_street_runs ?? [];
  const inputs = example.final_inputs;

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="space-y-3">
        <div>
          <div className="text-xs font-semibold text-gray-700 mb-1">
            Satellite — confirmed perimeter (
            <span style={{ color: FRONT }}>front</span> / <span style={{ color: LEFT }}>left</span> /{' '}
            <span style={{ color: RIGHT }}>right</span> / <span style={{ color: BACK }}>back</span>)
            {example.satellite_feet_per_pixel ? ` — ${example.satellite_feet_per_pixel.toFixed(4)} ft/px` : ''}
          </div>
          <AnnotatedPhoto
            src={`data:${example.satellite_media_type};base64,${example.satellite_photo_base64}`}
            alt="Satellite photo with confirmed perimeter overlay"
            lineGroups={[
              { color: FRONT, segments: lines.front },
              { color: LEFT, segments: lines.left },
              { color: RIGHT, segments: lines.right },
              { color: BACK, segments: lines.back },
            ]}
          />
        </div>
        {example.street_photo_base64 && example.street_media_type && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Street — confirmed runs</div>
            <AnnotatedPhoto
              src={`data:${example.street_media_type};base64,${example.street_photo_base64}`}
              alt="Street photo with confirmed run overlay"
              lineGroups={(['front', 'left', 'right'] as const).map((side) => ({
                color: SIDE_COLORS[side],
                segments: streetRuns.filter((r) => r.side === side),
              }))}
            />
          </div>
        )}
      </div>
      <div className="text-xs space-y-2 text-gray-600">
        {inputs && (
          <div>
            <div className="font-semibold text-gray-700">Footage / corners at capture time (context only)</div>
            <div>
              Front {inputs.frontFootage}ft ({inputs.frontCorners} corners) · Left {inputs.leftFootage}ft (
              {inputs.leftCorners}) · Right {inputs.rightFootage}ft ({inputs.rightCorners}) · Back{' '}
              {inputs.backFootage}ft ({inputs.backCorners})
            </div>
            {inputs.extensions && (
              <div className="mt-0.5">
                Extensions 3&apos; {inputs.extensions.e3} · 5&apos; {inputs.extensions.e5} · 10&apos;{' '}
                {inputs.extensions.e10} · 25&apos; {inputs.extensions.e25}
                {typeof inputs.splittersNeeded === 'number' && <> · Splitters {inputs.splittersNeeded}</>}
              </div>
            )}
          </div>
        )}
        <div>
          <div className="font-semibold text-gray-700">Provenance</div>
          <div>
            {example.original_analysis
              ? 'Has the AI’s original satellite trace (for future seed-vs-final comparison).'
              : 'No AI run — fully manual design.'}
            {example.quote_id && (
              <>
                {' '}
                <Link href={`/quote/${example.quote_id}`} className="text-blue-600 hover:underline">
                  Open the quote ↗
                </Link>
              </>
            )}
          </div>
        </div>
        <details>
          <summary className="cursor-pointer font-semibold text-gray-700">Raw JSON</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all bg-white border border-gray-200 rounded p-2 text-[10px] max-h-64 overflow-auto">
            {JSON.stringify(
              { final_satellite_lines: lines, final_street_runs: streetRuns, original_analysis: example.original_analysis },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
    </div>
  );
}
