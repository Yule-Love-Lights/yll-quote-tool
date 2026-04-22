'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Spritzer, Wreath, GarlandItem } from '@/lib/pricing/pricingEngine';
import type { PhotoTag, TrainingPhoto } from '@/lib/training';

type LineSegment = { points: [number, number][]; label: string };
type MiniLightDetection = {
  type: 'tree' | 'bush' | 'column';
  wrapStyle: 'canopy' | 'trunk';
  stringCount: number;
  columnMode?: 'minilight' | 'garland'; // columns only: switch output to garland
  box: [number, number, number, number];
  label: string;
};
type WreathSize = '24noble' | '30noble' | '36noble' | '48noble' | '36oregon';
type WreathTier = 'labor' | 'bow' | 'fullDecor';
type WreathDetection = {
  size: WreathSize;
  tier: WreathTier;
  box: [number, number, number, number];
  label: string;
};
type SpritzerSize = '16' | '24' | '32';
type SpritzerDetection = {
  size: SpritzerSize;
  box: [number, number, number, number];
  label: string;
};

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';

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
  front_takedown: 'Front — Takedown',
  side: 'Side view',
  back: 'Back view',
  satellite: 'Satellite',
  detail: 'Detail shot',
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

  const [address, setAddress] = useState('');
  const [yearCompleted, setYearCompleted] = useState<number | ''>('');
  const [houseStyle, setHouseStyle] = useState('');
  const [notes, setNotes] = useState('');
  const [scaleAnchor, setScaleAnchor] = useState('');
  const [didntInstall, setDidntInstall] = useState('');
  const [aiFailureNotes, setAiFailureNotes] = useState('');
  const [costMaterials, setCostMaterials] = useState<number | ''>('');
  const [costLaborHours, setCostLaborHours] = useState<number | ''>('');
  const [revenue, setRevenue] = useState<number | ''>('');

  const [photos, setPhotos] = useState<TrainingPhoto[]>([]);
  const [activePhotoIdx, setActivePhotoIdx] = useState(0);

  const [santasFootage, setSantasFootage] = useState<number | ''>('');
  const [santasDifficulty, setSantasDifficulty] = useState<'easy'|'medium'|'hard'>('medium');
  const [santasLines, setSantasLines] = useState<LineSegment[]>([]);

  const [gingerbreadFootage, setGingerbreadFootage] = useState<number | ''>('');
  const [gingerbreadDifficulty, setGingerbreadDifficulty] = useState<'easy'|'medium'|'hard'>('medium');
  const [gingerbreadLines, setGingerbreadLines] = useState<LineSegment[]>([]);

  const [wwFootage, setWwFootage] = useState<number | ''>('');
  const [wwDifficulty, setWwDifficulty] = useState<'easy'|'medium'|'hard'>('medium');

  const [miniLightDetections, setMiniLightDetections] = useState<MiniLightDetection[]>([]);
  const [wreathDetections, setWreathDetections] = useState<WreathDetection[]>([]);
  const [spritzerDetections, setSpritzerDetections] = useState<SpritzerDetection[]>([]);
  const [spritzers, setSpritzers] = useState<Spritzer[]>([]);
  const [wreaths, setWreaths] = useState<Wreath[]>([]);
  const [garland, setGarland] = useState<GarlandItem[]>([]);

  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [imgAspect, setImgAspect] = useState<number>(1);
  const [feetPerUnit, setFeetPerUnit] = useState<number | null>(null);
  const PLANT_PERSPECTIVE_FACTOR = 0.4;

  // Recompute feet-per-pixel-unit whenever polylines or footages change (same pattern as quote/new).
  useEffect(() => {
    const santasLen = polylineLength(santasLines, imgAspect);
    const ridgeLen = polylineLength(gingerbreadLines, imgAspect);
    const sFt = typeof santasFootage === 'number' ? santasFootage : 0;
    const gFt = typeof gingerbreadFootage === 'number' ? gingerbreadFootage : 0;
    let scale: number | null = null;
    if (santasLen > 0 && sFt > 0) scale = sFt / santasLen;
    else if (ridgeLen > 0 && gFt > 0) scale = gFt / ridgeLen;
    setFeetPerUnit(scale);
  }, [santasLines, gingerbreadLines, santasFootage, gingerbreadFootage, imgAspect]);

  const calcStringsFromBox = (box: [number, number, number, number]): number => {
    if (!feetPerUnit) return 1;
    const widthFt = box[2] * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const heightFt = (box[3] / imgAspect) * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const circumIn = Math.PI * widthFt * 12;
    const wraps = (heightFt * 12) / 6;
    const footageFt = (wraps * circumIn) / 12;
    return Math.max(1, Math.round(footageFt / 25));
  };

  type LineType = 'santas' | 'gingerbread';
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  type BoxDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';
  const [boxDrag, setBoxDrag] = useState<{ idx: number; mode: BoxDragMode; startX: number; startY: number; startBox: [number, number, number, number] } | null>(null);
  type OverlayDrag = { type: 'wreath' | 'spritzer'; idx: number; startX: number; startY: number; startBox: [number, number, number, number] };
  const [overlayDrag, setOverlayDrag] = useState<OverlayDrag | null>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);

  const activePhoto = photos[activePhotoIdx];

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
    e.target.value = '';
  };

  const removePhoto = (idx: number) => {
    setPhotos(p => p.filter((_, i) => i !== idx));
    if (activePhotoIdx >= photos.length - 1) setActivePhotoIdx(0);
  };

  const updatePhotoTag = (idx: number, tag: PhotoTag) => {
    setPhotos(p => p.map((ph, i) => i === idx ? { ...ph, tag } : ph));
  };

  // ─── Polyline drag/edit logic (mirrors quote/new/page.tsx) ───
  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: PointerEvent) => {
      const rect = imgContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      const setter = dragging.type === 'santas' ? setSantasLines : setGingerbreadLines;
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
      const newStringCount = boxDrag.mode !== 'move' ? calcStringsFromBox(newBox) : undefined;
      setMiniLightDetections(dets => dets.map((d, i) =>
        i === boxDrag.idx
          ? { ...d, box: newBox, ...(newStringCount !== undefined && { stringCount: newStringCount }) }
          : d
      ));
    };
    const handleUp = () => setBoxDrag(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [boxDrag, feetPerUnit, imgAspect]);

  // Drag handler for wreath + spritzer overlays (move only)
  useEffect(() => {
    if (!overlayDrag) return;
    const handleMove = (e: PointerEvent) => {
      const rect = imgContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curX = (e.clientX - rect.left) / rect.width;
      const curY = (e.clientY - rect.top) / rect.height;
      const dx = curX - overlayDrag.startX;
      const dy = curY - overlayDrag.startY;
      const [sx, sy, sw, sh] = overlayDrag.startBox;
      const w = sw; const h = sh;
      const x = Math.max(0, Math.min(1 - w, sx + dx));
      const y = Math.max(0, Math.min(1 - h, sy + dy));
      const newBox: [number, number, number, number] = [x, y, w, h];
      if (overlayDrag.type === 'wreath') {
        setWreathDetections(dets => dets.map((d, i) => i === overlayDrag.idx ? { ...d, box: newBox } : d));
      } else {
        setSpritzerDetections(dets => dets.map((d, i) => i === overlayDrag.idx ? { ...d, box: newBox } : d));
      }
    };
    const handleUp = () => setOverlayDrag(null);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [overlayDrag]);

  const startOverlayDrag = (type: 'wreath' | 'spritzer', idx: number, box: [number, number, number, number]) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = imgContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setOverlayDrag({ type, idx, startX: (e.clientX - rect.left) / rect.width, startY: (e.clientY - rect.top) / rect.height, startBox: box });
  };

  const startBoxDrag = (idx: number, mode: BoxDragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = imgContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = (e.clientX - rect.left) / rect.width;
    const startY = (e.clientY - rect.top) / rect.height;
    setBoxDrag({ idx, mode, startX, startY, startBox: miniLightDetections[idx].box });
  };

  const deletePoint = (type: LineType, lineIdx: number, ptIdx: number) => {
    const setter = type === 'santas' ? setSantasLines : setGingerbreadLines;
    setter(lines => lines.map((line, i) =>
      i === lineIdx ? { ...line, points: line.points.filter((_, j) => j !== ptIdx) } : line
    ).filter(line => line.points.length >= 2));
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
    const setter = addMode === 'santas' ? setSantasLines : setGingerbreadLines;
    setter(lines => [...lines, {
      points: pendingPoints,
      label: addMode === 'santas' ? 'gutterline' : 'ridgeline',
    }]);
    setAddMode(null);
    setPendingPoints([]);
  };

  const addDetection = (type: 'bush' | 'tree' | 'column') => {
    const defaults = {
      bush:   { wrapStyle: 'canopy' as const, stringCount: 2, label: 'bush' },
      tree:   { wrapStyle: 'trunk'  as const, stringCount: 4, label: 'tree' },
      column: { wrapStyle: 'canopy' as const, stringCount: 2, label: 'column' },
    }[type];
    setMiniLightDetections(dets => [...dets, { type, ...defaults, box: [0.4, 0.6, 0.15, 0.15] }]);
  };

  const handleAutoAnalyze = async () => {
    if (!activePhoto) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisNotes(null);
    try {
      const blob = base64ToBlob(activePhoto.base64, activePhoto.mediaType);
      const fd = new FormData();
      fd.append('photo', blob, 'photo.jpg');
      const res = await fetch('/api/analyze-photo', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Analysis failed');
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
        notes: string;
        confidence: string;
      };

      const newSantasLines = r.santasLines ?? [];
      const newGingerLines = r.gingerbreadLines ?? [];
      const detections = r.miniLightDetections ?? [];
      const wreathDets = r.wreathDetections ?? [];
      const spritzerDets = r.spritzerDetections ?? [];

      setSantasLines(newSantasLines);
      setGingerbreadLines(newGingerLines);
      setSantasFootage(r.santasFootage);
      setSantasDifficulty(r.santasDifficulty);
      setGingerbreadFootage(r.gingerbreadFootage);
      setGingerbreadDifficulty(r.gingerbreadDifficulty);
      setWreathDetections(wreathDets);
      setSpritzerDetections(spritzerDets);

      // Auto-populate the Wreaths Used summary from detections (grouped by size+tier)
      if (wreathDets.length > 0) {
        const groups = new Map<string, Wreath>();
        for (const w of wreathDets) {
          const key = `${w.size}|${w.tier}`;
          const existing = groups.get(key);
          if (existing) existing.quantity += 1;
          else groups.set(key, { size: w.size, tier: w.tier, quantity: 1 });
        }
        setWreaths(Array.from(groups.values()));
      }

      // Auto-populate Spritzers Used summary from detections (grouped by size)
      if (spritzerDets.length > 0) {
        const groups = new Map<string, Spritzer>();
        for (const s of spritzerDets) {
          const existing = groups.get(s.size);
          if (existing) existing.quantity += 1;
          else groups.set(s.size, { size: s.size as Spritzer['size'], quantity: 1 });
        }
        setSpritzers(Array.from(groups.values()));
      }

      // Recalc string counts from box dimensions using shared scale (same formula as quote/new)
      const santasLen = polylineLength(newSantasLines, imgAspect);
      const ridgeLen = polylineLength(newGingerLines, imgAspect);
      let scale: number | null = null;
      if (santasLen > 0 && r.santasFootage > 0) scale = r.santasFootage / santasLen;
      else if (ridgeLen > 0 && r.gingerbreadFootage > 0) scale = r.gingerbreadFootage / ridgeLen;

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
        setMiniLightDetections(detections.map(d => ({ ...d, stringCount: recalcStrings(d.box) })));
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

  const handleSave = async () => {
    if (photos.length === 0) {
      setSaveError('Upload at least one photo before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // Split columns: garland-mode columns → garland section; rest stay as mini-light detections
      const miniLightsToSave = miniLightDetections.filter(d => d.type !== 'column' || d.columnMode !== 'garland');
      const garlandFromColumns: GarlandItem[] = miniLightDetections
        .filter(d => d.type === 'column' && d.columnMode === 'garland')
        .map(d => {
          // Estimate column height in feet from box dimensions
          const heightFt = feetPerUnit
            ? (d.box[3] / imgAspect) * feetPerUnit * PLANT_PERSPECTIVE_FACTOR
            : 8; // default 8ft column if no scale
          const nineFootPieces = Math.max(1, Math.ceil(heightFt / 9));
          return { type: 'noble' as GarlandItem['type'], length: '9ft' as GarlandItem['length'], tier: 'bow' as GarlandItem['tier'], quantity: nineFootPieces };
        });

      const res = await fetch('/api/training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: address || undefined,
          yearCompleted: yearCompleted || undefined,
          houseStyle: houseStyle || undefined,
          notes: notes || undefined,
          photos,
          santasFootage: santasFootage || undefined,
          santasDifficulty,
          santasLines,
          gingerbreadFootage: gingerbreadFootage || undefined,
          gingerbreadDifficulty,
          gingerbreadLines,
          winterWonderlandFootage: wwFootage || undefined,
          winterWonderlandDifficulty: wwDifficulty,
          miniLightDetections: miniLightsToSave,
          wreathDetections,
          spritzerDetections,
          spritzers,
          wreaths,
          garland: [...garland, ...garlandFromColumns],
          scaleAnchor: scaleAnchor || null,
          didntInstall: didntInstall || null,
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
    <div className="min-h-screen bg-gray-50 py-8 px-4">
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
              <label className={lbl}>House Style</label>
              <select className={sel} value={houseStyle} onChange={e => setHouseStyle(e.target.value)}>
                <option value="">— Select —</option>
                <option value="cape">Cape</option>
                <option value="ranch">Ranch</option>
                <option value="colonial">Colonial</option>
                <option value="split">Split Level</option>
                <option value="tudor">Tudor</option>
                <option value="custom">Custom / Luxury</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Notes</label>
              <input className={inp} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything unusual worth remembering" />
            </div>
            <div className="col-span-2">
              <label className={lbl}>Scale Anchor <span className="text-gray-400 font-normal">(what in the photo gives the real-world scale?)</span></label>
              <input
                className={inp}
                value={scaleAnchor}
                onChange={e => setScaleAnchor(e.target.value)}
                placeholder='e.g. "front door is 36in wide, garage door is 7ft tall"'
              />
            </div>
            <div className="col-span-2">
              <label className={lbl}>Didn&apos;t Install <span className="text-gray-400 font-normal">(items visible in photo that the customer skipped)</span></label>
              <input
                className={inp}
                value={didntInstall}
                onChange={e => setDidntInstall(e.target.value)}
                placeholder='e.g. "customer declined ridgeline, skipped the lamp post bushes"'
              />
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
            {(['front_install', 'front_takedown', 'side', 'detail'] as PhotoTag[]).map(tag => (
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

        {/* Photo markup */}
        {activePhoto && (
          <Section title="Mark Up Rooflines, Bushes, Trees & Columns">
            <p className="text-xs text-gray-500 mb-3">
              Trace the gutterline and ridgeline on the active photo, and place boxes around each bush/tree/column with its final string count.
            </p>

            {/* Auto-Analyze */}
            <div className="mb-4 bg-purple-50 border border-purple-200 rounded-md p-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <p className="text-sm font-semibold text-purple-900">Auto-Analyze Photo</p>
                  <p className="text-xs text-purple-700 mt-0.5">
                    Let Claude guess rooflines, footage, and bush/tree placements. You verify and correct below — then save to train the AI.
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

            <div
              ref={imgContainerRef}
              onClick={addMode ? handleImageClick : undefined}
              className={`relative w-full ${addMode ? 'cursor-crosshair' : ''}`}
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
                {pendingPoints.length > 0 && (
                  <polyline points={pendingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                    fill="none" stroke={addMode === 'santas' ? '#ef4444' : '#3b82f6'}
                    strokeWidth="3" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                )}
              </svg>
              {!addMode && miniLightDetections.map((d, i) => (
                <div
                  key={`box-${i}`}
                  className="absolute border-2 border-dashed border-amber-500 bg-amber-400/15 cursor-move"
                  style={{
                    left: `${d.box[0] * 100}%`, top: `${d.box[1] * 100}%`,
                    width: `${d.box[2] * 100}%`, height: `${d.box[3] * 100}%`,
                    touchAction: 'none',
                  }}
                  onPointerDown={startBoxDrag(i, 'move')}
                >
                  <div className="absolute -top-5 left-0 bg-amber-500 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                    {d.type} · {d.stringCount}s
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
                        onPointerDown={startBoxDrag(i, corner)} />
                    );
                  })}
                </div>
              ))}
              {/* Wreath overlay — draggable + removable */}
              {!addMode && wreathDetections.map((w, i) => (
                <div
                  key={`wreath-${i}`}
                  className="absolute border-2 border-green-600 bg-green-400/15 rounded-full cursor-move group"
                  style={{ left: `${w.box[0] * 100}%`, top: `${w.box[1] * 100}%`, width: `${w.box[2] * 100}%`, height: `${w.box[3] * 100}%`, touchAction: 'none' }}
                  onPointerDown={startOverlayDrag('wreath', i, w.box)}
                >
                  <div className="absolute -top-5 left-0 bg-green-600 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                    wreath · {w.size.replace('noble', '" Noble').replace('oregon', '" Oregon')}
                  </div>
                  <button
                    type="button"
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold opacity-0 group-hover:opacity-100 pointer-events-auto"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => setWreathDetections(dets => dets.filter((_, j) => j !== i))}
                  >×</button>
                </div>
              ))}
              {/* Spritzer overlay — draggable + removable */}
              {!addMode && spritzerDetections.map((s, i) => (
                <div
                  key={`spritzer-${i}`}
                  className="absolute border-2 border-yellow-500 bg-yellow-400/15 cursor-move group"
                  style={{ left: `${s.box[0] * 100}%`, top: `${s.box[1] * 100}%`, width: `${s.box[2] * 100}%`, height: `${s.box[3] * 100}%`, touchAction: 'none' }}
                  onPointerDown={startOverlayDrag('spritzer', i, s.box)}
                >
                  <div className="absolute -top-5 left-0 bg-yellow-500 text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-sm whitespace-nowrap pointer-events-none">
                    spritzer · {s.size}&quot;
                  </div>
                  <button
                    type="button"
                    className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs font-bold opacity-0 group-hover:opacity-100 pointer-events-auto"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => setSpritzerDetections(dets => dets.filter((_, j) => j !== i))}
                  >×</button>
                </div>
              ))}
              {!addMode && santasLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`sh-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-red-500 border-2 border-white shadow cursor-move"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); setDragging({ type: 'santas', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('santas', li, pi)} />
              )))}
              {!addMode && gingerbreadLines.flatMap((line, li) => line.points.map(([x, y], pi) => (
                <div key={`gh-${li}-${pi}`}
                  className="absolute w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow cursor-move"
                  style={{ left: `calc(${x * 100}% - 8px)`, top: `calc(${y * 100}% - 8px)` }}
                  onPointerDown={e => { e.preventDefault(); setDragging({ type: 'gingerbread', lineIdx: li, ptIdx: pi }); }}
                  onDoubleClick={() => deletePoint('gingerbread', li, pi)} />
              )))}
              {pendingPoints.map(([x, y], i) => (
                <div key={`pp-${i}`}
                  className={`absolute w-3 h-3 rounded-full ${addMode === 'santas' ? 'bg-red-500' : 'bg-blue-500'} border-2 border-white shadow`}
                  style={{ left: `calc(${x * 100}% - 6px)`, top: `calc(${y * 100}% - 6px)` }} />
              ))}
            </div>

            {/* Markup controls */}
            {addMode ? (
              <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-md p-3 flex items-center justify-between">
                <span className="text-sm text-yellow-900">
                  Click to add points ({pendingPoints.length} placed). Tracing the {addMode === 'santas' ? 'gutterline' : 'ridgeline'}.
                </span>
                <div className="flex gap-2">
                  <button type="button" onClick={finishAddingLine} disabled={pendingPoints.length < 2}
                    className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white text-xs font-medium px-3 py-1.5 rounded">Done</button>
                  <button type="button" onClick={() => { setAddMode(null); setPendingPoints([]); }}
                    className="bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-medium px-3 py-1.5 rounded">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => { setAddMode('santas'); setPendingPoints([]); }}
                    className="text-xs font-medium text-red-700 border border-red-300 hover:border-red-500 rounded px-3 py-1.5">
                    + Add Gutterline
                  </button>
                  <button type="button" onClick={() => { setAddMode('gingerbread'); setPendingPoints([]); }}
                    className="text-xs font-medium text-blue-700 border border-blue-300 hover:border-blue-500 rounded px-3 py-1.5">
                    + Add Ridgeline
                  </button>
                  <button type="button" onClick={() => addDetection('bush')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Bush</button>
                  <button type="button" onClick={() => addDetection('tree')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Tree</button>
                  <button type="button" onClick={() => addDetection('column')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">+ Add Column</button>
                  <button type="button"
                    onClick={() => setWreathDetections(dets => [...dets, { size: '30noble', tier: 'bow', box: [0.38, 0.38, 0.12, 0.12], label: 'wreath' }])}
                    className="text-xs font-medium text-green-700 border border-green-300 hover:border-green-500 rounded px-3 py-1.5">+ Add Wreath</button>
                  <button type="button"
                    onClick={() => setSpritzerDetections(dets => [...dets, { size: '24', box: [0.1, 0.7, 0.07, 0.1], label: 'spritzer' }])}
                    className="text-xs font-medium text-yellow-700 border border-yellow-300 hover:border-yellow-500 rounded px-3 py-1.5">+ Add Spritzer</button>
                </div>

                {/* Existing polylines — removal + per-line controls */}
                {(santasLines.length > 0 || gingerbreadLines.length > 0) && (
                  <div className="mt-3 space-y-1 text-xs">
                    {santasLines.map((line, i) => (
                      <div key={`sline-${i}`} className="flex items-center justify-between bg-red-50 border border-red-200 rounded px-2 py-1">
                        <span className="text-red-800">Gutterline {i + 1} · {line.points.length} pts · {line.label}</span>
                        <button type="button" onClick={() => setSantasLines(ls => ls.filter((_, j) => j !== i))}
                          className="text-red-600 hover:text-red-800 font-semibold">× Remove</button>
                      </div>
                    ))}
                    {gingerbreadLines.map((line, i) => (
                      <div key={`gline-${i}`} className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded px-2 py-1">
                        <span className="text-blue-800">Ridgeline {i + 1} · {line.points.length} pts · {line.label}</span>
                        <button type="button" onClick={() => {
                          setGingerbreadLines(ls => ls.filter((_, j) => j !== i));
                          // If this was the last ridgeline, clear ridge footage too (house has no ridge)
                          if (gingerbreadLines.length === 1) {
                            setGingerbreadFootage('');
                          }
                        }}
                          className="text-blue-600 hover:text-blue-800 font-semibold">× Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                {gingerbreadLines.length === 0 && gingerbreadFootage !== '' && (
                  <button type="button"
                    onClick={() => setGingerbreadFootage('')}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline">
                    Clear ridge footage (no ridge on this house)
                  </button>
                )}
              </>
            )}
          </Section>
        )}

        {/* Roofline measurements */}
        <Section title="Final Roofline Measurements">
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-3">
            <div>
              <label className={lbl}>Santa&apos;s (gutter) ft</label>
              <input className={inp} type="number" value={santasFootage}
                onChange={e => setSantasFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Gingerbread (ridge) ft</label>
              <input className={inp} type="number" value={gingerbreadFootage}
                onChange={e => setGingerbreadFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Winter Wonderland ft</label>
              <input className={inp} type="number" value={wwFootage}
                onChange={e => setWwFootage(e.target.value ? Number(e.target.value) : '')} />
            </div>
            <div>
              <label className={lbl}>Santa&apos;s Difficulty</label>
              <select className={sel} value={santasDifficulty} onChange={e => setSantasDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Gingerbread Difficulty</label>
              <select className={sel} value={gingerbreadDifficulty} onChange={e => setGingerbreadDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
            <div>
              <label className={lbl}>Winter Wonderland Difficulty</label>
              <select className={sel} value={wwDifficulty} onChange={e => setWwDifficulty(e.target.value as 'easy'|'medium'|'hard')}>
                <option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option>
              </select>
            </div>
          </div>
        </Section>

        {/* Mini Light summary */}
        <Section title="Bushes / Trees / Columns">
          {miniLightDetections.length === 0 ? (
            <p className="text-xs text-gray-500">Use the +Add buttons above on the photo to place boxes.</p>
          ) : (
            <div className="space-y-1.5">
              <div className="grid grid-cols-[1fr_1fr_80px_80px_32px] gap-2 text-[10px] uppercase tracking-wide text-gray-400 px-1">
                <span>Type</span><span>Wrap / Mode</span><span>Strings</span><span>Column Output</span><span />
              </div>
              {miniLightDetections.map((d, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_80px_80px_32px] gap-2 items-center">
                  <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                    value={d.type}
                    onChange={e => setMiniLightDetections(ds => ds.map((x, j) => j === i ? { ...x, type: e.target.value as 'bush'|'tree'|'column', columnMode: undefined } : x))}>
                    <option value="bush">Bush</option><option value="tree">Tree</option><option value="column">Column</option>
                  </select>
                  <select className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                    value={d.wrapStyle}
                    onChange={e => setMiniLightDetections(ds => ds.map((x, j) => j === i ? { ...x, wrapStyle: e.target.value as 'canopy'|'trunk' } : x))}>
                    <option value="canopy">Canopy</option><option value="trunk">Trunk</option>
                  </select>
                  <input type="number" min="1" className="border border-gray-200 rounded px-2 py-1 text-xs"
                    value={d.stringCount}
                    onChange={e => setMiniLightDetections(ds => ds.map((x, j) => j === i ? { ...x, stringCount: Math.max(1, Number(e.target.value)) } : x))} />
                  {/* Column garland toggle — only shown for columns */}
                  {d.type === 'column' ? (
                    <button
                      type="button"
                      onClick={() => setMiniLightDetections(ds => ds.map((x, j) => j === i
                        ? { ...x, columnMode: x.columnMode === 'garland' ? 'minilight' : 'garland' }
                        : x))}
                      className={`text-[10px] font-semibold px-2 py-1 rounded border ${d.columnMode === 'garland' ? 'bg-emerald-100 border-emerald-400 text-emerald-800' : 'bg-gray-50 border-gray-300 text-gray-500'}`}
                    >
                      {d.columnMode === 'garland' ? 'Garland' : 'Mini Lights'}
                    </button>
                  ) : <span />}
                  <button type="button" onClick={() => setMiniLightDetections(ds => ds.filter((_, j) => j !== i))}
                    className="text-red-400 hover:text-red-600 font-bold text-lg leading-none">×</button>
                </div>
              ))}
              {miniLightDetections.some(d => d.columnMode === 'garland') && (
                <p className="text-[10px] text-emerald-700 mt-1">
                  Columns set to Garland mode will be saved to the Garland Used section using the column height measurement.
                </p>
              )}
            </div>
          )}
        </Section>

        {/* Spritzers */}
        <Section title="Spritzers Used">
          {spritzers.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px_32px] gap-2 items-center mb-2">
              <select className={sel} value={s.size}
                onChange={e => setSpritzers(arr => arr.map((x, j) => j === i ? { ...x, size: e.target.value as Spritzer['size'] } : x))}>
                <option value="16">16&quot;</option><option value="24">24&quot;</option><option value="32">32&quot;</option>
              </select>
              <input type="number" min="1" className={inp} value={s.quantity}
                onChange={e => setSpritzers(arr => arr.map((x, j) => j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x))} />
              <button type="button" onClick={() => setSpritzers(arr => arr.filter((_, j) => j !== i))}
                className="text-red-400 hover:text-red-600 font-bold text-xl">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setSpritzers(arr => [...arr, { size: '24', quantity: 1 }])}
            className="text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5">
            + Add Spritzer
          </button>
        </Section>

        {/* Wreaths */}
        <Section title="Wreaths Used">
          {wreaths.map((w, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_100px_32px] gap-2 items-center mb-2">
              <select className={sel} value={w.size}
                onChange={e => setWreaths(arr => arr.map((x, j) => j === i ? { ...x, size: e.target.value as Wreath['size'] } : x))}>
                <option value="24noble">24&quot; Noble</option>
                <option value="30noble">30&quot; Noble</option>
                <option value="36noble">36&quot; Noble</option>
                <option value="48noble">48&quot; Noble</option>
                <option value="36oregon">36&quot; Oregon</option>
              </select>
              <select className={sel} value={w.tier}
                onChange={e => setWreaths(arr => arr.map((x, j) => j === i ? { ...x, tier: e.target.value as Wreath['tier'] } : x))}>
                <option value="labor">Labor Only</option><option value="bow">With Bow</option><option value="fullDecor">Full Decor</option>
              </select>
              <input type="number" min="1" className={inp} value={w.quantity}
                onChange={e => setWreaths(arr => arr.map((x, j) => j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x))} />
              <button type="button" onClick={() => setWreaths(arr => arr.filter((_, j) => j !== i))}
                className="text-red-400 hover:text-red-600 font-bold text-xl">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setWreaths(arr => [...arr, { size: '30noble', tier: 'bow', quantity: 1 }])}
            className="text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5">
            + Add Wreath
          </button>
        </Section>

        {/* Garland */}
        <Section title="Garland Used">
          {garland.map((g, i) => (
            <div key={i} className="grid grid-cols-[120px_1fr_100px_32px] gap-2 items-center mb-2">
              <select className={sel} value={g.length}
                onChange={e => setGarland(arr => arr.map((x, j) => j === i ? { ...x, length: e.target.value as GarlandItem['length'] } : x))}>
                <option value="9ft">9ft Noble</option><option value="4.5ft">4.5ft Noble</option>
              </select>
              <select className={sel} value={g.tier}
                onChange={e => setGarland(arr => arr.map((x, j) => j === i ? { ...x, tier: e.target.value as GarlandItem['tier'] } : x))}>
                <option value="labor">Labor Only</option><option value="bow">With Bow</option><option value="fullDecor">Full Decor</option>
              </select>
              <input type="number" min="1" className={inp} value={g.quantity}
                onChange={e => setGarland(arr => arr.map((x, j) => j === i ? { ...x, quantity: Math.max(1, Number(e.target.value)) } : x))} />
              <button type="button" onClick={() => setGarland(arr => arr.filter((_, j) => j !== i))}
                className="text-red-400 hover:text-red-600 font-bold text-xl">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setGarland(arr => [...arr, { length: '9ft', type: 'noble', tier: 'bow', quantity: 1 }])}
            className="text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5">
            + Add Garland
          </button>
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
    </div>
  );
}
