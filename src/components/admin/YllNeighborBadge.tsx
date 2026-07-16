// Shared "YLL Neighbor" pill (#158) — flags a legacy_rebook=true quote (migrated
// from last year's Jobber data, migrations/2026-07-16-legacy-rebook.sql).
// Internal/staff surfaces ONLY (quotes list, quote detail, quote builder) — the
// customer-facing portal never shows this. Mirrors JobStatusBadge's pill style;
// sky is distinct from the Test badge (violet) and every status/service-type
// color already in use elsewhere in the admin UI.
export function YllNeighborBadge() {
  return (
    <span
      title="Migrated from last year's data — a YLL Neighbor rebook"
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-700"
    >
      YLL Neighbor
    </span>
  );
}
