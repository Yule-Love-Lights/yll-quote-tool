'use client';

// What's Included — detailed line items with per-item toggle. Icon
// per kind (Lucide only). Tapping the toggle flips selection to
// Custom via SelectionContext.

import { Home, Triangle, TreePine, Sparkles, Gift, Leaf, Flower2 } from 'lucide-react';
import type { PortalLineItem, PortalLineItemKind } from './types';
import { useSelection } from './SelectionContext';
import { formatUsd } from './format';

const ICONS: Record<PortalLineItemKind, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  roofline: Home,
  ridge: Triangle,
  tree: TreePine,
  bush: Leaf,
  wreath: Gift,          // closest Lucide approximation — wreath has no dedicated icon
  garland: Flower2,
  spritzer: Sparkles,
  column: Sparkles,
};

export type WhatsIncludedProps = {
  items: PortalLineItem[];
};

export function WhatsIncluded({ items }: WhatsIncludedProps) {
  const { isItemSelected, toggleItem, activeName } = useSelection();

  return (
    <section
      aria-labelledby="portal-included-heading"
      className="w-full bg-[#F3EDE1]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-10">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            What&apos;s Included
          </p>
          <h2
            id="portal-included-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Your {activeName} — line by line.
          </h2>
          <p className="mt-3 text-[16px] md:text-[17px] text-[#3A3229] leading-[1.6]">
            Toggle anything off to remove it. We&apos;ll switch your package to &ldquo;Build Your Own&rdquo; and update your total automatically.
          </p>
        </div>

        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          {items.map((item) => {
            const Icon = ICONS[item.kind] ?? Sparkles;
            const selected = isItemSelected(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleItem(item.id)}
                  className={[
                    'w-full flex items-center gap-4 p-4 md:p-5 rounded-2xl cursor-pointer transition-[background-color,border-color,opacity] duration-200 text-left',
                    'border',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#F3EDE1]',
                    selected
                      ? 'bg-[#FAF6EF] border-[#C89B3C]/40'
                      : 'bg-[#FAF6EF]/60 border-[#E8DFCC] opacity-70 hover:opacity-100',
                  ].join(' ')}
                >
                  <span
                    aria-hidden
                    className={[
                      'shrink-0 w-11 h-11 rounded-full flex items-center justify-center transition-colors duration-200',
                      selected ? 'bg-[#C89B3C]' : 'bg-[#E8DFCC]',
                    ].join(' ')}
                  >
                    <Icon className={selected ? 'w-5 h-5 text-[#1F1B16]' : 'w-5 h-5 text-[#6B5F52]'} aria-hidden />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-display text-[17px] md:text-[18px] font-semibold text-[#1F1B16] leading-[1.3]">
                      {item.label}
                    </span>
                    <span className="block text-[14px] text-[#6B5F52] mt-0.5">
                      {item.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-display text-[18px] font-semibold text-[#1F1B16] tabular-nums">
                      {formatUsd(item.price)}
                    </span>
                    <span className="block text-[12px] font-semibold tracking-[0.1em] uppercase mt-0.5" style={{ color: selected ? '#1F3D2B' : '#9E9082' }}>
                      {selected ? 'Included' : 'Off'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
