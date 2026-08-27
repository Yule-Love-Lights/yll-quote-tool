'use client';

// #141 / WT-37 — review UI for permanent-lighting training examples (the
// Permanent tab on /training/examples). Mirrors the holiday tab's
// list/expand/exclude/delete shape, PLUS a corrections editor (WT-37): staff
// can now fix a mis-traced side or a bad street run instead of only being able
// to discard the whole example (Exclude/Delete). The ground truth the AI
// actually learns is the traced geometry (final_satellite_lines /
// final_street_runs — see src/lib/permanent/fewShot.ts); final_inputs
// (footage/corners/extensions) is context-only for a human reviewer, but is
// editable too for the same reason holiday's footage numbers are.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  PermanentTrainingExampleListItem,
  PermanentTrainingExampleRow,
  PermanentTrainingExampleInputs,
} from '@/lib/permanent/trainingExamples';
import type { PermanentSatelliteLines, PermanentStreetRun } from '@/lib/permanent/photoAnalysis';
import type { LineSegment, RoofFeatureClass } from '@/lib/photoAnalysis';
import AnnotatedPhoto from '@/components/training/AnnotatedPhoto';
import { TrainingRowsSkeleton } from '@/app/training/TrainingRowsSkeleton';

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
// Client-side mirror of permanent/trainingExamples.ts's sanitizeNotes cap
// (the server re-caps regardless) so the box doesn't accept more than it can
// keep.
const NOTES_MAX_LEN = 2000;

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

  // WT-37 — after a correction saves, re-pull the open detail (so the overlays +
  // list badges reflect the fix) and refresh the list (side counts). Mirrors
  // the holiday tab's reloadDetail.
  const reloadDetail = async (id: string) => {
    const reqId = ++detailReqRef.current;
    try {
      const res = await fetch(`/api/permanent-training-examples/${id}`);
      const data = await res.json().catch(() => ({}));
      if (reqId !== detailReqRef.current) return;
      if (res.ok) setDetail(data.example as PermanentTrainingExampleRow);
    } finally {
      refresh();
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

      {/* Same shared skeleton the holiday tab (this page's other panel) shows
          (row 346, mirrors row 332/#171b) — this tab mounts on first switch
          to "Permanent" and fetches, so was a bare "Loading…" line where its
          sibling panel already got the rich skeleton. */}
      {loading && <TrainingRowsSkeleton />}

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
                  {/* Row 410 judged this one a KEEP: the panel only exists because the
                      operator just clicked to expand this row, so the growth is the
                      gesture they asked for, and the detail's height depends on how many
                      photos the example has — a fixed skeleton could not match it. */}
                  {loadingDetail && <p className="text-xs text-gray-500">Loading photos…</p>}
                  {detailError && (
                    <p className="text-xs text-red-600">Couldn&rsquo;t load this example: {detailError}</p>
                  )}
                  {detail && detail.id === ex.id && (
                    <PermanentExampleDetail example={detail} onSaved={() => reloadDetail(ex.id)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Side = 'front' | 'left' | 'right' | 'back';
const SATELLITE_SIDES: Side[] = ['front', 'left', 'right', 'back'];
const FEATURE_OPTIONS: (RoofFeatureClass | '')[] = ['', 'gutter', 'peak', 'side', 'ridge', 'metal'];
type NumField =
  | 'frontFootage' | 'leftFootage' | 'rightFootage' | 'backFootage'
  | 'frontCorners' | 'leftCorners' | 'rightCorners' | 'backCorners';

type LineDraft = { label: string; pointsText: string; feature?: RoofFeatureClass };
type RunDraft = { side: 'front' | 'left' | 'right'; label: string; pointsText: string };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function pointsToText(points: [number, number][]): string {
  return points.map(([x, y]) => `${round4(x)},${round4(y)}`).join(' ');
}
// "x1,y1 x2,y2 ..." → normalized points, clamped into 0-1 (mirrors the API's
// tolerance). null = unparseable — the caller surfaces which line is broken
// instead of silently dropping or sending a corrupt patch.
function parsePointsText(text: string): [number, number][] | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const pts: [number, number][] = [];
  for (const tok of tokens) {
    const parts = tok.split(',');
    if (parts.length !== 2) return null;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]);
  }
  return pts;
}
function lineToDraft(l: LineSegment): LineDraft {
  return { label: l.label, pointsText: pointsToText(l.points), feature: l.feature };
}
function runToDraft(r: PermanentStreetRun): RunDraft {
  return { side: r.side, label: r.label, pointsText: pointsToText(r.points) };
}

// WT-37 — the corrections editor: staff can now fix a mis-traced side or a bad
// street run (the fields the AI actually learns from, per fewShot.ts) instead
// of only being able to Exclude/Delete the whole example. Points are edited as
// "x1,y1 x2,y2 ..." text (normalized 0-1, same format AnnotatedPhoto renders)
// rather than a drag-to-redraw canvas — simplest thing that lets a bad line be
// fixed or removed without losing the rest of the example's photos/geometry.
function PermanentExampleDetail({
  example,
  onSaved,
}: {
  example: PermanentTrainingExampleRow;
  onSaved: () => void;
}) {
  const lines = example.final_satellite_lines;
  const streetRuns = example.final_street_runs ?? [];
  const inputs = example.final_inputs;

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [linesDraft, setLinesDraft] = useState<Record<Side, LineDraft[]>>({ front: [], left: [], right: [], back: [] });
  const [runsDraft, setRunsDraft] = useState<RunDraft[]>([]);
  const [inputsDraft, setInputsDraft] = useState<PermanentTrainingExampleInputs | null>(inputs);
  // What did the AI get wrong here — editable from this review page too, so a
  // note captured (or skipped) at correction time isn't write-once.
  const [draftNotes, setDraftNotes] = useState(example.notes ?? '');

  const startEdit = () => {
    setLinesDraft({
      front: lines.front.map(lineToDraft),
      left: lines.left.map(lineToDraft),
      right: lines.right.map(lineToDraft),
      back: lines.back.map(lineToDraft),
    });
    setRunsDraft(streetRuns.map(runToDraft));
    setInputsDraft(inputs);
    setDraftNotes(example.notes ?? '');
    setSaveErr(null);
    setEditing(true);
  };

  const updateLine = (side: Side, idx: number, patch: Partial<LineDraft>) =>
    setLinesDraft((d) => ({ ...d, [side]: d[side].map((l, i) => (i === idx ? { ...l, ...patch } : l)) }));
  const removeLine = (side: Side, idx: number) =>
    setLinesDraft((d) => ({ ...d, [side]: d[side].filter((_, i) => i !== idx) }));
  const addLine = (side: Side) =>
    setLinesDraft((d) => ({ ...d, [side]: [...d[side], { label: '', pointsText: '' }] }));

  const updateRun = (idx: number, patch: Partial<RunDraft>) =>
    setRunsDraft((r) => r.map((run, i) => (i === idx ? { ...run, ...patch } : run)));
  const removeRun = (idx: number) => setRunsDraft((r) => r.filter((_, i) => i !== idx));
  const addRun = () => setRunsDraft((r) => [...r, { side: 'front', label: '', pointsText: '' }]);

  const setNumField = (k: NumField, v: string) =>
    setInputsDraft((d) => (d ? { ...d, [k]: Math.max(0, Math.round(Number(v) || 0)) } : d));
  const setExtension = (k: 'e3' | 'e5' | 'e10' | 'e25', v: string) =>
    setInputsDraft((d) =>
      d
        ? {
            ...d,
            extensions: {
              e3: d.extensions?.e3 ?? 0,
              e5: d.extensions?.e5 ?? 0,
              e10: d.extensions?.e10 ?? 0,
              e25: d.extensions?.e25 ?? 0,
              [k]: Math.max(0, Math.round(Number(v) || 0)),
            },
          }
        : d,
    );
  const setSplitters = (v: string) =>
    setInputsDraft((d) => (d ? { ...d, splittersNeeded: Math.max(0, Math.round(Number(v) || 0)) } : d));

  const save = async () => {
    // Parse + validate every line/run's points BEFORE sending — surface exactly
    // which one is broken instead of a generic server 400.
    const builtLines: PermanentSatelliteLines = { front: [], left: [], right: [], back: [] };
    for (const side of SATELLITE_SIDES) {
      for (const l of linesDraft[side]) {
        const points = parsePointsText(l.pointsText);
        if (!points) {
          setSaveErr(`${side}: "${l.label || '(untitled)'}" needs at least 2 valid "x,y" points`);
          return;
        }
        builtLines[side].push(l.feature ? { points, label: l.label, feature: l.feature } : { points, label: l.label });
      }
    }
    const builtRuns: PermanentStreetRun[] = [];
    for (const r of runsDraft) {
      const points = parsePointsText(r.pointsText);
      if (!points) {
        setSaveErr(`Street run (${r.side}) "${r.label || '(untitled)'}" needs at least 2 valid "x,y" points`);
        return;
      }
      builtRuns.push({ side: r.side, points, label: r.label });
    }

    setSaving(true);
    setSaveErr(null);
    try {
      const body: Record<string, unknown> = { finalSatelliteLines: builtLines, finalStreetRuns: builtRuns };
      if (inputsDraft) body.finalInputs = inputsDraft;
      body.notes = draftNotes.trim() || null;
      const res = await fetch(`/api/permanent-training-examples/${example.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        {!editing ? (
          <>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-gray-700">Traced geometry (what the AI learns)</div>
              <button onClick={startEdit} className="text-blue-600 hover:underline">✎ Edit</button>
            </div>
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
              <div className="font-semibold text-gray-700">What did the AI get wrong here?</div>
              {example.notes ? (
                <div className="italic">&ldquo;{example.notes}&rdquo;</div>
              ) : (
                <div className="text-gray-400">No note yet.</div>
              )}
            </div>
          </>
        ) : (
          <div className="space-y-3 border border-blue-200 bg-blue-50 rounded p-2">
            <div className="font-semibold text-gray-700">Correct the traced geometry (what the AI learns)</div>
            {SATELLITE_SIDES.map((side) => (
              <div key={side}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold" style={{ color: SIDE_COLORS[side] }}>{side}</span>
                  <button type="button" onClick={() => addLine(side)} className="text-blue-600 hover:underline">
                    + line
                  </button>
                </div>
                {linesDraft[side].length === 0 && <div className="text-gray-400 italic">no lines</div>}
                {linesDraft[side].map((l, idx) => (
                  <div key={idx} className="flex gap-1 items-center mb-1 flex-wrap">
                    <input
                      value={l.label}
                      onChange={(e) => updateLine(side, idx, { label: e.target.value })}
                      placeholder="label"
                      className="border border-gray-300 rounded px-1 py-0.5 w-24 bg-white"
                    />
                    <input
                      value={l.pointsText}
                      onChange={(e) => updateLine(side, idx, { pointsText: e.target.value })}
                      placeholder="x1,y1 x2,y2 ..."
                      className="border border-gray-300 rounded px-1 py-0.5 flex-1 min-w-[10rem] font-mono bg-white"
                    />
                    <select
                      value={l.feature ?? ''}
                      onChange={(e) =>
                        updateLine(side, idx, { feature: (e.target.value || undefined) as RoofFeatureClass | undefined })
                      }
                      className="border border-gray-300 rounded px-1 py-0.5 bg-white"
                    >
                      {FEATURE_OPTIONS.map((f) => (
                        <option key={f} value={f}>{f || '(feature)'}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => removeLine(side, idx)} className="text-red-500 hover:underline px-1">
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ))}

            <div>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-gray-700">Street runs</span>
                <button type="button" onClick={addRun} className="text-blue-600 hover:underline">
                  + run
                </button>
              </div>
              {runsDraft.length === 0 && <div className="text-gray-400 italic">no runs</div>}
              {runsDraft.map((r, idx) => (
                <div key={idx} className="flex gap-1 items-center mb-1 flex-wrap">
                  <select
                    value={r.side}
                    onChange={(e) => updateRun(idx, { side: e.target.value as RunDraft['side'] })}
                    className="border border-gray-300 rounded px-1 py-0.5 bg-white"
                  >
                    <option value="front">front</option>
                    <option value="left">left</option>
                    <option value="right">right</option>
                  </select>
                  <input
                    value={r.label}
                    onChange={(e) => updateRun(idx, { label: e.target.value })}
                    placeholder="label"
                    className="border border-gray-300 rounded px-1 py-0.5 w-20 bg-white"
                  />
                  <input
                    value={r.pointsText}
                    onChange={(e) => updateRun(idx, { pointsText: e.target.value })}
                    placeholder="x1,y1 x2,y2 ..."
                    className="border border-gray-300 rounded px-1 py-0.5 flex-1 min-w-[10rem] font-mono bg-white"
                  />
                  <button type="button" onClick={() => removeRun(idx)} className="text-red-500 hover:underline px-1">
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {inputsDraft && (
              <div>
                <div className="font-semibold text-gray-700">Footage / corners (context only — not fed to the AI)</div>
                <div className="grid grid-cols-2 gap-1 mt-1">
                  <label className="flex items-center gap-1 flex-wrap">
                    <span className="w-10">Front</span>
                    <input type="number" min={0} value={inputsDraft.frontFootage}
                      onChange={(e) => setNumField('frontFootage', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-14 bg-white" />ft
                    <input type="number" min={0} value={inputsDraft.frontCorners}
                      onChange={(e) => setNumField('frontCorners', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-10 bg-white" />corners
                  </label>
                  <label className="flex items-center gap-1 flex-wrap">
                    <span className="w-10">Left</span>
                    <input type="number" min={0} value={inputsDraft.leftFootage}
                      onChange={(e) => setNumField('leftFootage', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-14 bg-white" />ft
                    <input type="number" min={0} value={inputsDraft.leftCorners}
                      onChange={(e) => setNumField('leftCorners', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-10 bg-white" />corners
                  </label>
                  <label className="flex items-center gap-1 flex-wrap">
                    <span className="w-10">Right</span>
                    <input type="number" min={0} value={inputsDraft.rightFootage}
                      onChange={(e) => setNumField('rightFootage', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-14 bg-white" />ft
                    <input type="number" min={0} value={inputsDraft.rightCorners}
                      onChange={(e) => setNumField('rightCorners', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-10 bg-white" />corners
                  </label>
                  <label className="flex items-center gap-1 flex-wrap">
                    <span className="w-10">Back</span>
                    <input type="number" min={0} value={inputsDraft.backFootage}
                      onChange={(e) => setNumField('backFootage', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-14 bg-white" />ft
                    <input type="number" min={0} value={inputsDraft.backCorners}
                      onChange={(e) => setNumField('backCorners', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-10 bg-white" />corners
                  </label>
                </div>
                <div className="flex flex-wrap gap-2 items-center mt-1">
                  <label className="flex items-center gap-1">3&apos;
                    <input type="number" min={0} value={inputsDraft.extensions?.e3 ?? 0}
                      onChange={(e) => setExtension('e3', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-12 bg-white" />
                  </label>
                  <label className="flex items-center gap-1">5&apos;
                    <input type="number" min={0} value={inputsDraft.extensions?.e5 ?? 0}
                      onChange={(e) => setExtension('e5', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-12 bg-white" />
                  </label>
                  <label className="flex items-center gap-1">10&apos;
                    <input type="number" min={0} value={inputsDraft.extensions?.e10 ?? 0}
                      onChange={(e) => setExtension('e10', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-12 bg-white" />
                  </label>
                  <label className="flex items-center gap-1">25&apos;
                    <input type="number" min={0} value={inputsDraft.extensions?.e25 ?? 0}
                      onChange={(e) => setExtension('e25', e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-12 bg-white" />
                  </label>
                  <label className="flex items-center gap-1">splitters
                    <input type="number" min={0} value={inputsDraft.splittersNeeded ?? 0}
                      onChange={(e) => setSplitters(e.target.value)}
                      className="border border-gray-300 rounded px-1 py-0.5 w-12 bg-white" />
                  </label>
                </div>
              </div>
            )}

            <div>
              <div className="font-semibold text-gray-700">What did the AI get wrong here? (optional)</div>
              <textarea
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                maxLength={NOTES_MAX_LEN}
                rows={2}
                placeholder={`e.g. "missed the back-right corner run"`}
                className="mt-1 w-full border border-gray-300 rounded px-1.5 py-0.5 bg-white placeholder:text-gray-400"
              />
            </div>

            {saveErr && <p className="text-red-600">{saveErr}</p>}
            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={saving} className="bg-green-600 text-white rounded px-3 py-1 disabled:bg-green-300">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(false)} disabled={saving} className="border border-gray-300 rounded px-3 py-1 bg-white">
                Cancel
              </button>
            </div>
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
