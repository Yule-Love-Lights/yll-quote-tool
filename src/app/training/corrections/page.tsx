'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CorrectionListItem, StoredCorrection } from '@/lib/corrections';

// Review page for saved quote corrections. Shows the measurements Claude
// learned from and lets you delete a bad one before it biases future quotes.
// Keep this simple — it's an internal audit tool, not a customer-facing UI.
export default function CorrectionsListPage() {
  const [items, setItems] = useState<CorrectionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StoredCorrection | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/corrections');
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

  const expand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/corrections/${id}`);
      const data = await res.json();
      if (res.ok) setDetail(data.correction as StoredCorrection);
    } finally {
      setLoadingDetail(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this correction? Claude will stop using it as a learning example.')) return;
    const res = await fetch(`/api/corrections/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (expandedId === id) { setExpandedId(null); setDetail(null); }
      refresh();
    } else {
      alert('Delete failed');
    }
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Saved Corrections</h1>
            <p className="text-sm text-gray-500 mt-1">
              Measurements you saved from the quote page. Each one teaches Claude. Delete any that were wrong before they bias future quotes.
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/training"
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
            >
              ← Training Houses
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
            <p className="text-gray-500">No corrections saved yet.</p>
            <p className="text-xs text-gray-400 mt-2">
              When you click &ldquo;Save as training example&rdquo; on a quote, it shows up here.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {items.map(c => {
            const isOpen = expandedId === c.id;
            const wreaths = c.corrected_wreath_detections?.length ?? 0;
            const spritzers = c.corrected_spritzer_detections?.length ?? 0;
            const garland = c.corrected_garland_detections?.length ?? 0;
            const mini = c.corrected_mini_light_detections?.length ?? 0;
            return (
              <div key={c.id} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => expand(c.id)}
                  className="w-full text-left p-3 hover:bg-gray-50 flex items-center justify-between gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500">{fmtDate(c.created_at)}</div>
                    <div className="text-sm text-gray-900 mt-0.5 flex gap-3 flex-wrap">
                      <span>Gutter <strong>{c.corrected_santas_footage}ft</strong> ({c.corrected_santas_difficulty})</span>
                      <span>Ridge <strong>{c.corrected_gingerbread_footage}ft</strong> ({c.corrected_gingerbread_difficulty})</span>
                      {(c.corrected_winter_wonderland_footage ?? 0) > 0 && (
                        <span>C9 <strong>{c.corrected_winter_wonderland_footage}ft</strong></span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {mini} mini · {wreaths} wreath · {spritzers} spritzer · {garland} garland
                      {c.notes && <> · <em>&ldquo;{c.notes}&rdquo;</em></>}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <span className="text-xs text-blue-600">{isOpen ? '▼ Hide' : '▶ View'}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); remove(c.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Delete
                    </button>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-gray-200 p-3 bg-gray-50">
                    {loadingDetail && <p className="text-xs text-gray-500">Loading photo…</p>}
                    {detail && detail.id === c.id && (
                      <div className="grid md:grid-cols-2 gap-4">
                        <div>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`data:${detail.photo_media_type};base64,${detail.photo_base64}`}
                            alt="Corrected photo"
                            className="w-full rounded border border-gray-300"
                          />
                        </div>
                        <div className="text-xs space-y-2">
                          <Section label="Santa's Roofline (gutter)">
                            <div>{detail.corrected_santas_footage} ft · {detail.corrected_santas_difficulty}</div>
                            <LineList lines={detail.corrected_santas_lines} />
                          </Section>
                          <Section label="Gingerbread Ridge">
                            <div>{detail.corrected_gingerbread_footage} ft · {detail.corrected_gingerbread_difficulty}</div>
                            <LineList lines={detail.corrected_gingerbread_lines} />
                          </Section>
                          {(detail.corrected_winter_wonderland_footage ?? 0) > 0 && (
                            <Section label="Winter Wonderland (C9)">
                              <div>{detail.corrected_winter_wonderland_footage} ft</div>
                              <LineList lines={detail.corrected_c9_lines ?? []} />
                            </Section>
                          )}
                          {(detail.corrected_mini_light_detections?.length ?? 0) > 0 && (
                            <Section label={`Mini Lights (${detail.corrected_mini_light_detections.length})`}>
                              <ul className="list-disc pl-4">
                                {detail.corrected_mini_light_detections.map((d, i) => (
                                  <li key={i}>{d.label} — {d.stringCount} string{d.stringCount === 1 ? '' : 's'} ({d.type}/{d.wrapStyle})</li>
                                ))}
                              </ul>
                            </Section>
                          )}
                          {(detail.corrected_wreath_detections?.length ?? 0) > 0 && (
                            <Section label={`Wreaths (${detail.corrected_wreath_detections!.length})`}>
                              <ul className="list-disc pl-4">
                                {detail.corrected_wreath_detections!.map((d, i) => (
                                  <li key={i}>{d.label} — {d.size}/{d.tier}</li>
                                ))}
                              </ul>
                            </Section>
                          )}
                          {(detail.corrected_spritzer_detections?.length ?? 0) > 0 && (
                            <Section label={`Spritzers (${detail.corrected_spritzer_detections!.length})`}>
                              <ul className="list-disc pl-4">
                                {detail.corrected_spritzer_detections!.map((d, i) => (
                                  <li key={i}>{d.label} — {d.size}in</li>
                                ))}
                              </ul>
                            </Section>
                          )}
                          {(detail.corrected_garland_detections?.length ?? 0) > 0 && (
                            <Section label={`Garland (${detail.corrected_garland_detections!.length})`}>
                              <ul className="list-disc pl-4">
                                {detail.corrected_garland_detections!.map((d, i) => (
                                  <li key={i}>{d.label} — {d.length}/{d.tier}</li>
                                ))}
                              </ul>
                            </Section>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-semibold text-gray-700">{label}</div>
      <div className="text-gray-600">{children}</div>
    </div>
  );
}

function LineList({ lines }: { lines: { label: string }[] }) {
  if (!lines || lines.length === 0) return <div className="text-gray-400 italic">no segments</div>;
  return (
    <ul className="list-disc pl-4">
      {lines.map((l, i) => <li key={i}>{l.label}</li>)}
    </ul>
  );
}
