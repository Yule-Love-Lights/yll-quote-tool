// Brand watermark overlay (#45). A subtle Yule Love Lights logo in the corner of
// the customer-facing design renders, so every house image we show carries our
// branding.
//
// App-layer DOM overlay — it is NOT drawn into the Konva render, so there is no
// shared editor-core change and no relay to the design tool. It sits OUTSIDE the
// `.portal-snow-stage-photo` element on purpose, so the per-package brightness
// filter + scale transition never dim or wobble the brand mark.
//
// Placement (#45): mobile = TOP-RIGHT (clean on phones); desktop = TOP-LEFT
// (Naldo's call from the preview — matches Jason's original note). The #61 hero
// heading ("Here's your home, {name}") also sits top-left on desktop, so the
// mark shares that zone; nudge top/left or z-index if it ever crowds the text.
// Render-time tunables (corner, size, opacity) — adjust + eyeball the preview.

const WATERMARK_SRC = '/yule-site-logo-2.png';

type Props = {
  /** Extra classes to nudge position/size per surface if ever needed. */
  className?: string;
};

export function LogoWatermark({ className = '' }: Props) {
  return (
    // Decorative branding → empty alt + aria-hidden. pointer-events-none so it
    // never intercepts taps/clicks on the design beneath it.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={WATERMARK_SRC}
      alt=""
      aria-hidden
      draggable={false}
      className={
        // Mobile = top-right; desktop = top-left (Naldo S13, from the preview).
        'pointer-events-none select-none absolute z-20 top-[3%] right-[3%] md:left-[3%] md:right-auto ' +
        // Size (Naldo S13): mobile kept at the +30% pass (≈84–90px on a phone);
        // desktop dialed back ~30% smaller via the md override (≈205–240px on a
        // desktop hero, was ≈290–340px). % of the photo box, clamped both ends.
        'h-auto w-[23%] min-w-[84px] max-w-[340px] md:w-[16%] md:max-w-[240px] ' +
        className
      }
      style={{ opacity: 0.22, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }}
    />
  );
}
