// Portal v2 DARK — Disclaimer. Small muted text at the bottom.
// Includes a spacer div so the sticky bar never covers it.

export function Disclaimer() {
  return (
    <section
      className="relative w-full bg-[#0B140F] border-t border-[#243029]"
      aria-label="Important disclaimer"
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12">
        <p className="text-[12px] leading-[1.65] text-[#7B7361] text-center max-w-[65ch] mx-auto">
          Quote based on current satellite imagery. If your property has changed since this photo, material quantities may differ slightly. Your installer will confirm everything on-site before installation.
        </p>
      </div>
      {/* Spacer so the sticky bar doesn't cover the disclaimer on
       * short viewports. Matches the sticky bar's compact height. */}
      <div aria-hidden className="h-20 md:h-24" />
    </section>
  );
}
