'use client';

// Portal v4 — Section V: Included in service.
// A minimal, editorial line-item list. Each row: red outlined checkbox +
// label + detail + price. Click to toggle (routes to Proposal IV Bespoke
// via SelectionContext). No bright fills, no badges — quiet and formal.

import { Check } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import type { PortalLineItem } from '../types';

export type IncludedInServiceProps = {
  items: PortalLineItem[];
};

export function IncludedInService({ items }: IncludedInServiceProps) {
  const { isItemSelected, toggleItem } = useSelection();

  return (
    <section
      aria-labelledby="concierge-included-heading"
      className="portal-concierge-band portal-concierge-section"
    >
      <div className="max-w-3xl mx-auto px-6 md:px-10">
        <div className="mb-12 md:mb-14 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">V</p>
          <p className="portal-concierge-eyebrow mb-4">Included in service</p>
          <h2
            id="concierge-included-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Every strand, <span className="font-display-italic">itemized.</span>
          </h2>
          <p className="mt-5 max-w-lg mx-auto font-display-italic text-[16px] md:text-[18px] text-[var(--yc-ink-soft)] leading-[1.6]">
            Add or remove any item to compose a bespoke proposal.
          </p>
        </div>

        <ul className="divide-y divide-[var(--yc-rule-soft)] bg-[var(--yc-cream-card)] border border-[var(--yc-rule-soft)] rounded-sm shadow-[var(--yc-shadow-card)]">
          {items.map((item) => {
            const selected = isItemSelected(item.id);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={`${selected ? 'Remove' : 'Add'} ${item.label}`}
                  onClick={() => toggleItem(item.id)}
                  className="w-full flex items-center gap-4 md:gap-5 px-5 md:px-7 py-4 md:py-5 text-left hover:bg-[var(--yc-cream-2)] transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-inset"
                >
                  <span
                    aria-hidden
                    className={`flex-shrink-0 flex items-center justify-center w-5 h-5 md:w-6 md:h-6 rounded-sm border transition-[background-color,border-color] duration-200 ${
                      selected
                        ? 'bg-[var(--yc-red-bright)] border-[var(--yc-red-bright)]'
                        : 'bg-transparent border-[var(--yc-red-deep)]'
                    }`}
                  >
                    {selected && (
                      <Check
                        className="w-3 h-3 md:w-3.5 md:h-3.5 text-[var(--yc-cream)]"
                        strokeWidth={3}
                        aria-hidden
                      />
                    )}
                  </span>

                  <div className="min-w-0 flex-1 grid grid-cols-[1fr,auto] items-baseline gap-4">
                    <div className="min-w-0">
                      <p
                        className={`font-display text-[18px] md:text-[20px] leading-[1.25] ${
                          selected ? 'text-[var(--yc-ink)]' : 'text-[var(--yc-ink-soft)]'
                        }`}
                      >
                        {item.label}
                      </p>
                      <p className="mt-0.5 text-[12px] md:text-[13px] text-[var(--yc-ink-muted)] tracking-wide">
                        {item.detail}
                      </p>
                    </div>
                    <p
                      className={`font-display tabular-nums text-[18px] md:text-[20px] ${
                        selected ? 'text-[var(--yc-red-deep)]' : 'text-[var(--yc-ink-muted)]'
                      }`}
                    >
                      {formatUsd(item.price)}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
