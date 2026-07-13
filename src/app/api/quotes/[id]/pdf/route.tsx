// GET /api/quotes/[id]/pdf?doc=quote|invoice|receipt — ledger #87(a).
//
// Generates a branded PDF (quote / invoice / receipt) for download. Auth
// model mirrors /api/quotes/[id] and the portal itself: the quote UUID is
// the capability token (unguessable, same as /approve, /send, /view) — no
// separate operator gate, so the SAME link works for the customer portal
// and the operator admin pages. This is not a new trust boundary; it's the
// existing one the portal already runs on.
//
// Every dollar figure comes from the pure builders in src/lib/pdf/docModels.ts
// (money-safe: they read PortalQuote / InvoiceDetail verbatim, no
// recomputation). This route only resolves which source to load and hands
// the resulting doc-model to a React-PDF component.
//
//   doc=quote   — 404 until the quote is APPROVED (fix-batch #87a HIGH #1):
//                 an unapproved quote has no persisted "current" selection to
//                 render, so there is nothing correct to generate.
//   doc=invoice — 404 (clean JSON) until a job → invoice exists for this quote.
//   doc=receipt — 404 until a payment has posted (deposit_applied > 0 or paid_at).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import { loadPortalQuote, isValidQuoteId, PortalConfigError } from '@/lib/portal/loader';
import { getInvoiceByQuote, getInvoiceDetail } from '@/lib/invoices';
import { getQuoteRaw } from '@/lib/quotes';
import { buildQuoteDocModel, buildInvoiceDocModel, buildReceiptDocModel } from '@/lib/pdf/docModels';
import { QuotePdf } from '@/components/pdf/QuotePdf';
import { InvoicePdf } from '@/components/pdf/InvoicePdf';
import { ReceiptPdf } from '@/components/pdf/ReceiptPdf';

export const runtime = 'nodejs';

type DocKind = 'quote' | 'invoice' | 'receipt';

function isDocKind(v: string | null): v is DocKind {
  return v === 'quote' || v === 'invoice' || v === 'receipt';
}

// Read once per warm lambda/process — the same brand asset the portal
// watermark uses (src/components/portal/LogoWatermark.tsx), never re-fetched
// or re-encoded. A missing/unreadable file degrades to a text wordmark
// (PdfHeader) rather than failing the whole PDF.
let cachedLogo: Buffer | null | undefined;
function loadLogo(): Buffer | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    cachedLogo = readFileSync(path.join(process.cwd(), 'public', 'yule-site-logo-2.png'));
  } catch (err) {
    console.warn('[api/quotes/:id/pdf] logo read failed:', err);
    cachedLogo = null;
  }
  return cachedLogo;
}

function pdfResponse(buffer: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidQuoteId(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const doc = req.nextUrl.searchParams.get('doc');
  if (!isDocKind(doc)) {
    return NextResponse.json({ error: "doc must be one of 'quote', 'invoice', 'receipt'" }, { status: 400 });
  }

  const logo = loadLogo();

  try {
    if (doc === 'quote') {
      const portal = await loadPortalQuote(id);
      if (!portal) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
      // Fix-batch #87a HIGH #1 — approved-only. buildQuoteDocModel throws for
      // an unapproved quote; gate here first so that's never reached.
      if (!portal.approval) {
        return NextResponse.json({ error: 'Quote PDF is available after approval' }, { status: 404 });
      }
      const model = buildQuoteDocModel(portal);
      const buffer = await renderToBuffer(<QuotePdf model={model} logo={logo} />);
      const ref = model.quoteNumber.replace(/^YLL-/, '');
      return pdfResponse(buffer, `YuleLoveLights-Quote-${ref}.pdf`);
    }

    const invoice = await getInvoiceByQuote(id);
    if (!invoice) return NextResponse.json({ error: 'No invoice for this quote yet' }, { status: 404 });

    if (doc === 'invoice') {
      const detail = await getInvoiceDetail(invoice.id);
      if (!detail) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
      // Jobber-format redesign: the itemized Subtotal/Discount/Fees/Tax block
      // is sourced from the AGREED line items (the same frozen approval
      // selection the Quote PDF has always rendered from), never the stored
      // (unscaled) invoice.subtotal column — see buildInvoiceDocModel's
      // docstring. A missing/failed portal-quote load degrades to the
      // minimal always-reconciling set (Total/Deposit/Balance), never a
      // guess.
      const portalQuote = await loadPortalQuote(id).catch(() => null);
      const model = buildInvoiceDocModel(detail, portalQuote);
      const buffer = await renderToBuffer(<InvoicePdf model={model} logo={logo} />);
      return pdfResponse(buffer, `YuleLoveLights-Invoice-${model.invoiceNumber}.pdf`);
    }

    // doc === 'receipt'
    if (invoice.deposit_applied <= 0 && !invoice.paid_at) {
      return NextResponse.json({ error: 'No payment recorded for this quote yet' }, { status: 404 });
    }
    const detail = await getInvoiceDetail(invoice.id);
    if (!detail) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    const [quoteRow, portalQuote] = await Promise.all([
      getQuoteRaw(id),
      loadPortalQuote(id).catch(() => null),
    ]);
    const model = buildReceiptDocModel(detail, { deposit_paid_at: quoteRow?.deposit_paid_at ?? null }, portalQuote);
    const buffer = await renderToBuffer(<ReceiptPdf model={model} logo={logo} />);
    return pdfResponse(buffer, `YuleLoveLights-Receipt-${model.receiptNumber}.pdf`);
  } catch (err) {
    if (err instanceof PortalConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    console.error('[api/quotes/:id/pdf] render failed:', err);
    const msg = err instanceof Error ? err.message : 'PDF generation failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
