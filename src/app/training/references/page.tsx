'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import type { StoredReferenceAsset, ReferenceAssetType } from '@/lib/referenceAssets';

const SPRITZER_SIZES = ['16', '24', '32'];
const WREATH_SIZES = ['24noble', '30noble', '36noble', '48noble', '60noble', '72noble'];
const WREATH_TIERS = ['bow', 'fullDecor'];
const GARLAND_SIZES = ['9ft', '6ft'];
const GARLAND_TIERS = ['bow', 'fullDecor'];

async function fileToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mediaType: file.type || 'image/jpeg' };
}

export default function ReferenceLibraryPage() {
  const [items, setItems] = useState<StoredReferenceAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetType, setAssetType] = useState<ReferenceAssetType>('wreath');
  const [size, setSize] = useState<string>('30noble');
  const [tier, setTier] = useState<string>('bow');
  const [caption, setCaption] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/references');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    // defer the initial load so refresh()'s setLoading isn't synchronous in the effect
    queueMicrotask(refresh);
  }, []);

  // Reset size/tier defaults when type changes
  useEffect(() => {
    // defer the reset so these state updates aren't synchronous in the effect body
    queueMicrotask(() => {
      if (assetType === 'spritzer') { setSize('24'); setTier(''); }
      else if (assetType === 'wreath') { setSize('30noble'); setTier('bow'); }
      else { setSize('9ft'); setTier('bow'); }
    });
  }, [assetType]);

  const sizeOptions = assetType === 'spritzer' ? SPRITZER_SIZES
    : assetType === 'wreath' ? WREATH_SIZES
    : GARLAND_SIZES;
  const tierOptions = assetType === 'spritzer' ? []
    : assetType === 'wreath' ? WREATH_TIERS
    : GARLAND_TIERS;

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError('Pick a photo first'); return; }
    setUploading(true);
    setError(null);
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const res = await fetch('/api/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetType,
          size,
          tier: tier || null,
          base64,
          mediaType,
          caption: caption || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      if (fileRef.current) fileRef.current.value = '';
      setCaption('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this reference image?')) return;
    const res = await fetch(`/api/references/${id}`, { method: 'DELETE' });
    if (res.ok) refresh();
    else alert('Delete failed');
  };

  const grouped: Record<ReferenceAssetType, StoredReferenceAsset[]> = {
    wreath: items.filter(i => i.asset_type === 'wreath'),
    spritzer: items.filter(i => i.asset_type === 'spritzer'),
    garland: items.filter(i => i.asset_type === 'garland'),
  };

  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Product Reference Library</h1>
            <p className="text-sm text-gray-500 mt-1">
              Upload canonical photos of what each wreath, spritzer, and garland looks like. Claude will use these as
              &quot;this is what a 30&quot; noble wreath looks like&quot; context when analyzing houses.
            </p>
          </div>
          <Link href="/training" className="text-sm text-blue-600 hover:underline">← Back to Training</Link>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-6">
          <h2 className="font-semibold text-gray-900 mb-3">Add Reference Photo</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
            <label className="text-xs text-gray-600">
              Type
              <select
                value={assetType}
                onChange={e => setAssetType(e.target.value as ReferenceAssetType)}
                className="w-full mt-1 border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
              >
                <option value="wreath">Wreath</option>
                <option value="spritzer">Spritzer</option>
                <option value="garland">Garland</option>
              </select>
            </label>
            <label className="text-xs text-gray-600">
              Size
              <select
                value={size}
                onChange={e => setSize(e.target.value)}
                className="w-full mt-1 border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
              >
                {sizeOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {tierOptions.length > 0 && (
              <label className="text-xs text-gray-600">
                Tier
                <select
                  value={tier}
                  onChange={e => setTier(e.target.value)}
                  className="w-full mt-1 border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
                >
                  {tierOptions.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
            )}
            <label className="text-xs text-gray-600">
              Photo
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="w-full mt-1 text-sm"
              />
            </label>
          </div>
          <label className="text-xs text-gray-600 block mb-3">
            Caption (optional — e.g. &quot;30in noble fir, red bow, installed on front door&quot;)
            <input
              value={caption}
              onChange={e => setCaption(e.target.value)}
              className="w-full mt-1 border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={upload}
              disabled={uploading}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded"
            >
              {uploading ? 'Uploading…' : 'Add Reference'}
            </button>
            {error && <span className="text-sm text-red-600 self-center">{error}</span>}
          </div>
        </div>

        {loading && <p className="text-sm text-gray-500">Loading…</p>}

        {(['wreath', 'spritzer', 'garland'] as ReferenceAssetType[]).map(t => (
          <div key={t} className="mb-6">
            <h2 className="font-semibold text-gray-900 mb-2 capitalize">
              {t}s ({grouped[t].length})
            </h2>
            {grouped[t].length === 0 ? (
              <p className="text-xs text-gray-400 italic">No {t} references yet.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
                {grouped[t].map(a => (
                  <div key={a.id} className="bg-white border border-gray-200 rounded overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${a.media_type};base64,${a.base64}`}
                      alt={a.caption ?? a.size}
                      className="w-full h-32 object-cover"
                    />
                    <div className="p-2 text-xs">
                      <div className="font-medium text-gray-900">
                        {a.size}{a.tier ? ` · ${a.tier}` : ''}
                      </div>
                      {a.caption && <div className="text-gray-500 truncate">{a.caption}</div>}
                      <button
                        onClick={() => remove(a.id)}
                        className="text-red-500 hover:underline mt-1"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </OperatorShell>
  );
}
