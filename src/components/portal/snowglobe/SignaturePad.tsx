'use client';

// Portal e-signature capture (#83 Phase 1, Slice B). Used in the Approve flow:
// the customer types their name (the baseline) and may optionally DRAW their
// signature on a small canvas. The captured value is POSTed in the approve body
// and frozen into approval_snapshot.signature server-side.
//
// Shape returned via onChange:
//   { name, kind: 'typed' | 'drawn', value }
//   - typed → value is the typed name
//   - drawn → value is a PNG data-URL of the canvas
// null when there isn't yet a usable signature (no name, or drawn mode with an
// empty canvas) so the caller can keep Approve disabled until it's signed.

import { useCallback, useEffect, useRef, useState } from 'react';

export type CapturedSignature = {
  name: string;
  kind: 'typed' | 'drawn';
  value: string;
};

type Props = {
  /** Fires whenever the signature becomes valid/invalid. null ⇒ not yet signed. */
  onChange: (sig: CapturedSignature | null) => void;
};

export function SignaturePad({ onChange }: Props) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'typed' | 'drawn'>('typed');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  // Recompute + emit the captured signature whenever inputs change.
  const emit = useCallback(
    (nextName: string, nextMode: 'typed' | 'drawn', drawn: boolean) => {
      const trimmed = nextName.trim();
      if (!trimmed) return onChange(null);
      if (nextMode === 'typed') {
        onChange({ name: trimmed, kind: 'typed', value: trimmed });
        return;
      }
      // drawn — need both a name (for the record) and a non-empty canvas.
      const canvas = canvasRef.current;
      if (!drawn || !canvas) return onChange(null);
      onChange({ name: trimmed, kind: 'drawn', value: canvas.toDataURL('image/png') });
    },
    [onChange],
  );

  useEffect(() => {
    emit(name, mode, hasDrawn);
    // re-emit on any dependency change
  }, [name, mode, hasDrawn, emit]);

  // ── Canvas drawing (pointer events cover mouse + touch + pen) ──────────────
  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    // Map CSS pixels → the canvas's internal pixel grid.
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const ctx = canvas.getContext('2d')!;
    const { x, y } = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    const ctx = canvas.getContext('2d')!;
    ctx.strokeStyle = '#F4ECD8';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const { x, y } = pointFromEvent(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasDrawnRef.current) {
      hasDrawnRef.current = true;
      setHasDrawn(true);
    }
  };

  const onPointerUp = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawnRef.current = false;
    setHasDrawn(false);
  };

  return (
    <div className="mt-4">
      <label htmlFor="sig-name" className="block text-[13px] text-[#A89F87] mb-1.5">
        Type your full name to sign
      </label>
      <input
        id="sig-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="name"
        placeholder="Your full name"
        className="w-full min-h-[44px] rounded-lg bg-[#060B0F] border border-[#FFB744]/30 px-3 py-2.5 text-[16px] text-[#F4ECD8] placeholder-[#6E6553] focus:outline-none focus:ring-2 focus:ring-[#FFB744]"
      />
      {name.trim() && mode === 'typed' && (
        <p className="mt-2 font-display text-[22px] text-[#FFD07A] italic" aria-hidden>
          {name.trim()}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 text-[12px]">
        <button
          type="button"
          onClick={() => {
            setMode(mode === 'typed' ? 'drawn' : 'typed');
            // Bug fix (audit W4-003): the canvas only exists while
            // mode === 'drawn' (it's conditionally rendered below), so
            // toggling drawn -> typed -> drawn unmounts and remounts a BLANK
            // canvas. hasDrawn/hasDrawnRef were previously reset only by
            // clearCanvas(), so they stayed true across the round-trip and
            // the emit effect above would read the fresh BLANK canvas and
            // emit it as a valid "drawn" signature — which could get frozen
            // into approval_snapshot on Approve without the customer ever
            // re-drawing anything. Reset both on every mode change so a
            // re-entered draw mode requires a real stroke before it can be
            // submitted again.
            hasDrawnRef.current = false;
            setHasDrawn(false);
          }}
          className="text-[#FFD07A] underline cursor-pointer min-h-[44px] inline-flex items-center"
        >
          {mode === 'typed' ? 'Or draw your signature instead' : 'Type my name instead'}
        </button>
      </div>

      {mode === 'drawn' && (
        <div className="mt-2">
          <canvas
            ref={canvasRef}
            width={520}
            height={160}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className="w-full h-[160px] rounded-lg bg-[#060B0F] border border-[#FFB744]/30 touch-none cursor-crosshair"
            aria-label="Draw your signature"
          />
          <div className="mt-1.5 flex items-center justify-between text-[12px] text-[#6E6553]">
            <span>Sign above with your finger or mouse</span>
            <button
              type="button"
              onClick={clearCanvas}
              className="text-[#A89F87] underline cursor-pointer min-h-[44px] inline-flex items-center"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
