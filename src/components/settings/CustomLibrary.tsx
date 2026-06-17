'use client';

// Custom graphic library manager (#32 Phase 3) for the /settings Custom tab —
// upload / preview / delete the global custom-item graphics outside the editor.
// Backed by /api/uploads (the editor's Custom tool uses the same endpoints).

import { useEffect, useRef, useState } from 'react';
import type { CustomUpload } from '@/lib/design/sceneTypes';

export function CustomLibrary() {
  const [uploads, setUploads] = useState<CustomUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/uploads');
        if (!cancelled && r.ok) setUploads(await r.json());
      } catch {
        /* leave empty on failure */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus('Uploading…');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/api/uploads', { method: 'POST', body: fd });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error ?? `HTTP ${r.status}`);
      }
      const entry = (await r.json()) as CustomUpload;
      setUploads((u) => [entry, ...u]);
      setStatus('Uploaded');
      window.setTimeout(() => setStatus((s) => (s === 'Uploaded' ? null : s)), 1500);
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  };

  const onDelete = async (id: string, filename: string) => {
    if (!window.confirm(`Remove "${filename}" from the library? Already-placed copies stay on their designs.`)) return;
    setStatus('Deleting…');
    try {
      const r = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUploads((u) => u.filter((x) => x.id !== id));
      setStatus('Deleted');
      window.setTimeout(() => setStatus((s) => (s === 'Deleted' ? null : s)), 1500);
    } catch (err) {
      setStatus(`Delete failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  };

  return (
    <div className="border border-gray-200 rounded-md p-3 mt-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold text-gray-800">Custom graphic library</h3>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-3 py-1.5"
        >
          + Upload image
        </button>
      </div>
      <p className="text-[11px] text-gray-400 mb-3">
        Uploaded graphics are available in every design&apos;s Custom tool. Removing one here doesn&apos;t
        affect copies already placed on designs.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        className="hidden"
        onChange={onUpload}
      />
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : uploads.length === 0 ? (
        <p className="text-sm text-gray-400">No graphics yet. Click “+ Upload image” to add one.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {uploads.map((u) => (
            <div key={u.id} className="relative border border-gray-200 rounded p-1">
              <div className="aspect-square flex items-center justify-center bg-gray-50 rounded overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u.url} alt={u.filename} className="max-w-full max-h-full object-contain" />
              </div>
              <div className="text-[10px] text-gray-500 truncate mt-1" title={u.filename}>
                {u.filename}
              </div>
              <button
                type="button"
                onClick={() => onDelete(u.id, u.filename)}
                title="Remove from library"
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-white/90 border border-gray-300 text-gray-500 hover:text-red-600 leading-none"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {status && <p className="text-xs text-gray-500 mt-2">{status}</p>}
    </div>
  );
}
