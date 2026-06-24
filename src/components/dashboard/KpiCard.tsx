export function KpiCard({
  label,
  value,
  sub,
  prominent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  prominent?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${prominent ? 'md:col-span-2' : ''}`}
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
