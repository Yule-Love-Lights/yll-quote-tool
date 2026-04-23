'use client';

// FAQ — single-open accordion. Uses the grid-template-rows trick in
// portal.css for smooth height transitions without any JS-measured
// heights.

import { useState, useId } from 'react';
import { ChevronDown } from 'lucide-react';

export type FAQItem = { q: string; a: string };

export type FAQProps = { items: FAQItem[] };

export function FAQ({ items }: FAQProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const baseId = useId();

  return (
    <section
      aria-labelledby="portal-faq-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-12">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Frequently Asked
          </p>
          <h2
            id="portal-faq-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Everything else you were going to ask.
          </h2>
        </div>

        <ul className="border-t border-[#E8DFCC]">
          {items.map((item, i) => {
            const open = openIdx === i;
            const triggerId = `${baseId}-trigger-${i}`;
            const panelId = `${baseId}-panel-${i}`;
            return (
              <li key={i} className="border-b border-[#E8DFCC]">
                <h3>
                  <button
                    type="button"
                    id={triggerId}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIdx(open ? null : i)}
                    className="w-full flex items-center justify-between text-left gap-4 py-5 md:py-6 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF] rounded-md"
                  >
                    <span className="font-display text-[18px] md:text-[22px] font-semibold text-[#1F1B16] leading-[1.3]">
                      {item.q}
                    </span>
                    <ChevronDown
                      className={`w-5 h-5 shrink-0 text-[#1F3D2B] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                      aria-hidden
                    />
                  </button>
                </h3>

                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={triggerId}
                  data-open={open}
                  className="portal-accordion-panel"
                >
                  <div>
                    <p className="pb-6 pr-8 text-[15px] md:text-[16px] text-[#3A3229] leading-[1.65]">
                      {item.a}
                    </p>
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
