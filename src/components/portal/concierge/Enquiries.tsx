'use client';

// Portal v4 — Section X: Enquiries.
// Minimal accordion FAQ. "Q" marker in oxblood serif. No colored chips,
// no highlight fills — quiet. grid-template-rows trick for animation.

import { useState } from 'react';
import { Plus, Minus } from 'lucide-react';

export type EnquiriesProps = {
  items: Array<{ q: string; a: string }>;
};

export function Enquiries({ items }: EnquiriesProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(0);

  return (
    <section
      aria-labelledby="concierge-enquiries-heading"
      className="portal-concierge-section"
    >
      <div className="max-w-3xl mx-auto px-6 md:px-10">
        <div className="mb-12 md:mb-14 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">X</p>
          <p className="portal-concierge-eyebrow mb-4">Enquiries</p>
          <h2
            id="concierge-enquiries-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Asked <span className="font-display-italic">and answered.</span>
          </h2>
        </div>

        <ul className="divide-y divide-[var(--yc-rule-soft)] border-t border-b border-[var(--yc-rule-soft)]">
          {items.map((item, idx) => {
            const open = openIdx === idx;
            return (
              <li key={item.q}>
                <button
                  type="button"
                  onClick={() => setOpenIdx(open ? null : idx)}
                  aria-expanded={open}
                  aria-controls={`enq-${idx}`}
                  className="w-full flex items-start gap-4 md:gap-6 py-5 md:py-7 text-left group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-cream)]"
                >
                  <span
                    aria-hidden
                    className="portal-concierge-numeral text-[22px] md:text-[26px] flex-shrink-0 w-7 md:w-9"
                  >
                    Q.
                  </span>
                  <span className="font-display text-[20px] md:text-[24px] leading-[1.3] text-[var(--yc-ink)] flex-1">
                    {item.q}
                  </span>
                  <span
                    aria-hidden
                    className={`flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full border border-[var(--yc-red-deep)] transition-[background-color,color] duration-300 ${
                      open
                        ? 'bg-[var(--yc-red-deep)] text-[var(--yc-cream)]'
                        : 'bg-transparent text-[var(--yc-red-deep)] group-hover:bg-[var(--yc-red-deep)] group-hover:text-[var(--yc-cream)]'
                    }`}
                  >
                    {open ? (
                      <Minus className="w-4 h-4" aria-hidden />
                    ) : (
                      <Plus className="w-4 h-4" aria-hidden />
                    )}
                  </span>
                </button>

                <div
                  id={`enq-${idx}`}
                  className="portal-concierge-accordion"
                  data-open={open}
                  aria-hidden={!open}
                >
                  <div>
                    <div className="pb-6 md:pb-8 pl-11 md:pl-[60px] pr-12">
                      <p className="font-display-italic text-[16px] md:text-[18px] leading-[1.7] text-[var(--yc-ink-soft)]">
                        {item.a}
                      </p>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
