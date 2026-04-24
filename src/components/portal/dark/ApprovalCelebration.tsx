'use client';

// Portal v2 DARK — one-shot confetti burst on mount. Purely decorative,
// aria-hidden. Uses .portal-dark-confetti-particle (defined in
// portal-dark.css) with --tx/--ty per particle so angles vary.
//
// Palette rule for v2: WARM ONLY. Gold tones + cream highlights — no
// red/green mix. Mixing holiday red with evergreen at peak happiness
// crosses the tacky line we were trying to avoid. Gold alone gives the
// "all the bulbs just turned on" feeling.
//
// Honors prefers-reduced-motion — renders zero particles in that mode.

import { useEffect, useState } from 'react';

type Particle = {
  id: number;
  color: string;
  tx: string;
  ty: string;
  delay: string;
  size: string;
};

// Warm gold spectrum only — no red, no green.
const COLORS = ['#E8B862', '#F5CC7A', '#D9B15B', '#F4ECD8', '#B08840'];
const PARTICLE_COUNT = 52;

function makeParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    // Bias slightly upward — feels like a real cannon burst rather
    // than a perfect circle (looks more cinematic against dark bg).
    const angle = Math.random() * Math.PI * 2 - Math.PI * 0.1;
    const dist = 32 + Math.random() * 28;
    const tx = `${Math.cos(angle) * dist}vmin`;
    const ty = `${Math.sin(angle) * dist}vmin`;
    return {
      id: i,
      color: COLORS[i % COLORS.length],
      tx,
      ty,
      delay: `${Math.random() * 180}ms`,
      size: `${7 + Math.round(Math.random() * 9)}px`,
    };
  });
}

export function ApprovalCelebration() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;
    }
    setParticles(makeParticles());
  }, []);

  if (particles.length === 0) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-30 overflow-hidden"
    >
      {particles.map((p) => (
        <span
          key={p.id}
          className="portal-dark-confetti-particle"
          style={{
            backgroundColor: p.color,
            width: p.size,
            height: p.size,
            animationDelay: p.delay,
            ['--tx' as string]: p.tx,
            ['--ty' as string]: p.ty,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}
