'use client';

import { useState, useRef, useEffect } from 'react';
import type {
  QuoteResult,
  QuoteInputs,
  CustomLineItem,
  RooflineDifficulty,
  RooflineChoice,
} from '@/lib/pricing/pricingEngine';
import {
  type QuoteFormData,
  type FormCustomer,
  type StoredCustomer,
  initialFormData,
  buildQuoteInputs,
  inputsToFormData,
} from '@/lib/quoteForm';
import type { CrmContact } from '@/lib/integrations/types';
import HighLevelContactAutocomplete from '@/components/admin/HighLevelContactAutocomplete';
import dynamic from 'next/dynamic';

import DesignSummary from '@/components/quote/DesignSummary';

// The Konva design editor touches the DOM/canvas, so load it client-only.
const DesignEditor = dynamic(() => import('@/components/design/DesignEditor'), { ssr: false });

// ─── Shared CSS constants ────────────────────────────────────────────────────

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const addBtn = 'mt-1 text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5 transition-colors';
const rmBtn = 'text-red-400 hover:text-red-600 font-bold text-xl leading-none mt-0.5';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// A measurement polyline on the satellite image (normalized 0–1 coords).
type LineSegment = { points: [number, number][]; label: string };

// Satellite image is always 640x640 at zoom=20 from Static Maps.
const SAT_PX = 640;

// Compute polyline length in "aspect-corrected" normalized units.
// dx stays as-is (image width = 1), dy is scaled by (height/width) so
// diagonal distances reflect real pixel distances on the image.
function polylineLength(lines: LineSegment[], aspect: number): number {
  const yScale = 1 / aspect; // height in width-units
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.points.length; i++) {
      const [x1, y1] = line.points[i - 1];
      const [x2, y2] = line.points[i];
      const dx = x2 - x1;
      const dy = (y2 - y1) * yScale;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4">
      <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
        {title}
      </h2>
      {children}
    </div>
  );
}

// ─── Form state ──────────────────────────────────────────────────────────────
// The form-state type + the form ⇄ QuoteInputs mapping live in
// src/lib/quoteForm.ts (tested) so /quote/[id] hydration can't drift from
// what Calculate Quote sends.

// What /quote/[id] passes in to reopen a saved quote (task #31): the raw quote
// row fields. The builder maps them into form state via inputsToFormData.
export type QuoteBuilderInitial = {
  quoteId: string;
  customer: StoredCustomer;
  inputs: Partial<QuoteInputs>;
  result: QuoteResult | null;
  designId: string | null;
  sentAt: string | null;
  approvedAt: string | null;
};

// ─── Builder component ───────────────────────────────────────────────────────
// The full quote builder, shared by /quote/new (blank) and /quote/[id] (edit —
// hydrated from a saved quote, task #31).

export default function QuoteBuilder({ initialQuote }: { initialQuote?: QuoteBuilderInitial }) {
  const editMode = initialQuote != null;
  const [form, setForm] = useState<QuoteFormData>(() =>
    initialQuote ? inputsToFormData(initialQuote.customer, initialQuote.inputs) : initialFormData,
  );
  // In edit mode the saved result hydrates too, so the operator sees the
  // current price breakdown (and the portal/send buttons) without recalculating.
  const [result, setResult] = useState<QuoteResult | null>(initialQuote?.result ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // ─── HighLevel integration state ────────────────────────────────────────
  // `highlevelContact`: the GHL contact picked in the autocomplete. When
  // set, customer fields are pre-filled and we'll attach the quote to this
  // contact's existing opportunity on save.
  // `savedQuoteId`: UUID returned from /api/quote. Needed for the attach
  // call and for the "Send Quote to Customer" button (which targets
  // /api/quotes/[id]/send).
  // `attachStatus` / `sendStatus`: informational — surfaced as a small
  // status line so the operator knows whether the GHL side is in sync.
  const [highlevelContact, setHighLevelContact] = useState<CrmContact | null>(null);
  const [savedQuoteId, setSavedQuoteId] = useState<string | null>(initialQuote?.quoteId ?? null);
  const [attachStatus, setAttachStatus] = useState<'idle' | 'attaching' | 'attached' | 'skipped' | 'error'>('idle');
  const [attachError, setAttachError] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendError, setSendError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  // Guards against re-attaching the same quote+contact on every recalculation,
  // now that Calculate updates the saved row in place instead of inserting.
  const lastAttachKey = useRef<string | null>(null);

  // Photo analysis (#35: the street photo lives in the DESIGN — only the
  // satellite keeps measurement polylines; street overlays/detections are gone)
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNotes, setAnalysisNotes] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoMediaType, setPhotoMediaType] = useState<string | null>(null);

  // ─── Embedded design editor — the Design tab (#27 Phase 1, #35 design-first) ──
  // The design IS the primary canvas now: it's created EAGERLY the moment a
  // street photo is in hand (address lookup or upload+analyze), not when a
  // section is opened. It links to the quote on Calculate. The Konva editor is
  // a client-only dynamic import, kept mounted (hidden) across tab switches.
  const [designId, setDesignId] = useState<string | null>(initialQuote?.designId ?? null);
  const [designBusy, setDesignBusy] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  // Bumped when the design's scene/photo changes outside the editor (roofline
  // seed, photo replacement) so a remount reloads it.
  const [designEditorKey, setDesignEditorKey] = useState(0);
  // The base64 photo the design currently carries (what we last pushed). Lets
  // the eager effect tell "new photo → create/replace" from re-renders, and
  // applyAnalysisResult tell "same photo re-analyzed → seed directly".
  const designPhotoRef = useRef<string | null>(null);
  // Roofline lines from the latest analysis, waiting for the design to exist
  // before they can seed (#33 tagging keeps the portal picture-toggle alive).
  const pendingSeedRef = useRef<{
    santas: [number, number][][];
    gingerbread: [number, number][][];
    winterWonderland: [number, number][][];
  } | null>(null);

  // Push the AI's roofline lines into the design as tagged C9 strands (#33's
  // replacement semantics: roofline-tagged strands swap out, hand-drawn decor
  // survives) and remount the editor so it shows them.
  const seedDesignRoofline = async (id: string, lines: NonNullable<typeof pendingSeedRef.current>) => {
    if (!lines.santas.length && !lines.gingerbread.length && !lines.winterWonderland.length) return;
    try {
      const res = await fetch(`/api/designs/${id}/seed-roofline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedLines: lines }),
      });
      if (res.ok) setDesignEditorKey((k) => k + 1);
    } catch {
      // Non-fatal: the design still works, the roofline just isn't pre-drawn.
    }
  };

  // Eager design lifecycle: photo arrives → create the design with it (plus any
  // pending roofline seed); photo changes later (camera recapture / re-lookup)
  // → replace the existing design's base photo in place.
  useEffect(() => {
    if (!photoBase64 || !photoMediaType) return;
    if (designPhotoRef.current === photoBase64) return;
    let stale = false;
    const push = async () => {
      setDesignBusy(true);
      setDesignError(null);
      try {
        if (!designId) {
          const res = await fetch('/api/designs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteId: savedQuoteId ?? undefined,
              photoBase64,
              photoMediaType,
              seedLines: pendingSeedRef.current ?? undefined,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Failed to create design');
          const id: string | undefined = data?.design?.id;
          if (!id) throw new Error('No design id returned');
          pendingSeedRef.current = null;
          designPhotoRef.current = photoBase64;
          if (!stale) setDesignId(id);
        } else {
          const res = await fetch(`/api/designs/${designId}/photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photoBase64, photoMediaType }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'Failed to update the design photo');
          designPhotoRef.current = photoBase64;
          if (pendingSeedRef.current) {
            const lines = pendingSeedRef.current;
            pendingSeedRef.current = null;
            await seedDesignRoofline(designId, lines);
          }
          if (!stale) setDesignEditorKey((k) => k + 1);
        }
      } catch (err) {
        if (!stale) setDesignError(err instanceof Error ? err.message : 'Design photo update failed');
      } finally {
        if (!stale) setDesignBusy(false);
      }
    };
    void push();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoBase64, photoMediaType, designId]);

  // Link the design to the quote once the quote has been saved (best-effort).
  useEffect(() => {
    if (!savedQuoteId || !designId) return;
    void fetch(`/api/designs/${designId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteId: savedQuoteId }),
    }).catch(() => {});
  }, [savedQuoteId, designId]);

  // (#35: the Gemini nighttime-render preview is gone — the live design IS the
  // customer-facing visual now; the app-wide render teardown is task #36.)
  const [fewShotCount, setFewShotCount] = useState(0);
  const [satellitePreview, setSatellitePreview] = useState<string | null>(null);
  const [googleAddress, setGoogleAddress] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // Geocoded coords + current camera angle for Street View re-capture.
  // Used when the default angle is blocked by trees, parked cars, etc.
  const [geoLat, setGeoLat] = useState<number | null>(null);
  const [geoLng, setGeoLng] = useState<number | null>(null);
  const [svHeading, setSvHeading] = useState<number | null>(null);
  const [svPitch, setSvPitch] = useState<number>(0);
  const [svFov, setSvFov] = useState<number>(80);
  const [recapturing, setRecapturing] = useState(false);
  // Satellite polylines (editable from top-down view — better for commercial
  // properties and complex rooflines where a street-view angle misses the back).
  const [satelliteSantasLines, setSatelliteSantasLines] = useState<LineSegment[]>([]);
  const [satelliteGingerbreadLines, setSatelliteGingerbreadLines] = useState<LineSegment[]>([]);
  const [satelliteC9Lines, setSatelliteC9Lines] = useState<LineSegment[]>([]);
  // Deterministic scale from Google Static Maps zoom-20 formula; no user
  // calibration needed. See analyze-address route for the math.
  const [satelliteFeetPerPixel, setSatelliteFeetPerPixel] = useState<number | null>(null);
  const [satelliteAspect, setSatelliteAspect] = useState<number>(1);
  // The top box's active tab (#35): the DESIGN (street photo in the editor) or
  // the SATELLITE measurement canvas. Both stay mounted across switches so
  // neither loses state. Measurement comes from satellite lines or manual
  // typing only — street is no longer a measurement source.
  const [viewMode, setViewMode] = useState<'design' | 'satellite'>('design');

  // Drag state for editing satellite polyline points
  type LineType = 'santas' | 'gingerbread' | 'c9';
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);

  // Tracks whether C9 lines existed on the previous effect run, so deleting
  // the last C9 line resets the derived footage instead of leaving a stale
  // value behind. (Manual entry without any lines is still preserved.)
  const hadC9LinesRef = useRef(false);

  // Recompute footages from the SATELLITE lines (#35: the only line-measurement
  // source — deterministic feet-per-pixel × image pixel width). When there's no
  // satellite, the footage fields are plain manual inputs.
  useEffect(() => {
    if (satelliteFeetPerPixel == null) return;
    const sFt = Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    const gFt = Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    const c9Ft = Math.round(polylineLength(satelliteC9Lines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    // When C9 lines are drawn, footage tracks them. When the last line is
    // deleted (had lines on the previous run, none now), reset footage to 0 —
    // it was derived from those lines. When no lines were ever drawn, leave
    // winterWonderlandFootage alone so the manual input still works.
    const hasC9Lines = satelliteC9Lines.length > 0;
    const c9Target = hasC9Lines ? c9Ft : hadC9LinesRef.current ? 0 : null;
    hadC9LinesRef.current = hasC9Lines;
    // defer so the form update isn't synchronous within the effect (flushes before paint)
    queueMicrotask(() => setForm(f => {
      const sameRoof = f.santasFootage === sFt && f.gingerbreadFootage === gFt;
      const sameC9 = c9Target == null || f.winterWonderlandFootage === c9Target;
      if (sameRoof && sameC9) return f;
      return {
        ...f,
        santasFootage: sFt,
        gingerbreadFootage: gFt,
        ...(c9Target != null ? { winterWonderlandFootage: c9Target } : {}),
      };
    }));
  }, [satelliteSantasLines, satelliteGingerbreadLines, satelliteC9Lines, satelliteFeetPerPixel, satelliteAspect]);

  // Footage readout for the satellite tab.
  const satFootage = {
    santas: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
    ginger: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
  };

  // Line setters — satellite-only now (#35): street lines are gone, the design
  // owns the street-side visuals.
  const getSetter = (type: LineType) => {
    if (type === 'santas') return setSatelliteSantasLines;
    if (type === 'gingerbread') return setSatelliteGingerbreadLines;
    return setSatelliteC9Lines;
  };
  const activeSantasLines = satelliteSantasLines;
  const activeGingerbreadLines = satelliteGingerbreadLines;
  const activeC9Lines = satelliteC9Lines;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: PointerEvent) => {
      const rect = imgContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const setter = getSetter(dragging.type);
      setter(lines => lines.map((line, i) =>
        i === dragging.lineIdx
          ? { ...line, points: line.points.map((p, j) => j === dragging.ptIdx ? [x, y] as [number, number] : p) }
          : line
      ));
    };
    const handleUp = () => setDragging(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const deletePoint = (type: LineType, lineIdx: number, ptIdx: number) => {
    const setter = getSetter(type);
    setter(lines => lines.map((line, i) =>
      i === lineIdx ? { ...line, points: line.points.filter((_, j) => j !== ptIdx) } : line
    ).filter(line => line.points.length >= 2));
  };

  const deleteLine = (type: LineType, lineIdx: number) => {
    const setter = getSetter(type);
    setter(lines => lines.filter((_, i) => i !== lineIdx));
  };

  const updateLineLabel = (type: LineType, lineIdx: number, label: string) => {
    const setter = getSetter(type);
    setter(lines => lines.map((line, i) => i === lineIdx ? { ...line, label } : line));
  };

  const handleImageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!addMode) return;
    const rect = imgContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setPendingPoints(prev => [...prev, [x, y]]);
  };

  const finishAddingLine = () => {
    if (!addMode || pendingPoints.length < 2) {
      setAddMode(null);
      setPendingPoints([]);
      return;
    }
    const newLine: LineSegment = {
      points: pendingPoints,
      label: addMode === 'santas' ? 'new gutterline' : addMode === 'gingerbread' ? 'new ridgeline' : 'new c9 run',
    };
    const setter = getSetter(addMode);
    setter(lines => [...lines, newLine]);
    setAddMode(null);
    setPendingPoints([]);
  };

  const cancelAdd = () => {
    setAddMode(null);
    setPendingPoints([]);
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setAnalysisNotes(null);
    setAnalysisError(null);
    // Reset stale state from any prior Google/address analysis so the manual
    // upload doesn't silently reuse satellite lines, base64, or calibration.
    setSatellitePreview(null);
    setSatelliteSantasLines([]);
    setSatelliteGingerbreadLines([]);
    setSatelliteC9Lines([]);
    setSatelliteFeetPerPixel(null);
    setGoogleAddress(null);
    setPhotoBase64(null);
    setPhotoMediaType(null);
    setFewShotCount(0);
    // Manual upload has no Google coords — hide the rotation controls.
    setGeoLat(null);
    setGeoLng(null);
  };

  // Re-fetch Street View at a new heading/pitch/fov — lets the user rotate
  // around obstacles (trees, parked cars, scaffolding) blocking the default
  // angle. Does NOT re-run Claude; user can manually edit lines or click
  // "Re-analyze" after to let Claude remeasure the new angle.
  const recaptureStreetView = async (patch: { heading?: number | null; pitch?: number; fov?: number }) => {
    if (geoLat == null || geoLng == null) return;
    // null heading means "reset to Google's auto heading"; absent means "keep current".
    const nextHeading = patch.heading === null ? null : (patch.heading ?? svHeading);
    const nextPitch = patch.pitch ?? svPitch;
    const nextFov = patch.fov ?? svFov;
    setRecapturing(true);
    setAnalysisError(null);
    try {
      const res = await fetch('/api/streetview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: geoLat, lng: geoLng,
          heading: nextHeading ?? undefined,
          pitch: nextPitch,
          fov: nextFov,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Street View refetch failed');
      // Any roofline seed from a PREVIOUS analysis belongs to the old camera
      // angle — drop it so it can't land on the new photo. (The eager design
      // effect will push this photo into the design as its new base.)
      pendingSeedRef.current = null;
      setPhotoPreview(`data:${data.photoMediaType};base64,${data.photoBase64}`);
      setPhotoBase64(data.photoBase64);
      setPhotoMediaType(data.photoMediaType);
      setSvHeading(nextHeading);
      setSvPitch(nextPitch);
      setSvFov(nextFov);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Street View refetch failed');
    } finally {
      setRecapturing(false);
    }
  };

  // Re-run Claude analysis on the current street view image (after user rotated
  // to a clearer angle). Uses the same base64 already loaded — no extra fetch.
  const reanalyzeCurrent = async () => {
    if (!photoBase64 || !photoMediaType) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotes(null);
    try {
      // Reconstruct a File-like blob so the existing /api/analyze-photo flow works.
      const byteString = atob(photoBase64);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
      const blob = new Blob([bytes], { type: photoMediaType });
      const fd = new FormData();
      fd.append('photo', blob, 'streetview.jpg');
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      applyAnalysisResult(data);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  // Shared: apply analysis result to the form + satellite state + the design's
  // roofline seed. Used by both manual upload and Google address lookup.
  // #35 Phase 1: the AI's street roofline lines feed the DESIGN (as tagged C9
  // strands); its per-unit detections are dropped for now — Phase 2 (the bridge
  // auto-design) converts them into scene items too, and #8 then upgrades the
  // AI itself to design directly.
  type AnalysisResponse = {
    result: {
      santasFootage: number;
      santasDifficulty: 'easy' | 'medium' | 'hard';
      gingerbreadFootage: number;
      gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
      santasLines?: LineSegment[];
      gingerbreadLines?: LineSegment[];
      satelliteSantasLines?: LineSegment[];
      satelliteGingerbreadLines?: LineSegment[];
      preferredSource?: 'street' | 'satellite';
      notes: string;
      confidence: string;
    };
    photoBase64?: string;
    photoMediaType?: string;
    satelliteBase64?: string;
    satelliteMediaType?: string;
    satelliteFeetPerPixel?: number;
    formattedAddress?: string;
    lat?: number;
    lng?: number;
    fewShotCount?: number;
  };
  const applyAnalysisResult = (data: AnalysisResponse) => {
    const r = data.result;
    // The AI's footage estimates pre-fill the inputs; satellite lines (when
    // present) take over via the measurement effect, and staff can always type.
    setForm(f => ({
      ...f,
      santasFootage: r.santasFootage,
      santasDifficulty: r.santasDifficulty,
      gingerbreadFootage: r.gingerbreadFootage,
      gingerbreadDifficulty: r.gingerbreadDifficulty,
    }));
    // Satellite polylines — seed them so the satellite tab is ready for
    // complex / commercial rooflines without re-analyzing.
    setSatelliteSantasLines(r.satelliteSantasLines ?? []);
    setSatelliteGingerbreadLines(r.satelliteGingerbreadLines ?? []);
    setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
    // The AI's street roofline lines become tagged C9 strands on the design
    // (#33). If the design already carries this exact photo (a re-analyze),
    // seed it directly; otherwise park the lines for the eager design effect.
    const seedLines = {
      santas: (r.santasLines ?? []).map((l) => l.points),
      gingerbread: (r.gingerbreadLines ?? []).map((l) => l.points),
      winterWonderland: [] as [number, number][][],
    };
    if (designId && data.photoBase64 && designPhotoRef.current === data.photoBase64) {
      void seedDesignRoofline(designId, seedLines);
    } else {
      pendingSeedRef.current = seedLines;
    }
    // Claude may flag satellite as the better measurement source (e.g. rear
    // rooflines invisible from the street) — surface that tab if so.
    setViewMode(r.preferredSource === 'satellite' ? 'satellite' : 'design');
    setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})`);
    setPhotoBase64(data.photoBase64 ?? null);
    setPhotoMediaType(data.photoMediaType ?? null);
    setFewShotCount(data.fewShotCount ?? 0);
  };

  const handleLookupAddress = async () => {
    const addr = form.customer.address.trim();
    if (!addr) {
      setAnalysisError('Enter the property address above first.');
      return;
    }
    setLookingUp(true);
    setAnalysisError(null);
    setAnalysisNotes(null);
    try {
      const res = await fetch('/api/analyze-address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Address lookup failed');
      // Show street view as the editable photo
      const streetUrl = `data:${data.photoMediaType};base64,${data.photoBase64}`;
      setPhotoPreview(streetUrl);
      setPhotoFile(null);
      setSatellitePreview(`data:${data.satelliteMediaType};base64,${data.satelliteBase64}`);
      setGoogleAddress(data.formattedAddress ?? null);
      if (typeof data.lat === 'number') setGeoLat(data.lat);
      if (typeof data.lng === 'number') setGeoLng(data.lng);
      // Reset camera to default on fresh lookup so the rotation controls start
      // from Google's auto-chosen angle rather than a stale heading.
      setSvHeading(null);
      setSvPitch(0);
      setSvFov(80);
      applyAnalysisResult(data);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Address lookup failed');
    } finally {
      setLookingUp(false);
    }
  };

  const handleAnalyzePhoto = async () => {
    if (!photoFile) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotes(null);

    const fd = new FormData();
    fd.append('photo', photoFile);

    try {
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      setSatellitePreview(null);
      setGoogleAddress(null);
      applyAnalysisResult(data);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  const set = <K extends keyof QuoteFormData>(k: K, v: QuoteFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const setCustomer = (k: keyof FormCustomer, v: string) =>
    setForm(f => ({ ...f, customer: { ...f.customer, [k]: v } }));

  // (#35: per-unit items — minis/spritzers/wreaths/garland/bows — are authored
  // ONLY on the design now; the manual form sections are gone. The engine still
  // accepts the arrays; the design projection populates them at Calculate.)

  // Custom / manual line items (#27 escape hatch) — staff-typed name + price for
  // off-design items. Not tied to the design; flow to the quote + portal.
  const addCustomLineItem = () =>
    set('customLineItems', [...form.customLineItems, { label: '', amount: 0, quantity: 1 }]);
  const removeCustomLineItem = (i: number) =>
    set('customLineItems', form.customLineItems.filter((_, idx) => idx !== i));
  const updateCustomLineItem = (i: number, patch: Partial<CustomLineItem>) =>
    set('customLineItems', form.customLineItems.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Pick a HighLevel contact → pre-fill the customer block below.
  // Precedence: HL data wins if the contact has a value for that field. If
  // HL has nothing (e.g., contact was created without an email), we keep
  // whatever is currently in the input — either typed by the operator or
  // left from a prior contact pick.
  //
  // Rationale: picking a contact is an explicit "use this person" action;
  // the operator expects the form to reflect the picked contact, not to
  // silently ignore HL's data because a prior value (including browser
  // autofill or a stray keystroke) was sitting in the field.
  const pickHighLevelContact = (c: CrmContact) => {
    setHighLevelContact(c);
    const hlName = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ');
    const hlAddress = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(', ');
    setForm(f => ({
      ...f,
      customer: {
        name: hlName || f.customer.name,
        phone: c.phone || f.customer.phone,
        email: c.email || f.customer.email,
        address: hlAddress || f.customer.address,
      },
    }));
    // Reset attach status — the previous attach (if any) was against a
    // different contact and doesn't apply anymore.
    setAttachStatus('idle');
    setAttachError(null);
  };

  const clearHighLevelContact = () => {
    setHighLevelContact(null);
    setAttachStatus('idle');
    setAttachError(null);
  };

  // Attach this quote's existing HL opportunity. Called async after save;
  // failures don't block the quote from displaying.
  const attachQuoteToHighLevel = async (quoteId: string, contactId: string) => {
    setAttachStatus('attaching');
    setAttachError(null);
    try {
      const res = await fetch('/api/integrations/highlevel/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteId,
          contactId,
          opportunityName: form.customer.address.trim()
            ? `Holiday Lights — ${form.customer.address.trim()}`
            : undefined,
          monetaryValue: result?.total,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Attach failed (${res.status})`);
      setAttachStatus('attached');
    } catch (err) {
      setAttachStatus('error');
      setAttachError(err instanceof Error ? err.message : 'Attach failed');
    }
  };

  // Build the portal URL from the saved quote id. Used both for the
  // "Send to Customer" action (which moves the HL stage) and for the
  // clipboard copy.
  const portalUrlFor = (quoteId: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/portal/${quoteId}`;
  };

  // "Send Quote to Customer" — copies the portal URL to clipboard AND
  // calls /api/quotes/:id/send which moves the HL opportunity stage to
  // "Bid Sent". The admin still manually shares the URL (email/SMS/
  // messaging app) — we don't auto-send yet. Phase 2 could add that.
  const handleSendToCustomer = async () => {
    if (!savedQuoteId) return;
    setSendStatus('sending');
    setSendError(null);
    setCopiedUrl(false);

    const url = portalUrlFor(savedQuoteId);
    // Copy first so if the stage-move fails the operator still has the
    // URL on their clipboard to share manually.
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(true);
    } catch {
      // Non-fatal — some browsers block clipboard without user gesture.
      setCopiedUrl(false);
    }

    try {
      const res = await fetch(`/api/quotes/${savedQuoteId}/send`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Send failed (${res.status})`);
      setSendStatus('sent');
    } catch (err) {
      setSendStatus('error');
      setSendError(err instanceof Error ? err.message : 'Send failed');
    }
  };

  // Run the quote calculation. `rooflineChoiceOverride` lets the breakdown's
  // staff-pick radios re-quote with a specific Santa's/Gingerbread choice
  // (#17 Phase 1b) without waiting on the async form-state update.
  const runQuote = async (rooflineChoiceOverride?: RooflineChoice) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setAttachStatus('idle');
    setAttachError(null);
    setSendStatus('idle');
    setSendError(null);
    setCopiedUrl(false);

    // Once a quote exists (edit mode, or any Calculate after the first on a
    // new quote), recalculating UPDATES that row in place — no more duplicate
    // rows piling up in /admin/quotes (#31).
    const existingQuoteId = savedQuoteId;
    const inputs = buildQuoteInputs(form, rooflineChoiceOverride);

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // designId → if the linked design has per-unit items, the route uses
        // them (design-driven pricing); otherwise the form's per-unit entry
        // drives it (decision 2a fallback).
        body: JSON.stringify({
          customer: form.customer,
          inputs,
          quoteId: existingQuoteId ?? undefined,
          designId: designId ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      const newQuoteId = typeof data.quoteId === 'string' ? data.quoteId : null;
      setSavedQuoteId(newQuoteId);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      // Attach to HL opportunity in parallel, if an HL contact was picked
      // (skipped when this quote+contact pair is already attached).
      const attachKey = newQuoteId && highlevelContact?.id ? `${newQuoteId}:${highlevelContact.id}` : null;
      if (attachKey && newQuoteId && highlevelContact?.id && lastAttachKey.current !== attachKey) {
        lastAttachKey.current = attachKey;
        void attachQuoteToHighLevel(newQuoteId, highlevelContact.id);
      } else if (highlevelContact?.id && !newQuoteId) {
        // Quote wasn't persisted (Supabase not configured). Tell the
        // operator the HL link won't be made either.
        setAttachStatus('skipped');
        setAttachError('Quote not persisted — HighLevel link skipped. Check Supabase config.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  // Staff recommends which roofline the customer sees by default. Lighter than
  // a full re-quote: re-prices the EXISTING quote in place (no new row, no
  // re-render, no scroll) so only the price/breakdown updates (#17 Phase 1b).
  const recommendRoofline = async (choice: RooflineChoice) => {
    if (loading) return;
    setForm((f) => ({ ...f, rooflineChoice: choice }));
    setLoading(true);
    setError(null);
    try {
      const inputs = buildQuoteInputs(form, choice);
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // quoteId → re-price that quote in place; falls back to a fresh save
        // if the quote wasn't persisted (Supabase unconfigured).
        body: JSON.stringify({ customer: form.customer, inputs, quoteId: savedQuoteId ?? undefined, designId: designId ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      if (typeof data.quoteId === 'string') setSavedQuoteId(data.quoteId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <p className="text-xs font-semibold text-green-600 uppercase tracking-widest mb-1">
            Yule Love Lights
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{editMode ? 'Edit Quote' : 'New Quote'}</h1>
            {initialQuote?.approvedAt ? (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                Approved
              </span>
            ) : initialQuote?.sentAt ? (
              <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                Sent
              </span>
            ) : null}
          </div>
          {editMode && (
            <p className="text-xs text-gray-500 mt-1">
              Editing saved quote <span className="font-mono">{initialQuote?.quoteId.slice(0, 8)}</span> —
              Calculate updates this quote in place{initialQuote?.approvedAt
                ? '. ⚠️ The customer already APPROVED this quote; edits change what their portal shows.'
                : initialQuote?.sentAt
                  ? '. ⚠️ This quote was already sent; edits change what the customer sees on their portal.'
                  : '.'}
            </p>
          )}
        </div>

        {/* No <form> wrapper (#35): the embedded design editor's vanilla
            buttons carry no type attribute and would implicitly submit a
            surrounding form on every click. Calculate is a plain button. */}
        <div>

          {/* ── Customer Info ── */}
          <Section title="Customer Info">
            {/* HighLevel contact autocomplete — pick an existing lead to
                pre-fill the fields below. If no match (or if we're doing
                a walk-in quote), just type straight into the fields. */}
            <HighLevelContactAutocomplete
              selected={highlevelContact}
              onPick={pickHighLevelContact}
              onClear={clearHighLevelContact}
            />
            <p className="text-xs text-amber-600 mb-3">
              Testing mode — name / phone / email are optional. Address is optional too, but helps if you want to tie the quote to a real property.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Name</label>
                <input className={inp} placeholder="Jane Smith (optional)"
                  value={form.customer.name} onChange={e => setCustomer('name', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Phone</label>
                <input className={inp} placeholder="(516) 555-0123"
                  value={form.customer.phone} onChange={e => setCustomer('phone', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Email</label>
                <input className={inp} type="email" placeholder="jane@example.com"
                  value={form.customer.email} onChange={e => setCustomer('email', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Property Address</label>
                <input className={inp} placeholder="123 Main St, Smithtown, NY 11787"
                  value={form.customer.address} onChange={e => setCustomer('address', e.target.value)} />
              </div>
            </div>
          </Section>

          {/* ── Photo Analysis ── */}
          <Section title="House Photo — Auto-Measure">
            <p className="text-xs text-gray-400 mb-3">
              Look up the address on Google Maps (Street View + satellite) or upload a photo. Claude will estimate front gutterline, ridge + sides, bushes, trees, and columns.
            </p>

            {/* Google lookup */}
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-blue-900">Look up on Google Maps</span>
                <button
                  type="button"
                  onClick={handleLookupAddress}
                  disabled={lookingUp || !form.customer.address.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium text-sm px-4 py-2 rounded-md whitespace-nowrap"
                >
                  {lookingUp ? 'Looking up…' : '🏠 Analyze from Address'}
                </button>
              </div>
              <p className="text-xs text-blue-700">
                Uses the Property Address above. Fetches Street View + satellite view, sends both to Claude.
              </p>
              {googleAddress && (
                <p className="mt-2 text-xs text-blue-800">
                  <span className="font-semibold">Matched:</span> {googleAddress}
                </p>
              )}
            </div>

            {/* Manual upload */}
            <p className="text-xs text-gray-500 font-medium mb-2">— Or upload a photo manually —</p>
            <div className="space-y-3">
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoSelect}
                className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
              />
              {photoPreview && photoFile && (
                <div className="space-y-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoPreview} alt="House preview" className="w-48 h-auto rounded-md border border-gray-200" />
                  <button
                    type="button"
                    onClick={handleAnalyzePhoto}
                    disabled={analyzing}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-medium py-2 px-4 rounded-md text-sm"
                  >
                    {analyzing ? 'Analyzing…' : 'Analyze with Claude'}
                  </button>
                </div>
              )}
              {satellitePreview && (
                <p className="text-xs text-gray-500 italic">
                  Roof measurements come from the Satellite tab below (or type them manually).
                </p>
              )}
              {analysisNotes && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
                  <strong className="block mb-1">
                    Analysis complete — measurements auto-filled, roofline drawn on the design.
                    {fewShotCount > 0 && (
                      <span className="ml-1 font-normal">• Using {fewShotCount} past correction{fewShotCount === 1 ? '' : 's'} as reference</span>
                    )}
                  </strong>
                  {analysisNotes}
                </div>
              )}
              {analysisError && (
                <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">
                  {analysisError}
                </div>
              )}
            </div>
          </Section>

          {/* ── House — Design (street) + Satellite measurement (#35) ── */}
          {(designId || photoPreview || satellitePreview || designBusy) ? (
            <Section title="House — Design & Measure">
              {/* Tab switcher. Both panes stay MOUNTED across switches (CSS
                  hidden) so the design editor and the satellite lines never
                  lose state; switching to Design nudges a window resize so the
                  Konva canvas refits after being unhidden. */}
              <div className="mb-3 flex items-center gap-3 flex-wrap">
                <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setViewMode('design');
                      requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))));
                    }}
                    className={`px-3 py-1.5 font-medium ${viewMode === 'design' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                  >
                    Design (Street)
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('satellite')}
                    disabled={!satellitePreview}
                    title={satellitePreview ? undefined : 'No satellite view — look up the address to get one.'}
                    className={`px-3 py-1.5 font-medium border-l border-gray-300 ${viewMode === 'satellite' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'} disabled:text-gray-300 disabled:hover:bg-white`}
                  >
                    Satellite (top-down)
                  </button>
                </div>
                {satelliteFeetPerPixel != null && (
                  <div className="text-xs rounded border border-green-200 bg-green-50 px-2 py-1.5 font-semibold text-gray-700">
                    Satellite: front {satFootage.santas ?? '—'}ft · ridge+sides {satFootage.ginger ?? '—'}ft
                  </div>
                )}
              </div>

              {/* ── DESIGN tab — the design tool IS the street view (#35) ── */}
              <div className={viewMode === 'design' ? '' : 'hidden'}>
                {/* Street View angle controls — rotate around obstacles (trees,
                    parked cars). Only shown when we have Google coordinates.
                    Re-capturing swaps the design's base photo underneath the
                    drawn items — fix the angle BEFORE designing. */}
                {geoLat != null && geoLng != null && (
                  <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                        Move the Camera
                      </span>
                      <span className="text-[11px] text-gray-500">
                        Tree or truck in the way? Rotate, tilt, or zoom — then re-analyze. Best done before designing.
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ Rotate −30°
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) - 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ◀ −10°
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 10 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        +10° ▶
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: (svHeading ?? 0) + 30 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Rotate +30° ▶
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ pitch: Math.min(90, svPitch + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▲ Tilt Up
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ pitch: Math.max(-90, svPitch - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        ▼ Tilt Down
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ fov: Math.min(120, svFov + 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        − Zoom Out
                      </button>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ fov: Math.max(30, svFov - 10) })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        + Zoom In
                      </button>
                      <span className="mx-1 text-gray-300">|</span>
                      <button type="button" disabled={recapturing}
                        onClick={() => recaptureStreetView({ heading: null, pitch: 0, fov: 80 })}
                        className="text-xs font-medium border border-gray-300 hover:border-gray-500 rounded px-3 py-1.5 bg-white disabled:opacity-50">
                        Reset
                      </button>
                      <button type="button" disabled={analyzing || recapturing}
                        onClick={reanalyzeCurrent}
                        className="ml-auto text-xs font-semibold text-white bg-green-600 hover:bg-green-700 disabled:bg-green-300 rounded px-3 py-1.5">
                        {analyzing ? 'Re-analyzing…' : 'Re-analyze This View'}
                      </button>
                    </div>
                    <div className="mt-2 text-[11px] text-gray-500 tabular-nums">
                      heading {svHeading ?? 'auto'}° · pitch {svPitch}° · fov {svFov}°
                      {recapturing && <span className="ml-2 text-blue-700 font-medium">Fetching new angle…</span>}
                    </div>
                  </div>
                )}
                {designError && <p className="text-sm text-red-600 mb-2">{designError}</p>}
                {designId ? (
                  <>
                    <DesignEditor key={designEditorKey} designId={designId} height={640} />
                    <p className="text-xs text-gray-400 mt-2">
                      Draw the install on the photo — roofline, minis, wreaths, garland, bows. The design IS the
                      quote&apos;s item list (Custom line items below are the escape hatch for anything it can&apos;t
                      represent). Saves automatically and attaches to this quote on Calculate.
                    </p>
                    <DesignSummary designId={designId} refreshKey={designEditorKey} />
                  </>
                ) : (
                  <p className="text-sm text-gray-500 py-10 text-center">
                    {designBusy
                      ? 'Setting up the design canvas…'
                      : 'Analyze from address (or upload + analyze a photo) and the design canvas opens here with the house photo.'}
                  </p>
                )}
              </div>

              {/* ── SATELLITE tab — roof measurement lines (the ONLY line-
                  measurement source; no satellite → type footage manually) ── */}
              <div className={viewMode === 'satellite' ? '' : 'hidden'}>
                {satellitePreview ? (
                  <>
                    <div className="mb-3 bg-amber-50 border border-amber-200 rounded-md p-2.5 text-xs text-amber-900">
                      <strong>Verify the roof outline.</strong> Claude often traces the property edge or driveway instead of the actual roof. Drag points or re-draw the lines to hug the real shingle/ridge edges — footage auto-updates from what you draw.
                    </div>
                    <div
                      ref={imgContainerRef}
                      onClick={addMode ? handleImageClick : undefined}
                      className={`relative w-full ${addMode ? 'cursor-crosshair' : ''}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={satellitePreview}
                        alt="Satellite view"
                        className="w-full h-auto rounded-md border border-gray-200 block select-none pointer-events-none"
                        draggable={false}
                        onLoad={e => {
                          const img = e.currentTarget;
                          if (img.naturalHeight > 0) setSatelliteAspect(img.naturalWidth / img.naturalHeight);
                        }}
                      />
                      <svg
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full"
                        style={{ pointerEvents: 'none' }}
                      >
                        {activeSantasLines.map((line, i) => (
                          <polyline
                            key={`s-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#ef4444"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {activeGingerbreadLines.map((line, i) => (
                          <polyline
                            key={`g-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#3b82f6"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {activeC9Lines.map((line, i) => (
                          <polyline
                            key={`c9-${i}`}
                            points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                        {pendingPoints.length > 0 && (
                          <polyline
                            points={pendingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                            fill="none"
                            stroke={addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : '#10b981'}
                            strokeWidth="3"
                            strokeDasharray="6 4"
                            vectorEffect="non-scaling-stroke"
                          />
                        )}
                      </svg>
                      {/* Draggable point handles (HTML elements, positioned absolute) */}
                      {!addMode && activeSantasLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`sh-${li}-${pi}`}
                          className="absolute w-4 h-4 rounded-full bg-red-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                          style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                          onPointerDown={e => { e.preventDefault(); setDragging({ type: 'santas', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('santas', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && activeGingerbreadLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`gh-${li}-${pi}`}
                          className="absolute w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                          style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                          onPointerDown={e => { e.preventDefault(); setDragging({ type: 'gingerbread', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('gingerbread', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {!addMode && activeC9Lines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                        <div
                          key={`c9h-${li}-${pi}`}
                          className="absolute w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                          style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                          onPointerDown={e => { e.preventDefault(); setDragging({ type: 'c9', lineIdx: li, ptIdx: pi }); }}
                          onDoubleClick={() => deletePoint('c9', li, pi)}
                          title="Drag to move • Double-click to delete"
                        />
                      )))}
                      {pendingPoints.map(([x, y], i) => (
                        <div
                          key={`pp-${i}`}
                          className={`absolute w-3 h-3 rounded-full ${addMode === 'santas' ? 'bg-red-500' : addMode === 'gingerbread' ? 'bg-blue-500' : 'bg-emerald-500'} border-2 border-white shadow`}
                          style={{ left: `calc(${x * 100}% - 6px)`, top: `calc(${y * 100}% - 6px)` }}
                        />
                      ))}
                    </div>

                    {/* Add-line controls */}
                    {addMode ? (
                      <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                        <span className="text-sm text-yellow-900">
                          Adding new {addMode === 'santas' ? 'front gutterline (red)' : addMode === 'gingerbread' ? 'ridge / side line (blue)' : 'C9 run (green)'} — click on the photo to add points ({pendingPoints.length} placed).
                        </span>
                        <div className="flex gap-2">
                          <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">
                            Done
                          </button>
                          <button type="button" onClick={cancelAdd}
                            className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => { setAddMode('santas'); setPendingPoints([]); }}
                          className="text-xs font-medium text-red-700 border border-red-300 hover:border-red-500 rounded px-3 py-1.5">
                          + Add Front Gutterline
                        </button>
                        <button type="button" onClick={() => { setAddMode('gingerbread'); setPendingPoints([]); }}
                          className="text-xs font-medium text-blue-700 border border-blue-300 hover:border-blue-500 rounded px-3 py-1.5">
                          + Add Ridge / Side
                        </button>
                        <button type="button" onClick={() => { setAddMode('c9'); setPendingPoints([]); }}
                          className="text-xs font-medium text-emerald-700 border border-emerald-300 hover:border-emerald-500 rounded px-3 py-1.5">
                          + Add C9 Run
                        </button>
                      </div>
                    )}

                    {/* Per-line edit panels — front gutterline / ridge+sides / C9s. */}
                    <div className="mt-4 grid grid-cols-3 gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-red-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">Front Gutterline — {form.santasFootage}ft</span>
                        </div>
                        {activeSantasLines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeSantasLines.map((line, i) => (
                              <li key={`sl-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('santas', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('santas', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-gray-400 ml-6">No segments</p>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-blue-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">Ridge + Sides — {form.gingerbreadFootage}ft</span>
                        </div>
                        {activeGingerbreadLines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeGingerbreadLines.map((line, i) => (
                              <li key={`gl-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('gingerbread', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('gingerbread', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-gray-400 ml-6">No segments</p>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-4 h-1 bg-emerald-500 rounded"></span>
                          <span className="text-sm font-semibold text-gray-800">C9s — {form.winterWonderlandFootage}ft</span>
                        </div>
                        {activeC9Lines.length > 0 ? (
                          <ul className="space-y-1 ml-6">
                            {activeC9Lines.map((line, i) => (
                              <li key={`c9l-${i}`} className="flex items-center gap-2 text-xs">
                                <input
                                  value={line.label}
                                  onChange={e => updateLineLabel('c9', i, e.target.value)}
                                  className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                                />
                                <span className="text-gray-400">{line.points.length}pts</span>
                                <button type="button" onClick={() => deleteLine('c9', i)}
                                  className="text-red-400 hover:text-red-600 font-bold">×</button>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="ml-6">
                            <p className="text-xs text-gray-400 mb-2">No segments — draw on photo, or enter manually:</p>
                            <div className="flex items-center gap-2">
                              <input className="border border-gray-200 rounded px-2 py-1 text-xs w-20" type="number" min="0" placeholder="0"
                                value={form.winterWonderlandFootage || ''}
                                onChange={e => set('winterWonderlandFootage', Number(e.target.value))} />
                              <span className="text-xs text-gray-500">ft</span>
                              <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white" value={form.winterWonderlandDifficulty}
                                onChange={e => set('winterWonderlandDifficulty', e.target.value as RooflineDifficulty)}>
                                <option value="easy">Easy</option>
                                <option value="medium">Medium</option>
                                <option value="hard">Hard</option>
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-gray-500 py-10 text-center">
                    No satellite view (manual photo upload) — enter the roof measurements in the sections below.
                  </p>
                )}
              </div>
            </Section>
          ) : null}

          {/* ── Santa's — Front Gutterline ── */}
          <div className={`transition-opacity ${form.santasFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Santa's — Front Gutterline (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.santasFootage || ''}
                    onChange={e => set('santasFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.santasDifficulty}
                    onChange={e => set('santasDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.santasFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Gingerbread — Ridge + Sides ── */}
          <div className={`transition-opacity ${form.gingerbreadFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Gingerbread — Ridge + Sides (C9 Bulbs)">
              <p className="text-xs text-gray-400 mb-3">Auto-measured from photo. Adjust if needed.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.gingerbreadFootage || ''}
                    onChange={e => set('gingerbreadFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.gingerbreadDifficulty}
                    onChange={e => set('gingerbreadDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.gingerbreadFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── C9s — Custom Runs ── */}
          <div className={`transition-opacity ${form.winterWonderlandFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="C9s — Custom Runs">
              <p className="text-xs text-gray-400 mb-3">Enter manually — C9 bulb runs.</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={lbl}>Linear Footage</label>
                  <input className={inp} type="number" min="0" placeholder="0"
                    value={form.winterWonderlandFootage || ''}
                    onChange={e => set('winterWonderlandFootage', Number(e.target.value))} />
                </div>
                <div>
                  <label className={lbl}>Difficulty</label>
                  <select className={sel} value={form.winterWonderlandDifficulty}
                    onChange={e => set('winterWonderlandDifficulty', e.target.value as RooflineDifficulty)}>
                    <option value="easy">Easy — $8/ft</option>
                    <option value="medium">Medium — $10/ft</option>
                    <option value="hard">Hard — $12/ft</option>
                  </select>
                </div>
              </div>
              {form.winterWonderlandFootage === 0 && (
                <p className="mt-2 text-xs text-amber-500">Footage is 0 — not included in quote</p>
              )}
            </Section>
          </div>

          {/* ── Custom / manual line items (#27 escape hatch) ── */}
          <Section title="Custom / manual line items">
            <p className="text-xs text-gray-400 mb-3">
              For anything the design can&apos;t represent — staff-named items billed at the price you set.
              They appear on the quote and the customer portal (not tied to the design).
            </p>
            {form.customLineItems.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_96px_64px_28px] gap-2 mb-1">
                  <span className={lbl}>Name</span>
                  <span className={lbl}>Unit $</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.customLineItems.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_96px_64px_28px] gap-2 mb-2 items-start">
                    <input className={inp} type="text" placeholder="e.g. Custom monogram display"
                      value={item.label}
                      onChange={e => updateCustomLineItem(i, { label: e.target.value })} />
                    <input className={inp} type="number" min="0" step="0.01"
                      value={item.amount || ''}
                      onChange={e => updateCustomLineItem(i, { amount: Number(e.target.value) })} />
                    <input className={inp} type="number" min="1" step="1"
                      value={item.quantity ?? 1}
                      onChange={e => updateCustomLineItem(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeCustomLineItem(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addCustomLineItem} className={addBtn}>
              + Add custom line item
            </button>
          </Section>

          {/* ── Options ── */}
          <Section title="Options">

            {/* Takedown */}
            <div className="mb-5">
              <p className={lbl}>Takedown</p>
              <div className="flex gap-8 mt-1.5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="included"
                    checked={form.takedown === 'included'} onChange={() => set('takedown', 'included')} />
                  Included — Jan 9 – Feb 3
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="takedown" value="premium"
                    checked={form.takedown === 'premium'} onChange={() => set('takedown', 'premium')} />
                  Premium (+$150) — before Jan 9
                </label>
              </div>
            </div>

            {/* Rush fee */}
            <div className="mb-5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form.rushFee}
                  onChange={e => set('rushFee', e.target.checked)} />
                Rush fee — add $150
              </label>
            </div>

            {/* Discount */}
            <div>
              <label className="flex items-center gap-2 text-sm cursor-pointer mb-3">
                <input type="checkbox" checked={form.discountEnabled}
                  onChange={e => set('discountEnabled', e.target.checked)} />
                Apply discount
              </label>
              {form.discountEnabled && (
                <div className="pl-6 flex flex-wrap items-center gap-5">
                  <div className="flex gap-5">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="discountType" value="percentage"
                        checked={form.discountType === 'percentage'}
                        onChange={() => set('discountType', 'percentage')} />
                      Percentage
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="discountType" value="flat"
                        checked={form.discountType === 'flat'}
                        onChange={() => set('discountType', 'flat')} />
                      Flat dollar
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min="0"
                      max={form.discountType === 'percentage' ? '100' : undefined}
                      step="0.01"
                      className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={form.discountAmount || ''}
                      placeholder={form.discountType === 'percentage' ? '20' : '100'}
                      onChange={e => set('discountAmount', Number(e.target.value))}
                    />
                    <span className="text-xs text-gray-400">
                      {form.discountType === 'percentage' ? 'e.g. 20 = 20% off' : 'e.g. 100 = $100 off'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Calculate */}
          <button
            type="button"
            onClick={() => void runQuote()}
            disabled={loading}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors mb-6 text-base"
          >
            {loading ? 'Calculating…' : 'Calculate Quote'}
          </button>

        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
            {error}
          </div>
        )}

        {/* ── Result ── */}
        {result && (
          <div ref={resultRef} className="bg-white border border-gray-200 rounded-lg p-6 mb-10">
            <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
              Quote Breakdown
            </h2>

            {/* Roofline options — Santa's vs Gingerbread are mutually exclusive
                (#17). BOTH are presented to the customer; only the recommended
                one is billed in the total below. (Interactive staff-pick toggle
                is Phase 1b — for now the recommendation is auto-picked to land
                the quote closest to the $1,000 minimum without going under.) */}
            {(result.rooflineOptions.santas || result.rooflineOptions.gingerbread) && (
              <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Roofline — recommend one <span className="font-normal normal-case text-gray-400">(the customer picks on the portal)</span>
                </p>
                <div className="space-y-1">
                  {result.rooflineOptions.santas && (
                    <label className="flex items-center justify-between text-sm cursor-pointer rounded px-2 py-1.5 hover:bg-gray-100">
                      <span className="flex items-center gap-2 text-gray-700">
                        <input
                          type="radio"
                          name="rooflineChoice"
                          checked={result.rooflineChoice === 'santas'}
                          onChange={() => recommendRoofline('santas')}
                          disabled={loading}
                        />
                        Santa&apos;s <span className="text-gray-400">(front roofline)</span>
                      </span>
                      <span className="font-medium tabular-nums">{usd(result.rooflineOptions.santas.amount)}</span>
                    </label>
                  )}
                  {result.rooflineOptions.gingerbread && (
                    <label className="flex items-center justify-between text-sm cursor-pointer rounded px-2 py-1.5 hover:bg-gray-100">
                      <span className="flex items-center gap-2 text-gray-700">
                        <input
                          type="radio"
                          name="rooflineChoice"
                          checked={result.rooflineChoice === 'gingerbread'}
                          onChange={() => recommendRoofline('gingerbread')}
                          disabled={loading}
                        />
                        Gingerbread <span className="text-gray-400">(front + ridge + sides)</span>
                      </span>
                      <span className="font-medium tabular-nums">{usd(result.rooflineOptions.gingerbread.amount)}</span>
                    </label>
                  )}
                </div>
                <p className="text-[11px] text-gray-400 mt-2">Only the recommended (selected) option is billed in the total below.</p>
              </div>
            )}

            {/* Line items (the recommended roofline is shown in the option box
                above, so it's filtered out here to avoid listing it twice). */}
            <div className="mb-4 space-y-1.5">
              {result.lineItems
                .filter((item) => !(item.label.startsWith("Santa's Roofline") || item.label.startsWith('Gingerbread')))
                .map((item, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-gray-700">{item.label}</span>
                    <span className="font-medium tabular-nums">{usd(item.amount)}</span>
                  </div>
                ))}
            </div>

            {/* Subtotals */}
            <div className="border-t border-gray-200 pt-3 space-y-1.5 text-sm text-gray-600">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span className="tabular-nums">{usd(result.subtotalBeforeDiscount)}</span>
              </div>
              {result.discountAmount > 0 && (
                <div className="flex justify-between text-green-600">
                  <span>Discount</span>
                  <span className="tabular-nums">−{usd(result.discountAmount)}</span>
                </div>
              )}
              {result.rushFeeAmount > 0 && (
                <div className="flex justify-between">
                  <span>Rush fee</span>
                  <span className="tabular-nums">{usd(result.rushFeeAmount)}</span>
                </div>
              )}
              {result.takedownAmount > 0 && (
                <div className="flex justify-between">
                  <span>Premium takedown</span>
                  <span className="tabular-nums">{usd(result.takedownAmount)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Tax (8.625% on {usd(result.taxableAmount)})</span>
                <span className="tabular-nums">{usd(result.taxAmount)}</span>
              </div>
            </div>

            {/* Total + split */}
            <div className="border-t border-gray-300 mt-3 pt-4">
              <div className="flex justify-between items-baseline">
                <span className="text-lg font-bold text-gray-900">Total</span>
                <span className="text-2xl font-bold text-gray-900 tabular-nums">{usd(result.total)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="bg-green-50 border border-green-200 rounded-md p-3">
                  <p className="text-xs text-green-700 font-medium uppercase tracking-wide">Deposit Due Now</p>
                  <p className="text-xl font-bold text-green-800 tabular-nums mt-0.5">{usd(result.depositAmount)}</p>
                </div>
                <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                  <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Balance at Install</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums mt-0.5">{usd(result.balanceDue)}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Send Quote to Customer ────────────────────────────────────
            Surfaces once a quote has been saved (so we have an ID for the
            portal URL). Copies the customer-facing link to the clipboard
            AND moves the HighLevel opportunity to "📨Bid Sent". Manual
            share — admin pastes the URL into email/SMS/etc. */}
        {savedQuoteId && result && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-10">
            <div className="flex items-baseline justify-between mb-4 pb-2 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-800 uppercase tracking-wide">
                Send Quote to Customer
              </h2>
              <span className="text-xs text-gray-400">Copies link + updates pipeline</span>
            </div>

            {/* Portal URL preview — always visible so the admin can copy
                manually if the button didn't work (e.g., clipboard blocked). */}
            <div className="mb-3">
              <p className={lbl}>Customer Portal URL</p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={portalUrlFor(savedQuoteId)}
                  className="flex-1 border border-gray-200 bg-gray-50 rounded-md px-3 py-2 text-sm text-gray-700 font-mono"
                  onClick={e => (e.target as HTMLInputElement).select()}
                />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(portalUrlFor(savedQuoteId));
                      setCopiedUrl(true);
                      setTimeout(() => setCopiedUrl(false), 2000);
                    } catch { /* clipboard blocked */ }
                  }}
                  className="shrink-0 border border-gray-300 hover:border-gray-400 bg-white hover:bg-gray-50 text-gray-700 font-medium text-xs px-3 py-2 rounded-md whitespace-nowrap"
                >
                  {copiedUrl ? '✓ Copied' : '📋 Copy'}
                </button>
              </div>
            </div>

            {/* HighLevel attach status — informational. The operator might
                have skipped the HL autocomplete (walk-in quote), in which
                case "Send Quote to Customer" still works but no pipeline
                stage moves. */}
            {highlevelContact && (
              <div className="mb-3 text-xs">
                {attachStatus === 'attaching' && (
                  <span className="text-gray-500">Linking to HighLevel opportunity…</span>
                )}
                {attachStatus === 'attached' && (
                  <span className="text-green-700">✓ Linked to {highlevelContact.fullName || 'HighLevel contact'}&rsquo;s pipeline card</span>
                )}
                {attachStatus === 'error' && (
                  <span className="text-red-600">HighLevel link failed: {attachError}. Sending will still copy the URL but won&rsquo;t move the pipeline stage.</span>
                )}
                {attachStatus === 'skipped' && (
                  <span className="text-amber-700">{attachError}</span>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-gray-500 flex-1">
                Click to copy the link AND move this quote to &ldquo;Bid Sent&rdquo; in HighLevel. Then paste the URL into your email / text to the customer.
              </p>
              <button
                type="button"
                onClick={handleSendToCustomer}
                disabled={sendStatus === 'sending'}
                className="shrink-0 bg-green-600 hover:bg-green-700 disabled:bg-green-300 text-white font-medium text-sm px-5 py-2.5 rounded-md whitespace-nowrap"
              >
                {sendStatus === 'sending' ? 'Sending…'
                  : sendStatus === 'sent' ? '✓ Sent — stage moved to Bid Sent'
                  : '📨 Send Quote to Customer'}
              </button>
            </div>

            {sendStatus === 'error' && (
              <p className="mt-3 text-sm text-red-600">
                Send failed: {sendError}. The portal URL is still valid — you can copy it manually and share.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
