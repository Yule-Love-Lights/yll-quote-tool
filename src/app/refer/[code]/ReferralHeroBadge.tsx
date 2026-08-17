// naldo/referral-self-serve: the "One of our real Long Island installs"
// label shown over the referral page's hero ONLY when it is falling back to
// a gallery photo (a stranger's completed job), never over the referrer's
// own approved design. Extracted as its own small pure-render component so
// this conditional is unit tested directly (see ReferralHeroBadge.test.tsx),
// the same approach ReferralSuccessScreen in ./ReferralForm.tsx already
// uses for this page's other verbatim copy.

export function ReferralHeroBadge({ kind }: { kind: 'design' | 'photo' }) {
  if (kind !== 'photo') return null;
  return (
    <p className="absolute left-4 bottom-4 md:left-6 md:bottom-6 text-[12px] font-semibold text-[#F4ECD8]/90 bg-black/30 backdrop-blur-sm px-3 py-1.5 rounded-full">
      One of our real Long Island installs
    </p>
  );
}
