'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import type {
  Spritzer,
  Wreath,
  GarlandItem,
  WreathSize,
  DecorTier,
  SpritzerSize,
  GarlandLength,
} from '@/lib/pricing/pricingEngine';
import type { PhotoTag, TrainingPhoto } from '@/lib/training';
import { useImageZoomPan } from '@/lib/useImageZoomPan';
import type { LineSegment } from '@/lib/photoAnalysis';

// ─── Shared types — mirror quote/new/page.tsx ───────────────────────────────
type MiniLightDetection = {
  type: 'tree' | 'bush' | 'column' | 'railing';
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
  columnMode?: 'minilight' | 'garland';
  box: [number, number, number, number];
  label: string;
};
type WreathDetection = { size: WreathSize; tier: DecorTier; box: [number, number, number, number]; label: string };
type SpritzerDetection = { size: SpritzerSize; box: [number, number, number, number]; label: string };
type GarlandDetection = { length: GarlandLength; tier: DecorTier; box: [number, number, number, number]; label: string };

type LineType = 'santas' | 'gingerbread' | 'c9' | 'stake';
type BoxDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type DetectionKind = 'mini' | 'wreath' | 'spritzer' | 'garland';

// W3-014: one photo's markup — lines/boxes traced or Auto-Analyzed on that
// specific image. Kept out of TrainingPhoto (the shared lib/API type) since
// this is page-local working state, not part of the saved photo record.
type PerPhotoMarkup = {
  santasLines: LineSegment[];
  gingerbreadLines: LineSegment[];
  c9Lines: LineSegment[];
  stakeLines: LineSegment[];
  miniLightDetections: MiniLightDetection[];
  wreathDetections: WreathDetection[];
  spritzerDetections: SpritzerDetection[];
  garlandDetections: GarlandDetection[];
};

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';

const MINI_LIGHT_RATES = { canopy: 35, trunk: 45 } as const;
const PLANT_PERSPECTIVE_FACTOR = 0.4;

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

async function fileToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const arrayBuffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), mediaType: file.type };
}

const PHOTO_TAG_LABELS: Record<PhotoTag, string> = {
  front_install: 'Front — Installed',
  tree_bush: 'Tree/Bush',
  other: 'Other',
};

function base64ToBlob(base64: string, mediaType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

function polylineLength(lines: LineSegment[], aspect: number): number {
  const yScale = 1 / aspect;
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

export default function NewTrainingHousePage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNotes, setAnalysisNotes] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Training-specific fields
  const [address, setAddress] = useState('');
  const [yearCompleted, setYearCompleted] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [aiFailureNotes, setAiFailureNotes] = useState('');
  const [costMaterials, setCostMaterials] = useState<number | ''>('');
  const [costLaborHours, setCostLaborHours] = useState<number | ''>('');
  const [revenue, setRevenue] = useState<number | ''>('');

  const [photos, setPhotos] = useState<TrainingPhoto[]>([]);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  // Footages + difficulties
  const [santasFootage, setSantasFootage] = useState<number | ''>('');
  const [santasDifficulty, setSantasDifficulty] = useState<'easy'|'medium'|'hard'>('medium');
  const [santasLines, setSantasLines] = useState<LineSegment[]>([]);

  const [gingerbreadFootage, setGingerbreadFootage] = useState<number | ''>('');
  const [gingerbreadDifficulty, setGingerbreadDifficulty] = useState<'easy'|'medium'|'hard'>('medium');
  const [gingerbreadLines, setGingerbreadLines] = useState<LineSegment[]>([]);

  const [wwFootage, setWwFootage] = useState<number | ''>('');
  const [wwDifficulty, setWwDifficulty] = useState<'easy'|'medium'|'hard'>('medium');
  const [c9Lines, setC9Lines] = useState<LineSegment[]>([]);
  const [stakeFootage, setStakeFootage] = useState<number | ''>('');
  const [stakeDifficulty, setStakeDifficulty] = useState<'easy'|'medium'|'hard'>('easy');
  const [stakeLines, setStakeLines] = useState<LineSegment[]>([]);

  // Detections
  const [miniLightDetections, setMiniLightDetections] = useState<MiniLightDetection[]>([]);
  const [wreathDetections, setWreathDetections] = useState<WreathDetection[]>([]);
  const [spritzerDetections, setSpritzerDetections] = useState<SpritzerDetection[]>([]);
  const [garlandDetections, setGarlandDetections] = useState<GarlandDetection[]>([]);

  // W3-014: the state above (lines + detections) is the WORKING COPY for
  // whichever photo is active — swapped in/out of this per-photo store on
  // every activePhotoIdx change (effect below) so a second Auto-Analyze or
  // manual markup pass on photo 2 can no longer silently overwrite photo 1's
  // already-confirmed markup. Footage/difficulty stay whole-house (the "Final
  // Roofline Measurements" panel is an explicit single-house override, and
  // feetPerUnit calibration was already a single global scale) — only the
  // per-photo lines/boxes needed scoping. Kept 1:1 indexed with `photos`.
  const emptyMarkup = (): PerPhotoMarkup => ({
    santasLines: [], gingerbreadLines: [], c9Lines: [], stakeLines: [],
    miniLightDetections: [], wreathDetections: [], spritzerDetections: [], garlandDetections: [],
  });
  const [photoMarkup, setPhotoMarkup] = useState<PerPhotoMarkup[]>([]);
  const prevPhotoIdxRef = useRef(0);

  // Persist the outgoing photo's working copy, then load the incoming
  // photo's — runs only when the active photo actually changes.
  useEffect(() => {
    const prevIdx = prevPhotoIdxRef.current;
    if (prevIdx === activePhotoIdx) return;
    setPhotoMarkup(store => {
      const next = [...store];
      next[prevIdx] = {
        santasLines, gingerbreadLines, c9Lines, stakeLines,
        miniLightDetections, wreathDetections, spritzerDetections, garlandDetections,
      };
      return next;
    });
    const incoming = photoMarkup[activePhotoIdx] ?? emptyMarkup();
    setSantasLines(incoming.santasLines);
    setGingerbreadLines(incoming.gingerbreadLines);
    setC9Lines(incoming.c9Lines);
    setStakeLines(incoming.stakeLines);
    setMiniLightDetections(incoming.miniLightDetections);
    setWreathDetections(incoming.wreathDetections);
    setSpritzerDetections(incoming.spritzerDetections);
    setGarlandDetections(incoming.garlandDetections);
    prevPhotoIdxRef.current = activePhotoIdx;
    // Only re-run on activePhotoIdx change — reading the live line/detection
    // state here (to snapshot the outgoing photo) must NOT retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhotoIdx]);

  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [imgAspect, setImgAspect] = useState<number>(1);
  const [feetPerUnit, setFeetPerUnit] = useState<number | null>(null);
  // Mirror fpu in a ref so the polyline→footage effect can read it without
  // listing it as a dep — that's what previously created the round-trip loop
  // (fpu update → footage rounded to 5ft → fpu recalibrated to the rounded
  // value → drift on next drag).
  const feetPerUnitRef = useRef<number | null>(null);
  // When true on next render, the calibration effect skips one tick — used
  // when WE set footage (from a polyline drag) so calibration doesn't treat
  // the rounded value as a new user input.
  const skipCalibRef = useRef(false);
  // Prior line counts per type, so the polyline effect can zero a footage the
  // moment its last segment is deleted (#53a: footage stayed stuck at the last
  // value — "no lines ⇒ 0 ft").
  const prevLineLensRef = useRef({ s: 0, g: 0, c: 0, st: 0 });

  useEffect(() => { feetPerUnitRef.current = feetPerUnit; }, [feetPerUnit]);

  // Feet-per-unit calibration (gutter preferred, ridge fallback).
  // Depends on footage inputs only — line edits recompute footage via the
  // effect below, which sets skipCalibRef to keep this one from re-firing.
  useEffect(() => {
    if (skipCalibRef.current) { skipCalibRef.current = false; return; }
    const santasLen = polylineLength(santasLines, imgAspect);
    const ridgeLen = polylineLength(gingerbreadLines, imgAspect);
    const sFt = typeof santasFootage === 'number' ? santasFootage : 0;
    const gFt = typeof gingerbreadFootage === 'number' ? gingerbreadFootage : 0;
    let scale: number | null = null;
    if (santasLen > 0 && sFt > 0) scale = sFt / santasLen;
    else if (ridgeLen > 0 && gFt > 0) scale = gFt / ridgeLen;
    // defer out of the synchronous effect body; the skipCalibRef guard above stays synchronous
    if (scale != null) queueMicrotask(() => setFeetPerUnit(scale));
    // santasLines/gingerbreadLines/c9Lines intentionally excluded — the
    // polyline-driven effect owns line-change recalibration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [santasFootage, gingerbreadFootage, imgAspect]);

  // Polyline-driven footage updates — matches quote/new behavior.
  // Reads fpu from the ref so changing lines doesn't retrigger calibration.
  useEffect(() => {
    const prev = prevLineLensRef.current;
    const cur = {
      s: santasLines.length,
      g: gingerbreadLines.length,
      c: c9Lines.length,
      st: stakeLines.length,
    };
    // A list going non-empty → empty (last segment deleted) zeroes its footage.
    // Guarded on the >0→0 transition so a manually-entered or AI-seeded footage
    // that never had lines is left untouched.
    if (cur.s === 0 && prev.s > 0 && santasFootage !== '') { skipCalibRef.current = true; setSantasFootage(''); }
    if (cur.g === 0 && prev.g > 0 && gingerbreadFootage !== '') { skipCalibRef.current = true; setGingerbreadFootage(''); }
    if (cur.c === 0 && prev.c > 0 && wwFootage !== '') { skipCalibRef.current = true; setWwFootage(''); }
    if (cur.st === 0 && prev.st > 0 && stakeFootage !== '') { skipCalibRef.current = true; setStakeFootage(''); }
    prevLineLensRef.current = cur;

    const fpu = feetPerUnitRef.current;
    if (fpu == null) return;
    const sFt = Math.round(polylineLength(santasLines, imgAspect) * fpu / 5) * 5;
    const gFt = Math.round(polylineLength(gingerbreadLines, imgAspect) * fpu / 5) * 5;
    const cFt = Math.round(polylineLength(c9Lines, imgAspect) * fpu / 5) * 5;
    const stFt = Math.round(polylineLength(stakeLines, imgAspect) * fpu / 5) * 5;
    const nextSantas = santasLines.length > 0 && sFt > 0 ? sFt : null;
    const nextGinger = gingerbreadLines.length > 0 && gFt > 0 ? gFt : null;
    const nextC9 = c9Lines.length > 0 && cFt > 0 ? cFt : null;
    const nextStake = stakeLines.length > 0 && stFt > 0 ? stFt : null;
    if (nextSantas != null && nextSantas !== santasFootage) {
      skipCalibRef.current = true;
      setSantasFootage(nextSantas);
    }
    if (nextGinger != null && nextGinger !== gingerbreadFootage) {
      skipCalibRef.current = true;
      setGingerbreadFootage(nextGinger);
    }
    if (nextC9 != null && nextC9 !== wwFootage) {
      skipCalibRef.current = true;
      setWwFootage(nextC9);
    }
    if (nextStake != null && nextStake !== stakeFootage) {
      skipCalibRef.current = true;
      setStakeFootage(nextStake);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [santasLines, gingerbreadLines, c9Lines, stakeLines, imgAspect]);

  const calcStringsFromBox = (box: [number, number, number, number]): number => {
    if (!feetPerUnit) return 1;
    const widthFt = box[2] * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const heightFt = (box[3] / imgAspect) * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const circumIn = Math.PI * widthFt * 12;
    const wraps = (heightFt * 12) / 6;
    const footageFt = (wraps * circumIn) / 12;
    return Math.max(1, Math.round(footageFt / 25));
  };

  // Drag state
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  const [boxDrag, setBoxDrag] = useState<{ kind: DetectionKind; idx: number; mode: BoxDragMode; startX: number; startY: number; startBox: [number, number, number, number] } | null>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  // Scroll-wheel zoom + drag-to-pan for the photo markup box (#26). Paused while
  // placing points (addMode) so clicks add points.
  const markupWrapperRef = useRef<HTMLDivElement>(null);
  const markupZoom = useImageZoomPan(markupWrapperRef, { disabled: !!addMode });
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);

  const activePhoto = photos[activePhotoIdx];

  // ─── Photo upload ───
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, tag: PhotoTag) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newPhotos: TrainingPhoto[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      if (file.size > 10 * 1024 * 1024) {
        alert(`${file.name} is larger than 10MB — skipping`);
        continue;
      }
      const { base64, mediaType } = await fileToBase64(file);
      newPhotos.push({ tag, base64, mediaType });
    }
    setPhotos(p => [...p, ...newPhotos]);
    setPhotoMarkup(m => [...m, ...newPhotos.map(() => emptyMarkup())]);
    e.target.value = '';
  };

  const removePhoto = (idx: number) => {
    setPhotos(p => p.filter((_, i) => i !== idx));
    setPhotoMarkup(m => m.filter((_, i) => i !== idx));
    if (idx === activePhotoIdx) {
      // The active photo itself was removed — its working-copy state (still
      // live in santasLines/etc.) belongs to a slot that no longer exists;
      // drop it rather than let the swap effect persist it into the wrong
      // (shifted) index. Point prevPhotoIdxRef past the end so that effect's
      // "outgoing save" is skipped, and load whatever now sits at this index.
      const nextIdx = Math.min(idx, photos.length - 2);
      const safeIdx = Math.max(0, nextIdx);
      prevPhotoIdxRef.current = safeIdx;
      const incoming = (safeIdx === idx ? photoMarkup[idx + 1] : photoMarkup[safeIdx]) ?? emptyMarkup();
      setSantasLines(incoming.santasLines);
      setGingerbreadLines(incoming.gingerbreadLines);
      setC9Lines(incoming.c9Lines);
      setStakeLines(incoming.stakeLines);
      setMiniLightDetections(incoming.miniLightDetections);
      setWreathDetections(incoming.wreathDetections);
      setSpritzerDetections(incoming.spritzerDetections);
      setGarlandDetections(incoming.garlandDetections);
      setActivePhotoIdx(safeIdx);
    } else if (idx < activePhotoIdx) {
      // A photo before the active one was removed — indices shifted down by
      // one. Keep pointing at the same photo (now one index earlier) without
      // running the swap effect's persist/load (nothing to swap; markup
      // state is untouched, only its index label moves).
      prevPhotoIdxRef.current = activePhotoIdx - 1;
      setActivePhotoIdx(activePhotoIdx - 1);
    }
  };

  const updatePhotoTag = (idx: number, tag: PhotoTag) => {
    setPhotos(p => p.map((ph, i) => i === idx ? { ...ph, tag } : ph));
  };

  // ─── Line type routing ───
  const getSetter = (type: LineType) => {
    if (type === 'santas') return setSantasLines;
    if (type === 'gingerbread') return setGingerbreadLines;
    if (type === 'stake') return setStakeLines;
    return setC9Lines;
  };

  // ─── Polyline drag ───
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
  }, [dragging]);

  // ─── Unified box drag for all four detection kinds ───
  useEffect(() => {
    if (!boxDrag) return;
    const handleMove = (e: PointerEvent) => {
      const rect = imgContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curX = (e.clientX - rect.left) / rect.width;
      const curY = (e.clientY - rect.top) / rect.height;
      const dx = curX - boxDrag.startX;
      const dy = curY - boxDrag.startY;
      const [sx, sy, sw, sh] = boxDrag.startBox;
      let [x, y, w, h] = [sx, sy, sw, sh];
      if (boxDrag.mode === 'move') { x = sx + dx; y = sy + dy; }
      else if (boxDrag.mode === 'nw') { x = sx + dx; y = sy + dy; w = sw - dx; h = sh - dy; }
      else if (boxDrag.mode === 'ne') { y = sy + dy; w = sw + dx; h = sh - dy; }
      else if (boxDrag.mode === 'sw') { x = sx + dx; w = sw - dx; h = sh + dy; }
      else if (boxDrag.mode === 'se') { w = sw + dx; h = sh + dy; }
      const minSize = 0.02;
      w = Math.max(minSize, w); h = Math.max(minSize, h);
      x = Math.max(0, Math.min(1 - w, x));
      y = Math.max(0, Math.min(1 - h, y));
      const newBox: [number, number, number, number] = [x, y, w, h];
      if (boxDrag.kind === 'mini') {
        setMiniLightDetections(dets => dets.map((d, i) => {
          if (i !== boxDrag.idx) return d;
          // Railings are a LINEAR top-rail run, not a cylindrical wrap (mirrors the
          // Auto-Analyze carve-out below) — resizing the box must not re-apply the
          // canopy/trunk wrap formula to its stringCount.
          const newStringCount = boxDrag.mode !== 'move' && d.type !== 'railing'
            ? calcStringsFromBox(newBox)
            : undefined;
          return { ...d, box: newBox, ...(newStringCount !== undefined && { stringCount: newStringCount }) };
        }));
      } else if (boxDrag.kind === 'wreath') {
        setWreathDetections(dets => dets.map((d, i) => i === boxDrag.idx ? { ...d, box: newBox } : d));
      } else if (boxDrag.kind === 'spritzer') {
        setSpritzerDetections(dets => dets.map((d, i) => i === boxDrag.idx ? { ...d, box: newBox } : d));
      } else if (boxDrag.kind === 'garland') {
        setGarlandDetections(dets => dets.map((d, i) => i === boxDrag.idx ? { ...d, box: newBox } : d));
      }
    };
    const handleUp = () => setBoxDrag(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [boxDrag, feetPerUnit, imgAspect]);

  const startBoxDrag = (kind: DetectionKind, idx: number, mode: BoxDragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = imgContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = (e.clientX - rect.left) / rect.width;
    const startY = (e.clientY - rect.top) / rect.height;
    const source =
      kind === 'mini' ? miniLightDetections[idx].box
      : kind === 'wreath' ? wreathDetections[idx].box
      : kind === 'spritzer' ? spritzerDetections[idx].box
      : garlandDetections[idx].box;
    setBoxDrag({ kind, idx, mode, startX, startY, startBox: source });
  };

  // ─── Polyline edit helpers ───
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

  // ─── Detection CRUD ───
  const addDetection = (type: 'bush' | 'tree' | 'column' | 'railing') => {
    const defaults = {
      bush:    { wrapStyle: 'canopy' as const, stringCount: 2, label: 'new bush' },
      tree:    { wrapStyle: 'trunk'  as const, stringCount: 4, label: 'new tree' },
      column:  { wrapStyle: 'canopy' as const, stringCount: 2, label: 'new column' },
      railing: { wrapStyle: 'canopy' as const, stringCount: 1, label: 'new railing' },
    }[type];
    setMiniLightDetections(dets => [...dets, { type, ...defaults, box: [0.4, 0.6, 0.15, 0.15] }]);
  };
  const updateDetection = (idx: number, patch: Partial<MiniLightDetection>) =>
    setMiniLightDetections(dets => dets.map((d, i) => i === idx ? { ...d, ...patch } : d));
  const deleteDetection = (idx: number) =>
    setMiniLightDetections(dets => dets.filter((_, i) => i !== idx));

  const updateWreathDetection = (idx: number, patch: Partial<WreathDetection>) =>
    setWreathDetections(dets => dets.map((d, i) => i === idx ? { ...d, ...patch } : d));
  const deleteWreathDetection = (idx: number) =>
    setWreathDetections(dets => dets.filter((_, i) => i !== idx));
  const addWreathDetection = () =>
    setWreathDetections(dets => [...dets, { size: '30noble', tier: 'bow', box: [0.4, 0.3, 0.08, 0.08], label: 'new wreath' }]);

  const updateSpritzerDetection = (idx: number, patch: Partial<SpritzerDetection>) =>
    setSpritzerDetections(dets => dets.map((d, i) => i === idx ? { ...d, ...patch } : d));
  const deleteSpritzerDetection = (idx: number) =>
    setSpritzerDetections(dets => dets.filter((_, i) => i !== idx));
  const addSpritzerDetection = () =>
    setSpritzerDetections(dets => [...dets, { size: '24', box: [0.5, 0.7, 0.05, 0.1], label: 'new spritzer' }]);

  const updateGarlandDetection = (idx: number, patch: Partial<GarlandDetection>) =>
    setGarlandDetections(dets => dets.map((d, i) => i === idx ? { ...d, ...patch } : d));
  const deleteGarlandDetection = (idx: number) =>
    setGarlandDetections(dets => dets.filter((_, i) => i !== idx));
  const addGarlandDetection = () =>
    setGarlandDetections(dets => [...dets, { length: '9ft', tier: 'bow', box: [0.2, 0.6, 0.2, 0.03], label: 'new garland' }]);

  // ─── Auto-analyze ───
  const handleAutoAnalyze = async () => {
    if (!activePhoto) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotes(null);
    try {
      const blob = base64ToBlob(activePhoto.base64, activePhoto.mediaType);
      const fd = new FormData();
      fd.append('photo', blob, 'photo.jpg');
      // #54: these are FINISHED installs — analyze in completed mode (record what
      // is actually installed & lit), not the quoting "suggest placements" pass.
      fd.append('mode', 'completed');
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
      // Fail-safe (analyzer outage): the API returns 200 with result:null + a
      // friendly analysisError rather than an HTTP error — mirrors QuoteBuilder's
      // applyAnalysisResult handling. Without this guard, reading r.santasLines
      // below throws a raw TypeError instead of showing the server's message.
      if (!data.result) {
        setAnalysisError(data.analysisError ?? 'Analyzer temporarily unavailable');
        return;
      }
      const r = data.result as {
        santasFootage: number;
        santasDifficulty: 'easy' | 'medium' | 'hard';
        gingerbreadFootage: number;
        gingerbreadDifficulty: 'easy' | 'medium' | 'hard';
        santasLines?: LineSegment[];
        gingerbreadLines?: LineSegment[];
        miniLightDetections?: MiniLightDetection[];
        wreathDetections?: WreathDetection[];
        spritzerDetections?: SpritzerDetection[];
        garlandDetections?: GarlandDetection[];
        notes: string;
        confidence: string;
      };

      const newSantasLines = r.santasLines ?? [];
      const newGingerLines = r.gingerbreadLines ?? [];
      const detections = r.miniLightDetections ?? [];

      setSantasLines(newSantasLines);
      setGingerbreadLines(newGingerLines);
      setSantasFootage(r.santasFootage);
      setSantasDifficulty(r.santasDifficulty);
      setGingerbreadFootage(r.gingerbreadFootage);
      setGingerbreadDifficulty(r.gingerbreadDifficulty);
      setWreathDetections(r.wreathDetections ?? []);
      setSpritzerDetections(r.spritzerDetections ?? []);
      setGarlandDetections(r.garlandDetections ?? []);

      const santasLen = polylineLength(newSantasLines, imgAspect);
      const ridgeLen = polylineLength(newGingerLines, imgAspect);
      let scale: number | null = null;
      if (santasLen > 0 && r.santasFootage > 0) scale = r.santasFootage / santasLen;
      else if (ridgeLen > 0 && r.gingerbreadFootage > 0) scale = r.gingerbreadFootage / ridgeLen;

      // Seed calibration so garland/column length readouts and any subsequent
      // polyline edits use feet, not raw normalized units.
      if (scale) setFeetPerUnit(scale);

      if (scale && detections.length > 0) {
        const PERSPECTIVE = 0.4;
        const recalcStrings = (box: [number, number, number, number]): number => {
          const widthFt = box[2] * scale! * PERSPECTIVE;
          const heightFt = (box[3] / imgAspect) * scale! * PERSPECTIVE;
          const circumIn = Math.PI * widthFt * 12;
          const wraps = (heightFt * 12) / 6;
          const footageFt = (wraps * circumIn) / 12;
          return Math.max(1, Math.round(footageFt / 25));
        };
        // Railings are a LINEAR top-rail run, not a cylindrical wrap — the AI's
        // ~1-string-per-25ft count is already right; don't re-apply the wrap math.
        setMiniLightDetections(detections.map(d => ({ ...d, stringCount: d.type === 'railing' ? d.stringCount : recalcStrings(d.box) })));
      } else {
        setMiniLightDetections(detections);
      }

      setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})`);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setAnalyzing(false);
    }
  };

  // ─── Save ───
  const handleSave = async () => {
    if (photos.length === 0) {
      setSaveError('Upload at least one photo before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // W3-014: flatten every photo's own markup into the single flat set the
      // API expects — including the active photo's, whose edits are still
      // live in santasLines/etc. and haven't been persisted into photoMarkup
      // by the swap effect yet (that only fires on an activePhotoIdx change).
      const allMarkup = photoMarkup.map((m, i) => i === activePhotoIdx
        ? {
            santasLines, gingerbreadLines, c9Lines, stakeLines,
            miniLightDetections, wreathDetections, spritzerDetections, garlandDetections,
          }
        : m);
      const combinedSantasLines = allMarkup.flatMap(m => m.santasLines);
      const combinedGingerbreadLines = allMarkup.flatMap(m => m.gingerbreadLines);
      const combinedC9Lines = allMarkup.flatMap(m => m.c9Lines);
      const combinedStakeLines = allMarkup.flatMap(m => m.stakeLines);
      const combinedMiniLightDetections = allMarkup.flatMap(m => m.miniLightDetections);
      const combinedWreathDetections = allMarkup.flatMap(m => m.wreathDetections);
      const combinedSpritzerDetections = allMarkup.flatMap(m => m.spritzerDetections);
      const combinedGarlandDetections = allMarkup.flatMap(m => m.garlandDetections);

      // Split columns: garland-mode columns → garland section; rest stay mini-light.
      const miniLightsToSave = combinedMiniLightDetections.filter(d => d.type !== 'column' || d.columnMode !== 'garland');
      const garlandFromColumns: GarlandItem[] = combinedMiniLightDetections
        .filter(d => d.type === 'column' && d.columnMode === 'garland')
        .map(d => {
          const heightFt = feetPerUnit
            ? (d.box[3] / imgAspect) * feetPerUnit * PLANT_PERSPECTIVE_FACTOR
            : 8;
          const nineFootPieces = Math.max(1, Math.ceil(heightFt / 9));
          return { type: 'noble' as GarlandItem['type'], length: '9ft' as GarlandItem['length'], tier: 'bow' as GarlandItem['tier'], quantity: nineFootPieces };
        });

      // Derive summary arrays from detections (same pattern as quote/new)
      const spritzersFromDetections: Spritzer[] = combinedSpritzerDetections.map(d => ({ size: d.size, quantity: 1 }));
      const wreathsFromDetections: Wreath[] = combinedWreathDetections.map(d => ({ size: d.size, tier: d.tier, quantity: 1 }));
      const garlandFromDetections: GarlandItem[] = combinedGarlandDetections.map(d => {
        const unitFt = d.length === '9ft' ? 9 : 4.5;
        const widthFt = feetPerUnit != null ? d.box[2] * feetPerUnit : 0;
        const pieces = feetPerUnit != null ? Math.max(1, Math.ceil(widthFt / unitFt)) : 1;
        return { length: d.length, type: 'noble' as const, tier: d.tier, quantity: pieces };
      });

      const res = await fetch('/api/training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: address || undefined,
          yearCompleted: yearCompleted || undefined,
          notes: notes || undefined,
          photos,
          santasFootage: santasFootage || undefined,
          santasDifficulty,
          santasLines: combinedSantasLines,
          gingerbreadFootage: gingerbreadFootage || undefined,
          gingerbreadDifficulty,
          gingerbreadLines: combinedGingerbreadLines,
          winterWonderlandFootage: wwFootage || undefined,
          winterWonderlandDifficulty: wwDifficulty,
          stakeLightingFootage: stakeFootage || undefined,
          stakeLightingDifficulty: stakeDifficulty,
          stakeLines: combinedStakeLines,
          miniLightDetections: miniLightsToSave,
          wreathDetections: combinedWreathDetections,
          spritzerDetections: combinedSpritzerDetections,
          garlandDetections: combinedGarlandDetections,
          c9Lines: combinedC9Lines,
          spritzers: spritzersFromDetections,
          wreaths: wreathsFromDetections,
          garland: [...garlandFromDetections, ...garlandFromColumns],
          aiFailureNotes: aiFailureNotes || null,
          costMaterials: costMaterials === '' ? null : costMaterials,
          costLaborHours: costLaborHours === '' ? null : costLaborHours,
          revenue: revenue === '' ? null : revenue,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      router.push('/training');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <OperatorShell active="training">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link href="/training" className="text-xs text-gray-500 hover:text-gray-700">← Back to Training Database</Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">Add Completed Job</h1>
          <p className="text-sm text-gray-500 mt-1">
            Enter a historical job with confirmed measurements. The AI will use this to improve future quotes.
          </p>
        </div>

        {/* House info */}
        <Section title="House Info">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={lbl}>Address</label>
              <input className={inp} value={address} onChange={e => setAddress(e.target.value)} placeholder="123 Main St, Smithtown, NY" />
            </div>
            <div>
              <label className={lbl}>Year Completed</label>
              <input className={inp} type="number" min="1990" max="2100"
                value={yearCompleted} onChange={e => setYearCompleted(e.target.value ? Number(e.target.value) : '')}
                placeholder="2024" />
            </div>
            <div>
              <label className={lbl}>Notes</label>
              <input className={inp} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything unusual worth remembering" />
            </div>
            <div className="col-span-2">
              <label className={lbl}>AI Failure Notes <span className="text-gray-400 font-normal">(where did Claude get this house wrong?)</span></label>
              <input
                className={inp}
                value={aiFailureNotes}
                onChange={e => setAiFailureNotes(e.target.value)}
                placeholder='e.g. "missed the back-side gutter run, over-counted side bushes"'
              />
            </div>
            <div>
              <label className={lbl}>Materials Cost ($)</label>
              <input className={inp} type="number" step="0.01" min="0"
                value={costMaterials}
                onChange={e => setCostMaterials(e.target.value ? Number(e.target.value) : '')}
                placeholder="850" />
            </div>
            <div>
              <label className={lbl}>Labor Hours</label>
              <input className={inp} type="number" step="0.25" min="0"
                value={costLaborHours}
                onChange={e => setCostLaborHours(e.target.value ? Number(e.target.value) : '')}
                placeholder="6.5" />
            </div>
            <div className="col-span-2">
              <label className={lbl}>Revenue ($)</label>
              <input className={inp} type="number" step="0.01" min="0"
                value={revenue}
                onChange={e => setRevenue(e.target.value ? Number(e.target.value) : '')}
                placeholder="3200" />
            </div>
          </div>
        </Section>

        {/* Photos */}
        <Section title="Photos">
          <p className="text-xs text-gray-500 mb-3">
            Upload photos of the completed installation. The front-installed photo is the primary training reference.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            {(['front_install', 'tree_bush'] as PhotoTag[]).map(tag => (
              <label key={tag} className="block">
                <span className="text-xs font-medium text-gray-600 block mb-1">{PHOTO_TAG_LABELS[tag]}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={e => handlePhotoUpload(e, tag)}
                  className="block w-full text-xs text-gray-700 file:mr-2 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
                />
              </label>
            ))}
          </div>

          {photos.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-2">Uploaded ({photos.length}):</p>
              <div className="flex flex-wrap gap-2 mb-3">
                {photos.map((p, i) => (
                  <div key={i} className={`relative group border-2 rounded-md ${activePhotoIdx === i ? 'border-green-500' : 'border-gray-200'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:${p.mediaType};base64,${p.base64}`}
                      alt={p.tag}
                      className="w-24 h-20 object-cover rounded cursor-pointer"
                      onClick={() => setActivePhotoIdx(i)}
                    />
                    <select
                      value={p.tag}
                      onChange={e => updatePhotoTag(i, e.target.value as PhotoTag)}
                      className="block w-full text-[10px] px-1 py-0.5 border-t border-gray-200 bg-white"
                    >
                      {(Object.keys(PHOTO_TAG_LABELS) as PhotoTag[]).map(t => (
                        <option key={t} value={t}>{PHOTO_TAG_LABELS[t]}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removePhoto(i)}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold opacity-0 group-hover:opacity-100"
                      type="button"
                    >×</button>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500">
                Click a photo to set it as the active markup target below. Green border = active.
              </p>
            </div>
          )}
        </Section>

        {/* Photo markup — mirrors quote/new Analysis Results structure */}
        {activePhoto && (
          <Section title="Mark Up & Correct The Measurement">
            <p className="text-xs text-gray-500 mb-3">
              Trace gutterline, ridgeline, and C9 custom runs. Place boxes around bushes, trees, columns, spritzers, wreaths, and garland.
            </p>

            {/* Auto-Analyze */}
            <div className="mb-4 bg-purple-50 border border-purple-200 rounded-md p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-semibold text-purple-900">Auto-Analyze Photo</p>
                  <p className="text-xs text-purple-700 mt-0.5">
                    Let Claude guess rooflines, footage, and detections. You verify and correct below — then save to train the AI.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAutoAnalyze}
                  disabled={analyzing}
                  className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 text-white font-medium text-sm px-4 py-2 rounded-md"
                >
                  {analyzing ? 'Analyzing…' : '✨ Auto-Analyze'}
                </button>
              </div>
              {analysisError && (
                <div className="mt-2 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                  {analysisError}
                </div>
              )}
              {analysisNotes && !analysisError && (
                <div className="mt-2 bg-white border border-purple-200 rounded p-2 text-xs text-gray-700">
                  <strong>Claude&apos;s notes:</strong> {analysisNotes}
                </div>
              )}
            </div>

            {/* Zoom/pan controls (#26) */}
            <div className="flex items-center justify-between mb-1.5 text-[11px] text-gray-500">
              <span>Scroll to zoom · drag to pan{markupZoom.isZoomed ? ` · ${Math.round(markupZoom.zoom * 100)}%` : ''}</span>
              {markupZoom.isZoomed && (
                <button type="button" onClick={markupZoom.reset}
                  className="font-medium border border-gray-300 hover:border-gray-500 rounded px-2 py-0.5 bg-white">
                  Reset view
                </button>
              )}
            </div>
            {/* Outer clip box — owns wheel-zoom + drag-to-pan (#26). */}
            <div
              ref={markupWrapperRef}
              {...markupZoom.panHandlers}
              className="relative w-full overflow-hidden rounded-md"
            >
            <div
              ref={imgContainerRef}
              onClick={addMode ? handleImageClick : undefined}
              style={markupZoom.transformStyle}
              className={`relative w-full ${addMode ? 'cursor-crosshair' : markupZoom.isZoomed ? 'cursor-grab' : ''}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${activePhoto.mediaType};base64,${activePhoto.base64}`}
                alt="Active"
                className="w-full h-auto rounded-md border border-gray-200 block select-none pointer-events-none"
                draggable={false}
                onLoad={e => {
                  const img = e.currentTarget;
                  if (img.naturalHeight > 0) setImgAspect(img.naturalWidth / img.naturalHeight);
                }}
              />
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
                {santasLines.map((line, i) => (
                  <polyline key={`s-${i}`} points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke="#ef4444" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}
                {gingerbreadLines.map((line, i) => (
                  <polyline key={`g-${i}`} points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke="#3b82f6" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}
                {c9Lines.map((line, i) => (
                  <polyline key={`c9-${i}`} points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke="#10b981" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}
                {stakeLines.map((line, i) => (
                  <polyline key={`stake-${i}`} points={line.points.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke="#a855f7" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}
                {pendingPoints.length > 0 && (
                  <polyline points={pendingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke={addMode === 'santas' ? '#ef4444' : addMode === 'gingerbread' ? '#3b82f6' : addMode === 'stake' ? '#a855f7' : '#10b981'}
                    strokeWidth="3" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                )}
              </svg>

              {/* Wreath boxes — purple */}
              {!addMode && wreathDetections.map((d, i) => (
                <div
                  key={`wbox-${i}`}
                  className="absolute border-2 border-purple-500 bg-purple-400/15 cursor-move rounded-full"
                  style={{ left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, touchAction: 'none' }}
                  onPointerDown={startBoxDrag('wreath', i, 'move')}
                  title="Drag to move • use corners to resize"
                >
                  <div className="absolute -top-5 left-0 bg-purple-500 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                    W{i + 1} {d.size} · {d.tier}
                  </div>
                  {(['nw','ne','sw','se'] as const).map(corner => {
                    const pos: Record<string, string> = {
                      nw: 'left-[-6px] top-[-6px] cursor-nw-resize',
                      ne: 'right-[-6px] top-[-6px] cursor-ne-resize',
                      sw: 'left-[-6px] bottom-[-6px] cursor-sw-resize',
                      se: 'right-[-6px] bottom-[-6px] cursor-se-resize',
                    };
                    return (
                      <div key={corner}
                        className={`absolute w-3 h-3 bg-white border-2 border-purple-600 rounded-sm ${pos[corner]}`}
                        style={{ touchAction: 'none' }}
                        onPointerDown={startBoxDrag('wreath', i, corner)} />
                    );
                  })}
                </div>
              ))}

              {/* Spritzer boxes — fuchsia */}
              {!addMode && spritzerDetections.map((d, i) => (
                <div
                  key={`spbox-${i}`}
                  className="absolute border-2 border-fuchsia-500 bg-fuchsia-400/15 cursor-move"
                  style={{ left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, touchAction: 'none' }}
                  onPointerDown={startBoxDrag('spritzer', i, 'move')}
                  title="Drag to move • use corners to resize"
                >
                  <div className="absolute -top-5 left-0 bg-fuchsia-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                    S{i + 1} · {d.size}in
                  </div>
                  {(['nw','ne','sw','se'] as const).map(corner => {
                    const pos: Record<string, string> = {
                      nw: 'left-[-6px] top-[-6px] cursor-nw-resize',
                      ne: 'right-[-6px] top-[-6px] cursor-ne-resize',
                      sw: 'left-[-6px] bottom-[-6px] cursor-sw-resize',
                      se: 'right-[-6px] bottom-[-6px] cursor-se-resize',
                    };
                    return (
                      <div key={corner}
                        className={`absolute w-3 h-3 bg-white border-2 border-fuchsia-700 rounded-sm ${pos[corner]}`}
                        style={{ touchAction: 'none' }}
                        onPointerDown={startBoxDrag('spritzer', i, corner)} />
                    );
                  })}
                </div>
              ))}

              {/* Garland boxes — teal */}
              {!addMode && garlandDetections.map((d, i) => {
                const unitFt = d.length === '9ft' ? 9 : 4.5;
                const widthFt = feetPerUnit != null ? d.box[2] * feetPerUnit : 0;
                const pieces = feetPerUnit != null ? Math.max(1, Math.ceil(widthFt / unitFt)) : 1;
                return (
                  <div
                    key={`gbox-${i}`}
                    className="absolute border-2 border-teal-500 bg-teal-400/15 cursor-move"
                    style={{ left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, touchAction: 'none' }}
                    onPointerDown={startBoxDrag('garland', i, 'move')}
                    title="Drag to move • use corners to resize"
                  >
                    <div className="absolute -top-5 left-0 bg-teal-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                      G{i + 1} · {pieces}×{d.length} · {d.tier}
                    </div>
                    {(['nw','ne','sw','se'] as const).map(corner => {
                      const pos: Record<string, string> = {
                        nw: 'left-[-6px] top-[-6px] cursor-nw-resize',
                        ne: 'right-[-6px] top-[-6px] cursor-ne-resize',
                        sw: 'left-[-6px] bottom-[-6px] cursor-sw-resize',
                        se: 'right-[-6px] bottom-[-6px] cursor-se-resize',
                      };
                      return (
                        <div key={corner}
                          className={`absolute w-3 h-3 bg-white border-2 border-teal-700 rounded-sm ${pos[corner]}`}
                          style={{ touchAction: 'none' }}
                          onPointerDown={startBoxDrag('garland', i, corner)} />
                      );
                    })}
                  </div>
                );
              })}

              {/* Mini-light boxes — amber */}
              {!addMode && miniLightDetections.map((d, i) => {
                const price = d.stringCount * MINI_LIGHT_RATES[d.wrapStyle];
                const typeLetter = d.type === 'bush' ? 'B' : d.type === 'tree' ? 'T' : 'C';
                return (
                  <div
                    key={`box-${i}`}
                    className="absolute border-2 border-dashed border-amber-500 bg-amber-400/15 cursor-move"
                    style={{ left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`, width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`, touchAction: 'none' }}
                    onPointerDown={startBoxDrag('mini', i, 'move')}
                    title="Drag to move • use corners to resize"
                  >
                    <div className="absolute -top-5 left-0 bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                      {typeLetter}{i + 1} {d.type} · {d.stringCount}s · ${price}
                    </div>
                    {(['nw','ne','sw','se'] as const).map(corner => {
                      const pos: Record<string, string> = {
                        nw: 'left-[-6px] top-[-6px] cursor-nw-resize',
                        ne: 'right-[-6px] top-[-6px] cursor-ne-resize',
                        sw: 'left-[-6px] bottom-[-6px] cursor-sw-resize',
                        se: 'right-[-6px] bottom-[-6px] cursor-se-resize',
                      };
                      return (
                        <div key={corner}
                          className={`absolute w-3 h-3 bg-white border-2 border-amber-600 rounded-sm ${pos[corner]}`}
                          style={{ touchAction: 'none' }}
                          onPointerDown={startBoxDrag('mini', i, corner)} />
                      );
                    })}
                  </div>
                );
              })}

              {/* Polyline point handles */}
              {!addMode && santasLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`sh-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-red-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'santas', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('santas', li, pi)}
                  title="Drag to move • Double-click to delete" />
              )))}
              {!addMode && gingerbreadLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`gh-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'gingerbread', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('gingerbread', li, pi)}
                  title="Drag to move • Double-click to delete" />
              )))}
              {!addMode && c9Lines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`c9h-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-emerald-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'c9', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('c9', li, pi)}
                  title="Drag to move • Double-click to delete" />
              )))}
              {!addMode && stakeLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`stakeh-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-purple-500 border-2 border-white shadow cursor-move hover:scale-125 transition-transform"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); e.stopPropagation(); setDragging({ type: 'stake', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('stake', li, pi)}
                  title="Drag to move • Double-click to delete" />
              )))}
              {pendingPoints.map(([x, y], i) => (
                <div key={`pp-${i}`}
                  className={`absolute w-3 h-3 rounded-full ${addMode === 'santas' ? 'bg-red-500' : addMode === 'gingerbread' ? 'bg-blue-500' : addMode === 'stake' ? 'bg-purple-500' : 'bg-emerald-500'} border-2 border-white shadow`}
                  style={{ left: `calc(${x * 100}% - 6px)`, top: `calc(${y * 100}% - 6px)` }} />
              ))}
            </div>
            </div>

            {/* Add-line controls */}
            {addMode ? (
              <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                <span className="text-sm text-yellow-900">
                  Adding new {addMode === 'santas' ? 'front gutterline (red)' : addMode === 'gingerbread' ? 'ridge / side line (blue)' : addMode === 'stake' ? 'stake run (purple)' : 'C9 run (green)'} — click on the photo to add points ({pendingPoints.length} placed).
                </span>
                <div className="flex gap-2">
                  <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">Done</button>
                  <button type="button" onClick={cancelAdd}
                    className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">Cancel</button>
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
                <button type="button" onClick={() => { setAddMode('stake'); setPendingPoints([]); }}
                  className="text-xs font-medium text-purple-700 border border-purple-300 hover:border-purple-500 rounded px-3 py-1.5">
                  + Add Stake Run
                </button>
              </div>
            )}

            {/* Per-line edit panels — Front Gutterline / Ridge+Sides / C9s / Stake */}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-4 h-1 bg-red-500 rounded"></span>
                  <span className="text-sm font-semibold text-gray-800">Front Gutterline — {typeof santasFootage === 'number' ? santasFootage : 0}ft</span>
                </div>
                {santasLines.length > 0 ? (
                  <ul className="space-y-1 ml-6">
                    {santasLines.map((line, i) => (
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
                  <span className="text-sm font-semibold text-gray-800">Ridge + Sides — {typeof gingerbreadFootage === 'number' ? gingerbreadFootage : 0}ft</span>
                </div>
                {gingerbreadLines.length > 0 ? (
                  <ul className="space-y-1 ml-6">
                    {gingerbreadLines.map((line, i) => (
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
                  <span className="text-sm font-semibold text-gray-800">C9s — {typeof wwFootage === 'number' ? wwFootage : 0}ft</span>
                </div>
                {c9Lines.length > 0 ? (
                  <ul className="space-y-1 ml-6">
                    {c9Lines.map((line, i) => (
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
                        value={wwFootage || ''}
                        onChange={e => setWwFootage(e.target.value ? Number(e.target.value) : '')} />
                      <span className="text-xs text-gray-500">ft</span>
                      <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white" value={wwDifficulty}
                        onChange={e => setWwDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-4 h-1 bg-purple-500 rounded"></span>
                  <span className="text-sm font-semibold text-gray-800">Stake Lighting — {typeof stakeFootage === 'number' ? stakeFootage : 0}ft</span>
                </div>
                {stakeLines.length > 0 ? (
                  <ul className="space-y-1 ml-6">
                    {stakeLines.map((line, i) => (
                      <li key={`stakel-${i}`} className="flex items-center gap-2 text-xs">
                        <input
                          value={line.label}
                          onChange={e => updateLineLabel('stake', i, e.target.value)}
                          className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs"
                        />
                        <span className="text-gray-400">{line.points.length}pts</span>
                        <button type="button" onClick={() => deleteLine('stake', i)}
                          className="text-red-400 hover:text-red-600 font-bold">×</button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="ml-6">
                    <p className="text-xs text-gray-400 mb-2">No segments — draw on photo, or enter manually:</p>
                    <div className="flex items-center gap-2">
                      <input className="border border-gray-200 rounded px-2 py-1 text-xs w-20" type="number" min="0" placeholder="0"
                        value={stakeFootage || ''}
                        onChange={e => setStakeFootage(e.target.value ? Number(e.target.value) : '')} />
                      <span className="text-xs text-gray-500">ft</span>
                      <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white" value={stakeDifficulty}
                        onChange={e => setStakeDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                        <option value="easy">Easy</option>
                        <option value="medium">Medium</option>
                        <option value="hard">Hard</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Mini Lights panel — amber */}
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-4 h-2 border-2 border-amber-500 border-dashed rounded-sm"></span>
                <span className="text-sm font-semibold text-gray-800">
                  Mini Lights — {miniLightDetections.length} item{miniLightDetections.length === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-gray-400">
                  (1 string = 50ct 5MM strand · $35 canopy · $45 trunk)
                </span>
              </div>
              {miniLightDetections.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  <div className="grid grid-cols-[28px_1fr_1fr_64px_64px_24px] gap-2 text-[10px] uppercase tracking-wide text-gray-400 px-1">
                    <span>#</span>
                    <span>Type</span>
                    <span>Wrap</span>
                    <span>Strings</span>
                    <span>Price</span>
                    <span />
                  </div>
                  {miniLightDetections.map((d, i) => {
                    const price = d.stringCount * MINI_LIGHT_RATES[d.wrapStyle];
                    const typeLetter = d.type === 'bush' ? 'B' : d.type === 'tree' ? 'T' : d.type === 'railing' ? 'R' : 'C';
                    return (
                      <div key={`drow-${i}`} className="grid grid-cols-[28px_1fr_1fr_64px_64px_24px] gap-2 items-center">
                        <span className="text-xs font-semibold text-amber-700">{typeLetter}{i + 1}</span>
                        <select
                          className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                          value={d.type}
                          onChange={e => updateDetection(i, { type: e.target.value as MiniLightDetection['type'], columnMode: undefined })}
                        >
                          <option value="bush">Bush</option>
                          <option value="tree">Tree</option>
                          <option value="column">Column</option>
                          <option value="railing">Railing</option>
                        </select>
                        <select
                          className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                          value={d.wrapStyle}
                          onChange={e => updateDetection(i, { wrapStyle: e.target.value as MiniLightDetection['wrapStyle'] })}
                        >
                          <option value="canopy">Canopy</option>
                          <option value="trunk">Trunk</option>
                        </select>
                        <input
                          type="number"
                          min="1"
                          value={d.stringCount}
                          onChange={e => updateDetection(i, { stringCount: Math.max(1, Number(e.target.value)) })}
                          className="border border-gray-200 rounded px-2 py-1 text-xs"
                        />
                        <span className="text-xs font-medium text-gray-700 tabular-nums">${price}</span>
                        <button type="button" onClick={() => deleteDetection(i)}
                          className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                      </div>
                    );
                  })}
                  {miniLightDetections.some(d => d.type === 'column') && (
                    <div className="pt-2 border-t border-gray-100">
                      <p className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">Column output</p>
                      {miniLightDetections.map((d, i) => d.type === 'column' ? (
                        <div key={`cmode-${i}`} className="flex items-center gap-2 text-xs mb-1">
                          <span className="text-amber-700 font-medium w-8">C{i + 1}</span>
                          <button
                            type="button"
                            onClick={() => updateDetection(i, { columnMode: d.columnMode === 'garland' ? 'minilight' : 'garland' })}
                            className={`text-[10px] font-semibold px-2 py-1 rounded border ${d.columnMode === 'garland' ? 'bg-emerald-100 border-emerald-400 text-emerald-800' : 'bg-gray-50 border-gray-300 text-gray-500'}`}
                          >
                            {d.columnMode === 'garland' ? 'Garland' : 'Mini Lights'}
                          </button>
                        </div>
                      ) : null)}
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => addDetection('bush')}
                  className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Bush</button>
                <button type="button" onClick={() => addDetection('tree')}
                  className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Tree</button>
                <button type="button" onClick={() => addDetection('column')}
                  className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Column</button>
                <button type="button" onClick={() => addDetection('railing')}
                  className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Railing</button>
              </div>
            </div>

            {/* Spritzers — fuchsia */}
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-4 h-2 border-2 border-fuchsia-500 rounded-sm"></span>
                <span className="text-sm font-semibold text-gray-800">
                  Spritzers — {spritzerDetections.length} item{spritzerDetections.length === 1 ? '' : 's'}
                </span>
              </div>
              {spritzerDetections.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  <div className="grid grid-cols-[28px_1fr_24px] gap-2 text-[10px] uppercase tracking-wide text-gray-400 px-1">
                    <span>#</span>
                    <span>Size</span>
                    <span />
                  </div>
                  {spritzerDetections.map((d, i) => (
                    <div key={`srow-${i}`} className="grid grid-cols-[28px_1fr_24px] gap-2 items-center">
                      <span className="text-xs font-semibold text-fuchsia-700">S{i + 1}</span>
                      <select
                        className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                        value={d.size}
                        onChange={e => updateSpritzerDetection(i, { size: e.target.value as SpritzerSize })}
                      >
                        <option value="16">16&quot;</option>
                        <option value="24">24&quot;</option>
                        <option value="32">32&quot;</option>
                      </select>
                      <button type="button" onClick={() => deleteSpritzerDetection(i)}
                        className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={addSpritzerDetection}
                className="text-xs font-medium text-fuchsia-700 border border-fuchsia-300 hover:border-fuchsia-500 rounded px-3 py-1.5">
                + Add Spritzer
              </button>
            </div>

            {/* Wreaths — purple */}
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-4 h-2 border-2 border-purple-500 rounded-sm"></span>
                <span className="text-sm font-semibold text-gray-800">
                  Wreaths — {wreathDetections.length} item{wreathDetections.length === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-gray-400">(sized by door / garage context)</span>
              </div>
              {wreathDetections.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  <div className="grid grid-cols-[28px_1fr_1fr_24px] gap-2 text-[10px] uppercase tracking-wide text-gray-400 px-1">
                    <span>#</span>
                    <span>Size</span>
                    <span>Tier</span>
                    <span />
                  </div>
                  {wreathDetections.map((d, i) => (
                    <div key={`wrow-${i}`} className="grid grid-cols-[28px_1fr_1fr_24px] gap-2 items-center">
                      <span className="text-xs font-semibold text-purple-700">W{i + 1}</span>
                      <select
                        className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                        value={d.size}
                        onChange={e => updateWreathDetection(i, { size: e.target.value as WreathSize })}
                      >
                        <option value="24noble">24&quot; Noble</option>
                        <option value="30noble">30&quot; Noble</option>
                        <option value="36noble">36&quot; Noble</option>
                        <option value="48noble">48&quot; Noble</option>
                        <option value="60noble">60&quot; Noble</option>
                        <option value="72noble">72&quot; Noble</option>
                      </select>
                      <select
                        className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                        value={d.tier}
                        onChange={e => updateWreathDetection(i, { tier: e.target.value as DecorTier })}
                      >
                        <option value="bow">Non-Decorated</option>
                        <option value="fullDecor">Decorated</option>
                      </select>
                      <button type="button" onClick={() => deleteWreathDetection(i)}
                        className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" onClick={addWreathDetection}
                className="text-xs font-medium text-purple-700 border border-purple-300 hover:border-purple-500 rounded px-3 py-1.5">
                + Add Wreath
              </button>
            </div>

            {/* Garland — teal */}
            <div className="mt-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-4 h-2 border-2 border-teal-500 rounded-sm"></span>
                <span className="text-sm font-semibold text-gray-800">
                  Garland — {garlandDetections.length} run{garlandDetections.length === 1 ? '' : 's'}
                </span>
                <span className="text-xs text-gray-400">(box width → pieces)</span>
              </div>
              {garlandDetections.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  <div className="grid grid-cols-[28px_1fr_1fr_64px_24px] gap-2 text-[10px] uppercase tracking-wide text-gray-400 px-1">
                    <span>#</span>
                    <span>Length</span>
                    <span>Tier</span>
                    <span>Pieces</span>
                    <span />
                  </div>
                  {garlandDetections.map((d, i) => {
                    const unitFt = d.length === '9ft' ? 9 : 4.5;
                    const widthFt = feetPerUnit != null ? d.box[2] * feetPerUnit : 0;
                    const pieces = feetPerUnit != null ? Math.max(1, Math.ceil(widthFt / unitFt)) : 1;
                    return (
                      <div key={`grow-${i}`} className="grid grid-cols-[28px_1fr_1fr_64px_24px] gap-2 items-center">
                        <span className="text-xs font-semibold text-teal-700">G{i + 1}</span>
                        <select
                          className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                          value={d.length}
                          onChange={e => updateGarlandDetection(i, { length: e.target.value as GarlandLength })}
                        >
                          <option value="9ft">9ft</option>
                          <option value="4.5ft">4.5ft</option>
                        </select>
                        <select
                          className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                          value={d.tier}
                          onChange={e => updateGarlandDetection(i, { tier: e.target.value as DecorTier })}
                        >
                          <option value="bow">Non-Decorated</option>
                          <option value="fullDecor">Decorated</option>
                        </select>
                        <span className="text-xs font-medium text-gray-700 tabular-nums">{pieces}</span>
                        <button type="button" onClick={() => deleteGarlandDetection(i)}
                          className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <button type="button" onClick={addGarlandDetection}
                className="text-xs font-medium text-teal-700 border border-teal-300 hover:border-teal-500 rounded px-3 py-1.5">
                + Add Garland Run
              </button>
            </div>
          </Section>
        )}

        {/* Final footage + difficulty — training-specific confirmation panel */}
        <Section title="Final Roofline Measurements">
          <p className="text-xs text-gray-400 mb-3">
            Final confirmed numbers. Auto-populated from polylines above. Override if the drawn lines don&apos;t capture reality.
          </p>
          <div className="grid grid-cols-[1fr_1fr_1fr_1fr] gap-3">
            <div>
              <label className={lbl}>Gutterline ft</label>
              <input className={inp} type="number" value={santasFootage}
                onChange={e => setSantasFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Ridgeline ft</label>
              <input className={inp} type="number" value={gingerbreadFootage}
                onChange={e => setGingerbreadFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>C9s ft</label>
              <input className={inp} type="number" value={wwFootage}
                onChange={e => setWwFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Stake ft</label>
              <input className={inp} type="number" value={stakeFootage}
                onChange={e => setStakeFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Gutterline Difficulty</label>
              <select className={sel} value={santasDifficulty} onChange={e => setSantasDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Ridgeline Difficulty</label>
              <select className={sel} value={gingerbreadDifficulty} onChange={e => setGingerbreadDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className={lbl}>C9s Difficulty</label>
              <select className={sel} value={wwDifficulty} onChange={e => setWwDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Stake Difficulty</label>
              <select className={sel} value={stakeDifficulty} onChange={e => setStakeDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
          </div>
        </Section>

        {saveError && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">
            {saveError}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || photos.length === 0}
            className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white font-semibold py-3 px-6 rounded-lg"
          >
            {saving ? 'Saving…' : 'Save Training Record'}
          </button>
          <Link
            href="/training"
            className="px-6 py-3 text-gray-700 border border-gray-300 hover:border-gray-500 rounded-lg font-medium"
          >
            Cancel
          </Link>
        </div>
      </div>
    </OperatorShell>
  );
}
