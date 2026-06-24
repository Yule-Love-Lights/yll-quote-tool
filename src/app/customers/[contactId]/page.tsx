import Link from 'next/link';
import { notFound } from 'next/navigation';
import { listQuotesForDashboard } from '@/lib/dashboard/queries';
import { statusOf } from '@/lib/dashboard/customers';
import { OperatorShell } from '@/components/OperatorShell';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';
import { getContact, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import type { CrmContact } from '@/lib/integrations/types';
import type { DashboardQuote } from '@/lib/dashboard/types';

export const dynamic = 'force-dynamic';

function fmtMoney(n: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** HighLevel app URL for a contact, built from the location id. Null if the
 *  location id isn't configured. (locationId is not a secret — it's in HL URLs.) */
function highLevelContactUrl(contactId: string): string | null {
  const loc = process.env.HIGHLEVEL_LOCATION_ID;
  if (!loc) return null;
  return `https://app.gohighlevel.com/v2/location/${loc}/contacts/detail/${encodeURIComponent(contactId)}`;
}

function fieldList(contact: CrmContact): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string }> = [];
  if (contact.email) fields.push({ label: 'Email', value: contact.email });
  if (contact.phone) fields.push({ label: 'Phone', value: contact.phone });
  const addr = [contact.address1, contact.city, contact.state, contact.postalCode].filter(Boolean).join(', ');
  if (addr) fields.push({ label: 'Address', value: addr });
  return fields;
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ contactId: string }>;
}) {
  const { contactId } = await params;
  if (!contactId || contactId.length > 200) notFound();

  // This customer's quotes (filtered from the same source the list uses).
  const quotes: DashboardQuote[] = (await listQuotesForDashboard(500)).filter(
    q => q.highlevel_contact_id === contactId,
  );

  // Live HighLevel record. Best-effort — a CRM hiccup must not 404 a customer
  // who has quotes here.
  let contact: CrmContact | null = null;
  let hlError: string | null = null;
  if (isHighLevelConfigured()) {
    try {
      contact = await getContact(contactId);
    } catch {
      hlError = 'HighLevel is configured but this contact could not be loaded.';
    }
  } else {
    hlError = 'HighLevel is not configured in this environment.';
  }

  // Nothing here at all → the id is bogus.
  if (!contact && quotes.length === 0) notFound();

  const name =
    contact?.fullName?.trim() ||
    quotes.find(q => q.customer_name?.trim())?.customer_name?.trim() ||
    'Customer';
  const hlUrl = highLevelContactUrl(contactId);
  const bookedSpend = quotes
    .filter(q => q.customer_approved_at)
    .reduce((sum, q) => sum + (q.total ?? 0), 0);

  return (
    <OperatorShell active="customers">
      <div className="max-w-4xl mx-auto w-full">
        <Link href="/customers" className="text-xs hover:underline" style={{ color: 'var(--op-text-dim)' }}>
          ← All customers
        </Link>

        <header className="mt-2 mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Customer
            </p>
            <h1 className="text-3xl font-semibold" style={{ color: 'var(--op-text)' }}>{name}</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
              {quotes.length} quote{quotes.length === 1 ? '' : 's'} · {fmtMoney(bookedSpend)} booked
            </p>
          </div>
          {hlUrl && (
            <a
              href={hlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm"
              style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              View in HighLevel ↗
            </a>
          )}
        </header>

        {/* Live HighLevel panel */}
        <section
          className="rounded-lg border p-4 mb-6"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--op-text)' }}>Contact (live from HighLevel)</h2>
          {contact ? (
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {fieldList(contact).map(f => (
                <div key={f.label}>
                  <dt className="text-xs uppercase tracking-wide" style={{ color: 'var(--op-text-dim)' }}>{f.label}</dt>
                  <dd className="mt-0.5 text-sm break-words" style={{ color: 'var(--op-text)' }}>{f.value}</dd>
                </div>
              ))}
              {fieldList(contact).length === 0 && (
                <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>No contact fields on file.</p>
              )}
            </dl>
          ) : (
            <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
              {hlError ?? 'Contact not available.'}
              {hlUrl ? ' Use “View in HighLevel” for the full profile.' : ''}
            </p>
          )}
        </section>

        {/* Quote history (this tool's data) */}
        <section
          className="rounded-lg border"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Quote history</h2>
          {quotes.length === 0 ? (
            <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>No quotes for this customer.</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Created</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-right px-3 py-2 font-semibold">Total</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {quotes
                  .slice()
                  .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
                  .map(q => (
                    <tr key={q.id} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>{fmtDate(q.created_at)}</td>
                      <td className="px-3 py-2.5"><CustomerStatusBadge status={statusOf(q)} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(q.total)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Link href={`/quote/${q.id}`} className="text-xs hover:underline" style={{ color: 'var(--op-primary)' }}>Open</Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            </div>
          )}
        </section>
      </div>
    </OperatorShell>
  );
}
