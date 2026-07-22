'use client';

// Customer self-serve estimate — before/after hero (ledger self-serve, S48).
//
// Ported from the approved mockup: a house photo with the holiday-light design
// drawn on as an SVG overlay ("with lights"), revealed against the plain photo
// ("before") by a drag slider. Same technique the real result screen uses for the
// customer's OWN house (photo + traced design), here for the sample-home styles.
//
// The lights are drawn from the style's hand-placed geometry (estimateSamples.ts).
// When real YLL before/after photo pairs arrive, this can switch to crossfading
// two <img>s instead of drawing the overlay — the slider chrome stays identical.

import { useState } from 'react';
import { VW, VH, bulbPositions, garlandDots, type SampleStyle, type SchemeKey } from './estimateSamples';

function LightsOverlay({ style, scheme }: { style: SampleStyle; scheme: SchemeKey }) {
  const bulbs = bulbPositions(style.runs, scheme);
  return (
    <svg
      viewBox={`0 0 ${VW} ${VH}`}
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      {/* Evening dim so the warm bulbs read against a daytime photo. */}
      <rect width={VW} height={VH} fill="#0A1020" opacity={0.24} />
      {/* Garland swags + their lit dots. */}
      {style.garlands.map((g, i) => (
        <g key={`g${i}`}>
          <path
            d={`M${g[0]} ${g[1]} Q${g[2]} ${g[3]} ${g[4]} ${g[5]}`}
            fill="none"
            stroke="#2F6B3C"
            strokeWidth={6}
            strokeLinecap="round"
            style={{ filter: 'drop-shadow(0 0 4px rgba(63,122,76,0.7))' }}
          />
          {garlandDots(g).map((p, j) => (
            <circle key={j} cx={p.x} cy={p.y} r={2} fill="#F5CC7A" style={{ filter: 'drop-shadow(0 0 4px #F5CC7A)' }} />
          ))}
        </g>
      ))}
      {/* Wreaths. */}
      {style.wreaths.map(([cx, cy, r], i) => (
        <g key={`w${i}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2F6B3C" strokeWidth={r * 0.5} style={{ filter: 'drop-shadow(0 0 4px rgba(63,122,76,0.8))' }} />
          <circle cx={cx} cy={cy - r} r={3} fill="#D8434F" />
          <circle cx={cx - r * 0.75} cy={cy + r * 0.5} r={1.6} fill="#F5CC7A" />
          <circle cx={cx + r * 0.75} cy={cy + r * 0.5} r={1.6} fill="#F5CC7A" />
          <circle cx={cx} cy={cy + r} r={1.6} fill="#F5CC7A" />
        </g>
      ))}
      {/* Roofline bulbs. */}
      <g>
        {bulbs.map((b, i) => (
          <circle key={i} cx={b.x} cy={b.y} r={3.2} fill={b.color} style={{ filter: `drop-shadow(0 0 6px ${b.color})` }} />
        ))}
      </g>
    </svg>
  );
}

export function BeforeAfter({ style, scheme }: { style: SampleStyle; scheme: SchemeKey }) {
  const [split, setSplit] = useState(50);
  return (
    <div className="est-framebox">
      <div className="relative aspect-[3/2] w-full">
        {/* AFTER (bottom): photo + drawn lights. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={style.photo} alt={`${style.label} home with holiday lights`} className="absolute inset-0 h-full w-full object-cover" />
        <LightsOverlay style={style} scheme={scheme} />
        {/* BEFORE (top): plain photo, clipped to the left of the handle. */}
        <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={style.photo} alt={`${style.label} home`} className="absolute inset-0 h-full w-full object-cover" />
        </div>
        <span className="est-ba-label est-ba-label-l">Before</span>
        <span className="est-ba-label est-ba-label-r">With lights</span>
        <div className="est-ba-handle" style={{ left: `${split}%` }} />
        <input
          type="range"
          min={0}
          max={100}
          value={split}
          onChange={(e) => setSplit(Number(e.target.value))}
          aria-label="Drag to compare before and with lights"
          className="est-ba-range"
        />
      </div>
    </div>
  );
}
