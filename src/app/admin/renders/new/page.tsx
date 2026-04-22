'use client';

// Dev/smoke-test page for the render engine. Upload a daytime house photo,
// analyze it with Claude Vision, then pass the polylines/detections into
// the Phase 1 render pipeline. Lands at /admin/renders after success.
//
// This is an internal tool — Phase 5 will wire rendering into the actual
// /quote/new flow. Until then, this is how we validate the pipeline
// end-to-end on real houses.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PhotoAnalysisResult } from '@/lib/photoAnalysis';
import type { RenderStyle } from '@/lib/rendering/types';
import { toRenderVisionInput } from '@/lib/rendering/adapter';

type Stage = 'idle' | 'analyzing' | 'rendering' | 'done' | 'error';

export default function NewRenderPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [style, setStyle] = useState<RenderStyle>('warm-white');
  const [notes, setNotes] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PhotoAnalysisResult | null>(null);

  const onPick = (f: File | null) => {
    setFile(f);
    setAnalysis(null);
    setError(null);
    if (!f) { setPreview(null); return; }
    const r = new FileReader();
    r.onload = () => setPreview(typeof r.result === 'string' ? r.result : null);
    r.readAsDataURL(f);
  };

  const go = async () => {
    if (!file) return;
    setError(null);

    // Step 1 — analyze the photo with the existing vision pipeline
    setStage('analyzing');
    let result: PhotoAnalysisResult;
    let photoBase64: string;
    let photoMediaType: string;
    try {
      const fd = new FormData();
      fd.append('photo', file);
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      result = data.result as PhotoAnalysisResult;
      photoBase64 = data.photoBase64 as string;
      photoMediaType = data.photoMediaType as string;
      setAnalysis(result);
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'Analysis failed');
      return;
    }

    // Step 2 — pass vision output into the render pipeline
    setStage('rendering');
    try {
      const res = await fetch('/api/renders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photoBase64,
          photoMediaType,
          style,
          notes: notes.trim() || undefined,
          // Adapter handles coord sanitization + c9Lines plumbing. Pass c9Lines
          // through `extra` once the quote page maintains a separate state.
          vision: toRenderVisionInput(result),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // stack only present in dev; prod keeps errors terse.
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
              Upload a daytime house photo. Claude analyzes it, then Gemini paints the nighttime install.
              Takes about 30–90 seconds end-to-end.
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
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={preview} alt="preview" className="mt-3 max-h-80 rounded border border-gray-300" />
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
            <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {analysis && stage !== 'error' && (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs text-blue-900">
              <strong>Analysis complete.</strong>{' '}
              {analysis.santasFootage}ft gutter · {analysis.gingerbreadFootage}ft ridge ·{' '}
              {analysis.miniLightDetections.length} bush/tree/column ·{' '}
              {analysis.wreathDetections.length} wreath · {analysis.garlandDetections.length} garland
            </div>
          )}

          <button
            type="button"
            disabled={!file || busy}
            onClick={go}
            className="w-full bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
          >
            {stage === 'idle' && 'Generate Render'}
            {stage === 'analyzing' && 'Analyzing photo with Claude…'}
            {stage === 'rendering' && 'Rendering nighttime scene with Gemini… (can take 60s)'}
            {stage === 'done' && 'Done — redirecting to gallery'}
            {stage === 'error' && 'Try again'}
          </button>
        </div>
      </div>
    </div>
  );
}
