'use client';

// Package Cards — the conversion core. Four cards: A, B (recommended),
// C, D (custom). Desktop = 4-up grid, mobile = vertical stack.
//
// Selection rules enforced by SelectionContext:
//  - Clicking a card card selects that package
//  - Individual item toggles handled in <WhatsIncluded>
//  - Selected card = red top-border + gold tint; others dim

import { useMemo } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useSelection } from './SelectionContext';
import { formatUsd } from './format';
import type { PortalPackage } from './types';

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
      aria-labelledby="portal-packages-heading"
      className="w-full bg-[#FAF6EF]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
        <div className="max-w-2xl mb-8 md:mb-12">
          <p className="text-[12px] md:text-[13px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-3">
            Choose Your Package
          </p>
          <h2
            id="portal-packages-heading"
            className="font-display text-[30px] md:text-[44px] leading-[1.1] font-semibold text-[#1F1B16]"
          >
            Three thoughtful packages. One custom builder.
          </h2>
          <p className="mt-3 text-[16px] md:text-[17px] text-[#3A3229] leading-[1.6]">
            Every package includes install, takedown, and a 48-hour fix guarantee. Swap any item below — your total updates live.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 md:gap-6">
          {packages.map((pkg) => {
            const isSelected = pkg.id === packageId;
            const isCustom = pkg.id === 'D';

            // Display total & deposit — for D use live values from context.
            const displayTotal = isCustom ? currentTotal : pkg.total;
            const displayDeposit = isCustom ? currentDeposit : pkg.deposit;

            return (
              <button
                key={pkg.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => selectPackage(pkg.id)}
                className={[
                  'relative text-left rounded-2xl p-6 md:p-7 cursor-pointer transition-[transform,background-color,box-shadow,opacity,border-color] duration-200',
                  'border border-[#E8DFCC]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C89B3C] focus-visible:ring-offset-2 focus-visible:ring-offset-[#FAF6EF]',
                  isSelected
                    ? 'bg-[#FBF5E8] border-t-4 border-t-[#B3202D] shadow-[0_2px_4px_rgba(31,27,22,0.06),0_16px_40px_-12px_rgba(31,27,22,0.14)]'
                    : 'bg-[#FAF6EF] shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)] hover:shadow-[0_2px_4px_rgba(31,27,22,0.06),0_16px_40px_-12px_rgba(31,27,22,0.14)]',
                  !isSelected && packageId !== 'D' ? 'opacity-[0.78] hover:opacity-100' : '',
                  pkg.recommended ? 'md:scale-[1.02] md:origin-top' : '',
                ].join(' ')}
              >
                {/* Recommended ribbon */}
                {pkg.recommended && (
                  <div className="absolute -top-3 right-5 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#C89B3C] text-[#1F1B16] text-[11px] font-semibold tracking-[0.1em] uppercase shadow-[0_4px_12px_-2px_rgba(200,155,60,0.45)]">
                    <Sparkles className="w-3 h-3" aria-hidden />
                    Recommended
                  </div>
                )}

                {/* Selected checkmark */}
                {isSelected && (
                  <div
                    aria-hidden
                    className="absolute top-5 right-5 w-7 h-7 rounded-full bg-[#B3202D] text-[#FAF6EF] flex items-center justify-center"
                  >
                    <Check className="w-4 h-4" />
                  </div>
                )}

                <p className="text-[11px] font-semibold tracking-[0.14em] uppercase text-[#1F3D2B] mb-2">
                  Package {pkg.id}
                </p>
                <h3 className="font-display text-[24px] md:text-[26px] font-semibold text-[#1F1B16] leading-[1.15] pr-10">
                  {pkg.name}
                </h3>
                <p className="mt-2 text-[14px] text-[#6B5F52] leading-[1.5] min-h-[42px]">
                  {pkg.tagline}
                </p>

                <div className="mt-5 pt-5 border-t border-[#E8DFCC]">
                  <p className="font-display text-[40px] md:text-[44px] font-bold text-[#1F1B16] tabular-nums leading-none">
                    {formatUsd(displayTotal)}
                  </p>
                  <p className="mt-1.5 text-[14px] text-[#6B5F52]">
                    <span className="tabular-nums">{formatUsd(displayDeposit)}</span> deposit
                  </p>
                </div>

                {/* Savings line on Package C */}
                {pkg.id === 'C' && savings > 0 && (
                  <p className="mt-3 font-display italic text-[14px] text-[#1F3D2B]">
                    Save {formatUsd(savings)} vs. à la carte
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
