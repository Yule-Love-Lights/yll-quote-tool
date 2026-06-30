import type { InvoiceStatus } from '@/lib/invoiceStatus';

// The "Charge remaining balance" operator action (ledger #83). DISABLED until the
// Valor card-on-file (Direct Sale - Token) capability is confirmed + wired — see
// docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md. Renders nothing when there is no
// balance to collect (paid / zero balance). Shared by the job + invoice detail.
export function BalanceChargeButton({ balance, status }: { balance: number; status: InvoiceStatus }) {
  if (status === 'paid' || status === 'cancelled' || balance <= 0) return null;
  return (
    <div className="mt-3">
      <button
        type="button"
        disabled
        title="Charge remaining balance — pending Valor auto-charge setup (docs/jobber-flow/VALOR-AUTOCHARGE-FOR-JASON.md)"
        className="rounded-md px-3 py-1.5 text-sm font-semibold text-white bg-gray-400 cursor-not-allowed"
      >
        Charge remaining balance
      </button>
      <p className="text-xs text-gray-500 mt-1">
        Charging the saved card is pending Valor confirmation (Jason). Until then, collect the balance
        manually.
      </p>
    </div>
  );
}
