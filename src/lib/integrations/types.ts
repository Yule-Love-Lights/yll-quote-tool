// Shared types for the CRM + field-service integrations. Kept isolated from
// the quote/render domains so the integration layer can evolve independently
// — if we switch CRMs next year, only this module + its consumers change.
//
// Design note: we map external systems into our own "CrmContact" shape before
// letting the rest of the app see it. That way HighLevel-specific field
// names (customField, locationId, etc.) never leak into the UI or pricing
// engine. If we add a second CRM (Salesforce, Close, etc.) later, it just
// needs to populate the same CrmContact shape.

// ─── Unified contact shape ────────────────────────────────────────────────
// This is what the rest of the app sees after a HighLevel lookup. Only
// includes the fields the quote tool actually needs. Everything optional
// so a partial match still produces a useful pre-fill.
export type CrmContact = {
  id: string;                // canonical id from the source CRM
  source: 'highlevel';       // discriminator for future multi-CRM support
  firstName?: string;
  lastName?: string;
  fullName?: string;         // HighLevel sends both halves + a combined — we store all
  email?: string;
  phone?: string;
  address1?: string;         // street line
  city?: string;
  state?: string;
  postalCode?: string;
  // Opportunity / deal info if a pipeline record already exists for this contact.
  // Lets the quote tool link to an existing deal instead of creating a duplicate.
  opportunityId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
};

// Server-only variant that additionally carries the raw source record for
// debugging. Audit fix: `raw` was previously on the public CrmContact and
// always populated, relying on each API route to strip it before responding —
// a latent leak if any future client-facing caller forwarded the object.
// Making redaction the DEFAULT (raw lives only here, exposed behind an explicit
// opt-in) removes that footgun. Keep CrmContactInternal off the wire.
export type CrmContactInternal = CrmContact & {
  raw: unknown;             // full HighLevel record — never return to the browser
};

// ─── HighLevel API shapes (subset) ────────────────────────────────────────
// Only the fields we actually consume. HighLevel's response is much larger;
// we defensively typecast rather than depending on their full schema.
export type HighLevelContact = {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  customFields?: Array<{ id: string; value?: string }>;
  tags?: string[];
};

export type HighLevelOpportunity = {
  id: string;
  name?: string;
  contactId: string;
  pipelineId: string;
  pipelineStageId?: string;
  status?: 'open' | 'won' | 'lost' | 'abandoned';
  monetaryValue?: number;
};

// ─── Home.works via Zapier webhook ────────────────────────────────────────
// Zapier is the middleman because home.works doesn't expose a direct API
// suitable for this integration. Our tool POSTs a JSON payload to a Zapier
// Catch Hook URL; the Zap translates that into the home.works action
// (create job / create estimate / send contract). This keeps our code
// decoupled from home.works's specific data model — if home.works changes
// their schema, Jason/Naldo update the Zap, not our codebase.
//
// The payload below is what the Zap will receive. Keep it stable; Zapier
// field mappings break when keys are renamed. If you need to add data,
// add new keys, don't repurpose old ones.
export type HomeworksPayload = {
  // Event discriminator — lets a single Zap branch based on event type
  // if we add more trigger points later (e.g., 'quote.revised').
  event: 'quote.send';

  // Our internal IDs so Zapier can round-trip them back if needed
  // (e.g., when home.works fires a webhook on signature, we can find
  // the original quote).
  quoteId: string;
  highlevelContactId?: string;

  // Customer block — flat for easy Zapier mapping.
  customer: {
    fullName: string;
    email?: string;
    phone?: string;
    address?: string;
  };

  // Line items mirror the pricing engine's LineItem shape: a
  // pre-formatted label (e.g., "Santa's Roofline – 120ft (medium)")
  // plus a flat dollar amount. Quantity / unit / per-unit-rate data is
  // embedded in the label text — the pricing engine composes it, we just
  // pass it through. Zapier can use the full label in home.works's
  // "Description" field and the amount in the "Price" field.
  lineItems: Array<{
    label: string;
    amountUsd: number;
  }>;

  // Pre-rolled "single line item" for systems (like home.works) that only
  // accept ONE line per estimate/invoice. The customer's package name is
  // the item name, the description contains a human-readable breakdown of
  // every selected item + the pricing math, quantity is always 1, and the
  // total is the subtotal-after-discount (pre-tax / pre-fees).
  //
  // Zap field mapping for home.works:
  //   Item name        → homeworksLineItem.name
  //   Description      → homeworksLineItem.description
  //   Quantity         → homeworksLineItem.quantity
  //   Total / Price    → homeworksLineItem.totalUsd
  //
  // The flat `lineItems` array above is still sent so other downstream
  // systems (Jobber, QuickBooks, anything that accepts multi-line) can
  // map those instead. Home.works specifically uses the single-line field.
  homeworksLineItem: {
    name: string;          // package name ("Build Your Own", "Santa's Classic", etc.)
    description: string;   // multi-line breakdown — use as-is in home.works description
    quantity: 1;
    totalUsd: number;      // equals subtotalAfterDiscountUsd
  };

  // Full pricing breakdown — one field per QuoteResult number so the Zap
  // can map each to the matching home.works estimate field without
  // JavaScript code steps.
  subtotalBeforeDiscountUsd: number;
  discountAmountUsd: number;
  subtotalAfterDiscountUsd: number;
  rushFeeUsd: number;
  takedownUsd: number;
  taxableAmountUsd: number;
  taxAmountUsd: number;
  totalUsd: number;
  depositUsd: number;
  balanceDueUsd: number;
  minimumApplied: boolean;

  // Customer-facing URLs for the Zap to attach / email.
  quoteUrl?: string;       // public-facing quote view on this tool
  renderUrl?: string;      // signed URL of the approved render PNG

  // Notes / special instructions (from the quote form).
  notes?: string;

  // When the quote was sent (ISO timestamp). Zapier uses this as the
  // estimate's "date issued" field.
  sentAt: string;
};

export type HomeworksSendResult = {
  ok: boolean;
  statusCode: number;
  webhookResponse?: unknown;  // whatever Zapier's catch-hook echoes back
  error?: string;
};
