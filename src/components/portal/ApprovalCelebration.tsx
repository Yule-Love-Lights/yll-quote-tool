'use client';

// ApprovalCelebration — a one-shot confetti burst on mount. Purely
// decorative, aria-hidden. Uses the portal-confetti keyframes defined
// in portal.css with inline --tx/--ty per particle so angles vary.
//
// Honors prefers-reduced-motion (the CSS already zeroes the animation
// duration there; we also render zero particles in that mode).

import { useEffect, useState } from 'react';

type Particle = {
  id: number;
  color: string;
  tx: string;
  ty: string;
  delay: string;
  size: string;
};

const COLORS = ['#B3202D', '#1F3D2B', '#C89B3C', '#D9B15B', '#FBEFEF'];
const PARTICLE_COUNT = 48;

function makeParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    // Random angle around the circle, pushed outward 30–55vmin.
    const angle = Math.random() * Math.PI * 2;
    const dist = 30 + Math.random() * 25;
    const tx = `${Math.cos(angle) * dist}vmin`;
    const ty = `${Math.sin(angle) * dist}vmin`;
    return {
      id: i,
      color: COLORS[i % COLORS.length],
      tx,
      ty,
      delay: `${Math.random() * 140}ms`,
      size: `${8 + Math.round(Math.random() * 8)}px`,
    };
  });
}

export function ApprovalCelebration() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    // Respect reduced motion — skip the burst entirely.
    if (typeof window !== 'undefined') {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced) return;
    }
    // Generate on the next frame: keeps the randomized particle set client-only
    // (no SSR/hydration mismatch) and makes the state update non-synchronous
    // within the effect.
    const raf = requestAnimationFrame(() => setParticles(makeParticles()));
    return () => cancelAnimationFrame(raf);
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
          className="portal-confetti-particle"
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
