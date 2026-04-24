'use client';

// Portal v2 DARK — FAQ. Single-open accordion, grid-rows animation,
// gold chevron that rotates on open.

import { useState, useId } from 'react';
import { ChevronDown } from 'lucide-react';

export type FAQItem = { q: string; a: string };
export type FAQProps = { items: FAQItem[] };

export function FAQ({ items }: FAQProps) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const baseId = useId();

  return (
    <section
      aria-labelledby="portal-dark-faq-heading"
      className="relative w-full bg-[#121B16] border-y border-[#243029]"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Frequently Asked
          </p>
          <h2
            id="portal-dark-faq-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Everything else you were going to ask.
          </h2>
        </div>

        <ul className="border-t border-[#243029]">
          {items.map((item, i) => {
            const open = openIdx === i;
            const triggerId = `${baseId}-trigger-${i}`;
            const panelId = `${baseId}-panel-${i}`;
            return (
              <li key={i} className="border-b border-[#243029]">
                <h3>
                  <button
                    type="button"
                    id={triggerId}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => setOpenIdx(open ? null : i)}
                    className="w-full flex items-center justify-between text-left gap-4 py-5 md:py-6 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16] rounded-md group"
                  >
                    <span
                      className={`font-display text-[18px] md:text-[22px] font-semibold leading-[1.3] tracking-[-0.005em] transition-colors duration-200 ${
                        open ? 'text-[#F4ECD8]' : 'text-[#E0D7C1] group-hover:text-[#F4ECD8]'
                      }`}
                    >
                      {item.q}
                    </span>
                    <ChevronDown
                      className={`w-5 h-5 shrink-0 text-[#E8B862] transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
                      aria-hidden
                    />
                  </button>
                </h3>

                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={triggerId}
                  data-open={open}
                  className="portal-dark-accordion"
                >
                  <div>
                    <p className="pb-6 pr-8 text-[15px] md:text-[16px] text-[#A89F87] leading-[1.7]">
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
