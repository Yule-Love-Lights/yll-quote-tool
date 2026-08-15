// Shared "NCE" pill (#198) — flags an is_nce=true quote/customer. NCE = the
// barter/trade network YLL belongs to; the money behaviors this tag drives
// (40% deposit default, balance-collection blocks, invoice mark-paid-NCE) are
// ledger #199, layered on top of this tag separately. Internal/staff surfaces
// ONLY (quotes list, quote detail, quote builder, customer profile/list) —
// mirrors YllNeighborBadge's placement + styling convention exactly. Rose is
// distinct from every status/service-type/other-tag color already in use.
export function NceBadge() {
  return (
    <span
      title="NCE — barter/trade network customer"
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-100 text-rose-700"
    >
      NCE
    </span>
  );
}
