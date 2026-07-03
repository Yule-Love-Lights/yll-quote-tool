'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TrainingListItem } from '@/lib/training';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

export default function TrainingListPage() {
  const [items, setItems] = useState<TrainingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/training');
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
    // Kick off the initial load in a microtask so refresh()'s loading-state
    // update isn't dispatched synchronously within the effect. Microtasks flush
    // before paint, so there's no visible flash.
    queueMicrotask(refresh);
  }, []);

  const remove = async (id: string) => {
    if (!confirm('Delete this training record? This cannot be undone.')) return;
    const res = await fetch(`/api/training/${id}`, { method: 'DELETE' });
    if (res.ok) refresh();
    else alert('Delete failed');
  };

  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <SettingsSubNav active="training" />
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">AI Training Database</h1>
            <p className="text-sm text-gray-500 mt-1">
              Historical jobs with confirmed measurements. Each entry makes Claude more accurate for Long Island houses.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/training/examples"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              Training Examples
            </Link>
            <Link
              href="/training/references"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              Product Library
            </Link>
            <Link
              href="/training/new"
              className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-4 py-2 rounded-md"
            >
              + Add Completed Job
            </Link>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {!loading && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <p className="text-gray-500 mb-4">No training data yet.</p>
            <Link
              href="/training/new"
              className="bg-green-600 hover:bg-green-700 text-white font-medium text-sm px-4 py-2 rounded-md"
            >
              Add your first completed job
            </Link>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map(h => (
            <div key={h.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden flex flex-col">
              {h.thumbnail ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`data:${h.thumbnail.mediaType};base64,${h.thumbnail.base64}`}
                  alt={h.address ?? 'House'}
                  className="w-full h-40 object-cover"
                />
              ) : (
                <div className="w-full h-40 bg-gray-100 flex items-center justify-center text-gray-400 text-sm">
                  No photo
                </div>
              )}
              <div className="p-3 flex-1 flex flex-col gap-1.5">
                <p className="font-semibold text-sm text-gray-900 truncate">{h.address ?? 'No address'}</p>
                <div className="text-xs text-gray-500 flex gap-2 flex-wrap">
                  {h.year_completed && <span>{h.year_completed}</span>}
                  {h.house_style && <span>· {h.house_style}</span>}
                  {h.photoCount > 1 && <span>· {h.photoCount} photos</span>}
                </div>
                <div className="text-xs text-gray-700 grid grid-cols-2 gap-1 mt-1">
                  <span>Front: <strong>{h.santas_footage ?? '—'}ft</strong></span>
                  <span>Ridge+Sides: <strong>{h.gingerbread_footage ?? '—'}ft</strong></span>
                  <span>Bushes/Trees: <strong>{h.mini_light_detections.length}</strong></span>
                  <span>Wreaths: <strong>{h.wreaths.reduce((s, w) => s + w.quantity, 0)}</strong></span>
                </div>
                <div className="mt-auto pt-2 flex justify-end text-xs">
                  <button onClick={() => remove(h.id)} className="text-red-500 hover:underline">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </OperatorShell>
  );
}
