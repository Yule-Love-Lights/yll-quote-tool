export function KpiCard({
  label,
  value,
  sub,
  prominent = false,
  wideBelowXl = false,
}: {
  label: string;
  value: string;
  sub?: string;
  prominent?: boolean;
  /** Takes two columns below xl and one at xl. The KPI strip is 4 columns
   *  below xl and 7 at xl, and its two prominent cards already take two each;
   *  one card has to widen below xl for the total to divide evenly, or the
   *  last row is left one column short and reads as a missing card. */
  wideBelowXl?: boolean;
}) {
  const span = prominent ? 'md:col-span-2' : wideBelowXl ? 'md:col-span-2 xl:col-span-1' : '';
  return (
    <div
      className={`rounded-lg border p-4 ${span}`}
      style={{
        background: 'var(--op-bg-raised)',
        borderColor: prominent ? 'var(--brand-gold)' : 'var(--op-border)',
      }}
    >
      <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>
        {label}
      </div>
      <div
        className={`mt-1 font-semibold tabular-nums ${prominent ? 'text-4xl' : 'text-2xl'}`}
        style={{ color: 'var(--op-text)' }}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1 text-xs" style={{ color: 'var(--op-text-dim)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}
