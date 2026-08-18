// naldo/referral-self-serve: the "One of our real Long Island installs"
// label shown over the referral page's hero ONLY when it is falling back to
// a gallery photo (a stranger's completed job), never over the referrer's
// own approved design. Extracted as its own small pure-render component so
// this conditional is unit tested directly (see ReferralHeroBadge.test.tsx),
// the same approach ReferralSuccessScreen in ./ReferralForm.tsx already
// uses for this page's other verbatim copy.
//
// Review fix 7: positioned top-left, not bottom-left. page.tsx's headline
// block is pulled up over the hero with a negative margin, and at narrow
// widths a wrapped headline can land in the same band a bottom badge would
// occupy. No device check is available, so this is a structural fix: the
// top of the hero is never in that overlap zone. The gradient in page.tsx is
// darkest at the BOTTOM (bg-gradient-to-t), so the badge's own pill
// background is bumped to bg-black/60 here (up from /30) to carry its own
// contrast on a bright sky photo, rather than leaning on the gradient.

export function ReferralHeroBadge({ kind }: { kind: 'design' | 'photo' }) {
  if (kind !== 'photo') return null;
  return (
    <p className="absolute left-4 top-4 md:left-6 md:top-6 text-[12px] font-semibold text-[#F4ECD8]/90 bg-black/60 backdrop-blur-sm px-3 py-1.5 rounded-full">
      One of our real Long Island installs
    </p>
  );
}
