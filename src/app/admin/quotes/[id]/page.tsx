import { notFound } from 'next/navigation';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { BillingSubNav } from '@/components/admin/BillingSubNav';
import { JobStatusBadge } from '@/components/admin/JobStatusBadge';
import { InvoiceStatusBadge } from '@/components/admin/InvoiceStatusBadge';
import { YllNeighborBadge } from '@/components/admin/YllNeighborBadge';
import { LegacyRebookToggle } from '@/components/admin/LegacyRebookToggle';
import { NceBadge } from '@/components/admin/NceBadge';
import { NceToggle } from '@/components/admin/NceToggle';
import { ViewOnlyToggle } from '@/components/admin/ViewOnlyToggle';
import { MarkAsSentButton } from '@/components/admin/MarkAsSentButton';
import { FreeItemsPanel } from '@/components/admin/FreeItemsPanel';
import { ColorRequestPanel } from '@/components/admin/ColorRequestPanel';
import { StaffColorRequestForm } from '@/components/admin/StaffColorRequestForm';
import { canRecordStaffColorRequest } from '@/components/admin/staffColorRequestEligibility';
import { buildPortalLineItems } from '@/lib/portal/adapter';
import { BUSINESS_RULES, resolveLineItemLabel, type QuoteInputs } from '@/lib/pricing/pricingEngine';
import { getQuoteRaw } from '@/lib/quotes';
import { deriveStatus, APPROVED_DISPLAYS_AS, type QuoteStatus } from '@/lib/quoteStatus';
import { requiresReconsent, isSupersededPendingAmendment } from '@/lib/amend';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';
import { getDesignByQuote } from '@/lib/designs';
import { permanentBomFromQuote, includedPermanentSidesFromSnapshot } from '@/lib/permanent/bomFromQuote';
import type { PermanentSide } from '@/lib/permanent/types';
import { catalogCostOverrides, listCatalog } from '@/lib/inventory/catalog';
import { PermanentBomPanel } from '@/components/permanent/PermanentBomPanel';
import { bistroBomFromQuote } from '@/lib/permanentBistro/bomFromQuote';
import { costOverridesFromBistroCatalog } from '@/lib/inventory/bistroCatalog';
import { getColorScheme, CUSTOM_SCHEME_ID } from '@/lib/design/colorSchemes';
import { depositDeclineReasonText } from '@/lib/integrations/quoteMessages';
import { VaultRegistrationNotice } from '@/components/admin/VaultRegistrationNotice';
import { isVaultRegisterEnabled } from '@/lib/integrations/valorVault';
import { getAppSettings } from '@/lib/appSettings';

// Read-only operator detail for a single quote (PR1 of #83 ops console).
// No action buttons here — those land in PR2's PipelineActionsMenu.

// Row 242 (Jason's ruling — no third stage): 'approved' reads + colors
// IDENTICALLY to 'sent' (APPROVED_DISPLAYS_AS === 'Sent') — see quoteStatus.ts
// for the rationale. deriveStatus/canTransition/money guards are unaffected;
// this is presentation only. Note the "Approved" dt below in the Lifecycle
// timeline is a DIFFERENT thing (a raw event timestamp — when
// customer_approved_at was stamped) and is untouched.
const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  approved: APPROVED_DISPLAYS_AS,
  booked: 'Booked',
  changes_requested: 'Changes requested',
  declined: 'Declined',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
};

const STATUS_STYLES: Record<QuoteStatus, string> = {
  booked: 'bg-emerald-100 text-emerald-700',
  // Row 242: no distinct color for approved — takes sent's exact style.
  approved: 'bg-blue-100 text-blue-700',
  viewed: 'bg-purple-100 text-purple-700',
  sent: 'bg-blue-100 text-blue-700',
  draft: 'bg-amber-100 text-amber-700',
  changes_requested: 'bg-orange-100 text-orange-700',
  declined: 'bg-red-100 text-red-700',
  cancelled: 'bg-gray-200 text-gray-600',
  abandoned: 'bg-gray-200 text-gray-600',
};

const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

// #175: "Card declined 2 hours ago" reads better on the decline notice below
// than an absolute timestamp — a simple minutes/hours/days ladder is plenty
// for a server-rendered admin page (no live-updating countdown needed).
function relativeTimeFromNow(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// #155 — the light color/pattern a legacy-rebook customer approved with, for
// the admin detail card. null when the quote hasn't been approved yet (no
// customerSelection to read) — the card renders nothing in that case.
function chosenLightColorLabel(
  sel: { colorSchemeId?: string; customPattern?: string[] } | undefined,
): string | null {
  if (!sel) return null;
  const hasCustomPattern = Array.isArray(sel.customPattern) && sel.customPattern.length > 0;
  if (sel.colorSchemeId === CUSTOM_SCHEME_ID || hasCustomPattern) return 'Custom pattern';
  if (sel.colorSchemeId) return getColorScheme(sel.colorSchemeId).label;
  return null;
}

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const quote = await getQuoteRaw(id);
  if (!quote) notFound();

  const status = deriveStatus(quote);

  const job = await getJobByQuote(id);
  const invoice = job ? await getInvoiceByJob(job.id) : null;
  // #13 PR5: small photo thumbnails (base + extras) so staff can see at a
  // glance which angles a quote's design covers. Best-effort — a design
  // lookup failure never blocks the detail page.
  const design = await getDesignByQuote(id).catch(() => null);
  const photoThumbs = design
    ? [
        { key: 'base', url: design.photoUrl, title: design.photoTitle || 'Photo 1' },
        ...design.extraPhotos
          .filter((p) => p.url)
          .map((p, i) => ({ key: p.id, url: p.url, title: p.title || `Photo ${i + 2}` })),
      ].filter((p) => p.url)
    : [];

  const amendments = quote.approval_snapshot?.amendments ?? [];

  // #163 Slice B — a pending customer colour-change request (set by the portal
  // "Request colour change" button). Staff Apply (re-freeze) or Dismiss it.
  const pendingColorRequest = quote.approval_snapshot?.pendingColorRequest as
    | { label?: string }
    | undefined;
  const staffColorRequestSettings =
    canRecordStaffColorRequest({
      serviceType: quote.service_type,
      status,
      customerApprovedAt: quote.customer_approved_at,
      customerSelection: quote.approval_snapshot?.customerSelection,
      pendingColorRequest,
    })
      ? await getAppSettings()
      : null;

  // #162 — the FREE ($0) items currently on the approved selection, so staff can
  // add/remove more (e.g. the free spritzers on #1191). Only an approved/booked
  // quote has a signed selection to edit; a priced line never appears here.
  const canEditFreeItems = (status === 'approved' || status === 'booked') && !!quote.result;
  const freeItems = canEditFreeItems && quote.result
    ? (() => {
        const { lineItems } = buildPortalLineItems(quote.result, quote.inputs as QuoteInputs | null);
        const ids =
          (quote.approval_snapshot?.customerSelection?.selectedItemIds as string[] | undefined) ?? [];
        const selected = new Set(ids);
        return lineItems
          .filter((li) => li.price === 0 && selected.has(li.id))
          .map((li) => ({ id: li.id, label: li.label }));
      })()
    : [];

  // #155 — for a legacy rebook, show what light color/pattern the customer
  // approved with (once approved). null while awaiting approval, or for a
  // normal (non-rebook) quote — the line simply doesn't render.
  const chosenLightColor =
    quote.legacy_rebook ? chosenLightColorLabel(quote.approval_snapshot?.customerSelection) : null;

  // Permanent Lighting (#88 P7/P8): the operator BOM (Ascend/Dauer APL material
  // list + wholesale cost) for ordering. Null for non-permanent quotes. Materials
  // never touch the customer price — this is ordering + margin only. Live
  // inventory_catalog costs (P8) override the engine's built-in fallback prices
  // when a SKU's been re-priced in Settings; a catalog read failure swallows to
  // [] → an empty override map → every SKU quietly falls back. Only fetched for
  // permanent quotes — no reason to hit the catalog for a holiday/event quote.
  //
  // #192 — approved-sides scoping cuts over at BOOKED (deposit paid), not
  // approved: an approved-but-unpaid quote still shows every measured side
  // (Jason's call — nothing is final until the deposit lands). fails open to
  // null (unscoped) on any missing/unparseable/no-match snapshot.
  const includedPermanentSides =
    quote.service_type === 'permanent' && status === 'booked'
      ? includedPermanentSidesFromSnapshot(quote.approval_snapshot)
      : null;
  const bom =
    quote.service_type === 'permanent'
      ? permanentBomFromQuote(quote.inputs, await catalogCostOverrides(), includedPermanentSides)
      : null;
  const PERMANENT_SIDE_LABEL: Record<PermanentSide, string> = {
    front: 'Front',
    left: 'Left side',
    right: 'Right side',
    back: 'Back',
  };
  const scopedSideLabels = includedPermanentSides
    ? (['front', 'left', 'right', 'back'] as const)
        .filter((s) => includedPermanentSides.has(s))
        .map((s) => PERMANENT_SIDE_LABEL[s])
    : null;

  // Permanent Bistro (#117): the same ordering-only BOM pattern, a separate
  // engine (Thunder/Home Depot/Amazon, no wholesale-cost totals shown here —
  // see the print sheet). Positive `=== 'permanent_bistro'` gate; null for an
  // empty job (no footage, no poles) even on a bistro quote.
  const bistroBom =
    quote.service_type === 'permanent_bistro'
      ? bistroBomFromQuote(quote.inputs, costOverridesFromBistroCatalog(await listCatalog()))
      : null;

  return (
    <OperatorShell active="quotes">
      <div className="max-w-3xl mx-auto">
        <BillingSubNav active="quotes" />
        <div className="mb-4">
          <Link href="/admin/quotes" className="text-sm text-gray-500 hover:text-gray-700">
            ← All quotes
          </Link>
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">
            {quote.quote_number != null ? `Quote #${quote.quote_number}` : `Quote ${id.slice(0, 8)}`}
          </h1>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[status]}`}>
            {STATUS_LABELS[status]}
          </span>
          {quote.is_test && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
              Test
            </span>
          )}
          {/* YLL Neighbor (#158) — shared pill, replaces the old inline "Legacy rebook" span. */}
          {quote.legacy_rebook && <YllNeighborBadge />}
          {/* NCE (#198) — the barter/trade network tag. Tags coexist: a quote
              can be both Neighbor and NCE. */}
          {quote.is_nce && <NceBadge />}
          {/* View-only portal (#176) — mirrors the Test pill above. */}
          {quote.view_only && (
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">
              View-only
            </span>
          )}
          {/* Staff-only toggle (detail page only, not the /admin/quotes list) —
              lets staff set/unset the flag for a hand-built quote that missed
              the migration (e.g. #1191). */}
          <LegacyRebookToggle quoteId={id} legacyRebook={quote.legacy_rebook} status={status} />
          {/* Staff-only toggle (#198) — beside the Neighbor toggle, same
              placement precedent. */}
          <NceToggle quoteId={id} isNce={quote.is_nce} />
          {/* Staff-only toggle (#176) — lets staff flag a quote as browse-only
              (a second quote spun up just for the colour picker). */}
          <ViewOnlyToggle quoteId={id} viewOnly={quote.view_only} status={status} />
          {/* Staff-only one-way action (#182) — a quote delivered outside the
              tool (hand-texted the link, walked through it on a call) never
              hits the real /send route and sits 'draft' forever. Only shown
              while still markable (draft/unsent); the route itself refuses
              any other status. */}
          {status === 'draft' && !quote.view_only && <MarkAsSentButton quoteId={id} />}
          <div className="ml-auto flex items-center gap-3">
            {/* #87(a) fix-batch HIGH #1 — the Quote PDF is approved-only (an
                unapproved quote has no persisted "current" selection to
                render), so only offer the link once the quote has actually
                been approved. */}
            {(status === 'approved' || status === 'booked') && (
              <Link
                href={`/api/quotes/${id}/pdf?doc=quote`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-700 hover:underline"
              >
                Download PDF ↓
              </Link>
            )}
            <Link
              href={`/portal/${id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-700 hover:underline"
            >
              Portal ↗
            </Link>
          </div>
        </div>

        {/* Customer */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4 mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Customer</h2>
          <p className="text-gray-800 font-medium">{quote.customer_name ?? '—'}</p>
          {quote.customer_address && <p className="text-sm text-gray-500">{quote.customer_address}</p>}
          <p className="text-sm text-gray-500">
            {[quote.customer_phone, quote.customer_email].filter(Boolean).join(' · ') || '—'}
          </p>
          {chosenLightColor && (
            <p className="text-sm text-gray-500 mt-1">Chosen light color: {chosenLightColor}</p>
          )}
        </div>

        {/* Design photos (#13 PR5) — read-only thumbnails, base + extras. */}
        {photoThumbs.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Design photos ({photoThumbs.length})
            </h2>
            <div className="flex gap-2 flex-wrap">
              {photoThumbs.map((p) => (
                <figure key={p.key} className="m-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url!} alt={p.title} className="w-24 h-16 object-cover rounded border border-gray-200" />
                  <figcaption className="text-[10px] text-gray-500 mt-0.5 max-w-24 truncate">{p.title}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Lifecycle</h2>
          <dl className="text-sm text-gray-600 space-y-0.5">
            <div className="flex justify-between">
              <dt>Sent</dt>
              <dd className="text-gray-800">{fmtDate(quote.quote_sent_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>First viewed</dt>
              <dd className="text-gray-800">{fmtDate(quote.viewed_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Approved</dt>
              <dd className="text-gray-800">{fmtDate(quote.customer_approved_at)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Deposit paid / booked</dt>
              <dd className="text-gray-800">{fmtDate(quote.deposit_paid_at)}</dd>
            </div>
          </dl>
        </div>

        {/* #175: a declined deposit charge otherwise only shows up in a
            webhook log — surface it here so staff notice before the
            customer's install slot slips. Gated on the deposit still being
            unpaid: once it clears, this stops rendering even though the
            stamp itself is left in place (harmless — nothing reads it once
            paid). A declined BALANCE charge stamps the same columns (#175)
            but isn't shown here since the deposit is already paid by then —
            that alert links straight to the invoice instead. */}
        {quote.deposit_declined_at && !quote.deposit_paid_at && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Card declined {relativeTimeFromNow(quote.deposit_declined_at)}
            {quote.deposit_decline_code && (
              <>
                {' '}
                (code {quote.deposit_decline_code} — {depositDeclineReasonText(quote.deposit_decline_code)})
              </>
            )}
            {quote.view_only ? (
              <>
                {' '}
                — the portal is view-only right now; turn that off before they can retry.
              </>
            ) : (
              <> — customer can retry from their portal link.</>
            )}
          </div>
        )}

        {/* #171g: a Vault registration failure was previously console.warn-only —
            surface it here so staff know the deposit token still works even
            though the card never landed in Valor's own Vault product.
            #663 review, two caveats baked in: (1) gated on isVaultRegisterEnabled()
            so a quote gets NO notice when the integration was never armed — without
            this, every deposit-paid quote (token set, customer_id always null since
            the webhook never attempts registration) would show a false failure.
            (2) the #171f reorder moved the vault hook to run AFTER job creation +
            notifications, widening the window where it's still in flight — the
            component's copy is deliberately honest about "hasn't completed (yet)"
            rather than asserting a hard failure. */}
        <VaultRegistrationNotice
          vaultRegisterEnabled={isVaultRegisterEnabled()}
          depositPaidAt={quote.deposit_paid_at}
          valorVaultToken={quote.valor_vault_token}
          valorVaultCustomerId={quote.valor_vault_customer_id}
        />

        {/* Line items */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Line items</h2>
          {!quote.result?.lineItems?.length ? (
            <p className="text-sm text-gray-500">No line items — quote not yet calculated.</p>
          ) : (
            <>
              <table className="w-full text-sm mb-2">
                <tbody>
                  {quote.result.lineItems.map((li, i) => (
                    <tr key={i} className="border-t border-gray-100 first:border-0">
                      {/* item-numbering-rename: a staff rename (quote.inputs.
                          labelOverrides) reads through the same seam the
                          builder/portal/PDF use, so this read-only operator
                          view never shows the stale auto label. */}
                      <td className="py-1.5 text-gray-700">
                        {resolveLineItemLabel(li.id, li.label, (quote.inputs as QuoteInputs | null)?.labelOverrides).label}
                      </td>
                      <td className="py-1.5 text-right text-gray-700 whitespace-nowrap">{money(li.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="text-sm text-gray-600 space-y-0.5 border-t border-gray-200 pt-2">
                {quote.result.discountAmount > 0 && (
                  <div className="flex justify-between">
                    <dt>Discount</dt>
                    <dd>−{money(quote.result.discountAmount)}</dd>
                  </div>
                )}
                {quote.result.taxAmount > 0 && (
                  <div className="flex justify-between">
                    <dt>Tax</dt>
                    <dd>{money(quote.result.taxAmount)}</dd>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-gray-900">
                  <dt>Total</dt>
                  <dd>{money(quote.total ?? quote.result.total)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>
                    Deposit
                    {/* #177 fix 5: surface the percent when it's not the 50% default —
                        cheaply derivable from the same result.depositRate. */}
                    {Math.round((quote.result.depositRate ?? BUSINESS_RULES.depositPercentage) * 100) !== 50 && (
                      <> ({Math.round((quote.result.depositRate ?? BUSINESS_RULES.depositPercentage) * 100)}%)</>
                    )}
                  </dt>
                  <dd>{money(quote.result.depositAmount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Balance due</dt>
                  <dd>{money(quote.result.balanceDue)}</dd>
                </div>
              </dl>
            </>
          )}
        </div>

        {/* Colour change request (#163 Slice B) — apply/dismiss a pending request. */}
        {pendingColorRequest?.label && (
          <ColorRequestPanel quoteId={id} label={pendingColorRequest.label} />
        )}
        {staffColorRequestSettings && (
          <StaffColorRequestForm
            quoteId={id}
            schemes={staffColorRequestSettings.permanentSwatches.schemes}
            buildableColorIds={staffColorRequestSettings.permanentSwatches.buildableColorIds}
            colors={staffColorRequestSettings.colors.map(({ id: colorId, label, hex }) => ({
              id: colorId,
              label,
              hex,
            }))}
            initialColorSchemeId={quote.approval_snapshot?.customerSelection?.colorSchemeId}
            initialCustomPattern={quote.approval_snapshot?.customerSelection?.customPattern}
          />
        )}

        {/* Free items (#162) — add/remove $0 items on an approved order. */}
        {canEditFreeItems && <FreeItemsPanel quoteId={id} items={freeItems} />}

        {/* Permanent BOM (#88 P7) — operator ordering material list + wholesale cost. */}
        {bom && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Materials — BOM (ordering)
              </h2>
              <Link
                href={`/admin/quotes/${id}/bom/print`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-700 hover:underline"
              >
                Print order sheet ↗
              </Link>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              Ascend/Dauer APL list — ordering + margin only. Materials never affect the customer price.
            </p>
            <PermanentBomPanel bom={bom} scopedSideLabels={scopedSideLabels} />
          </div>
        )}

        {/* Permanent Bistro BOM (#117) — order sheet link (Thunder/Home Depot/Amazon). */}
        {bistroBom && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Materials — BOM (ordering)
              </h2>
              <Link
                href={`/admin/quotes/${id}/bistro-bom/print`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-700 hover:underline"
              >
                Print order sheet ↗
              </Link>
            </div>
            <p className="text-xs text-gray-400">
              {bistroBom.totals.totalFootage} ft ({bistroBom.totals.strands} strand
              {bistroBom.totals.strands === 1 ? '' : 's'}), {bistroBom.totals.poles} pole
              {bistroBom.totals.poles === 1 ? '' : 's'}. Thunder / Home Depot / Amazon order list. Materials never
              affect the customer price.
            </p>
          </div>
        )}

        {/* Linked job */}
        {job && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Linked job</h2>
            <div className="flex items-center gap-2">
              <Link href={`/admin/jobs/${job.id}`} className="text-blue-700 hover:underline text-sm font-medium">
                {job.job_number != null ? `Job #${job.job_number}` : `Job ${job.id.slice(0, 8)}`} →
              </Link>
              <JobStatusBadge status={job.status} />
            </div>
          </div>
        )}

        {/* Linked invoice */}
        {invoice && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Linked invoice</h2>
            <div className="flex items-center gap-2 mb-2">
              <Link href={`/admin/invoices/${invoice.id}`} className="text-blue-700 hover:underline text-sm font-medium">
                {invoice.invoice_number != null ? `Invoice #${invoice.invoice_number}` : `Invoice ${invoice.id.slice(0, 8)}`} →
              </Link>
              <InvoiceStatusBadge status={invoice.status} />
            </div>
            <dl className="text-sm text-gray-600 space-y-0.5">
              <div className="flex justify-between">
                <dt>Total</dt>
                <dd>{money(invoice.total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Deposit applied</dt>
                <dd>−{money(invoice.deposit_applied)}</dd>
              </div>
              <div className="flex justify-between font-semibold text-gray-900">
                <dt>Balance due</dt>
                <dd>{money(invoice.balance)}</dd>
              </div>
              {invoice.paid_at && (
                <div className="flex justify-between">
                  <dt>Paid at</dt>
                  <dd>{fmtDate(invoice.paid_at)}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {/* Amendment trail */}
        {amendments.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Amendments ({amendments.length})
            </h2>
            <ol className="space-y-3 text-sm">
              {amendments.map((a, i) => {
                // Cosmetic (zero-delta) entries never carry `consent` — only a
                // total-changing amendment asks for one (requiresReconsent).
                // A missing `consent` on a REAL price change reads as pending,
                // matching the backward-compat convention documented on
                // AmendmentConsent in lib/amend.ts.
                const rawStatus = requiresReconsent(a) ? (a.consent?.status ?? 'pending') : null;
                // FIX6: relabel a still-'pending' entry that's been superseded
                // by a later amendment (no route will ever resolve it — see
                // isSupersededPendingAmendment's doc comment) so an operator
                // doesn't read "Pending customer response" as still actionable.
                const isSuperseded = isSupersededPendingAmendment(a, amendments);
                const status = isSuperseded ? 'superseded' : rawStatus;
                const badge =
                  status === 'declined'
                    ? { label: 'Declined', cls: 'bg-red-100 text-red-700' }
                    : status === 'accepted'
                      ? { label: 'Approved', cls: 'bg-emerald-100 text-emerald-700' }
                      : status === 'superseded'
                        ? { label: 'Superseded — see latest', cls: 'bg-gray-100 text-gray-500' }
                        : status === 'pending'
                          ? { label: 'Pending customer response', cls: 'bg-amber-100 text-amber-700' }
                          : null;
                return (
                  <li key={i} className="border-t border-gray-100 pt-2 first:border-0 first:pt-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-gray-800 font-medium">{a.reason}</p>
                      {badge && (
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                    </div>
                    <p className="text-gray-500 text-xs">
                      {fmtDate(a.amended_at)} · by {a.by} ·{' '}
                      {a.delta >= 0 ? '+' : '−'}{money(Math.abs(a.delta))} → new total{' '}
                      {money(a.new_total)} · balance {money(a.new_balance)}
                    </p>
                    {a.consent?.status === 'declined' && (
                      <p className="mt-1 text-xs text-red-700">
                        Customer declined {fmtDate(a.consent.declined_at)}
                        {a.consent.reason ? `: "${a.consent.reason}"` : ' (no reason given)'}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}
