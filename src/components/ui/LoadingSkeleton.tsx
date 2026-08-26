// Row 410 — the row 346 / #171b loading-skeleton idiom, factored out.
//
// The defect these fix: a panel renders one bare "Loading…" line, then swaps it
// for a full table/list, so the whole page jumps once the fetch lands. Row 346
// fixed six surfaces by hand-shaping a skeleton at each one; row 410 found ~11
// more, which is enough repetition to be worth one place. Same visual language
// as the hand-shaped ones (animate-pulse bars at black/10, `role="status"` +
// `aria-busy`, the original text kept for screen readers) so the two generations
// look identical on screen.
//
// The heights are PROPS on purpose: a skeleton shorter than the content it
// stands in for just relocates the jump instead of removing it (the staff-lens
// finding on row 346's own fix round), so each caller passes the real row
// height of the list it is covering.

export function SkeletonBar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-black/10 ${className}`} />;
}

export function SkeletonRows({
  label,
  rows = 3,
  rowClassName = 'h-11',
  className = 'flex flex-col gap-2',
}: {
  /** The text the bare line used to show — kept for screen readers. */
  label: string;
  rows?: number;
  /** Height (and any width) of one placeholder row, matching the real one. */
  rowClassName?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonBar key={i} className={rowClassName} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
