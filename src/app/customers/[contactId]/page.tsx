import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { authGateEngaged, getOperator } from '@/lib/auth/supabaseServer';
import { listQuotesForDashboard, getViewEventsForQuotes } from '@/lib/dashboard/queries';
import { buildCustomerActivity } from '@/lib/dashboard/activity';
import { statusOf, matchesCustomerRoute } from '@/lib/dashboard/customers';
import { OperatorShell } from '@/components/OperatorShell';
import { CustomerStatusBadge } from '@/components/dashboard/CustomerStatusBadge';
import { CustomerActivityFeed } from '@/components/dashboard/CustomerActivityFeed';
import { CustomerReferralPanel } from '@/components/dashboard/CustomerReferralPanel';
import { PipelineActionsMenuRefresh } from '@/components/admin/PipelineActionsMenuRefresh';
import { RebookButton } from '@/components/dashboard/RebookButton';
import { CustomerTenureEditor } from '@/components/dashboard/CustomerTenureEditor';
import { CustomerTagsEditor } from '@/components/dashboard/CustomerTagsEditor';
import { CustomerPropertiesPanel } from '@/components/dashboard/CustomerPropertiesPanel';
import { getPropertiesForCustomer, getCustomer } from '@/lib/customers';
import { getCustomerTenure, tenureHeaderLabel } from '@/lib/customerTenure';
import { getContact, isHighLevelConfigured } from '@/lib/integrations/highlevel';
import type { CrmContact } from '@/lib/integrations/types';
import type { DashboardQuote } from '@/lib/dashboard/types';
import { listJobsForCustomer } from '@/lib/jobs';
import { listInvoicesForCustomer } from '@/lib/invoices';
import { JobStatusBadge } from '@/components/admin/JobStatusBadge';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';

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
  // bypassed. Engaged by default; dormant only on the explicit
  // AUTH_GATE_ENABLED=false opt-out (ledger #347).
  if (authGateEngaged() && !(await getOperator())) {
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

  // This customer's jobs + invoices (billing side, ledger #83): matched by EITHER
  // the resolved customer_id OR belonging to one of the quotes already shown
  // above — the second leg covers legacy rows whose customer_id is still null.
  const quoteIds = quotes.map(q => q.id);
  const jobs = await listJobsForCustomer(customerId, quoteIds);
  const invoices = await listInvoicesForCustomer(customerId, quoteIds);

  // Property-aware rebook (WT-53): resolve this customer's properties server-side
  // so RebookButton can scope the clone to a KNOWN building instead of falling
  // back to a system-wide "most recently approved" guess when a customer has
  // more than one property.
  //
  // #205: fetched ONCE with includeArchived:true (the full set) so the new
  // Properties panel below can toggle "Show archived" client-side without a
  // second round trip.
  //
  // #205 review fix (customer/staff HIGH, F1): rebookProperties now passes
  // ALL properties (archived included) to RebookButton, NOT a live-only
  // filter. Archived-ness is a display preference, not a claim about quote
  // history — a customer can have a LIVE property with zero history and an
  // ARCHIVED one holding last season's approved quote; filtering archived
  // out here made "1 visible property" stop meaning "unambiguous", so a
  // click could silently post against the wrong (empty) property and 404.
  // See RebookButton's decideRebookClick + rebook.ts's own #205 comments.
  const allProperties = customerId
    ? await getPropertiesForCustomer(customerId, { includeArchived: true })
    : [];
  const rebookProperties = allProperties.map(p => ({
    id: p.id,
    address: p.address,
    archivedAt: p.archived_at ?? null,
  }));
  const propertiesPanelData = allProperties.map(p => ({
    id: p.id,
    address: p.address,
    nickname: p.nickname ?? null,
    archivedAt: p.archived_at ?? null,
  }));

  // Customer tenure (#178): auto-derived (deposit-paid + legacy-rebook years)
  // unioned with staff-entered manual years. Matches by EITHER id kind, same
  // as the quotes filter above, so a pre-backfill (HL-only) customer still
  // gets a derived count even with no customerId yet to edit against.
  const tenure = await getCustomerTenure(customerId, hlContactId, new Date());

  // NCE + YLL Neighbor tags (#198): same pre-backfill guard as the tenure
  // editor above (getCustomer needs a real customerId to save against) —
  // CustomerTagsEditor is hidden entirely (mirrors CustomerTenureEditor's
  // own {customerId && ...} guard below) rather than shown disabled, since a
  // pre-backfill (HL-only) customer has no row here to read tags FROM either.
  const customerRow = customerId ? await getCustomer(customerId) : null;

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
            {/* Customer tenure (#178): auto-derived ∪ manual "years with YLL" —
                informs the returning-customer free-spritzers offer + call tone. */}
            <p className="text-sm mt-1" style={{ color: 'var(--op-text-dim)' }}>
              {tenureHeaderLabel(tenure)}
            </p>
            {/* The editor needs a persisted customer row to save against —
                hidden pre-backfill (HL-only customer, no customerId yet). */}
            {customerId && (
              <div className="mt-2">
                <CustomerTenureEditor
                  customerId={customerId}
                  derivedYears={tenure.derivedYears}
                  initialManualYears={tenure.manualYears}
                />
              </div>
            )}
            {/* NCE + YLL Neighbor tags (#198) — same pre-backfill guard as
                the tenure editor above. */}
            {customerId && (
              <div className="mt-2">
                <CustomerTagsEditor
                  customerId={customerId}
                  initialIsNce={customerRow?.is_nce ?? false}
                  initialIsYllNeighbor={customerRow?.is_yll_neighbor ?? false}
                />
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {/* Rebook last season (Part D): hidden until the backfill populates customer_id. */}
            {customerId && <RebookButton customerId={customerId} properties={rebookProperties} />}
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

        {/* Properties (#205, full manage): every address this customer has had
            quote activity on, plus any staff added by hand. Nickname label,
            a Google Maps pin link, add/archive — archiving hides a property
            from the default list without deleting it (quotes/jobs/invoices
            reference properties by id). Same pre-backfill guard as tenure/
            tags above — a customerId is required to fetch/save against. */}
        {customerId && (
          <section
            className="rounded-lg border p-4 mb-6"
            style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
          >
            <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--op-text)' }}>Properties</h2>
            <CustomerPropertiesPanel customerId={customerId} initialProperties={propertiesPanelData} />
          </section>
        )}

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
                      {/* Sequential display number (#83) when allocated; falls
                          back to the truncated UUID on legacy rows (BUG-2, S22). */}
                      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }} title={`Quote ID: ${q.id}`}>{q.quote_number != null ? `#${q.quote_number}` : q.id.slice(0, 8)}</td>
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

        {/* Jobs (billing side, ledger #83): matched by customer_id OR by belonging
            to one of the quotes shown above (legacy rows, null customer_id). */}
        <section
          className="rounded-lg border mt-6"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Jobs</h2>
          {jobs.length === 0 ? (
            <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>No jobs yet.</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Created</th>
                  <th className="text-left px-3 py-2 font-semibold">Job</th>
                  <th className="text-left px-3 py-2 font-semibold">Type</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-left px-3 py-2 font-semibold">Install date</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>{fmtDate(j.created_at)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }} title={`Job ID: ${j.id}`}>{j.job_number != null ? `#${j.job_number}` : j.id.slice(0, 8)}</td>
                    <td className="px-3 py-2.5" style={{ color: 'var(--op-text)' }}>{j.type === 'permanent' ? 'Permanent' : 'One-off'}</td>
                    <td className="px-3 py-2.5"><JobStatusBadge status={j.status} /></td>
                    <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>{j.install_date ? fmtDate(j.install_date) : '—'}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Link href={`/admin/jobs/${j.id}`} className="text-xs hover:underline" style={{ color: 'var(--op-primary)' }}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </section>

        {/* Invoices (billing side, ledger #83): same match rule as Jobs above. */}
        <section
          className="rounded-lg border mt-6"
          style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
        >
          <h2 className="text-sm font-semibold px-4 pt-4 pb-2" style={{ color: 'var(--op-text)' }}>Invoices</h2>
          {invoices.length === 0 ? (
            <div className="p-6 text-sm text-center" style={{ color: 'var(--op-text-dim)' }}>No invoices yet.</div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase" style={{ color: 'var(--op-text-dim)', background: 'var(--op-bg)' }}>
                <tr>
                  <th className="text-left px-4 py-2 font-semibold">Created</th>
                  <th className="text-left px-3 py-2 font-semibold">Invoice</th>
                  <th className="text-left px-3 py-2 font-semibold">Status</th>
                  <th className="text-right px-3 py-2 font-semibold">Total</th>
                  <th className="text-right px-3 py-2 font-semibold">Balance</th>
                  <th className="text-left px-3 py-2 font-semibold">Paid date</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id} className="border-t" style={{ borderColor: 'var(--op-border)' }}>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>{fmtDate(inv.created_at)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--op-text-dim)' }} title={`Invoice ID: ${inv.id}`}>{inv.invoice_number != null ? `#${inv.invoice_number}` : inv.id.slice(0, 8)}</td>
                    <td className="px-3 py-2.5"><InvoiceStatusBadge status={inv.status} /></td>
                    <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(inv.total)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--op-text)' }}>{fmtMoney(inv.balance)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: 'var(--op-text-2)' }}>{inv.paid_at ? fmtDate(inv.paid_at) : '—'}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <Link href={`/admin/invoices/${inv.id}`} className="text-xs hover:underline" style={{ color: 'var(--op-primary)' }}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </section>

        {/* Referral program (#41): this customer's own referral link, credit
            balance, history, and the staff photo opt-out switch. */}
        <CustomerReferralPanel customerId={customerId} />

        {/* Activity timeline: every customer view + each quote's lifecycle. */}
        <CustomerActivityFeed events={activity} />
      </div>
    </OperatorShell>
  );
}
