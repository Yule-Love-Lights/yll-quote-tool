import type { ReferralRow, ReferralStatus } from '@/lib/referrals';
import { QrSvg } from '@/components/QrSvg';

// Referral program growth feature 2 (ledger #41 growth) — operator-facing
// profile panel on a customer's detail page. Pure/presentational (data is
// fetched by the page, same convention as every other dashboard component)
// so a customer with no referral activity yet still gets a clear, honest
// empty state instead of a missing section. Read-only: no mutation controls
// here, matching the panel's scope (display only).

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_LABEL: Record<ReferralStatus, string> = {
  pending: 'Pending',
  booked: 'Booked',
  credited: 'Credited',
};

const STATUS_DOT: Record<ReferralStatus, string> = {
  pending: 'var(--brand-gold)',
  booked: 'var(--brand-evergreen)',
  credited: 'var(--op-text-dim)',
};

function refereeLabel(row: ReferralRow): string {
  return row.referee_contact_name?.trim() || row.referee_contact_email?.trim() || row.referee_contact_phone?.trim() || 'Unnamed referral';
}

export function CustomerReferralPanel({
  referralLink,
  creditBalanceUsd,
  referrals,
  qrSvg,
}: {
  /** This customer's personal /refer/<code> link, or null when no referral
   *  code could be resolved (Supabase unconfigured, or the customer row is
   *  missing) — the panel then shows an explanatory empty state. */
  referralLink: string | null;
  /** Spendable balance: booked-but-not-yet-credited referrals (creditBalanceFor). */
  creditBalanceUsd: number;
  /** Every referral this customer has generated as the referrer, newest first. */
  referrals: ReferralRow[];
  /** Server-generated inline QR SVG for `referralLink` (null when unavailable
   *  — fail-open, the link text below still works for a manual copy). */
  qrSvg: string | null;
}) {
  return (
    <section
      aria-label="Referral program"
      className="rounded-lg border p-4 mb-6"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--op-text)' }}>Referral program</h2>
        {referralLink && (
          <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
            {fmtMoney(creditBalanceUsd)} credit balance
          </span>
        )}
      </div>

      {!referralLink ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
          No referral link yet for this customer.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-4 mb-4">
          {qrSvg && (
            <div className="flex flex-col items-center gap-1.5">
              <QrSvg svg={qrSvg} className="w-32 h-32" />
              <p className="text-[11px] text-center max-w-[140px]" style={{ color: 'var(--op-text-dim)' }}>
                Print for a yard sign or door hanger
              </p>
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide mb-1" style={{ color: 'var(--op-text-dim)' }}>
              Personal link
            </p>
            <p className="text-sm font-mono break-all" style={{ color: 'var(--op-text)' }}>
              {referralLink}
            </p>
          </div>
        </div>
      )}

      <p className="text-xs uppercase tracking-wide mb-2" style={{ color: 'var(--op-text-dim)' }}>
        Referred friends {referrals.length > 0 ? `(${referrals.length})` : ''}
      </p>
      {referrals.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
          This customer hasn&apos;t referred anyone yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {referrals.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ background: STATUS_DOT[r.status] }}
                />
                <span className="truncate" style={{ color: 'var(--op-text-2)' }}>{refereeLabel(r)}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{fmtDate(r.created_at)}</span>
                <span className="text-xs font-medium" style={{ color: 'var(--op-text)' }}>
                  {STATUS_LABEL[r.status]}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
