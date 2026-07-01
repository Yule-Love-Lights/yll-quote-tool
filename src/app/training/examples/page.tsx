'use client';

// Review page for scene-based training examples (#8 Stage A) — the snapshots
// captured automatically at Send-to-customer (or via the builder's manual
// button). Each example = street photo + satellite + the staff's FINAL design,
// drawn with overlays so a bad capture is obvious at a glance. The "Exclude"
// toggle parks an oddball out of the AI's few-shot without deleting it.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  TrainingExampleListItem,
  TrainingExampleRow,
  TrainingExampleInputs,
} from '@/lib/trainingExamples';
import {
  editableItems,
  SPRITZER_SIZES,
  WREATH_SIZES,
  GARLAND_LENGTHS,
  TIERS,
  type ItemCorrection,
} from '@/lib/design/sceneCorrections';
import { sceneToFewShotPieces } from '@/lib/design/sceneToFewShot';
import AnnotatedPhoto, { type OverlayBox } from '@/components/training/AnnotatedPhoto';
import { OperatorShell } from '@/components/OperatorShell';

const RED = '#ef4444'; // Santa's / front
const BLUE = '#3b82f6'; // Gingerbread / ridge+sides
const AMBER = '#f59e0b'; // C9 / Winter Wonderland
const GREEN = '#22c55e'; // mini-light detections
const PURPLE = '#a855f7'; // wreaths/spritzers/garland

const tierLabel = (t: string) => (t === 'bow' ? 'Non-Decorated' : 'Decorated');
const wreathLabel = (s: string) => s.replace('noble', '” Noble'); // 24noble → 24” Noble

export default function TrainingExamplesPage() {
  const [items, setItems] = useState<TrainingExampleListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrainingExampleRow | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Latest expand request — guards against a slow earlier fetch overwriting a
  // newer one (or a closed panel) when responses land out of order.
  const detailReqRef = useRef(0);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/training-examples');
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
      const res = await fetch(`/api/training-examples/${id}`);
      const data = await res.json().catch(() => ({}));
      if (reqId !== detailReqRef.current) return; // superseded — ignore
      if (res.ok) setDetail(data.example as TrainingExampleRow);
      else setDetailError(data.error ?? `Failed to load (${res.status})`);
    } catch (err) {
      if (reqId === detailReqRef.current) {
        setDetailError(err instanceof Error ? err.message : 'Failed to load');
      }
    } finally {
      if (reqId === detailReqRef.current) setLoadingDetail(false);
    }
  };

  const toggleExcluded = async (item: TrainingExampleListItem) => {
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/training-examples/${item.id}`, {
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
    const res = await fetch(`/api/training-examples/${id}`, { method: 'DELETE' });
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

  // #52 — after an inline edit saves, re-pull the open detail (so the overlays +
  // derived counts reflect the correction) and refresh the list (row footage).
  const reloadDetail = async (id: string) => {
    const reqId = ++detailReqRef.current;
    try {
      const res = await fetch(`/api/training-examples/${id}`);
      const data = await res.json().catch(() => ({}));
      if (reqId !== detailReqRef.current) return;
      if (res.ok) setDetail(data.example as TrainingExampleRow);
    } finally {
      refresh();
    }
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Training Examples</h1>
            <p className="text-sm text-gray-500 mt-1">
              Captured automatically when a quote is sent (or via the builder&rsquo;s save button).
              Street + satellite photos with the staff-final design — these teach the AI. Exclude
              oddballs so they don&rsquo;t bias future quotes.
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
            <p className="text-gray-500">No training examples captured yet.</p>
            <p className="text-xs text-gray-400 mt-2">
              Send a quote to the customer (or click &ldquo;Save as training example&rdquo; on the
              quote page) and it shows up here.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {items.map((ex) => {
            const isOpen = expandedId === ex.id;
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
                      {ex.has_satellite && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-600">
                          🛰 satellite
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
                      Front <strong>{ex.final_inputs.santasFootage}ft</strong> ({ex.final_inputs.santasDifficulty}) ·
                      Ridge+Sides <strong>{ex.final_inputs.gingerbreadFootage}ft</strong> ({ex.final_inputs.gingerbreadDifficulty})
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
                    {detail && detail.id === ex.id && (
                      <ExampleDetail example={detail} onSaved={() => reloadDetail(ex.id)} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </OperatorShell>
  );
}

function ExampleDetail({ example, onSaved }: { example: TrainingExampleRow; onSaved: () => void }) {
  const pieces = sceneToFewShotPieces(
    example.final_scene,
    example.street_w ?? 0,
    example.street_h ?? 0,
  );
  const boxes: OverlayBox[] = [
    ...pieces.miniLightDetections.map((d) => ({ color: GREEN, box: d.box, label: d.label })),
    ...pieces.wreathDetections.map((d) => ({ color: PURPLE, box: d.box, label: d.label })),
    ...pieces.spritzerDetections.map((d) => ({ color: PURPLE, box: d.box, label: d.label })),
    ...pieces.garlandDetections.map((d) => ({ color: PURPLE, box: d.box, label: d.label })),
  ];
  const sat = example.satellite_lines;

  // #52 — inline edit of the numbers the AI learns: roofline footage/difficulty
  // + per-item detections (mini strand counts, spritzer/wreath size, tier,
  // garland length). Saves to the frozen snapshot.
  const editItems = editableItems(example.final_scene);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrainingExampleInputs>(example.final_inputs);
  const [corr, setCorr] = useState<Record<string, ItemCorrection>>({});

  const startEdit = () => {
    setDraft(example.final_inputs);
    // Seed each editable item with its current values so unchanged items save
    // as-is (re-applying the same value is a no-op) and the controls are simple.
    const seed: Record<string, ItemCorrection> = {};
    for (const it of editItems) {
      if (it.kind === 'mini') seed[it.id] = { stringCount: it.stringCount };
      else if (it.kind === 'spritzer') seed[it.id] = { quoteSize: it.quoteSize };
      else if (it.kind === 'wreath') seed[it.id] = { quoteSize: it.quoteSize, tier: it.tier };
      else seed[it.id] = { quoteLength: it.quoteLength, tier: it.tier };
    }
    setCorr(seed);
    setSaveErr(null);
    setEditing(true);
  };
  const setFootage = (k: keyof TrainingExampleInputs, v: string) =>
    setDraft((d) => ({ ...d, [k]: Math.max(0, Math.round(Number(v) || 0)) }));
  const setDifficulty = (
    k: 'santasDifficulty' | 'gingerbreadDifficulty',
    v: 'easy' | 'medium' | 'hard',
  ) => setDraft((d) => ({ ...d, [k]: v }));
  const bump = (id: string, delta: number) =>
    setCorr((c) => ({ ...c, [id]: { ...c[id], stringCount: Math.max(1, (c[id]?.stringCount ?? 1) + delta) } }));
  const setField = (id: string, patch: Partial<ItemCorrection>) =>
    setCorr((c) => ({ ...c, [id]: { ...c[id], ...patch } }));

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch(`/api/training-examples/${example.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finalInputs: draft, itemCorrections: corr }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setEditing(false);
      onSaved();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="space-y-3">
        {example.street_photo_base64 && example.street_media_type && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">
              Street — staff-final design (<span style={{ color: RED }}>front</span> /{' '}
              <span style={{ color: BLUE }}>ridge+sides</span> lines, detection boxes)
            </div>
            <AnnotatedPhoto
              src={`data:${example.street_media_type};base64,${example.street_photo_base64}`}
              alt="Street photo with final design overlay"
              lineGroups={[
                { color: RED, segments: pieces.santasLines },
                { color: BLUE, segments: pieces.gingerbreadLines },
              ]}
              boxes={boxes}
            />
          </div>
        )}
        {example.satellite_base64 && example.satellite_media_type && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">
              Satellite — staff-confirmed measurement lines
              {example.satellite_feet_per_pixel
                ? ` (${example.satellite_feet_per_pixel.toFixed(4)} ft/px)`
                : ' (manual upload — no scale)'}
            </div>
            <AnnotatedPhoto
              src={`data:${example.satellite_media_type};base64,${example.satellite_base64}`}
              alt="Satellite photo with measurement overlay"
              lineGroups={[
                { color: RED, segments: sat?.santas ?? [] },
                { color: BLUE, segments: sat?.gingerbread ?? [] },
                { color: AMBER, segments: sat?.c9 ?? [] },
                { color: PURPLE, segments: sat?.stake ?? [] },
              ]}
            />
          </div>
        )}
      </div>
      <div className="text-xs space-y-2 text-gray-600">
        {!editing ? (
          <>
            <div>
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-700">Final measurements (what the AI learns)</div>
                <button onClick={startEdit} className="text-blue-600 hover:underline">✎ Edit</button>
              </div>
              <div>
                Front {example.final_inputs.santasFootage} ft ({example.final_inputs.santasDifficulty}) ·
                Ridge+Sides {example.final_inputs.gingerbreadFootage} ft ({example.final_inputs.gingerbreadDifficulty})
                {(example.final_inputs.winterWonderlandFootage ?? 0) > 0 && (
                  <> · C9 {example.final_inputs.winterWonderlandFootage} ft</>
                )}
                {(example.final_inputs.stakeLightingFootage ?? 0) > 0 && (
                  <> · Stake {example.final_inputs.stakeLightingFootage} ft</>
                )}
              </div>
              {sat?.santasFootage != null && (
                <div>
                  Satellite-derived: front {sat.santasFootage} ft · ridge+sides {sat.gingerbreadFootage ?? '—'} ft
                </div>
              )}
            </div>
            <div>
              <div className="font-semibold text-gray-700">Items from the final design</div>
              <div>
                {pieces.miniLightDetections.length} mini · {pieces.wreathDetections.length} wreath ·{' '}
                {pieces.spritzerDetections.length} spritzer · {pieces.garlandDetections.length} garland
              </div>
              {(pieces.miniLightDetections.length > 0 ||
                pieces.wreathDetections.length > 0 ||
                pieces.spritzerDetections.length > 0 ||
                pieces.garlandDetections.length > 0) && (
                <ul className="list-disc pl-4 mt-1">
                  {pieces.miniLightDetections.map((d, i) => (
                    <li key={`m${i}`}>{d.label} ({d.wrapStyle})</li>
                  ))}
                  {pieces.wreathDetections.map((d, i) => (
                    <li key={`w${i}`}>{d.label} — {d.tier}</li>
                  ))}
                  {pieces.spritzerDetections.map((d, i) => (
                    <li key={`s${i}`}>{d.label}</li>
                  ))}
                  {pieces.garlandDetections.map((d, i) => (
                    <li key={`g${i}`}>{d.label} — {d.tier}</li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-2 border border-blue-200 bg-blue-50 rounded p-2">
            <div className="font-semibold text-gray-700">Correct the measurements the AI learns</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5">
                Front (Santa&rsquo;s) ft
                <input type="number" min={0} value={draft.santasFootage}
                  onChange={(e) => setFootage('santasFootage', e.target.value)}
                  className="border border-gray-300 rounded px-1.5 py-0.5" />
              </label>
              <label className="flex flex-col gap-0.5">
                Front difficulty
                <select value={draft.santasDifficulty}
                  onChange={(e) => setDifficulty('santasDifficulty', e.target.value as 'easy' | 'medium' | 'hard')}
                  className="border border-gray-300 rounded px-1.5 py-0.5">
                  <option value="easy">easy</option><option value="medium">medium</option><option value="hard">hard</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                Ridge+Sides (Gingerbread) ft
                <input type="number" min={0} value={draft.gingerbreadFootage}
                  onChange={(e) => setFootage('gingerbreadFootage', e.target.value)}
                  className="border border-gray-300 rounded px-1.5 py-0.5" />
              </label>
              <label className="flex flex-col gap-0.5">
                Ridge+Sides difficulty
                <select value={draft.gingerbreadDifficulty}
                  onChange={(e) => setDifficulty('gingerbreadDifficulty', e.target.value as 'easy' | 'medium' | 'hard')}
                  className="border border-gray-300 rounded px-1.5 py-0.5">
                  <option value="easy">easy</option><option value="medium">medium</option><option value="hard">hard</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                C9 (Winter Wonderland) ft
                <input type="number" min={0} value={draft.winterWonderlandFootage ?? 0}
                  onChange={(e) => setFootage('winterWonderlandFootage', e.target.value)}
                  className="border border-gray-300 rounded px-1.5 py-0.5" />
              </label>
              <label className="flex flex-col gap-0.5">
                Stake ft
                <input type="number" min={0} value={draft.stakeLightingFootage ?? 0}
                  onChange={(e) => setFootage('stakeLightingFootage', e.target.value)}
                  className="border border-gray-300 rounded px-1.5 py-0.5" />
              </label>
            </div>
            {editItems.length > 0 && (
              <div>
                <div className="font-semibold text-gray-700">Detections (what the AI learns)</div>
                <div className="space-y-1 mt-1">
                  {editItems.map((it) => {
                    if (it.kind === 'mini') {
                      return (
                        <div key={it.id} className="flex items-center gap-2">
                          <span className="capitalize w-20">{it.surface}</span>
                          <button type="button" onClick={() => bump(it.id, -1)}
                            className="border border-gray-300 rounded w-6 h-6 leading-none bg-white">−</button>
                          <span className="w-6 text-center tabular-nums">{corr[it.id]?.stringCount ?? it.stringCount}</span>
                          <button type="button" onClick={() => bump(it.id, 1)}
                            className="border border-gray-300 rounded w-6 h-6 leading-none bg-white">+</button>
                          <span className="text-gray-400">strings</span>
                          {it.surface === 'curtain' && (
                            <span className="text-[10px] text-amber-600" title="Saved for the future — the analyzer doesn't detect curtains yet, so this doesn't change AI training.">
                              stored · not yet AI-trained
                            </span>
                          )}
                        </div>
                      );
                    }
                    if (it.kind === 'spritzer') {
                      return (
                        <div key={it.id} className="flex items-center gap-2">
                          <span className="w-20">Spritzer</span>
                          <select value={corr[it.id]?.quoteSize ?? it.quoteSize}
                            onChange={(e) => setField(it.id, { quoteSize: e.target.value })}
                            className="border border-gray-300 rounded px-1.5 py-0.5 bg-white">
                            {SPRITZER_SIZES.map((s) => <option key={s} value={s}>{s}&Prime;</option>)}
                          </select>
                        </div>
                      );
                    }
                    if (it.kind === 'wreath') {
                      return (
                        <div key={it.id} className="flex items-center gap-2 flex-wrap">
                          <span className="w-20">Wreath</span>
                          <select value={corr[it.id]?.quoteSize ?? it.quoteSize}
                            onChange={(e) => setField(it.id, { quoteSize: e.target.value })}
                            className="border border-gray-300 rounded px-1.5 py-0.5 bg-white">
                            {WREATH_SIZES.map((s) => <option key={s} value={s}>{wreathLabel(s)}</option>)}
                          </select>
                          <select value={corr[it.id]?.tier ?? it.tier}
                            onChange={(e) => setField(it.id, { tier: e.target.value })}
                            className="border border-gray-300 rounded px-1.5 py-0.5 bg-white">
                            {TIERS.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
                          </select>
                        </div>
                      );
                    }
                    // garland
                    return (
                      <div key={it.id} className="flex items-center gap-2 flex-wrap">
                        <span className="w-20">Garland</span>
                        <select value={corr[it.id]?.quoteLength ?? it.quoteLength}
                          onChange={(e) => setField(it.id, { quoteLength: e.target.value })}
                          className="border border-gray-300 rounded px-1.5 py-0.5 bg-white">
                          {GARLAND_LENGTHS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                        <select value={corr[it.id]?.tier ?? it.tier}
                          onChange={(e) => setField(it.id, { tier: e.target.value })}
                          className="border border-gray-300 rounded px-1.5 py-0.5 bg-white">
                          {TIERS.map((t) => <option key={t} value={t}>{tierLabel(t)}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {saveErr && <p className="text-red-600">{saveErr}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={saving}
                className="bg-green-600 text-white rounded px-3 py-1 disabled:bg-green-300">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(false)} disabled={saving}
                className="border border-gray-300 rounded px-3 py-1 bg-white">Cancel</button>
            </div>
          </div>
        )}
        <div>
          <div className="font-semibold text-gray-700">Provenance</div>
          <div>
            {example.original_analysis
              ? 'Has the AI’s original analysis (for future seed-vs-final comparison).'
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
      </div>
    </div>
  );
}
