// Row 444 — a quote whose money came from the retired home.works CRM.
//
// Those 20 orders carry the figures the customer actually agreed and paid,
// copied verbatim, and this app's pricing engine cannot reproduce them: it
// disagrees with the charged tax on 8 of the 14 Homeworks invoices (per-line
// rounding, two rates on one invoice, one rate absent from the document). So the
// quote refuses to re-price, and this is the only thing on the screen that
// explains why. Without it, a staffer clicking Calculate gets a flat refusal
// with no visible reason — which is how a correct guard reads as a broken app.

export function MigratedBadge() {
  return (
    <span
      title="Migrated from home.works. The totals, tax and deposit are what the customer actually agreed and paid — this tool did not calculate them and cannot re-price this order."
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-200 text-slate-700"
    >
      Migrated
    </span>
  );
}
