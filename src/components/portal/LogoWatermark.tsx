// Brand watermark overlay (#45). A subtle Yule Love Lights logo in the corner of
// the customer-facing design renders, so every house image we show carries our
// branding.
//
// App-layer DOM overlay — it is NOT drawn into the Konva render, so there is no
// shared editor-core change and no relay to the design tool. It sits OUTSIDE the
// `.portal-snow-stage-photo` element on purpose, so the per-package brightness
// filter + scale transition never dim or wobble the brand mark.
//
// Placement note (#45): Jason asked for TOP-LEFT, but the #61 hero heading
// ("Here's your home, {name}") now lives top-left and would collide — so the
// default is TOP-RIGHT (a clean corner). Everything here is a render-time tunable
// (corner, size, opacity) — adjust the constants and eyeball the preview.

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
        'pointer-events-none select-none absolute z-20 top-[3%] right-[3%] ' +
        // Size (Naldo S13): ~2× bigger on desktop, ~+30% on mobile vs the first
        // pass. % of the photo box, clamped so it never gets tiny on phones or
        // huge on ultra-wide. ≈84–90px on a phone, ≈290–340px on a desktop hero.
        'h-auto w-[23%] min-w-[84px] max-w-[340px] ' +
        className
      }
      style={{ opacity: 0.22, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }}
    />
  );
}
