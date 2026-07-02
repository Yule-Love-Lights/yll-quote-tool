import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getOperator } from '@/lib/auth/supabaseServer';
import { listQuotesForDashboard, getViewEventsForQuotes } from '@/lib/dashboard/queries';
import { buildCustomerActivity } from '@/lib/dashboard/activity';
import { statusOf, matchesCustomerRoute } from '@/lib/dashboard/customers';
import { OperatorShell } from '@/components/OperatorShell';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';
import { CustomerActivityFeed } from '@/components/dashboard/CustomerActivityFeed';
import { PipelineActionsMenuRefresh } from '@/components/admin/PipelineActionsMenuRefresh';
import { RebookButton } from '@/components/dashboard/RebookButton';
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
  // Defense in depth behind the middleware perimeter — re-check at render so this
  // customer-PII surface never serves anonymously even if the perimeter is
  // bypassed. Dormant until the auth gate is live (Slice 4).
  if (process.env.AUTH_GATE_ENABLED === 'true' && !(await getOperator())) {
    redirect('/login?from=/customers');
  }
  // The route id is either a HighLevel contact id (CRM-linked customers) or a
  // stable customer_id (backfilled non-CRM customers) — see customerRouteId.
  const { contactId: routeId } = await params;
  if (!routeId || routeId.length > 200) notFound();

  // This customer's quotes (filtered from the same source the list uses), matched
  // by EITHER id kind so a non-CRM customer resolves via their customer_id.
  const quotes: DashboardQuote[] = (await listQuotesForDashboard(500)).filter(
    q => matchesCustomerRoute(q, routeId),
  );

  // The HighLevel contact id for this customer, if any of their quotes carry one.
  // When the route id IS a HL id this is just that id; when the route id is a
  // customer_id, this recovers the HL link (if the customer also has one) so the
  // live panel + "View in HighLevel" still work.
  const hlContactId: string | null =
    quotes.find(q => q.highlevel_contact_id)?.highlevel_contact_id ?? null;

  // Activity feed: per-view events (best-effort — a missing quote_view_events
  // table never breaks the page) merged with each quote's lifecycle timestamps.
  const viewEvents = await getViewEventsForQuotes(quotes.map(q => q.id));
  const activity = buildCustomerActivity(quotes, viewEvents);

  // Live HighLevel record. Best-effort — a CRM hiccup must not 404 a customer
  // who has quotes here. Only attempted when this customer actually has a HL
  // contact id; a non-CRM customer simply shows their quote history.
  let contact: CrmContact | null = null;
  let hlError: string | null = null;
  if (!hlContactId) {
    hlError = 'This customer is not linked to HighLevel.';
  } else if (isHighLevelConfigured()) {
    try {
      contact = await getContact(hlContactId);
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
  const hlUrl = hlContactId ? highLevelContactUrl(hlContactId) : null;
  const bookedSpend = quotes
    .filter(q => q.customer_approved_at)
    .reduce((sum, q) => sum + (q.total ?? 0), 0);

  // Resolve the stable customer_id for the "Rebook last season" button (Part D).
  // Any quote's customer_id works — they all map to the same customer row after
  // backfill. If none is populated yet (pre-backfill), the button is hidden.
  const customerId: string | null =
    quotes.find(q => q.customer_id)?.customer_id ?? null;

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
          <div className="shrink-0 flex items-center gap-2">
            {/* Rebook last season (Part D): hidden until the backfill populates customer_id. */}
            {customerId && <RebookButton customerId={customerId} />}
            {hlUrl && (
              <a
                href={hlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm"
                style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
              >
                View in HighLevel ↗
              </a>
            )}
          </div>
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
                  <th className="text-left px-3 py-2 font-semibold">Quote</th>
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
                      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }} title={`Quote ID: ${q.id}`}>{q.id.slice(0, 8)}</td>
                      <td className="px-3 py-2.5"><CustomerStatusBadge status={statusOf(q)} /></td>
                      <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(q.total)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <Link href={`/quote/${q.id}`} className="text-xs hover:underline mr-2" style={{ color: 'var(--op-primary)' }}>Open</Link>
                        <PipelineActionsMenuRefresh quoteId={q.id} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            </div>
          )}
        </section>

        {/* Activity timeline: every customer view + each quote's lifecycle. */}
        <CustomerActivityFeed events={activity} />
      </div>
    </OperatorShell>
  );
}
