'use client';

// Portal v4 — Sticky engagement pill.
// Floats bottom-right on desktop, full-width at the bottom on mobile
// (matches the concierge reserved feel — not a full-width bar demanding
// attention). Scrolls to the Engagement section on tap.

import { formatUsd } from '../format';
import { useSelection } from '../SelectionContext';
import { ArrowDown } from 'lucide-react';

export function StickyPill() {
  const { currentTotal, currentDeposit } = useSelection();

  const onEngage = () => {
    const el = document.getElementById('concierge-engagement-heading');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div
      className="portal-concierge-sticky"
      role="region"
      aria-label="Live total and engage"
    >
      <div className="flex flex-col items-start min-w-0">
        <span className="font-display tabular-nums text-[18px] md:text-[20px] text-[var(--yc-cream-on-green)] leading-none">
          {currentTotal > 0 ? formatUsd(currentTotal) : '—'}
        </span>
        <span className="text-[10px] md:text-[11px] tracking-[0.22em] uppercase text-[var(--yc-brass-bright)] mt-1 font-semibold whitespace-nowrap">
          Deposit{' '}
          <span className="tabular-nums">
            {currentDeposit > 0 ? formatUsd(currentDeposit) : '—'}
          </span>
        </span>
      </div>

      <button
        type="button"
        onClick={onEngage}
        disabled={currentTotal <= 0}
        aria-label="Scroll to engagement section"
        className="inline-flex items-center gap-1.5 px-4 md:px-5 py-2.5 md:py-3 rounded-full bg-[var(--yc-red-bright)] hover:bg-[var(--yc-red-brighter)] text-[var(--yc-cream)] font-semibold text-[13px] md:text-[14px] cursor-pointer transition-[background-color,transform] duration-200 active:scale-[0.98] shadow-[0_0_0_3px_rgba(200,49,61,0.18),0_6px_18px_-4px_rgba(139,31,43,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-brass-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-green)] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Engage
        <ArrowDown className="w-4 h-4" aria-hidden />
      </button>
    </div>
  );
}
