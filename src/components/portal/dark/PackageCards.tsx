'use client';

// Portal v2 DARK — Package Cards. Conversion core. Dark surfaces,
// gold selected state (not red — saves red for peak emphasis).
// "Recommended" becomes a subtle glowing tag above the card rather
// than a merch-tag ribbon.

import { useMemo } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import type { PortalPackage } from '../types';

export type PackageCardsProps = {
  packages: PortalPackage[];
};

export function PackageCards({ packages }: PackageCardsProps) {
  const { packageId, selectPackage, currentTotal, currentDeposit } = useSelection();

  const packageC = useMemo(() => packages.find((p) => p.id === 'C'), [packages]);
  const savings = useMemo(() => {
    if (!packageC?.aLaCarteTotal) return 0;
    return packageC.aLaCarteTotal - packageC.total;
  }, [packageC]);

  return (
    <section
      aria-labelledby="portal-dark-packages-heading"
      className="relative w-full bg-[#0B140F]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-14">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Choose Your Package
          </p>
          <h2
            id="portal-dark-packages-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Three thoughtful packages. One custom builder.
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#E0D7C1]/85 leading-[1.65]">
            Every package includes install, takedown, and a 48-hour fix guarantee. Swap any item below — your total updates live.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 md:gap-6">
          {packages.map((pkg) => {
            const isSelected = pkg.id === packageId;
            const isCustom = pkg.id === 'D';
            const displayTotal = isCustom ? currentTotal : pkg.total;
            const displayDeposit = isCustom ? currentDeposit : pkg.deposit;

            return (
              <div key={pkg.id} className="relative pt-5">
                {/* "Most popular" tag — floats just above the card */}
                {pkg.recommended && (
                  <div className="absolute -top-0.5 left-6 right-6 flex items-center justify-center pointer-events-none">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#0B140F] border border-[#E8B862]/50 text-[10px] font-semibold tracking-[0.16em] uppercase text-[#E8B862] shadow-[0_0_14px_rgba(232,184,98,0.35)]">
                      <Sparkles className="w-3 h-3" aria-hidden />
                      Most Popular
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => selectPackage(pkg.id)}
                  className={[
                    'relative w-full text-left rounded-2xl p-6 md:p-7 cursor-pointer transition-[background-color,box-shadow,border-color,opacity] duration-300',
                    'border',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B140F]',
                    isSelected
                      ? 'bg-[#1F2A23] border-[#E8B862]/70 shadow-[0_0_32px_rgba(232,184,98,0.18),0_24px_56px_-12px_rgba(0,0,0,0.75)]'
                      : 'bg-[#18221C] border-[#243029] hover:border-[#3C4F43] hover:bg-[#1C2620] shadow-[0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.55)]',
                    !isSelected && packageId !== 'D' ? 'opacity-75 hover:opacity-100' : '',
                  ].join(' ')}
                >
                  {/* Selected checkmark */}
                  {isSelected && (
                    <div
                      aria-hidden
                      className="absolute top-5 right-5 w-7 h-7 rounded-full bg-[#E8B862] text-[#0B140F] flex items-center justify-center shadow-[0_0_12px_rgba(232,184,98,0.6)]"
                    >
                      <Check className="w-4 h-4" strokeWidth={3} />
                    </div>
                  )}

                  <p className="text-[11px] font-semibold tracking-[0.18em] uppercase text-[#E8B862]/90 mb-2">
                    Package {pkg.id}
                  </p>
                  <h3 className="font-display text-[24px] md:text-[26px] font-semibold text-[#F4ECD8] leading-[1.15] pr-10 tracking-[-0.01em]">
                    {pkg.name}
                  </h3>
                  <p className="mt-2 text-[14px] text-[#A89F87] leading-[1.5] min-h-[42px]">
                    {pkg.tagline}
                  </p>

                  <div className="mt-5 pt-5 border-t border-[#243029]">
                    <p className="font-display text-[40px] md:text-[44px] font-bold text-[#F4ECD8] tabular-nums leading-none tracking-[-0.02em]">
                      {formatUsd(displayTotal)}
                    </p>
                    <p className="mt-1.5 text-[14px] text-[#A89F87]">
                      <span className="tabular-nums text-[#E0D7C1]">{formatUsd(displayDeposit)}</span> deposit
                    </p>
                  </div>

                  {/* Savings line on Package C */}
                  {pkg.id === 'C' && savings > 0 && (
                    <p className="mt-3 font-display italic text-[14px] text-[#E8B862]">
                      Save {formatUsd(savings)} vs. à la carte
                    </p>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
