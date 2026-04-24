'use client';

// Dev/smoke-test page for the render engine. Flow:
//   1. Upload a daytime house photo
//   2. Claude analyzes it — returns polylines + boxes
//   3. Operator SELECTS which items to render via checkboxes (per-item,
//      per-category toggles). Everything is on by default.
//   4. Gemini paints only the checked subset.
//
// This is the internal "render what I want" lever. Without it, Gemini
// draws everything the analyzer saw, which is rarely what we want when
// we're debugging a single subsystem (e.g. "I just want to see the
// roofline C9s on this house, no bushes").

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';
import type { RenderModel, RenderStyle, RenderVisionInput } from '@/lib/rendering/types';
import { toRenderVisionInput } from '@/lib/rendering/adapter';

type Stage = 'idle' | 'analyzing' | 'selecting' | 'rendering' | 'done' | 'error';

// Per-category include sets. True index = include that item.
type Selection = {
  santas: boolean[];
  gingerbread: boolean[];
  c9: boolean[];
  mini: boolean[];
  wreaths: boolean[];
  spritzers: boolean[];
  garland: boolean[];
};

function allTrue(n: number): boolean[] {
  return Array.from({ length: n }, () => true);
}

export default function NewRenderPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [style, setStyle] = useState<RenderStyle>('warm-white');
  const [model, setModel] = useState<RenderModel>('flash2');
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PhotoAnalysisResult | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoMediaType, setPhotoMediaType] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  // Skip cache → force a fresh Gemini call even if a prior render exists
  // for this exact photo + selection. Default ON while we're iterating on
  // the prompt, so the cache doesn't silently serve the old broken output.
  const [skipCache, setSkipCache] = useState(true);

  const onPick = (f: File | null) => {
    setFile(f);
    setAnalysis(null);
    setSelection(null);
    setPhotoBase64(null);
    setPhotoMediaType(null);
    setError(null);
    setStage('idle');
    if (!f) { setPreview(null); return; }
    const r = new FileReader();
    r.onload = () => setPreview(typeof r.result === 'string' ? r.result : null);
    r.readAsDataURL(f);
  };

  const analyze = async () => {
    if (!file) return;
    setError(null);
    setStage('analyzing');
    try {
      const fd = new FormData();
      fd.append('photo', file);
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      const result = data.result as PhotoAnalysisResult;
      setAnalysis(result);
      setPhotoBase64(data.photoBase64 as string);
      setPhotoMediaType(data.photoMediaType as string);
      // Default: render everything the analyzer found.
      setSelection({
        santas: allTrue(result.santasLines.length),
        gingerbread: allTrue(result.gingerbreadLines.length),
        c9: allTrue(0), // analyzer doesn't yet produce c9Lines
        mini: allTrue(result.miniLightDetections.length),
        wreaths: allTrue(result.wreathDetections.length),
        spritzers: allTrue(result.spritzerDetections.length),
        garland: allTrue(result.garlandDetections.length),
      });
      setStage('selecting');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'Analysis failed');
    }
  };

  // Build a filtered RenderVisionInput using only checked items.
  const filteredVision = useMemo<RenderVisionInput | null>(() => {
    if (!analysis || !selection) return null;
    const full = toRenderVisionInput(analysis);
    return {
      santasLines: full.santasLines.filter((_, i) => selection.santas[i]),
      gingerbreadLines: full.gingerbreadLines.filter((_, i) => selection.gingerbread[i]),
      c9Lines: (full.c9Lines ?? []).filter((_, i) => selection.c9[i]),
      miniLights: full.miniLights.filter((_, i) => selection.mini[i]),
      wreaths: full.wreaths.filter((_, i) => selection.wreaths[i]),
      spritzers: full.spritzers.filter((_, i) => selection.spritzers[i]),
      garland: full.garland.filter((_, i) => selection.garland[i]),
    };
  }, [analysis, selection]);

  const render = async () => {
    if (!photoBase64 || !photoMediaType || !filteredVision) return;
    setError(null);
    setStage('rendering');
    try {
      const res = await fetch('/api/renders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photoBase64,
          photoMediaType,
          style,
          model,
          notes: notes.trim() || undefined,
          vision: filteredVision,
          skipCache,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.stack ? `\n\n${data.stack.split('\n').slice(0, 4).join('\n')}` : '';
        throw new Error(`${data.error ?? 'Render failed'}${detail}`);
      }
      setStage('done');
      router.push('/admin/renders');
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'Render failed');
    }
  };

  const busy = stage === 'analyzing' || stage === 'rendering';

  // Helpers that mutate selection for a given category.
  const toggleAll = (key: keyof Selection, value: boolean) => {
    if (!selection) return;
    setSelection({ ...selection, [key]: selection[key].map(() => value) });
  };
  const toggleOne = (key: keyof Selection, idx: number) => {
    if (!selection) return;
    const next = [...selection[key]];
    next[idx] = !next[idx];
    setSelection({ ...selection, [key]: next });
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
              Yule Love Lights — Admin
            </p>
            <h1 className="text-2xl font-bold text-gray-900">New Render — Smoke Test</h1>
            <p className="text-sm text-gray-500 mt-1">
              Upload a daytime house photo. Claude analyzes it, you choose what to render, then Gemini paints the nighttime install.
            </p>
          </div>
          <Link
            href="/admin/renders"
            className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
          >
            ← Gallery
          </Link>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Daytime photo</label>
            <input
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
            {preview && (
              <div className="relative mt-3 inline-block max-w-full">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt="preview"
                  className="block max-h-80 rounded border border-gray-300"
                />
                {analysis && selection && (
                  <DebugOverlay analysis={analysis} selection={selection} />
                )}
              </div>
            )}
            {analysis && selection && (
              <div className="mt-2 text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
                <LegendDot color="bg-red-500"    code="S" label="Santa's (roofline)" />
                <LegendDot color="bg-blue-500"   code="G" label="Gingerbread (ridge)" />
                <LegendDot color="bg-green-500"  code="M" label="Mini-lights" />
                <LegendDot color="bg-pink-500"   code="W" label="Wreaths" />
                <LegendDot color="bg-orange-500" code="P" label="Spritzers" />
                <LegendDot color="bg-cyan-500"   code="L" label="Garland" />
                <span className="text-gray-400">· dashed = unchecked</span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Style</label>
            <div className="flex gap-2">
              {(['warm-white', 'multi', 'red-green'] as RenderStyle[]).map(s => (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => setStyle(s)}
                  className={`text-sm px-3 py-1.5 rounded-md border ${
                    style === s
                      ? 'bg-green-600 text-white border-green-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Model</label>
            <div className="flex gap-2">
              {([
                { id: 'flash' as const,  label: 'Flash 2.5', cost: '~$0.04',  hint: 'cheapest, often passthrough' },
                { id: 'flash2' as const, label: 'Flash 3.1', cost: '~$0.067', hint: 'middle tier, Nano Banana 2' },
                { id: 'pro' as const,    label: 'Pro 3',     cost: '~$0.134', hint: 'photoreal, customer-ready' },
              ]).map(m => (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setModel(m.id)}
                  className={`flex-1 text-sm px-3 py-2 rounded-md border text-left ${
                    model === m.id
                      ? 'bg-green-600 text-white border-green-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="font-semibold">{m.label} <span className="text-xs opacity-80">{m.cost}</span></div>
                  <div className="text-xs opacity-80">{m.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-1">Notes (optional)</label>
            <input
              type="text"
              value={notes}
              disabled={busy}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Jason's house, test run"
              className="block w-full text-sm border border-gray-300 rounded-md px-3 py-2"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {/* Stage 1: no analysis yet → single "Analyze" button. */}
          {!analysis && (
            <button
              type="button"
              disabled={!file || busy}
              onClick={analyze}
              className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
            >
              {stage === 'analyzing' ? 'Analyzing photo with Claude…' : 'Analyze Photo'}
            </button>
          )}

          {/* Stage 2: analysis done → checkbox selector + "Render selected". */}
          {analysis && selection && (
            <div className="space-y-3">
              <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs text-blue-900">
                <strong>Analysis complete.</strong>{' '}
                {analysis.santasFootage}ft gutter · {analysis.gingerbreadFootage}ft ridge ·{' '}
                {analysis.miniLightDetections.length} bush/tree/column ·{' '}
                {analysis.wreathDetections.length} wreath · {analysis.spritzerDetections.length} spritzer ·{' '}
                {analysis.garlandDetections.length} garland
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-semibold text-gray-700">What to render</label>
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setSelection({
                        santas: allTrue(analysis.santasLines.length),
                        gingerbread: allTrue(analysis.gingerbreadLines.length),
                        c9: [],
                        mini: allTrue(analysis.miniLightDetections.length),
                        wreaths: allTrue(analysis.wreathDetections.length),
                        spritzers: allTrue(analysis.spritzerDetections.length),
                        garland: allTrue(analysis.garlandDetections.length),
                      })}
                      className="text-blue-600 hover:underline"
                    >
                      Select all
                    </button>
                    <span className="text-gray-300">·</span>
                    <button
                      type="button"
                      onClick={() => setSelection({
                        santas: analysis.santasLines.map(() => false),
                        gingerbread: analysis.gingerbreadLines.map(() => false),
                        c9: [],
                        mini: analysis.miniLightDetections.map(() => false),
                        wreaths: analysis.wreathDetections.map(() => false),
                        spritzers: analysis.spritzerDetections.map(() => false),
                        garland: analysis.garlandDetections.map(() => false),
                      })}
                      className="text-blue-600 hover:underline"
                    >
                      Select none
                    </button>
                  </div>
                </div>

                <div className="border border-gray-200 rounded-md divide-y divide-gray-200">
                  <CategoryBlock
                    title="Santa's — gutter rooflines (C9)"
                    codePrefix="S"
                    dotColor="bg-red-500"
                    items={analysis.santasLines.map((seg, i) => ({
                      label: seg.label || `Run ${i + 1}`,
                      detail: `${seg.points.length} points`,
                    }))}
                    flags={selection.santas}
                    onToggleAll={(v) => toggleAll('santas', v)}
                    onToggleOne={(i) => toggleOne('santas', i)}
                  />
                  <CategoryBlock
                    title="Gingerbread — ridgelines (C9)"
                    codePrefix="G"
                    dotColor="bg-blue-500"
                    items={analysis.gingerbreadLines.map((seg, i) => ({
                      label: seg.label || `Run ${i + 1}`,
                      detail: `${seg.points.length} points`,
                    }))}
                    flags={selection.gingerbread}
                    onToggleAll={(v) => toggleAll('gingerbread', v)}
                    onToggleOne={(i) => toggleOne('gingerbread', i)}
                  />
                  <CategoryBlock
                    title="Bushes / Trees / Columns (mini-lights)"
                    codePrefix="M"
                    dotColor="bg-green-500"
                    items={analysis.miniLightDetections.map((m, i) => ({
                      label: m.label || `${m.type} ${i + 1}`,
                      detail: `${m.wrapStyle} · ${m.stringCount} string${m.stringCount === 1 ? '' : 's'}`,
                    }))}
                    flags={selection.mini}
                    onToggleAll={(v) => toggleAll('mini', v)}
                    onToggleOne={(i) => toggleOne('mini', i)}
                  />
                  <CategoryBlock
                    title="Wreaths"
                    codePrefix="W"
                    dotColor="bg-pink-500"
                    items={analysis.wreathDetections.map((w, i) => ({
                      label: w.label || `Wreath ${i + 1}`,
                      detail: `${w.size} · ${w.tier}`,
                    }))}
                    flags={selection.wreaths}
                    onToggleAll={(v) => toggleAll('wreaths', v)}
                    onToggleOne={(i) => toggleOne('wreaths', i)}
                  />
                  <CategoryBlock
                    title="Spritzers"
                    codePrefix="P"
                    dotColor="bg-orange-500"
                    items={analysis.spritzerDetections.map((s, i) => ({
                      label: s.label || `Spritzer ${i + 1}`,
                      detail: `${s.size}"`,
                    }))}
                    flags={selection.spritzers}
                    onToggleAll={(v) => toggleAll('spritzers', v)}
                    onToggleOne={(i) => toggleOne('spritzers', i)}
                  />
                  <CategoryBlock
                    title="Garland"
                    codePrefix="L"
                    dotColor="bg-cyan-500"
                    items={analysis.garlandDetections.map((g, i) => ({
                      label: g.label || `Garland ${i + 1}`,
                      detail: `${g.length} · ${g.tier}`,
                    }))}
                    flags={selection.garland}
                    onToggleAll={(v) => toggleAll('garland', v)}
                    onToggleOne={(i) => toggleOne('garland', i)}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="render-feedback" className="block text-sm font-semibold text-gray-700 mb-1">
                  What was wrong with the last render? <span className="font-normal text-gray-500">(optional — helps us tune future renders)</span>
                </label>
                <textarea
                  id="render-feedback"
                  value={notes}
                  disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="e.g. Bulbs too big on the right gable, spritzers all got dropped, wreath color was wrong, bushes looked like net lights instead of pinpoints…"
                  className="block w-full text-sm border border-gray-300 rounded-md px-3 py-2 resize-y"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Saved to this render&rsquo;s <code>notes</code> field. When you hit render again, these notes ride along with the next attempt so you have a paper trail of what you&rsquo;ve tried.
                </p>
              </div>

              <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipCache}
                  disabled={busy}
                  onChange={(e) => setSkipCache(e.target.checked)}
                />
                <span>
                  <strong>Force fresh render</strong> (skip cache). Leave on while iterating on the prompt — otherwise identical inputs serve the previously cached output. Turn off to save Gemini calls once you&rsquo;re happy.
                </span>
              </label>

              <button
                type="button"
                disabled={busy}
                onClick={render}
                className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
              >
                {stage === 'rendering' && 'Rendering nighttime scene with Gemini… (can take 60s)'}
                {stage === 'done' && 'Done — redirecting to gallery'}
                {stage !== 'rendering' && stage !== 'done' && 'Render selected items'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Color-coded overlay drawn on top of the source preview so you can SEE
// what Claude labeled before you hit render. Critical for debugging
// "wait, what did it call that region?" questions. Every polyline and bbox
// is drawn in its category's color; unchecked items render dashed + dim.
// Labels (S1, G1, M1...) are HTML spans so text stays readable even when
// the SVG viewBox is stretched to non-square aspect ratios.
function DebugOverlay({
  analysis,
  selection,
}: {
  analysis: PhotoAnalysisResult;
  selection: Selection;
}) {
  // Normalized coords → SVG 0-100 scale. Using a 100x100 viewBox with
  // `preserveAspectRatio="none"` makes the overlay stretch perfectly to
  // whatever aspect ratio the <img> is rendered at.
  const scale = (n: number) => n * 100;

  return (
    <>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        {analysis.santasLines.map((seg, i) => (
          <polyline
            key={`s-${i}`}
            points={seg.points.map(([x, y]) => `${scale(x)},${scale(y)}`).join(' ')}
            fill="none"
            stroke="#ef4444"
            strokeWidth={selection.santas[i] ? 3 : 2}
            strokeOpacity={selection.santas[i] ? 0.95 : 0.3}
            strokeDasharray={selection.santas[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {analysis.gingerbreadLines.map((seg, i) => (
          <polyline
            key={`g-${i}`}
            points={seg.points.map(([x, y]) => `${scale(x)},${scale(y)}`).join(' ')}
            fill="none"
            stroke="#3b82f6"
            strokeWidth={selection.gingerbread[i] ? 3 : 2}
            strokeOpacity={selection.gingerbread[i] ? 0.95 : 0.3}
            strokeDasharray={selection.gingerbread[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {analysis.miniLightDetections.map((d, i) => (
          <rect
            key={`m-${i}`}
            x={scale(d.box[0])}
            y={scale(d.box[1])}
            width={scale(d.box[2])}
            height={scale(d.box[3])}
            fill="#22c55e"
            fillOpacity={selection.mini[i] ? 0.18 : 0.05}
            stroke="#22c55e"
            strokeWidth={selection.mini[i] ? 3 : 2}
            strokeOpacity={selection.mini[i] ? 0.95 : 0.3}
            strokeDasharray={selection.mini[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {analysis.wreathDetections.map((d, i) => (
          <rect
            key={`w-${i}`}
            x={scale(d.box[0])}
            y={scale(d.box[1])}
            width={scale(d.box[2])}
            height={scale(d.box[3])}
            fill="#ec4899"
            fillOpacity={selection.wreaths[i] ? 0.18 : 0.05}
            stroke="#ec4899"
            strokeWidth={selection.wreaths[i] ? 3 : 2}
            strokeOpacity={selection.wreaths[i] ? 0.95 : 0.3}
            strokeDasharray={selection.wreaths[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {analysis.spritzerDetections.map((d, i) => (
          <rect
            key={`p-${i}`}
            x={scale(d.box[0])}
            y={scale(d.box[1])}
            width={scale(d.box[2])}
            height={scale(d.box[3])}
            fill="#f97316"
            fillOpacity={selection.spritzers[i] ? 0.3 : 0.1}
            stroke="#f97316"
            strokeWidth={selection.spritzers[i] ? 3 : 2}
            strokeOpacity={selection.spritzers[i] ? 0.95 : 0.3}
            strokeDasharray={selection.spritzers[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {analysis.garlandDetections.map((d, i) => (
          <rect
            key={`l-${i}`}
            x={scale(d.box[0])}
            y={scale(d.box[1])}
            width={scale(d.box[2])}
            height={scale(d.box[3])}
            fill="#06b6d4"
            fillOpacity={selection.garland[i] ? 0.18 : 0.05}
            stroke="#06b6d4"
            strokeWidth={selection.garland[i] ? 3 : 2}
            strokeOpacity={selection.garland[i] ? 0.95 : 0.3}
            strokeDasharray={selection.garland[i] ? undefined : '6 4'}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {/* HTML label chips over the SVG — text doesn't distort with viewBox stretch. */}
      {analysis.santasLines.map((seg, i) => {
        const p = seg.points[0];
        if (!p) return null;
        return <OverlayTag key={`ts-${i}`} x={p[0]} y={p[1]} color="bg-red-600"    on={selection.santas[i]}      code={`S${i + 1}`} />;
      })}
      {analysis.gingerbreadLines.map((seg, i) => {
        const p = seg.points[0];
        if (!p) return null;
        return <OverlayTag key={`tg-${i}`} x={p[0]} y={p[1]} color="bg-blue-600"   on={selection.gingerbread[i]} code={`G${i + 1}`} />;
      })}
      {analysis.miniLightDetections.map((d, i) => (
        <OverlayTag key={`tm-${i}`} x={d.box[0]} y={d.box[1]} color="bg-green-600"  on={selection.mini[i]}      code={`M${i + 1}`} />
      ))}
      {analysis.wreathDetections.map((d, i) => (
        <OverlayTag key={`tw-${i}`} x={d.box[0]} y={d.box[1]} color="bg-pink-600"   on={selection.wreaths[i]}   code={`W${i + 1}`} />
      ))}
      {analysis.spritzerDetections.map((d, i) => (
        <OverlayTag key={`tp-${i}`} x={d.box[0]} y={d.box[1]} color="bg-orange-600" on={selection.spritzers[i]} code={`P${i + 1}`} />
      ))}
      {analysis.garlandDetections.map((d, i) => (
        <OverlayTag key={`tl-${i}`} x={d.box[0]} y={d.box[1]} color="bg-cyan-600"   on={selection.garland[i]}   code={`L${i + 1}`} />
      ))}
    </>
  );
}

function OverlayTag({
  x, y, color, on, code,
}: { x: number; y: number; color: string; on: boolean; code: string }) {
  return (
    <span
      className={`absolute text-[9px] leading-none font-bold text-white ${color} px-1 py-0.5 rounded-sm pointer-events-none select-none shadow`}
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: 'translate(-50%, -110%)',
        opacity: on ? 0.95 : 0.4,
      }}
    >
      {code}
    </span>
  );
}

function LegendDot({ color, code, label }: { color: string; code: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-3 h-3 rounded-sm ${color}`} />
      <span className="font-mono text-gray-600">{code}</span>
      <span>{label}</span>
    </span>
  );
}

// Collapsible block showing every item in a category with a per-item
// checkbox plus a category-level "all" checkbox. The header shows count
// in the form "selected / total" so it's obvious what's active.
function CategoryBlock({
  title,
  codePrefix,
  dotColor,
  items,
  flags,
  onToggleAll,
  onToggleOne,
}: {
  title: string;
  codePrefix: string;        // e.g. 'S', 'G', 'M' — matches the overlay tag
  dotColor: string;          // tailwind bg class for the color swatch
  items: { label: string; detail: string }[];
  flags: boolean[];
  onToggleAll: (value: boolean) => void;
  onToggleOne: (idx: number) => void;
}) {
  const total = items.length;
  const selected = flags.filter(Boolean).length;
  const [open, setOpen] = useState(true);

  if (total === 0) {
    return (
      <div className="px-3 py-2 text-xs text-gray-400 bg-gray-50 flex items-center gap-2">
        <span className={`inline-block w-3 h-3 rounded-sm ${dotColor} opacity-40`} />
        <span className="font-semibold text-gray-500">{title}</span> — none detected
      </div>
    );
  }

  const allOn = selected === total;
  const noneOn = selected === 0;

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
        <label className="flex items-center gap-2 cursor-pointer select-none flex-1 min-w-0">
          <input
            type="checkbox"
            checked={allOn}
            ref={(el) => {
              if (el) el.indeterminate = !allOn && !noneOn;
            }}
            onChange={() => onToggleAll(!allOn)}
            className="shrink-0"
          />
          <span className={`inline-block w-3 h-3 rounded-sm ${dotColor} shrink-0`} />
          <span className="text-sm font-semibold text-gray-700 truncate">{title}</span>
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {selected} / {total}
          </span>
        </label>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="text-xs text-blue-600 hover:underline ml-3"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && (
        <div className="divide-y divide-gray-100">
          {items.map((it, i) => (
            <label key={i} className="flex items-center gap-2 px-6 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={flags[i] ?? false}
                onChange={() => onToggleOne(i)}
              />
              <span className="font-mono text-[10px] text-gray-500 bg-gray-100 px-1 rounded shrink-0">
                {codePrefix}{i + 1}
              </span>
              <span className="flex-1 min-w-0 truncate">{it.label}</span>
              <span className="text-xs text-gray-400 whitespace-nowrap">{it.detail}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
