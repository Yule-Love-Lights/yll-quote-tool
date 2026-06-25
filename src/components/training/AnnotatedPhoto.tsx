'use client';

// Photo + measurement overlay for the training review pages (#8 Stage A).
// Draws normalized-0–1 polylines (rooflines) and boxes (detections) over a
// base64 photo — a visual spot-check of the saved measurements.

import type { LineSegment } from '@/lib/photoAnalysis';

export type OverlayLineGroup = {
  color: string; // stroke color, e.g. '#ef4444' red santas / '#3b82f6' blue gingerbread
  segments: LineSegment[];
};

export type OverlayBox = {
  color: string;
  box: [number, number, number, number]; // normalized [x, y, w, h]
  label?: string;
};

export default function AnnotatedPhoto({
  src,
  alt,
  lineGroups = [],
  boxes = [],
}: {
  src: string;
  alt: string;
  lineGroups?: OverlayLineGroup[];
  boxes?: OverlayBox[];
}) {
  return (
    <div className="relative inline-block w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="w-full rounded border border-gray-300" />
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        {lineGroups.map((g, gi) =>
          g.segments.map((seg, si) => (
            <polyline
              key={`l-${gi}-${si}`}
              points={seg.points.map(([x, y]) => `${x},${y}`).join(' ')}
              fill="none"
              stroke={g.color}
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )),
        )}
        {boxes.map((b, i) => (
          <rect
            key={`b-${i}`}
            x={b.box[0]}
            y={b.box[1]}
            width={b.box[2]}
            height={b.box[3]}
            fill="none"
            stroke={b.color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            /* dash units are user-space under the 0–1 viewBox → keep them tiny */
            strokeDasharray="0.012 0.008"
          />
        ))}
      </svg>
    </div>
  );
}
