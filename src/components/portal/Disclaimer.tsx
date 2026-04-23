// Small legal disclaimer at the very bottom of the page. Intentionally
// quiet — cream background, ink-500 text, centered max-65ch.

export function Disclaimer() {
  return (
    <section className="w-full bg-[#F3EDE1]" aria-label="Important disclaimer">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 md:py-12">
        <p className="text-[12px] leading-[1.55] text-[#6B5F52] text-center max-w-[65ch] mx-auto">
          Quote based on current satellite imagery. If your property has changed since this photo, material quantities may differ slightly. Your installer will confirm everything on-site before installation.
        </p>
      </div>
      {/* Spacer so the sticky bar doesn't cover the disclaimer on short
       * viewports. Height matches the sticky bar's compact state. */}
      <div aria-hidden className="h-20 md:h-24" />
    </section>
  );
}
