'use client';

// Portal v4 — Section IV: The Proposal.
// Packages rendered as a numbered list (Proposal I, II, III, IV Bespoke),
// NOT as equal-weight cards. Each proposal is a horizontal entry — Roman
// numeral on the left, name + tagline + itemized inclusions in the middle,
// price + select button on the right. The active one gets a subtle oxblood
// left-rule + soft red glow, not a big highlight.

import { Check } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import type { PackageId, PortalPackage, PortalLineItem } from '../types';

export type ProposalProps = {
  packages: PortalPackage[];
  lineItems: PortalLineItem[];
};

const ROMAN: Record<PackageId, string> = { A: 'I', B: 'II', C: 'III', D: 'IV' };

export function Proposal({ packages, lineItems }: ProposalProps) {
  const { packageId, selectPackage, currentTotal, currentDeposit } = useSelection();
  const itemById = new Map(lineItems.map((li) => [li.id, li]));

  return (
    <section
      id="concierge-proposal"
      aria-labelledby="concierge-proposal-heading"
      className="portal-concierge-section"
    >
      <div className="max-w-4xl mx-auto px-6 md:px-10">
        <div className="mb-12 md:mb-16 text-center">
          <p className="portal-concierge-numeral text-[18px] md:text-[22px] mb-4">IV</p>
          <p className="portal-concierge-eyebrow mb-4">The Proposal</p>
          <h2
            id="concierge-proposal-heading"
            className="font-display text-[36px] md:text-[56px] leading-[1.05] text-[var(--yc-ink)]"
          >
            Four paths, <span className="font-display-italic">one home.</span>
          </h2>
          <p className="mt-5 max-w-xl mx-auto font-display-italic text-[17px] md:text-[19px] text-[var(--yc-ink-soft)] leading-[1.6]">
            Each proposal is complete as offered — or may be tailored bespoke.
          </p>
        </div>

        <ol className="space-y-5 md:space-y-6" role="radiogroup" aria-label="Select a proposal">
          {packages.map((pkg) => {
            const active = pkg.id === packageId;
            const isCustom = pkg.id === 'D';
            const displayTotal = active ? currentTotal : pkg.total;
            const displayDeposit = active ? currentDeposit : pkg.deposit;

            const inclusions = pkg.includedItemIds
              .map((id) => itemById.get(id))
              .filter((x): x is PortalLineItem => !!x);

            return (
              <li key={pkg.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => selectPackage(pkg.id)}
                  data-active={active}
                  className={`portal-concierge-proposal w-full text-left bg-[var(--yc-cream-card)] border border-l-4 rounded-sm p-6 md:p-8 transition-[border-color,box-shadow,background-color] duration-300 hover:border-[var(--yc-red-deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--yc-red-bright)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--yc-cream)] cursor-pointer ${
                    active
                      ? 'border-[var(--yc-red-bright)] border-l-[var(--yc-red-bright)] shadow-[var(--yc-glow-red)]'
                      : 'border-[var(--yc-rule-soft)] border-l-[var(--yc-rule)]'
                  }`}
                  style={{
                    boxShadow: active ? 'var(--yc-glow-red)' : 'var(--yc-shadow-card)',
                  }}
                >
                  <div className="grid grid-cols-[auto,1fr,auto] gap-5 md:gap-8 items-start">
                    <div>
                      <span
                        className="portal-concierge-numeral text-[44px] md:text-[60px] leading-none block"
                        aria-hidden
                      >
                        {ROMAN[pkg.id]}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-baseline gap-3 flex-wrap">
                        <h3 className="font-display text-[26px] md:text-[34px] leading-[1.1] text-[var(--yc-ink)]">
                          {pkg.name}
                        </h3>
                        {pkg.recommended && (
                          <span className="portal-concierge-eyebrow text-[var(--yc-red-bright)]">
                            Recommended
                          </span>
                        )}
                        {isCustom && (
                          <span className="portal-concierge-eyebrow text-[var(--yc-ink-muted)]">
                            Bespoke
                          </span>
                        )}
                      </div>
                      <p className="mt-2 font-display-italic text-[16px] md:text-[17px] text-[var(--yc-ink-soft)] leading-[1.5]">
                        {pkg.tagline}
                      </p>

                      {!isCustom && inclusions.length > 0 && (
                        <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
                          {inclusions.map((li) => (
                            <li
                              key={li.id}
                              className="flex items-start gap-2 text-[14px] text-[var(--yc-ink-soft)] leading-[1.5]"
                            >
                              <Check
                                className="w-3.5 h-3.5 mt-[0.3em] flex-shrink-0 text-[var(--yc-red-deep)]"
                                aria-hidden
                              />
                              <span>
                                {li.label}
                                <span className="text-[var(--yc-ink-muted)]"> · {li.detail}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {isCustom && (
                        <p className="mt-4 text-[14px] text-[var(--yc-ink-muted)] leading-[1.55] max-w-md">
                          Composed line-by-line below. Begin with what catches your eye — adjust
                          freely. Pricing updates in real time.
                        </p>
                      )}
                    </div>

                    <div className="text-right flex-shrink-0 min-w-[110px]">
                      <p
                        className={`font-display tabular-nums text-[30px] md:text-[40px] leading-[1] ${
                          active ? 'text-[var(--yc-red-bright)]' : 'text-[var(--yc-ink)]'
                        }`}
                      >
                        {displayTotal > 0 ? formatUsd(displayTotal) : '—'}
                      </p>
                      <p className="mt-1.5 text-[11px] tracking-[0.18em] uppercase text-[var(--yc-ink-muted)]">
                        Deposit{' '}
                        <span className="tabular-nums text-[var(--yc-red-deep)] font-semibold">
                          {displayDeposit > 0 ? formatUsd(displayDeposit) : '—'}
                        </span>
                      </p>
                      {pkg.aLaCarteTotal && pkg.aLaCarteTotal > pkg.total && (
                        <p className="mt-2 text-[11px] italic text-[var(--yc-ink-muted)]">
                          à la carte {formatUsd(pkg.aLaCarteTotal)}
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
