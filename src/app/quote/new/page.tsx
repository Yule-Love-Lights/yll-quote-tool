'use client';

import { useState, useRef, useEffect } from 'react';
import type {
  QuoteResult,
  MiniLightItem,
  Spritzer,
  Wreath,
  GarlandItem,
  WreathSize,
  DecorTier,
  SpritzerSize,
  GarlandLength,
} from '@/lib/pricing/pricingEngine';

// ─── Shared CSS constants ────────────────────────────────────────────────────

const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500';
const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const addBtn = 'mt-1 text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5 transition-colors';
const rmBtn = 'text-red-400 hover:text-red-600 font-bold text-xl leading-none mt-0.5';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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

type Customer = { name: string; address: string; phone: string; email: string };

type RooflineDifficulty = 'easy' | 'medium' | 'hard';

type FormData = {
  customer: Customer;
  santasFootage: number;
  santasDifficulty: RooflineDifficulty;
  gingerbreadFootage: number;
  gingerbreadDifficulty: RooflineDifficulty;
  winterWonderlandFootage: number;
  winterWonderlandDifficulty: RooflineDifficulty;
  miniLightItems: MiniLightItem[];
  spritzers: Spritzer[];
  wreaths: Wreath[];
  garland: GarlandItem[];
  takedown: 'included' | 'premium';
  rushFee: boolean;
  discountEnabled: boolean;
  discountType: 'percentage' | 'flat';
  discountAmount: number;
};

const initial: FormData = {
  customer: { name: '', address: '', phone: '', email: '' },
  santasFootage: 0,
  santasDifficulty: 'medium',
  gingerbreadFootage: 0,
  gingerbreadDifficulty: 'medium',
  winterWonderlandFootage: 0,
  winterWonderlandDifficulty: 'medium',
  miniLightItems: [],
  spritzers: [],
  wreaths: [],
  garland: [],
  takedown: 'included',
  rushFee: false,
  discountEnabled: false,
  discountType: 'percentage',
  discountAmount: 0,
};

// ─── Page component ───────────────────────────────────────────────────────────

export default function NewQuotePage() {
  const [form, setForm] = useState<FormData>(initial);
  const [result, setResult] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Photo analysis
  type LineSegment = { points: [number, number][]; label: string };
  type MiniLightDetection = {
    type: 'tree' | 'bush' | 'column';
    wrapStyle: 'canopy' | 'trunk';
    stringCount: number;
    box: [number, number, number, number];
    label: string;
  };
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisNotes, setAnalysisNotes] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [santasLines, setSantasLines] = useState<LineSegment[]>([]);
  const [gingerbreadLines, setGingerbreadLines] = useState<LineSegment[]>([]);
  // C9 custom runs — drawn as polylines on the photo, same UX as gutter/ridge.
  // Footage reuses feetPerUnit from the gutterline calibration.
  const [c9Lines, setC9Lines] = useState<LineSegment[]>([]);
  const [miniLightDetections, setMiniLightDetections] = useState<MiniLightDetection[]>([]);
  // Wreath / spritzer / garland detections — rendered as editable boxes on
  // the street view, same UX as mini lights. Auto-sync into form.wreaths /
  // form.spritzers / form.garland so they appear in the quote.
  type WreathDetection = { size: WreathSize; tier: DecorTier; box: [number, number, number, number]; label: string };
  type SpritzerDetection = { size: SpritzerSize; box: [number, number, number, number]; label: string };
  type GarlandDetection = { length: GarlandLength; tier: DecorTier; box: [number, number, number, number]; label: string };
  const [wreathDetections, setWreathDetections] = useState<WreathDetection[]>([]);
  const [spritzerDetections, setSpritzerDetections] = useState<SpritzerDetection[]>([]);
  const [garlandDetections, setGarlandDetections] = useState<GarlandDetection[]>([]);
  // Shared feet-per-normalized-unit scale — calibrated from the gutterline
  // (most reliable reference) and applied to both line types. This way edited
  // footage always reflects the drawn polylines, not Claude's separate text guess.
  const [feetPerUnit, setFeetPerUnit] = useState<number | null>(null);
  const [imgAspect, setImgAspect] = useState<number>(1); // width/height
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoMediaType, setPhotoMediaType] = useState<string | null>(null);
  const [originalAnalysis, setOriginalAnalysis] = useState<unknown>(null);
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [correctionSaved, setCorrectionSaved] = useState(false);
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
  const [viewMode, setViewMode] = useState<'street' | 'satellite'>('street');
  // Pricing follows the view the user is actively editing. Keeps manual
  // polyline edits in lockstep with the form inputs below the photo.
  const [measurementSource, setMeasurementSource] = useState<'street' | 'satellite'>('street');
  useEffect(() => {
    setMeasurementSource(viewMode);
  }, [viewMode]);

  // Mini light rates (mirror of BUSINESS_RULES.miniLightRates)
  const MINI_LIGHT_RATES = { canopy: 35, trunk: 45 } as const;

  // Drag state for editing polyline points
  type LineType = 'santas' | 'gingerbread' | 'c9';
  const [dragging, setDragging] = useState<{ type: LineType; lineIdx: number; ptIdx: number } | null>(null);
  // Drag state for detection boxes. `kind` lets one handler edit any of the
  // four detection arrays (mini light, wreath, spritzer, garland).
  type BoxDragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';
  type DetectionKind = 'mini' | 'wreath' | 'spritzer' | 'garland';
  const [boxDrag, setBoxDrag] = useState<{ kind: DetectionKind; idx: number; mode: BoxDragMode; startX: number; startY: number; startBox: [number, number, number, number] } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const [addMode, setAddMode] = useState<LineType | null>(null);
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([]);

  // Compute polyline length in "aspect-corrected" normalized units.
  // dx stays as-is (image width = 1), dy is scaled by (height/width) so
  // diagonal distances reflect real pixel distances on the image.
  const polylineLength = (lines: LineSegment[], aspect: number): number => {
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
  };

  // Satellite image is always 640x640 at zoom=20 from Static Maps.
  const SAT_PX = 640;

  // Recompute both footages from whichever source is driving pricing. Street
  // source uses calibrated feet-per-normalized-unit; satellite source uses
  // deterministic feet-per-pixel × image pixel width (640).
  useEffect(() => {
    let santasFt: number | null = null;
    let gingerFt: number | null = null;
    let c9Ft: number | null = null;
    if (measurementSource === 'street' && feetPerUnit != null) {
      santasFt = Math.round(polylineLength(santasLines, imgAspect) * feetPerUnit / 5) * 5;
      gingerFt = Math.round(polylineLength(gingerbreadLines, imgAspect) * feetPerUnit / 5) * 5;
      c9Ft = Math.round(polylineLength(c9Lines, imgAspect) * feetPerUnit / 5) * 5;
    } else if (measurementSource === 'satellite' && satelliteFeetPerPixel != null) {
      santasFt = Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
      gingerFt = Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
      c9Ft = Math.round(polylineLength(satelliteC9Lines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5;
    }
    if (santasFt == null || gingerFt == null) return;
    const sFt = santasFt, gFt = gingerFt;
    // c9 polyline only overrides the form value when lines are actually drawn.
    // Otherwise leave winterWonderlandFootage alone so the manual input still works.
    const hasC9Lines = c9Lines.length > 0 || satelliteC9Lines.length > 0;
    const c9Target = hasC9Lines ? c9Ft : null;
    setForm(f => {
      const sameRoof = f.santasFootage === sFt && f.gingerbreadFootage === gFt;
      const sameC9 = c9Target == null || f.winterWonderlandFootage === c9Target;
      if (sameRoof && sameC9) return f;
      return {
        ...f,
        santasFootage: sFt,
        gingerbreadFootage: gFt,
        ...(c9Target != null ? { winterWonderlandFootage: c9Target } : {}),
      };
    });
  }, [santasLines, gingerbreadLines, c9Lines, satelliteSantasLines, satelliteGingerbreadLines, satelliteC9Lines, feetPerUnit, satelliteFeetPerPixel, imgAspect, satelliteAspect, measurementSource]);

  // Footage display helpers — compute both sources independently so user can compare.
  const streetFootage = {
    santas: feetPerUnit != null ? Math.round(polylineLength(santasLines, imgAspect) * feetPerUnit / 5) * 5 : null,
    ginger: feetPerUnit != null ? Math.round(polylineLength(gingerbreadLines, imgAspect) * feetPerUnit / 5) * 5 : null,
  };
  const satFootage = {
    santas: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteSantasLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
    ginger: satelliteFeetPerPixel != null ? Math.round(polylineLength(satelliteGingerbreadLines, satelliteAspect) * SAT_PX * satelliteFeetPerPixel / 5) * 5 : null,
  };

  // Perspective correction: foreground plants are closer to the camera than the
  // roofline (typically ~half the distance), so the same pixel width represents
  // a smaller real-world object. Without this, bushes get sized 2-3x too large
  // and strand counts cube. 0.4 is an empirical factor for typical street-view
  // photos of LI houses (camera 20-40ft from curb, bushes at foundation).
  const PLANT_PERSPECTIVE_FACTOR = 0.4;

  // 5MM Round Bush/Tree Canopy Wrap formula (matches spreadsheet):
  // wraps = height_in / 6  (spacing always 6")
  // footage_ft = wraps × circumference_in / 12
  // strands = footage_ft / 25  (each strand = 50ct 5MM at 6" spacing = 25ft)
  // circumference = π × diameter, diameter = box width in real feet
  //
  // All roofline math is in FEET (pixel units × feetPerUnit).
  // Plant math converts to INCHES (ft × 12) for the wrap formula.
  // Perspective factor shrinks box→real conversion for foreground plants.
  const calcStringsFromBox = (box: [number, number, number, number]): number => {
    if (!feetPerUnit) return 1;
    const widthFt = box[2] * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const heightFt = (box[3] / imgAspect) * feetPerUnit * PLANT_PERSPECTIVE_FACTOR;
    const heightIn = heightFt * 12;
    const circumIn = Math.PI * widthFt * 12;
    const wraps = heightIn / 6;
    const footageFt = (wraps * circumIn) / 12;
    const strands = footageFt / 25;
    return Math.max(1, Math.round(strands));
  };

  // Drag handler for detection boxes (mini lights, wreaths, spritzers, garland).
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
        // Resize recomputes strand count from the new dimensions.
        const newStringCount = boxDrag.mode !== 'move' ? calcStringsFromBox(newBox) : undefined;
        setMiniLightDetections(dets => dets.map((d, i) =>
          i === boxDrag.idx
            ? { ...d, box: newBox, ...(newStringCount !== undefined && { stringCount: newStringCount }) }
            : d
        ));
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

  const updateDetection = (idx: number, patch: Partial<MiniLightDetection>) => {
    setMiniLightDetections(dets => dets.map((d, i) => i === idx ? { ...d, ...patch } : d));
  };

  const deleteDetection = (idx: number) => {
    setMiniLightDetections(dets => dets.filter((_, i) => i !== idx));
  };

  // Wreath / spritzer / garland CRUD — same pattern as mini-light detections.
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

  const addDetection = (type: 'bush' | 'tree' | 'column') => {
    const defaults = {
      bush:   { wrapStyle: 'canopy' as const, stringCount: 2, label: 'new bush' },
      tree:   { wrapStyle: 'trunk'  as const, stringCount: 4, label: 'new tree' },
      column: { wrapStyle: 'canopy' as const, stringCount: 2, label: 'new column' },
    }[type];
    setMiniLightDetections(dets => [...dets, {
      type,
      ...defaults,
      box: [0.4, 0.6, 0.15, 0.15],
    }]);
  };

  // Sync detection edits back into form.miniLightItems
  useEffect(() => {
    setForm(f => ({
      ...f,
      miniLightItems: miniLightDetections.map(d => ({
        type: d.type,
        wrapStyle: d.wrapStyle,
        stringCount: d.stringCount,
      })),
    }));
  }, [miniLightDetections]);

  // Wreaths — one form entry per detection. Grouped rendering in the quote is
  // fine with duplicates; each detection keeps its own box for editability.
  useEffect(() => {
    setForm(f => ({
      ...f,
      wreaths: wreathDetections.map(d => ({ size: d.size, tier: d.tier, quantity: 1 })),
    }));
  }, [wreathDetections]);

  // Spritzers — one form entry per detection.
  useEffect(() => {
    setForm(f => ({
      ...f,
      spritzers: spritzerDetections.map(d => ({ size: d.size, quantity: 1 })),
    }));
  }, [spritzerDetections]);

  // Garland — box width in real feet (via feetPerUnit) tells us how many 9ft
  // pieces the run needs. Rounded up so we never short the customer.
  useEffect(() => {
    const pieces = (box: [number, number, number, number], length: GarlandLength): number => {
      const unitFt = length === '9ft' ? 9 : 4.5;
      if (feetPerUnit == null) return 1;
      const widthFt = box[2] * feetPerUnit;
      return Math.max(1, Math.ceil(widthFt / unitFt));
    };
    setForm(f => ({
      ...f,
      garland: garlandDetections.map(d => ({
        length: d.length,
        type: 'noble' as const,
        tier: d.tier,
        quantity: pieces(d.box, d.length),
      })),
    }));
  }, [garlandDetections, feetPerUnit]);

  // Active setter routing — drag ops operate on whichever line set matches
  // the current viewMode. Street view edits street polylines; satellite view
  // edits satellite polylines.
  const getSetter = (type: LineType) => {
    if (viewMode === 'street') {
      if (type === 'santas') return setSantasLines;
      if (type === 'gingerbread') return setGingerbreadLines;
      return setC9Lines;
    }
    if (type === 'santas') return setSatelliteSantasLines;
    if (type === 'gingerbread') return setSatelliteGingerbreadLines;
    return setSatelliteC9Lines;
  };
  const activeSantasLines = viewMode === 'street' ? santasLines : satelliteSantasLines;
  const activeGingerbreadLines = viewMode === 'street' ? gingerbreadLines : satelliteGingerbreadLines;
  const activeC9Lines = viewMode === 'street' ? c9Lines : satelliteC9Lines;

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
  }, [dragging, viewMode]);

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

  const saveCorrections = async () => {
    if (!photoBase64 || !photoMediaType || !originalAnalysis) return;
    setSavingCorrection(true);
    setCorrectionSaved(false);
    try {
      const res = await fetch('/api/save-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photoBase64,
          photoMediaType,
          originalAnalysis,
          correctedSantasFootage: form.santasFootage,
          correctedSantasDifficulty: form.santasDifficulty,
          correctedSantasLines: santasLines,
          correctedGingerbreadFootage: form.gingerbreadFootage,
          correctedGingerbreadDifficulty: form.gingerbreadDifficulty,
          correctedGingerbreadLines: gingerbreadLines,
          correctedMiniLightDetections: miniLightDetections,
        }),
      });
      if (res.ok) setCorrectionSaved(true);
      else {
        const data = await res.json();
        alert(`Save failed: ${data.error ?? 'unknown error'}`);
      }
    } finally {
      setSavingCorrection(false);
    }
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setAnalysisNotes(null);
    setAnalysisError(null);
    setSantasLines([]);
    setGingerbreadLines([]);
    setC9Lines([]);
    setMiniLightDetections([]);
    setWreathDetections([]);
    setSpritzerDetections([]);
    setGarlandDetections([]);
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
      setPhotoPreview(`data:${data.photoMediaType};base64,${data.photoBase64}`);
      setPhotoBase64(data.photoBase64);
      setPhotoMediaType(data.photoMediaType);
      // Polylines + mini-light boxes were drawn in the old image's pixel space
      // — wipe them so they don't sit on the wrong spots. Satellite untouched.
      setSantasLines([]);
      setGingerbreadLines([]);
      setC9Lines([]);
      setMiniLightDetections([]);
      setWreathDetections([]);
      setSpritzerDetections([]);
      setGarlandDetections([]);
      setFeetPerUnit(null);
      setSvHeading(nextHeading);
      setSvPitch(nextPitch);
      setSvFov(nextFov);
      // Force view to street so the new image is visible.
      setViewMode('street');
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

  // Shared: apply analysis result to form + line/detection state.
  // Used by both manual upload and Google address lookup.
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
      satelliteSantasFootage?: number;
      satelliteGingerbreadFootage?: number;
      preferredSource?: 'street' | 'satellite';
      miniLightDetections?: MiniLightDetection[];
      wreathDetections?: WreathDetection[];
      spritzerDetections?: SpritzerDetection[];
      garlandDetections?: GarlandDetection[];
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
    setForm(f => ({
      ...f,
      santasFootage: r.santasFootage,
      santasDifficulty: r.santasDifficulty,
      gingerbreadFootage: r.gingerbreadFootage,
      gingerbreadDifficulty: r.gingerbreadDifficulty,
    }));
    const newSantasLines: LineSegment[] = r.santasLines ?? [];
    const newGingerbreadLines: LineSegment[] = r.gingerbreadLines ?? [];
    const detections: MiniLightDetection[] = r.miniLightDetections ?? [];
    setSantasLines(newSantasLines);
    setGingerbreadLines(newGingerbreadLines);
    setMiniLightDetections(detections);
    setWreathDetections(r.wreathDetections ?? []);
    setSpritzerDetections(r.spritzerDetections ?? []);
    setGarlandDetections(r.garlandDetections ?? []);
    const santasLen = polylineLength(newSantasLines, imgAspect);
    const ridgeLen = polylineLength(newGingerbreadLines, imgAspect);
    let scale: number | null = null;
    if (santasLen > 0 && r.santasFootage > 0) scale = r.santasFootage / santasLen;
    else if (ridgeLen > 0 && r.gingerbreadFootage > 0) scale = r.gingerbreadFootage / ridgeLen;
    setFeetPerUnit(scale);
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
    }
    // Satellite polylines — always seed them so the user can toggle to the
    // satellite canvas for complex / commercial rooflines without re-analyzing.
    setSatelliteSantasLines(r.satelliteSantasLines ?? []);
    setSatelliteGingerbreadLines(r.satelliteGingerbreadLines ?? []);
    setSatelliteFeetPerPixel(data.satelliteFeetPerPixel ?? null);
    // Claude may have flagged satellite as the better source (e.g. because
    // rear rooflines aren't visible from the street). Honor that hint.
    const preferred = r.preferredSource ?? 'street';
    setMeasurementSource(preferred);
    setViewMode(preferred);
    setAnalysisNotes(`${r.notes} (confidence: ${r.confidence})`);
    setPhotoBase64(data.photoBase64 ?? null);
    setPhotoMediaType(data.photoMediaType ?? null);
    setOriginalAnalysis(r);
    setFewShotCount(data.fewShotCount ?? 0);
    setCorrectionSaved(false);
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

  const set = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const setCustomer = (k: keyof Customer, v: string) =>
    setForm(f => ({ ...f, customer: { ...f.customer, [k]: v } }));

  // Mini lights — when detections are present, route all changes through
  // miniLightDetections so the boxes in the Analysis Results stay in lockstep.
  // When no photo has been analyzed, fall back to editing miniLightItems directly.
  const addMiniLight = () => {
    if (miniLightDetections.length > 0 || photoPreview) {
      addDetection('tree');
    } else {
      set('miniLightItems', [...form.miniLightItems, { type: 'tree', wrapStyle: 'trunk', stringCount: 3 }]);
    }
  };
  const removeMiniLight = (i: number) => {
    if (i < miniLightDetections.length) {
      deleteDetection(i);
    } else {
      set('miniLightItems', form.miniLightItems.filter((_, idx) => idx !== i));
    }
  };
  const updateMiniLight = (i: number, patch: Partial<MiniLightItem>) => {
    if (i < miniLightDetections.length) {
      updateDetection(i, patch as Partial<MiniLightDetection>);
    } else {
      set('miniLightItems', form.miniLightItems.map((item, idx) => idx === i ? { ...item, ...patch } : item));
    }
  };

  // Spritzers
  const addSpritzer = () =>
    set('spritzers', [...form.spritzers, { size: '24' as const, quantity: 1 }]);
  const removeSpritzer = (i: number) =>
    set('spritzers', form.spritzers.filter((_, idx) => idx !== i));
  const updateSpritzer = (i: number, patch: Partial<Spritzer>) =>
    set('spritzers', form.spritzers.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Wreaths
  const addWreath = () =>
    set('wreaths', [...form.wreaths, { size: '30noble' as const, tier: 'bow' as const, quantity: 1 }]);
  const removeWreath = (i: number) =>
    set('wreaths', form.wreaths.filter((_, idx) => idx !== i));
  const updateWreath = (i: number, patch: Partial<Wreath>) =>
    set('wreaths', form.wreaths.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  // Garland
  const addGarland = () =>
    set('garland', [...form.garland, { length: '9ft' as const, type: 'noble' as const, tier: 'bow' as const, quantity: 1 }]);
  const removeGarland = (i: number) =>
    set('garland', form.garland.filter((_, idx) => idx !== i));
  const updateGarland = (i: number, patch: Partial<GarlandItem>) =>
    set('garland', form.garland.map((item, idx) => idx === i ? { ...item, ...patch } : item));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    const inputs = {
      santasFootage: form.santasFootage,
      santasDifficulty: form.santasDifficulty,
      gingerbreadFootage: form.gingerbreadFootage,
      gingerbreadDifficulty: form.gingerbreadDifficulty,
      winterWonderlandFootage: form.winterWonderlandFootage,
      winterWonderlandDifficulty: form.winterWonderlandDifficulty,
      miniLightItems: form.miniLightItems,
      spritzers: form.spritzers,
      wreaths: form.wreaths,
      garland: form.garland,
      takedown: form.takedown,
      rushFee: form.rushFee,
      ...(form.discountEnabled && {
        discount: { type: form.discountType, amount: form.discountAmount },
      }),
    };

    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer: form.customer, inputs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data.result);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
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
          <h1 className="text-2xl font-bold text-gray-900">New Quote</h1>
        </div>

        <form onSubmit={handleSubmit}>

          {/* ── Customer Info ── */}
          <Section title="Customer Info">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={lbl}>Name *</label>
                <input className={inp} required placeholder="Jane Smith"
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
                <label className={lbl}>Property Address *</label>
                <input className={inp} required placeholder="123 Main St, Smithtown, NY 11787"
                  value={form.customer.address} onChange={e => setCustomer('address', e.target.value)} />
              </div>
            </div>
          </Section>

          {/* ── Photo Analysis ── */}
          <Section title="House Photo — Auto-Measure">
            <p className="text-xs text-gray-400 mb-3">
              Look up the address on Google Maps (Street View + satellite) or upload a photo. Claude will estimate gutterline, ridgeline, bushes, trees, and columns.
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
                  Satellite view is editable below — toggle to it in the results canvas.
                </p>
              )}
              {analysisNotes && (
                <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800">
                  <strong className="block mb-1">Analysis complete — form auto-filled below.</strong>
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

          {/* ── Analysis Results — editable marked-up photo ── */}
          {photoPreview && photoBase64 && (
            <Section title="Analysis Results — Correct The Measurement">
              <p className="text-xs text-gray-500 mb-3">
                Drag dots to reshape lines. Double-click a dot to remove it. Footage updates automatically as you edit.
                {fewShotCount > 0 && <span className="ml-2 text-green-700 font-medium">• Using {fewShotCount} past correction{fewShotCount === 1 ? '' : 's'} as reference</span>}
              </p>

              {/* View toggle — edit street or satellite polylines. Satellite is
                  better for commercial properties + complex rooflines where the
                  back + sides aren't visible from the street. */}
              {satellitePreview && (
                <div className="mb-3 flex items-center gap-3 flex-wrap">
                  <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs">
                    <button
                      type="button"
                      onClick={() => setViewMode('street')}
                      className={`px-3 py-1.5 font-medium ${viewMode === 'street' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    >
                      Street View
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode('satellite')}
                      className={`px-3 py-1.5 font-medium border-l border-gray-300 ${viewMode === 'satellite' ? 'bg-green-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    >
                      Satellite (top-down)
                    </button>
                  </div>
                  <div className="text-xs text-gray-500">
                    Pricing uses:
                    <label className="ml-2 inline-flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="msrc" checked={measurementSource === 'street'} onChange={() => setMeasurementSource('street')} />
                      Street
                    </label>
                    <label className="ml-2 inline-flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="msrc" checked={measurementSource === 'satellite'} onChange={() => setMeasurementSource('satellite')} />
                      Satellite
                    </label>
                  </div>
                </div>
              )}

              {/* Street View angle controls — rotate around obstacles (trees,
                  parked cars). Only shown when we have Google coordinates. */}
              {geoLat != null && geoLng != null && viewMode === 'street' && (
                <div className="mb-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                      Move the Camera
                    </span>
                    <span className="text-[11px] text-gray-500">
                      Tree or truck in the way? Rotate, tilt, or zoom — then re-analyze.
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

              {/* Side-by-side footage comparison */}
              {satellitePreview && (
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <div className={`rounded border p-2 ${measurementSource === 'street' ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                    <p className="font-semibold text-gray-700">Street: gutter {streetFootage.santas ?? '—'}ft · ridge {streetFootage.ginger ?? '—'}ft</p>
                  </div>
                  <div className={`rounded border p-2 ${measurementSource === 'satellite' ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                    <p className="font-semibold text-gray-700">Satellite: gutter {satFootage.santas ?? '—'}ft · ridge {satFootage.ginger ?? '—'}ft</p>
                  </div>
                </div>
              )}

              <div
                ref={imgContainerRef}
                onClick={addMode ? handleImageClick : undefined}
                className={`relative w-full ${addMode ? 'cursor-crosshair' : ''}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={viewMode === 'satellite' && satellitePreview ? satellitePreview : photoPreview}
                  alt={viewMode === 'satellite' ? 'Satellite view' : 'Analyzed house'}
                  className="w-full h-auto rounded-md border border-gray-200 block select-none pointer-events-none"
                  draggable={false}
                  onLoad={e => {
                    const img = e.currentTarget;
                    if (img.naturalHeight > 0) {
                      const aspect = img.naturalWidth / img.naturalHeight;
                      if (viewMode === 'satellite') setSatelliteAspect(aspect);
                      else setImgAspect(aspect);
                    }
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
                {/* Editable wreath boxes — purple outline. */}
                {!addMode && viewMode === 'street' && wreathDetections.map((d, i) => (
                  <div
                    key={`wbox-${i}`}
                    className="absolute border-2 border-purple-500 bg-purple-400/15 cursor-move rounded-full"
                    style={{
                      left: `${d.box[0] * 100}%`,
                      top: `${d.box[1] * 100}%`,
                      width: `${d.box[2] * 100}%`,
                      height: `${d.box[3] * 100}%`,
                      touchAction: 'none',
                    }}
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
                        <div
                          key={corner}
                          className={`absolute w-3 h-3 bg-white border-2 border-purple-600 rounded-sm ${pos[corner]}`}
                          style={{ touchAction: 'none' }}
                          onPointerDown={startBoxDrag('wreath', i, corner)}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* Editable spritzer boxes — fuchsia outline. */}
                {!addMode && viewMode === 'street' && spritzerDetections.map((d, i) => (
                  <div
                    key={`spbox-${i}`}
                    className="absolute border-2 border-fuchsia-500 bg-fuchsia-400/15 cursor-move"
                    style={{
                      left: `${d.box[0] * 100}%`,
                      top: `${d.box[1] * 100}%`,
                      width: `${d.box[2] * 100}%`,
                      height: `${d.box[3] * 100}%`,
                      touchAction: 'none',
                    }}
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
                        <div
                          key={corner}
                          className={`absolute w-3 h-3 bg-white border-2 border-fuchsia-700 rounded-sm ${pos[corner]}`}
                          style={{ touchAction: 'none' }}
                          onPointerDown={startBoxDrag('spritzer', i, corner)}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* Editable garland boxes — teal outline; width along the run
                    drives piece count via feetPerUnit. */}
                {!addMode && viewMode === 'street' && garlandDetections.map((d, i) => {
                  const unitFt = d.length === '9ft' ? 9 : 4.5;
                  const widthFt = feetPerUnit != null ? d.box[2] * feetPerUnit : 0;
                  const pieces = feetPerUnit != null ? Math.max(1, Math.ceil(widthFt / unitFt)) : 1;
                  return (
                    <div
                      key={`gbox-${i}`}
                      className="absolute border-2 border-teal-500 bg-teal-400/15 cursor-move"
                      style={{
                        left: `${d.box[0] * 100}%`,
                        top: `${d.box[1] * 100}%`,
                        width: `${d.box[2] * 100}%`,
                        height: `${d.box[3] * 100}%`,
                        touchAction: 'none',
                      }}
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
                          <div
                            key={corner}
                            className={`absolute w-3 h-3 bg-white border-2 border-teal-700 rounded-sm ${pos[corner]}`}
                            style={{ touchAction: 'none' }}
                            onPointerDown={startBoxDrag('garland', i, corner)}
                          />
                        );
                      })}
                    </div>
                  );
                })}

                {/* Editable mini-light boxes — only meaningful on street view
                    (box→strands math uses street-perspective scale). */}
                {!addMode && viewMode === 'street' && miniLightDetections.map((d, i) => {
                  const price = d.stringCount * MINI_LIGHT_RATES[d.wrapStyle];
                  const typeLetter = d.type === 'bush' ? 'B' : d.type === 'tree' ? 'T' : 'C';
                  return (
                    <div
                      key={`box-${i}`}
                      className="absolute border-2 border-dashed border-amber-500 bg-amber-400/15 cursor-move"
                      style={{
                        left: `${d.box[0] * 100}%`,
                        top: `${d.box[1] * 100}%`,
                        width: `${d.box[2] * 100}%`,
                        height: `${d.box[3] * 100}%`,
                        touchAction: 'none',
                      }}
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
                          <div
                            key={corner}
                            className={`absolute w-3 h-3 bg-white border-2 border-amber-600 rounded-sm ${pos[corner]}`}
                            style={{ touchAction: 'none' }}
                            onPointerDown={startBoxDrag('mini', i, corner)}
                          />
                        );
                      })}
                    </div>
                  );
                })}
                {/* Draggable point handles (HTML elements, positioned absolute — easier than SVG hit-testing) */}
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
                    Adding new {addMode === 'santas' ? 'gutterline (red)' : addMode === 'gingerbread' ? 'ridgeline (blue)' : 'C9 run (green)'} — click on the photo to add points ({pendingPoints.length} placed).
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
                    + Add Gutterline
                  </button>
                  <button type="button" onClick={() => { setAddMode('gingerbread'); setPendingPoints([]); }}
                    className="text-xs font-medium text-blue-700 border border-blue-300 hover:border-blue-500 rounded px-3 py-1.5">
                    + Add Ridgeline
                  </button>
                  <button type="button" onClick={() => { setAddMode('c9'); setPendingPoints([]); }}
                    className="text-xs font-medium text-emerald-700 border border-emerald-300 hover:border-emerald-500 rounded px-3 py-1.5">
                    + Add C9 Run
                  </button>
                </div>
              )}

              {/* Per-line edit panels — gutterline / ridgeline / C9s.
                  Each shows live footage + editable segment labels + delete. */}
              <div className="mt-4 grid grid-cols-3 gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-4 h-1 bg-red-500 rounded"></span>
                    <span className="text-sm font-semibold text-gray-800">Gutterline — {form.santasFootage}ft</span>
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
                    <span className="text-sm font-semibold text-gray-800">Ridgeline — {form.gingerbreadFootage}ft</span>
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

              {/* Mini light detections — editable */}
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
                      const typeLetter = d.type === 'bush' ? 'B' : d.type === 'tree' ? 'T' : 'C';
                      return (
                        <div key={`drow-${i}`} className="grid grid-cols-[28px_1fr_1fr_64px_64px_24px] gap-2 items-center">
                          <span className="text-xs font-semibold text-amber-700">{typeLetter}{i + 1}</span>
                          <select
                            className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                            value={d.type}
                            onChange={e => updateDetection(i, { type: e.target.value as MiniLightDetection['type'] })}
                          >
                            <option value="bush">Bush</option>
                            <option value="tree">Tree</option>
                            <option value="column">Column</option>
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
                          <button
                            type="button"
                            onClick={() => deleteDetection(i)}
                            className="text-red-400 hover:text-red-600 font-bold text-lg leading-none"
                            title="Delete"
                          >×</button>
                        </div>
                      );
                    })}
                    <div className="flex justify-end pt-1 text-xs font-semibold text-gray-700">
                      Total: ${miniLightDetections.reduce((s, d) => s + d.stringCount * MINI_LIGHT_RATES[d.wrapStyle], 0)}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => addDetection('bush')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">
                    + Add Bush
                  </button>
                  <button type="button" onClick={() => addDetection('tree')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">
                    + Add Tree
                  </button>
                  <button type="button" onClick={() => addDetection('column')}
                    className="text-xs font-medium text-amber-700 border border-amber-300 hover:border-amber-500 rounded px-3 py-1.5">
                    + Add Column
                  </button>
                </div>
              </div>

              {/* Spritzers */}
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

              {/* Wreaths — detected boxes, auto-synced into form.wreaths */}
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
                          <option value="36oregon">36&quot; Oregon</option>
                        </select>
                        <select
                          className="border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                          value={d.tier}
                          onChange={e => updateWreathDetection(i, { tier: e.target.value as DecorTier })}
                        >
                          <option value="labor">Labor</option>
                          <option value="bow">Bow</option>
                          <option value="fullDecor">Full Decor</option>
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

              {/* Garland — box width × feet/unit gives piece count (like columns) */}
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
                            <option value="labor">Labor</option>
                            <option value="bow">Bow</option>
                            <option value="fullDecor">Full Decor</option>
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

              {/* Save corrections */}
              <div className="mt-5 pt-4 border-t border-gray-100 flex items-center gap-3">
                <button
                  type="button"
                  onClick={saveCorrections}
                  disabled={savingCorrection}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium text-sm px-4 py-2 rounded-md"
                >
                  {savingCorrection ? 'Saving…' : 'Save Corrections (train AI)'}
                </button>
                {correctionSaved && (
                  <span className="text-xs text-green-700 font-medium">✓ Saved — future photos will use this as a reference.</span>
                )}
                <span className="text-xs text-gray-400">
                  Also adjust footage in the form below if needed. Those values are saved with the corrections.
                </span>
              </div>
            </Section>
          )}

          {/* ── Santa's — Gutterline ── */}
          <div className={`transition-opacity ${form.santasFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Santa's — Gutterline (C9 Bulbs)">
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

          {/* ── Gingerbread — Ridgeline ── */}
          <div className={`transition-opacity ${form.gingerbreadFootage === 0 ? 'opacity-50' : ''}`}>
            <Section title="Gingerbread — Ridgeline (C9 Bulbs)">
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

          {/* ── Trees / Bushes / Columns ── */}
          <Section title="Trees / Bushes / Columns — Mini Lights">
            {form.miniLightItems.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Type</span>
                  <span className={lbl}>Wrap Style</span>
                  <span className={lbl}>Strings</span>
                  <span />
                </div>
                {form.miniLightItems.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.type}
                      onChange={e => updateMiniLight(i, { type: e.target.value as MiniLightItem['type'] })}>
                      <option value="tree">Tree</option>
                      <option value="bush">Bush</option>
                      <option value="column">Column</option>
                    </select>
                    <select className={sel} value={item.wrapStyle}
                      onChange={e => updateMiniLight(i, { wrapStyle: e.target.value as MiniLightItem['wrapStyle'] })}>
                      <option value="canopy">Canopy — $35/strand</option>
                      <option value="trunk">Trunk — $45/strand</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.stringCount}
                      onChange={e => updateMiniLight(i, { stringCount: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeMiniLight(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addMiniLight} className={addBtn}>
              + Add Tree / Bush / Column
            </button>
          </Section>

          {/* ── Spritzers ── */}
          <Section title="Spritzers">
            {form.spritzers.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Size</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.spritzers.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.size}
                      onChange={e => updateSpritzer(i, { size: e.target.value as Spritzer['size'] })}>
                      <option value="16">16&quot; — $85 each</option>
                      <option value="24">24&quot; — $95 each</option>
                      <option value="32">32&quot; — $105 each</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateSpritzer(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeSpritzer(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addSpritzer} className={addBtn}>
              + Add Spritzer
            </button>
          </Section>

          {/* ── Wreaths ── */}
          <Section title="Wreaths">
            {form.wreaths.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Size</span>
                  <span className={lbl}>Tier</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.wreaths.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.size}
                      onChange={e => updateWreath(i, { size: e.target.value as Wreath['size'] })}>
                      <option value="24noble">24&quot; Noble</option>
                      <option value="30noble">30&quot; Noble</option>
                      <option value="36noble">36&quot; Noble</option>
                      <option value="48noble">48&quot; Noble</option>
                      <option value="36oregon">36&quot; Oregon</option>
                    </select>
                    <select className={sel} value={item.tier}
                      onChange={e => updateWreath(i, { tier: e.target.value as Wreath['tier'] })}>
                      <option value="labor">Labor Only</option>
                      <option value="bow">With Bow</option>
                      <option value="fullDecor">Full Decor</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateWreath(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeWreath(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addWreath} className={addBtn}>
              + Add Wreath
            </button>
          </Section>

          {/* ── Garland ── */}
          <Section title="Garland">
            {form.garland.length > 0 && (
              <div className="mb-3">
                <div className="grid grid-cols-[140px_1fr_72px_28px] gap-2 mb-1">
                  <span className={lbl}>Length</span>
                  <span className={lbl}>Tier</span>
                  <span className={lbl}>Qty</span>
                  <span />
                </div>
                {form.garland.map((item, i) => (
                  <div key={i} className="grid grid-cols-[140px_1fr_72px_28px] gap-2 mb-2 items-start">
                    <select className={sel} value={item.length}
                      onChange={e => updateGarland(i, { length: e.target.value as GarlandItem['length'] })}>
                      <option value="9ft">9ft Noble</option>
                      <option value="4.5ft">4.5ft Noble</option>
                    </select>
                    <select className={sel} value={item.tier}
                      onChange={e => updateGarland(i, { tier: e.target.value as GarlandItem['tier'] })}>
                      <option value="labor">Labor Only</option>
                      <option value="bow">With Bow</option>
                      <option value="fullDecor">Full Decor</option>
                    </select>
                    <input className={inp} type="number" min="1" value={item.quantity}
                      onChange={e => updateGarland(i, { quantity: Number(e.target.value) })} />
                    <button type="button" onClick={() => removeGarland(i)} className={rmBtn}>×</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" onClick={addGarland} className={addBtn}>
              + Add Garland
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
                      type="number" min="0" step="0.01"
                      className="border border-gray-300 rounded-md px-3 py-2 text-sm w-28 focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={form.discountAmount || ''}
                      placeholder={form.discountType === 'percentage' ? '0.20' : '100'}
                      onChange={e => set('discountAmount', Number(e.target.value))}
                    />
                    <span className="text-xs text-gray-400">
                      {form.discountType === 'percentage' ? 'e.g. 0.20 = 20% off' : 'e.g. 100 = $100 off'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors mb-6 text-base"
          >
            {loading ? 'Calculating…' : 'Calculate Quote'}
          </button>

        </form>

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

            {/* Line items */}
            <div className="mb-4 space-y-1.5">
              {result.lineItems.map((item, i) => (
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
              {result.minimumApplied && (
                <p className="text-xs text-amber-600 italic">Minimum quote of $1,000 applied</p>
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

      </div>
    </div>
  );
}
