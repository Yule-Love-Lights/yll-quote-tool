// Customer profile referral panel (ledger #41, PR 2). Server component:
// resolves the referrer's link + history + photo opt-out server-side (same
// data path as the portal's booked-page referral section) and renders a card
// matching the rest of src/app/customers/[contactId]/page.tsx.
//
// customerId is the STABLE customer_id the profile page already resolves
// from the customer's quotes (see the "Rebook last season" resolution there)
// — reused as-is, not re-derived here. A pure-CRM contact with no quotes has
// no customer_id yet, so this renders a graceful empty state with no code
// and no fetches.

import type { ReferralSource, ReferralStatus } from '@/lib/referrals';
import { ensureReferralCode, listReferralsFor, getReferralPhotoOptout } from '@/lib/referrals';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { CustomerReferralLinkCopy } from './CustomerReferralLinkCopy';
import { CustomerReferralPhotoToggle } from './CustomerReferralPhotoToggle';

function fmtMoney(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const SOURCE_LABEL: Record<ReferralSource, string> = { link: 'Link', mention: 'Mention' };

// Mirrors CustomerStatusBadge's palette conventions (gold/evergreen/gray) so
// this reads as the same visual language as the quote-status pills above it.
const STATUS_STYLE: Record<ReferralStatus, { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending', bg: 'var(--brand-gold)', fg: 'var(--brand-evergreen)' },
  booked: { label: 'Booked', bg: '#047857', fg: 'var(--brand-cream)' },
  credited: { label: 'Credited', bg: '#6b7280', fg: 'var(--brand-cream)' },
};

function ReferralStatusPill({ status }: { status: ReferralStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

export async function CustomerReferralPanel({ customerId }: { customerId: string | null }) {
  if (!customerId) {
    return (
      <section
        className="rounded-lg border mt-6"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Referrals</h2>
        <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>
          No referral activity yet.
        </div>
      </section>
    );
  }

  const [referralCode, { items, summary }, photoOptout] = await Promise.all([
    ensureReferralCode(customerId),
    listReferralsFor(customerId),
    getReferralPhotoOptout(customerId),
  ]);
  const referralLink = referralCode ? `${appBaseUrl()}/refer/${referralCode}` : null;

  return (
    <section
      className="rounded-lg border mt-6"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Referrals</h2>

      <div className="px-4 pb-4 flex flex-col gap-4">
        <div>
          <p className="text-xs mb-2" style={{ color: 'var(--op-text-dim)' }}>Their personal referral link</p>
          {referralLink ? (
            <CustomerReferralLinkCopy link={referralLink} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>No referral link yet.</p>
          )}
        </div>

        <p className="text-sm" style={{ color: 'var(--op-text)' }}>
          <span className="font-semibold">{fmtMoney(summary.spendableUsd)}</span> spendable credit
          <span style={{ color: 'var(--op-text-dim)' }}> · {fmtMoney(summary.lifetimeEarnedUsd)} lifetime earned</span>
          <span style={{ color: 'var(--op-text-dim)' }}>
            {' '}· {summary.pendingCount} pending · {summary.bookedCount} booked · {summary.creditedCount} credited
          </span>
        </p>

        <CustomerReferralPhotoToggle customerId={customerId} initialOptout={photoOptout} />
      </div>

      {items.length === 0 ? (
        <div
          className="p-6 text-sm text-center border-t"
          style={{ color: 'var(--op-text-dim)', borderColor: 'var(--op-border)' }}
        >
          No referrals yet.
        </div>
      ) : (
        <div className="overflow-x-auto border-t" style={{ borderColor: 'var(--op-border)' }}>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Friend</th>
                <th className="text-left px-3 py-2 font-semibold">Source</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Date</th>
                <th className="text-right px-3 py-2 font-semibold">Credit</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const date = item.status === 'credited' ? item.creditedAt
                  : item.status === 'booked' ? item.bookedAt
                  : item.createdAt;
                return (
                  <tr key={item.id} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                    <td className="px-4 py-2.5" style={{ color: 'var(--op-text)' }}>{item.displayName}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--op-text-2)' }}>{SOURCE_LABEL[item.source]}</td>
                    <td className="px-3 py-2.5"><ReferralStatusPill status={item.status} /></td>
                    <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>
                      {date ? fmtDate(date) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>
                      {fmtMoney(item.amountUsd)}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {item.status === 'credited' && item.creditedQuoteId && (
                        <a
                          href={`/quote/${item.creditedQuoteId}`}
                          className="text-xs hover:underline"
                          style={{ color: 'var(--op-primary)' }}
                        >
                          Spent on quote
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
