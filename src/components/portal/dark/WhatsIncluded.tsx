'use client';

// Portal v2 DARK — What's Included. Per-item toggle list. Selected
// items get gold icon badge + bright cream text; deselected items
// dim out with muted cream. No red anywhere — keeps red reserved
// for the sticky bar CTA.

import type { CSSProperties } from 'react';
import { Home, Triangle, TreePine, Sparkles, Gift, Leaf, Flower2, Ribbon, Fence, Lightbulb, Check } from 'lucide-react';
import type { PortalDesign, PortalLineItem, PortalLineItemKind } from '../types';
import type { BulbColor } from '@/lib/design/sceneTypes';
import type { ServiceType } from '@/lib/serviceType';
import type { RenderSettings } from '@/components/design/editor-core/renderSettings';
import { useSelection } from '../SelectionContext';
import { formatUsd } from '../format';
import { DesignReprise } from './DesignReprise';
import { SatelliteRoofView } from './SatelliteRoofView';
import { selectDrawableLineGroups, permanentAllowedSatelliteKeys } from '@/lib/portal/satelliteLines';

// Customer-toggleable add-on (rush install / premium takedown) — #4.
function AddOnToggle({
  selected,
  onToggle,
  title,
  blurb,
  amount,
  disabled = false,
  disabledHint,
}: {
  selected: boolean;
  onToggle: () => void;
  title: string;
  blurb: string;
  amount: number;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={onToggle}
        className={[
          'w-full flex items-start gap-4 p-4 md:p-5 rounded-2xl transition-[background-color,border-color,opacity] duration-300 text-left border',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16]',
          disabled
            ? 'opacity-40 cursor-not-allowed bg-[#18221C]/40 border-[#243029]'
            : selected
              ? 'bg-[#1F2A23] border-[#3C4F43] cursor-pointer'
              : 'bg-[#18221C]/70 border-[#243029] opacity-60 hover:opacity-100 cursor-pointer',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center transition-colors duration-300 border',
            selected ? 'bg-[#E8B862] border-[#E8B862]' : 'bg-transparent border-[#3C4F43]',
          ].join(' ')}
        >
          {selected && <Check className="w-4 h-4 text-[#0B140F]" aria-hidden />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline justify-between gap-3">
            <span className={`font-display text-[17px] md:text-[18px] font-semibold ${selected ? 'text-[#F4ECD8]' : 'text-[#A89F87]'}`}>
              {title}
            </span>
            <span className={`font-display text-[16px] font-semibold tabular-nums ${selected ? 'text-[#E8B862]' : 'text-[#A89F87]'}`}>
              +{formatUsd(amount)}
            </span>
          </span>
          <span className="block text-[13px] mt-1 leading-[1.5] text-[#A89F87]">
            {blurb}
          </span>
        </span>
      </button>
    </li>
  );
}

// Customer-selectable early-install discount (Sep/Oct) — #40. Mutually
// exclusive with each other and with rush install (disabled while rush is on).
function DiscountToggle({
  selected,
  disabled,
  onToggle,
  title,
  blurb,
  percentLabel,
  disabledHint,
}: {
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  title: string;
  blurb: string;
  percentLabel: string;
  disabledHint?: string;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
        onClick={onToggle}
        className={[
          'w-full flex items-start gap-4 p-4 md:p-5 rounded-2xl transition-[background-color,border-color,opacity] duration-300 text-left border',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16]',
          disabled
            ? 'opacity-40 cursor-not-allowed bg-[#18221C]/40 border-[#243029]'
            : selected
              ? 'bg-[#1F2A23] border-[#3C4F43] cursor-pointer'
              : 'bg-[#18221C]/70 border-[#243029] opacity-60 hover:opacity-100 cursor-pointer',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'shrink-0 mt-0.5 w-6 h-6 rounded-md flex items-center justify-center transition-colors duration-300 border',
            selected ? 'bg-[#E8B862] border-[#E8B862]' : 'bg-transparent border-[#3C4F43]',
          ].join(' ')}
        >
          {selected && <Check className="w-4 h-4 text-[#0B140F]" aria-hidden />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline justify-between gap-3">
            <span className={`font-display text-[17px] md:text-[18px] font-semibold ${selected ? 'text-[#F4ECD8]' : 'text-[#A89F87]'}`}>
              {title}
            </span>
            <span className={`font-display text-[16px] font-semibold ${selected ? 'text-[#86C9A0]' : 'text-[#A89F87]'}`}>
              −{percentLabel}
            </span>
          </span>
          <span className="block text-[13px] mt-1 leading-[1.5] text-[#A89F87]">
            {blurb}
          </span>
        </span>
      </button>
    </li>
  );
}

const ICONS: Record<PortalLineItemKind, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>> = {
  roofline: Home,
  ridge: Triangle,
  tree: TreePine,
  bush: Leaf,
  wreath: Gift,
  garland: Flower2,
  spritzer: Sparkles,
  column: Sparkles,
  bow: Ribbon,
  railing: Fence,
  curtain: Lightbulb,
  'stake-lighting': Lightbulb,
  // Permanent Lighting (#88 P5): per-surface line items reuse the house icon;
  // the maintenance add-on reuses the generic bulb icon.
  permanent: Home,
  'permanent-addon': Lightbulb,
};

export type WhatsIncludedProps = {
  items: PortalLineItem[];
  // Linked design (#27 Phase 2) + global app settings (#32), passed through so the
  // second on-page design render (#50) can sit between the items and the add-ons.
  // Absent ⇒ no second render (legacy / no-design quotes).
  design?: PortalDesign;
  palette?: BulbColor[];
  renderSettings?: RenderSettings;
  // Permanent Lighting (#88): hide the holiday-only rush/takedown + early-install
  // add-ons for a permanent quote (those fees are forced off in pricing/approve).
  // Event (#96): when 'event', seasonal takedown/install wording is swapped for
  // date-driven event wording; otherwise holiday copy is unchanged. Absent ⇒ holiday.
  serviceType?: ServiceType;
};

export function WhatsIncluded({ items, design, palette, renderSettings, serviceType }: WhatsIncludedProps) {
  const isEvent = serviceType === 'event';
  // Permanent Lighting (#88) fix: the satellite trace is captured during the
  // holiday roofline flow, independent of which permanent strands were sold —
  // restrict the drawn/legend groups to the surfaces actually billed on this
  // quote. undefined for holiday/event so their satellite view is unchanged.
  const allowedSatelliteKeys =
    serviceType === 'permanent' ? permanentAllowedSatelliteKeys(items.map((li) => li.id)) : undefined;
  const {
    isItemSelected,
    toggleItem,
    activeName,
    breakdown,
    minimumOrderSubtotal,
    meetsMinimum,
    amountToMinimum,
    currentSubtotal,
    rushSelected,
    takedownSelected,
    rushAmount,
    takedownAmount,
    toggleRush,
    toggleTakedown,
    installTiming,
    toggleInstallTiming,
    septemberDiscountRate,
    octoberDiscountRate,
    hasManualDiscount,
    manualDiscount,
    earlyInstallHidden,
    locked,
  } = useSelection();

  return (
    <section
      aria-labelledby="portal-dark-included-heading"
      className="relative w-full bg-[#121B16] border-y border-[#243029]"
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 md:py-28">
        <div className="max-w-2xl mb-10 md:mb-12">
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            What&apos;s Included
          </p>
          <h2
            id="portal-dark-included-heading"
            className="font-display text-[30px] md:text-[46px] leading-[1.1] font-semibold text-[#F4ECD8] tracking-[-0.01em]"
          >
            Your {activeName} — line by line.
          </h2>
          <p className="mt-4 text-[16px] md:text-[17px] text-[#E0D7C1]/85 leading-[1.65]">
            {locked
              ? "This is your booked quote — here's everything included, line by line."
              : "Toggle anything off to remove it and we'll update your total automatically."}
          </p>
          <p className="mt-3 text-[13px] text-[#A89F87]">Prices shown are before tax.</p>
        </div>

        <ul className={`grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 ${locked ? 'pointer-events-none' : ''}`}>
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
                    'w-full flex items-center gap-4 p-4 md:p-5 rounded-2xl cursor-pointer transition-[background-color,border-color] duration-300 text-left',
                    'border',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8B862] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121B16]',
                    selected
                      ? 'bg-[#1F2A23] border-[#3C4F43]'
                      : 'bg-[#18221C]/70 border-[#243029] hover:border-[#3C4F43]',
                  ].join(' ')}
                >
                  {/* Deselected cue lives on this decorative icon badge only (not
                      the text below it) — audit fix W4-010: a blanket opacity-60
                      on the whole button dropped the label/price/status text
                      under WCAG AA. */}
                  <span
                    aria-hidden
                    className={[
                      'shrink-0 w-11 h-11 rounded-full flex items-center justify-center transition-[background-color,box-shadow,opacity] duration-300',
                      selected
                        ? 'bg-[#E8B862] shadow-[0_0_14px_rgba(232,184,98,0.45)]'
                        : 'bg-[#243029] opacity-60',
                    ].join(' ')}
                  >
                    <Icon className={selected ? 'w-5 h-5 text-[#0B140F]' : 'w-5 h-5 text-[#7B7361]'} aria-hidden />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className={`block font-display text-[17px] md:text-[18px] font-semibold leading-[1.3] tracking-[-0.005em] ${selected ? 'text-[#F4ECD8]' : 'text-[#A89F87]'}`}>
                      {item.label}
                    </span>
                    {/* "Recommended" badge (#12) — replaces the old detail line.
                        Always-rendered block reserves the line so flagging an
                        item recommended doesn't shift layout; text is blank
                        (a non-breaking space) when not recommended. Gold accent
                        matches the selected "Included" badge. */}
                    <span
                      className="block text-[11px] font-semibold tracking-[0.14em] uppercase mt-0.5"
                      style={{ color: '#E8B862' }}
                    >
                      {item.recommended ? 'Recommended' : ' '}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`block font-display text-[18px] font-semibold tabular-nums tracking-[-0.01em] ${selected ? 'text-[#F4ECD8]' : 'text-[#A89F87]'}`}>
                      {formatUsd(item.price)}
                    </span>
                    <span
                      className="block text-[11px] font-semibold tracking-[0.14em] uppercase mt-1"
                      style={{ color: selected ? '#E8B862' : '#A89F87' }}
                    >
                      {selected ? 'Included' : 'Off'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Front (lit) design render (#50) + the satellite roof view (#51).
            When the quote HAS satellite roofline data, show the two side by side
            on DESKTOP (lg+) — the lit "front view" next to the top-down "where
            the lights go" view — both set to the SAME height (var(--row-h)) so
            they look uniform, each width derived from its own aspect (no crop).
            The row breaks OUT wider than the content column so the images span
            the page; on tablet/mobile they stack full-width. Without satellite
            data, the lit render stays full-width on its own. */}
        {design &&
          (!!design.satelliteUrl &&
          selectDrawableLineGroups(design.satelliteLines, allowedSatelliteKeys).length > 0 ? (
            <div
              className="mt-10 md:mt-12 lg:[margin-left:calc(50%_-_50vw)] lg:[margin-right:calc(50%_-_50vw)] lg:overflow-x-clip"
              style={{ ['--row-h']: 'clamp(280px, 42vh, 480px)' } as CSSProperties}
            >
              {/* Outer full-bleeds to the viewport on lg (no transform — keeps it
                  out of the Konva render's stacking concerns); the inner re-centers
                  with mx-auto + a max width, so the pair is centered on the PAGE
                  regardless of the surrounding column. justify-center then centers
                  the two cards within. */}
              <div className="mx-auto flex flex-col gap-8 lg:max-w-[1500px] lg:flex-row lg:items-start lg:justify-center lg:gap-10 lg:px-8">
                <DesignReprise design={design} palette={palette} renderSettings={renderSettings} className="" inRow />
                <SatelliteRoofView design={design} className="" inRow allowedSatelliteKeys={allowedSatelliteKeys} />
              </div>
            </div>
          ) : (
            <DesignReprise design={design} palette={palette} renderSettings={renderSettings} />
          ))}

        {/* Optional add-ons — customer-toggleable rush + premium takedown (#4).
         * Seeded from the staff quote's choice; NEVER changed by picking a
         * package. Toggling either updates the totals + the approval.
         * Event (#96) fix: events never carry rush/takedown (see
         * src/lib/event/packages.ts:10) — hide the toggles so a customer can't
         * add a holiday-only fee to a one-off event (derivePackages.ts also
         * zeroes the charge amounts as defense in depth). */}
        {serviceType !== 'permanent' && !isEvent && (
        <div className={`mt-10 md:mt-12 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Optional add-ons
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            <AddOnToggle
              selected={rushSelected}
              onToggle={toggleRush}
              title="Rush install"
              blurb="Bump your install to the front of the queue."
              amount={rushAmount}
              disabled={installTiming !== 'none'}
              disabledHint="Not available with an early-install discount."
            />
            <AddOnToggle
              selected={takedownSelected}
              onToggle={toggleTakedown}
              title={isEvent ? 'Early takedown' : 'Premium takedown'}
              blurb={
                isEvent
                  ? 'We take everything down after your event, on the date we agreed.'
                  : 'We take everything down before Jan 9 (standard is Jan 9 – Feb 3).'
              }
              amount={takedownAmount}
            />
          </ul>
        </div>
        )}

        {/* Early-install discount (#40) — Sep/Oct roof-light install for a
         * percentage off the order. Mutually exclusive with each other and with
         * rush install. HIDDEN when a staff manual discount is set (one discount
         * per quote — the "Your discount" banner below shows that instead), OR
         * when the global "hide early-install discounts" setting is on (the
         * season has passed — Settings → Customer Portal). */}
        {serviceType !== 'permanent' && !isEvent && !hasManualDiscount && !earlyInstallHidden && (
        <div className={`mt-10 md:mt-12 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
          <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
            Install early &amp; save
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            <DiscountToggle
              selected={installTiming === 'september'}
              disabled={rushSelected}
              onToggle={() => toggleInstallTiming('september')}
              title="September install"
              blurb="We hang your roof lights in mid–late September."
              percentLabel={`${Math.round(septemberDiscountRate * 100)}% off`}
              disabledHint="Not available with rush install."
            />
            <DiscountToggle
              selected={installTiming === 'october'}
              disabled={rushSelected}
              onToggle={() => toggleInstallTiming('october')}
              title="October install"
              blurb="We hang your roof lights anytime in October."
              percentLabel={`${Math.round(octoberDiscountRate * 100)}% off`}
              disabledHint="Not available with rush install."
            />
          </ul>
          <p className="mt-3 text-[13px] text-[#A89F87] leading-[1.6] max-w-2xl">
            <span className="text-[#E0D7C1] font-semibold">What early install means:</span> we put up your{' '}
            <span className="text-[#E0D7C1]">roof lights only</span>{' '}in mid–late September or anytime in October —
            {isEvent
              ? ' everything else is installed before your event and removed after.'
              : ' everything else (wreaths, garland, trees, columns, railings, spritzers) still goes up in November.'}{' '}
            Your lights stay off until you&apos;re ready to turn them on. Pick a month and that&apos;s when we install — the
            discount requires the install to happen that month.
          </p>
        </div>
        )}

        {/* Staff manual discount — when set, the early-install picker is hidden
         * and the customer sees their discount here + in the price tie-out
         * below. One discount per quote. */}
        {hasManualDiscount && manualDiscount && breakdown.discount > 0 && (
          <div className="mt-10 md:mt-12">
            <p className="text-[11px] md:text-[12px] font-semibold tracking-[0.18em] uppercase text-[#E8B862] mb-3">
              Your discount
            </p>
            <div className="rounded-2xl border border-[#E8B862]/40 bg-[#1B1409] p-4 md:p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-[#F4ECD8] font-semibold text-[17px] md:text-[19px]">
                  {/* Flat label uses the APPLIED amount (breakdown.discount) so it can
                      never disagree with the figure beside it when the flat discount
                      exceeds the live subtotal (priceSelection caps it). */}
                  {manualDiscount.rate > 0
                    ? `${Math.round(manualDiscount.rate * 100)}% off`
                    : `${formatUsd(breakdown.discount)} off`}{' '}applied
                </p>
                <p className="text-[13px] text-[#A89F87] mt-1 leading-[1.6]">
                  A special discount on your quote — already reflected in your total below.
                </p>
              </div>
              <span className="text-[#E8B862] font-display font-semibold text-[20px] md:text-[24px] tabular-nums whitespace-nowrap">
                −{formatUsd(breakdown.discount)}
              </span>
            </div>
          </div>
        )}

        {/* Totals — ties the line items above out to the all-in price:
         * Subtotal (+ any per-job fees) + tax = Total, with the 50% deposit
         * due today. No silent $1,000 floor; the minimum is a gate enforced
         * on the Approve button (status line below). */}
        <div className="mt-8 md:mt-10 ml-auto w-full max-w-sm rounded-2xl bg-[#18221C] border border-[#243029] p-5 md:p-6">
          <dl className="space-y-2.5 text-[14px] md:text-[15px]">
            <div className="flex justify-between text-[#A89F87]">
              <dt>Subtotal</dt>
              <dd className="tabular-nums text-[#E0D7C1]">{formatUsd(breakdown.subtotal)}</dd>
            </div>
            {breakdown.discount > 0 && (
              <div className="flex justify-between text-[#86C9A0]">
                <dt>
                  {hasManualDiscount
                    ? 'Discount'
                    : `${installTiming === 'september' ? 'September' : 'October'} install discount`}
                </dt>
                <dd className="tabular-nums">−{formatUsd(breakdown.discount)}</dd>
              </div>
            )}
            {breakdown.rushFee > 0 && (
              <div className="flex justify-between text-[#A89F87]">
                <dt>Rush fee</dt>
                <dd className="tabular-nums text-[#E0D7C1]">{formatUsd(breakdown.rushFee)}</dd>
              </div>
            )}
            {breakdown.takedown > 0 && (
              <div className="flex justify-between text-[#A89F87]">
                <dt>Premium takedown</dt>
                <dd className="tabular-nums text-[#E0D7C1]">{formatUsd(breakdown.takedown)}</dd>
              </div>
            )}
            <div className="flex justify-between text-[#A89F87]">
              <dt>Tax</dt>
              <dd className="tabular-nums text-[#E0D7C1]">{formatUsd(breakdown.tax)}</dd>
            </div>
            <div className="flex justify-between pt-2.5 border-t border-[#243029]">
              <dt className="font-display font-semibold text-[#F4ECD8]">Total</dt>
              <dd className="font-display font-semibold tabular-nums text-[#F4ECD8]">{formatUsd(breakdown.total)}</dd>
            </div>
            <div className="flex justify-between text-[13px]">
              <dt className="text-[#A89F87]">Deposit (50%)</dt>
              <dd className="tabular-nums text-[#E8B862]">{formatUsd(breakdown.deposit)}</dd>
            </div>
          </dl>
          {minimumOrderSubtotal > 0 && !meetsMinimum && (
            <p className="mt-4 border-t border-[#243029] pt-3 text-[13px] text-[#E8B862]">
              {/* "season minimum" is holiday-only copy. Permanent (year-round) and
                  event (date-driven) are not seasonal → neutral "minimum". Only
                  holiday/undefined keeps "season minimum". */}
              {serviceType === 'permanent' || serviceType === 'event'
                ? currentSubtotal <= 0
                  ? `Our minimum is ${formatUsd(minimumOrderSubtotal)}. Select items to continue.`
                  : `Our minimum is ${formatUsd(minimumOrderSubtotal)} — add ${formatUsd(amountToMinimum)} more to approve.`
                : currentSubtotal <= 0
                  ? `Our season minimum is ${formatUsd(minimumOrderSubtotal)}. Select items to continue.`
                  : `Our season minimum is ${formatUsd(minimumOrderSubtotal)} — add ${formatUsd(amountToMinimum)} more to approve.`}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
