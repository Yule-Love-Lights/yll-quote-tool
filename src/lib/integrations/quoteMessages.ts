// Customer-facing copy for the "quote sent" notifications (#37), delivered via
// GHL (SMS + Email) when staff hit "Send Quote." Kept in one place so the
// wording is easy to tweak. The caller fills in the customer's first name and
// the portal link.
//
// Per-service-type (S26): holiday/permanent/event each get their own voice —
// distinct copy also defeats carrier/GHL SMS de-dup that was suspected of
// silently swallowing perm/event sends whose body was otherwise byte-identical
// to holiday's. Type resolution mirrors ghlPipelineMap.ts: asServiceType ??
// DEFAULT_SERVICE_TYPE (unknown/missing service_type → holiday).

import { asServiceType, DEFAULT_SERVICE_TYPE, type ServiceType } from '@/lib/serviceType';

const QUOTE_READY_EMAIL_SUBJECT: Record<ServiceType, string> = {
  holiday: 'Your Yule Love Lights quote is ready 🎄',
  permanent: 'Your Yule Love Lights Permanent Lighting quote is ready ✨',
  event: 'Your Yule Love Lights Event Lighting quote is ready ✨',
  permanent_bistro: 'Your Yule Love Lights Bistro Lighting quote is ready ✨',
};

export function quoteEmailSubject(serviceType?: string | null): string {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  return QUOTE_READY_EMAIL_SUBJECT[type];
}

const QUOTE_READY_SMS_INTRO: Record<ServiceType, string> = {
  holiday: '🎄 Your custom Yule Love Lights quote is ready!',
  permanent: '✨ Your custom Yule Love Lights Permanent Lighting quote is ready!',
  event: '✨ Your custom Yule Love Lights Event Lighting quote is ready!',
  permanent_bistro: '✨ Your custom Yule Love Lights Bistro Lighting quote is ready!',
};

export function quoteSmsBody(firstName: string, portalUrl: string, serviceType?: string | null): string {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  return `Hi ${firstName}! ${QUOTE_READY_SMS_INTRO[type]} View your design, see the price, and approve here: ${portalUrl} Reply with any questions!`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Holiday keeps its ORIGINAL wording byte-for-byte ("holiday lighting" /
// "line-item breakdown"); permanent/event mirror the same HTML skeleton with
// their own service-line wording ("permanent|event lighting" / "item
// breakdown" — no "line-" prefix, per the dev's exact copy).
const QUOTE_READY_EMAIL_COPY: Record<ServiceType, { intro: string; breakdown: string }> = {
  holiday: { intro: 'Your custom holiday lighting quote is ready.', breakdown: 'line-item' },
  permanent: { intro: 'Your custom permanent lighting quote is ready.', breakdown: 'item' },
  event: { intro: 'Your custom event lighting quote is ready.', breakdown: 'item' },
  permanent_bistro: { intro: 'Your custom bistro lighting quote is ready.', breakdown: 'item' },
};

export function quoteEmailHtml(firstName: string, portalUrl: string, serviceType?: string | null): string {
  const type = asServiceType(serviceType) ?? DEFAULT_SERVICE_TYPE;
  const { intro, breakdown } = QUOTE_READY_EMAIL_COPY[type];
  const name = escapeHtml(firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>${intro}</p>`,
    `<p>We've put together a design showing exactly how your home will look, with a full ${breakdown} breakdown and your price. You can review it, adjust what's included, and approve right from the page:</p>`,
    `<p><a href="${portalUrl}">View my quote →</a></p>`,
    `<p>Once you approve and place your deposit, your spot on our install calendar is reserved.</p>`,
    `<p>Questions? Just reply here or text/call us at (631) 517-0186, we're happy to help!</p>`,
    `<p>Warm wishes,<br>Yule Love Lights team</p>`,
  ].join('\n');
}

// ─── Approval notifications (temporary pre-Valor deposit flow) ──────────────
// When the customer clicks Approve we don't take payment online yet (Valor
// isn't connected). Instead we confirm the approval and tell them we'll reach
// out to collect their 50% deposit, then email ourselves to go do it. These
// replace the online-payment receipt until #38 lands.

// Whole-dollar format for customer-facing "about $X" amounts.
function usd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// Exact format (with cents) for the internal record.
function usdExact(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const APPROVAL_EMAIL_SUBJECT = "You're approved! Here's what happens next 🎄";

// #177: depositPercent is the quote's ACTUAL deposit percent (integer, e.g.
// 50) — the caller derives it from effectiveDepositRate, never a hardcoded 50.
export function approvalSmsBody(
  firstName: string,
  depositUsd: number,
  phone: string,
  depositPercent: number,
): string {
  return `Hi ${firstName}! 🎄 Thanks for approving your Yule Love Lights quote. We'll reach out shortly to collect your ${depositPercent}% deposit (about ${usd(depositUsd)}) and lock in your install date — nothing to do right now. Questions? Call or text us at ${phone}.`;
}

export function approvalEmailHtml(
  firstName: string,
  depositUsd: number,
  portalUrl: string,
  phone: string,
  depositPercent: number,
): string {
  const name = escapeHtml(firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Thanks for approving your holiday lighting quote! 🎄</p>`,
    `<p>Here's what happens next: a member of our team will reach out to you shortly to collect your <strong>${depositPercent}% deposit (about ${usd(depositUsd)})</strong> and lock in your install date.</p>`,
    `<p>There's nothing you need to do right now — we'll contact you to take care of the deposit and confirm your spot on our schedule.</p>`,
    `<p>You can review your quote anytime here:</p>`,
    `<p><a href="${portalUrl}">View my quote →</a></p>`,
    `<p>Questions? Just reply here or text/call us at ${escapeHtml(phone)}, we're happy to help!</p>`,
    `<p>Warm wishes,<br>Yule Love Lights team</p>`,
  ].join('\n');
}

export function internalApprovalEmailSubject(customerName: string | null): string {
  // Strip control chars (defense-in-depth against header injection — the name
  // comes from a GHL contact record, not a request body, but cheap to harden).
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `🔔 Approved — collect deposit: ${who}`;
}

export function internalApprovalEmailHtml(input: {
  customerName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  totalUsd: number;
  depositUsd: number;
  // #177: the quote's ACTUAL deposit percent (integer, e.g. 50) — the caller
  // derives it from effectiveDepositRate, never a hardcoded 50.
  depositPercent: number;
  packageName: string;
  installTiming: 'none' | 'september' | 'october';
  rushSelected: boolean;
  takedownSelected: boolean;
  portalUrl: string;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  const installLabel =
    input.installTiming === 'september'
      ? 'September (early install, 15% off)'
      : input.installTiming === 'october'
        ? 'October (early install, 10% off)'
        : 'Standard (Nov–Dec)';
  return [
    `<p><strong>${name}</strong> just approved their quote and needs a deposit call.</p>`,
    `<p><strong>Action:</strong> reach out to collect the ${input.depositPercent}% deposit (${usdExact(input.depositUsd)}) to lock them in on the schedule.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Phone', escapeHtml(input.phone || '—')),
    row('Email', escapeHtml(input.email || '—')),
    row('Address', escapeHtml(input.address || '—')),
    row('Package', escapeHtml(input.packageName)),
    row('Total', usdExact(input.totalUsd)),
    row(`Deposit (${input.depositPercent}%)`, usdExact(input.depositUsd)),
    row('Install', installLabel),
    row('Rush install', input.rushSelected ? 'Yes' : 'No'),
    row('Premium takedown', input.takedownSelected ? 'Yes' : 'No'),
    `</table>`,
    `<p><a href="${input.portalUrl}">Customer portal →</a> &nbsp;|&nbsp; <a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

// ─── Decline / Request-changes staff notifications (#83 Phase 1, Slice B) ────
// Fired (best-effort) from the portal decline / request-changes routes so staff
// see the customer's answer in their inbox. Internal-only — the customer gets a
// friendly on-screen confirmation, not an email.

export function internalDeclineEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `🚫 Quote declined: ${who}`;
}

export function internalDeclineEmailHtml(input: {
  customerName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  reason: string;
  portalUrl: string;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  return [
    `<p><strong>${name}</strong> declined their quote.</p>`,
    `<p><strong>Reason given:</strong></p>`,
    `<blockquote style="margin:6px 0;padding:8px 12px;border-left:3px solid #C8313D;background:#faf3f3;">${escapeHtml(
      input.reason,
    )}</blockquote>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Phone', escapeHtml(input.phone || '—')),
    row('Email', escapeHtml(input.email || '—')),
    row('Address', escapeHtml(input.address || '—')),
    `</table>`,
    `<p><a href="${input.portalUrl}">Customer portal →</a> &nbsp;|&nbsp; <a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

export function internalChangesRequestedEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `✏️ Changes requested: ${who}`;
}

export function internalChangesRequestedEmailHtml(input: {
  customerName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  note: string;
  portalUrl: string;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  return [
    `<p><strong>${name}</strong> asked for changes to their quote.</p>`,
    `<p><strong>Action:</strong> edit the quote to address their note, then re-send it.</p>`,
    `<p><strong>What they asked for:</strong></p>`,
    `<blockquote style="margin:6px 0;padding:8px 12px;border-left:3px solid #FFB744;background:#fdf8ee;">${escapeHtml(
      input.note,
    )}</blockquote>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Phone', escapeHtml(input.phone || '—')),
    row('Email', escapeHtml(input.email || '—')),
    row('Address', escapeHtml(input.address || '—')),
    `</table>`,
    `<p><a href="${input.adminUrl}">Open in quote tool to edit →</a> &nbsp;|&nbsp; <a href="${input.portalUrl}">Customer portal →</a></p>`,
  ].join('\n');
}

// ─── View receipt (#68) ─────────────────────────────────────────────────────
// Sent to the internal GHL contact each time the customer opens their portal
// link, so staff know the quote is being looked at (a warm-lead signal to
// follow up). Fires per open; the count tells you how engaged they are.

export function internalViewedEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `👀 Quote viewed: ${who}`;
}

export function internalViewedEmailHtml(input: {
  customerName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  viewCount: number;
  portalUrl: string;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  // "1st time" / "2nd time" / "3rd time" / "Nth time".
  const n = input.viewCount;
  const ord =
    n % 100 >= 11 && n % 100 <= 13
      ? `${n}th`
      : `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'}`;
  return [
    `<p><strong>${name}</strong> just opened their quote (their <strong>${ord}</strong> time).</p>`,
    `<p>Good moment to follow up while it's top of mind.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Phone', escapeHtml(input.phone || '—')),
    row('Email', escapeHtml(input.email || '—')),
    row('Address', escapeHtml(input.address || '—')),
    row('Times opened', String(n)),
    `</table>`,
    `<p><a href="${input.portalUrl}">Customer portal →</a> &nbsp;|&nbsp; <a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

// ─── Inventory: materials order email (#82 Slice 3) ─────────────────────────
// Staff-only — the projected materials for a booked job, emailed to the internal
// contact (sales@ / purchasing) so the order lands in an inbox to act on or
// forward to the supplier. Mirrors the PDF work order, but as an email body.

export type OrderEmailLine = { sku: string; name: string; qty: number; onHand: number | null; short: boolean };
export type OrderEmailUnbound = { label: string; qty: number };

export function orderEmailSubject(jobNumber: number | null, customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim();
  return `📦 Materials order — Job #${jobNumber ?? '—'}${who ? ` (${who})` : ''}`;
}

export function orderEmailHtml(input: {
  jobNumber: number | null;
  customerName: string | null;
  address: string | null;
  installDate: string | null;
  materials: OrderEmailLine[];
  unbound: OrderEmailUnbound[];
  // Test Quote (ledger #93) — when true, a loud banner up top so this can never
  // be mistaken for a real order to forward/pull stock against.
  isTest?: boolean;
}): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  const td = (s: string, extra = '') => `<td style="padding:4px 12px 4px 0;${extra}">${s}</td>`;
  const matRows = input.materials
    .map((m) => {
      const onHand = m.onHand === null ? 'not tracked' : m.short ? `${m.onHand} — SHORT` : String(m.onHand);
      return `<tr>${td(escapeHtml(m.sku), 'font-family:monospace;font-size:12px;')}${td(escapeHtml(m.name))}${td(
        String(m.qty),
        'text-align:right;',
      )}${td(onHand, `text-align:right;${m.short ? 'color:#b45309;font-weight:bold;' : 'color:#666;'}`)}</tr>`;
    })
    .join('\n');
  const out = [
    ...(input.isTest
      ? [
          `<p style="background:#fef3c7;color:#92400e;border:2px solid #b45309;border-radius:6px;padding:8px 12px;font-weight:bold;text-transform:uppercase;letter-spacing:0.04em;">TEST — do not pull real stock</p>`,
        ]
      : []),
    `<p>Materials order for <strong>Job #${input.jobNumber ?? '—'}</strong> — staff-only. Forward to the supplier or use to pull stock.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;margin-bottom:12px;">`,
    row('Customer', escapeHtml(input.customerName || '—')),
    row('Address', escapeHtml(input.address || '—')),
    row('Install', escapeHtml(input.installDate || '—')),
    `</table>`,
  ];
  if (input.materials.length) {
    out.push(
      `<table style="border-collapse:collapse;font-size:13px;">`,
      `<tr style="text-align:left;border-bottom:1px solid #999;"><th style="padding:4px 12px 4px 0;">SKU</th><th style="padding:4px 12px 4px 0;">Item</th><th style="padding:4px 12px 4px 0;text-align:right;">Need</th><th style="padding:4px 12px 4px 0;text-align:right;">On hand</th></tr>`,
      matRows,
      `</table>`,
    );
  } else {
    out.push(`<p style="color:#666;">No bound materials projected for this job.</p>`);
  }
  if (input.unbound.length) {
    out.push(
      `<p style="color:#b45309;margin-top:12px;"><strong>Unbound — no SKU set yet:</strong></p>`,
      `<ul style="font-size:13px;">${input.unbound
        .map((u) => `<li>${escapeHtml(u.label)} × ${u.qty}</li>`)
        .join('')}</ul>`,
    );
  }
  return out.join('\n');
}

// ─── Supplier purchase order (#82 Phase 3 auto-ordering) ─────────────────────
// Emailed to the supplier (Thunder) — the aggregated shortfall across booked
// jobs. Staff review + send (human-gated). Plain order sheet: SKU · item · qty.

export type SupplierOrderLine = { sku: string; name: string; order: number };

export function supplierOrderEmailSubject(jobCount: number, date: string): string {
  return `Yule Love Lights — purchase order (${jobCount} job${jobCount === 1 ? '' : 's'}, ${date})`;
}

export function supplierOrderEmailHtml(input: { lines: SupplierOrderLine[]; jobCount: number; date: string }): string {
  const td = (s: string, extra = '') => `<td style="padding:4px 12px 4px 0;${extra}">${s}</td>`;
  const rows = input.lines
    .map((l) => `<tr>${td(escapeHtml(l.sku), 'font-family:monospace;font-size:12px;')}${td(escapeHtml(l.name))}${td(String(l.order), 'text-align:right;font-weight:bold;')}</tr>`)
    .join('\n');
  return [
    `<p>Hi — please prepare the following order for Yule Love Lights (covers ${input.jobCount} booked job${input.jobCount === 1 ? '' : 's'}, generated ${escapeHtml(input.date)}):</p>`,
    `<table style="border-collapse:collapse;font-size:13px;">`,
    `<tr style="text-align:left;border-bottom:1px solid #999;"><th style="padding:4px 12px 4px 0;">SKU</th><th style="padding:4px 12px 4px 0;">Item</th><th style="padding:4px 12px 4px 0;text-align:right;">Qty</th></tr>`,
    rows,
    `</table>`,
    `<p>Thank you!<br>Yule Love Lights</p>`,
  ].join('\n');
}

// ─── Deposit-paid receipt + alert (#38 ValorPay) ────────────────────────────
// Fired from the Valor payment webhook once a deposit is confirmed (NOT on the
// Approve click). The customer gets a receipt; staff get a "deposit received"
// alert with the txn details for reconciliation against the Valor portal.

// ── Amendment notice (ledger #83 Phase 4) ───────────────────────────────────
// Sent to the customer (staff-initiated, optional — the SPEC §4.4 re-consent
// default) when a booked order is amended to a new total.
export const AMENDMENT_EMAIL_SUBJECT = 'Your Yule Love Lights order was updated';

export function amendmentSmsBody(firstName: string, newBalanceUsd: number, phone: string): string {
  return `Hi ${firstName}! Your Yule Love Lights order was updated — your remaining balance is now ${usd(newBalanceUsd)}. We'll confirm the details with you. Questions? Call or text ${phone}.`;
}

export function amendmentEmailHtml(input: {
  firstName: string;
  newTotalUsd: number;
  newBalanceUsd: number;
  portalUrl: string;
  phone: string;
}): string {
  const name = escapeHtml(input.firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>We've updated your holiday lighting order. Here are the new figures:</p>`,
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0;">`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">New order total</td><td style="padding:2px 0;"><strong>${usdExact(input.newTotalUsd)}</strong></td></tr>`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">Remaining balance</td><td style="padding:2px 0;"><strong>${usdExact(input.newBalanceUsd)}</strong></td></tr>`,
    `</table>`,
    `<p>You can review your order here: <a href="${escapeHtml(input.portalUrl)}">${escapeHtml(input.portalUrl)}</a></p>`,
    `<p>Questions? Call or text ${escapeHtml(input.phone)}.</p>`,
    `<p>— Yule Love Lights</p>`,
  ].join('');
}

// ── Balance pay-link (ledger #83) ───────────────────────────────────────────
// Staff-initiated: after a job is complete, the operator sends the customer a
// link to pay their remaining balance (100% minus whatever deposit percent this
// quote used — #177, not always 50%) on Valor's hosted page
// (/portal/[quoteId]/pay-balance). Distinct from the deposit send — no stage
// move, no booking; just a reach-out with the balance amount + the pay link.
export const BALANCE_LINK_EMAIL_SUBJECT = 'Your Yule Love Lights balance is ready to pay';

export function balanceLinkSmsBody(firstName: string, balanceUsd: number, payUrl: string, phone: string): string {
  return `Hi ${firstName}! 🎄 Your Yule Love Lights install is wrapping up. Your remaining balance of ${usdExact(balanceUsd)} can be paid securely here: ${payUrl}  Questions? Call or text ${phone}.`;
}

export function balanceLinkEmailHtml(input: {
  firstName: string;
  balanceUsd: number;
  payUrl: string;
  phone: string;
}): string {
  const name = escapeHtml(input.firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Your holiday lighting install is wrapping up — thank you! Here's your remaining balance:</p>`,
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0;">`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">Remaining balance</td><td style="padding:2px 0;"><strong>${usdExact(
      input.balanceUsd,
    )}</strong></td></tr>`,
    `</table>`,
    `<p><a href="${escapeHtml(
      input.payUrl,
    )}" style="display:inline-block;padding:10px 18px;background:#1f6f43;color:#fff;text-decoration:none;border-radius:6px;">Pay your balance →</a></p>`,
    `<p style="font-size:13px;color:#666;">Or paste this link into your browser: ${escapeHtml(input.payUrl)}</p>`,
    `<p>Questions? Call or text ${escapeHtml(input.phone)}.</p>`,
    `<p>— Yule Love Lights</p>`,
  ].join('');
}

export const RECEIPT_EMAIL_SUBJECT = 'Your deposit is confirmed — you’re booked! 🎄';

// Customer SMS confirming the deposit posted. Whole-dollar amount; points them
// at the booked/confirmation page.
export function receiptSmsBody(firstName: string, depositUsd: number, phone: string): string {
  return `Hi ${firstName}! 🎄 We received your ${usd(depositUsd)} deposit — you're officially booked with Yule Love Lights. We'll be in touch about your install date. Questions? Call or text ${phone}.`;
}

// Customer receipt email. Includes the deposit amount, the official Valor
// receipt link when present, and the portal/confirmation link.
export function receiptEmailHtml(input: {
  firstName: string;
  depositUsd: number;
  totalUsd: number;
  receiptUrl: string | null;
  confirmationUrl: string;
  phone: string;
}): string {
  const name = escapeHtml(input.firstName);
  const balance = Math.max(0, input.totalUsd - input.depositUsd);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Thank you — your deposit is confirmed and your holiday lighting is officially booked! 🎄</p>`,
    `<table style="border-collapse:collapse;font-size:14px;margin:12px 0;">`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">Deposit paid</td><td style="padding:2px 0;"><strong>${usdExact(
      input.depositUsd,
    )}</strong></td></tr>`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">Order total</td><td style="padding:2px 0;"><strong>${usdExact(
      input.totalUsd,
    )}</strong></td></tr>`,
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">Balance due at install</td><td style="padding:2px 0;"><strong>${usdExact(
      balance,
    )}</strong></td></tr>`,
    `</table>`,
    input.receiptUrl
      ? `<p>Your official payment receipt: <a href="${escapeHtml(input.receiptUrl)}">view receipt →</a></p>`
      : '',
    `<p>We'll be in touch to confirm your install date. You can view your booking anytime here:</p>`,
    `<p><a href="${input.confirmationUrl}">View my booking →</a></p>`,
    `<p>The remaining balance is collected after your install is complete — nothing to do now.</p>`,
    `<p>Questions? Just reply here or text/call us at ${escapeHtml(input.phone)}.</p>`,
    `<p>Warm wishes,<br>Yule Love Lights team</p>`,
  ]
    .filter(Boolean)
    .join('\n');
}

// Internal "deposit received" alert — the second staff notification (the first
// fires on approve). Confirms money actually landed + carries the txn details
// for reconciliation against the Valor portal.
export function internalPaidEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `✅ Deposit received: ${who}`;
}

export function internalPaidEmailHtml(input: {
  customerName: string | null;
  depositUsd: number;
  totalUsd: number;
  // #177: the quote's ACTUAL deposit percent (integer, e.g. 50) — the caller
  // derives it from the frozen result.depositRate, never a hardcoded 50.
  depositPercent: number;
  txnId: string | null;
  approvalCode: string | null;
  receiptUrl: string | null;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const balance = Math.max(0, input.totalUsd - input.depositUsd);
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  return [
    `<p><strong>${name}</strong> just paid their ${input.depositPercent}% deposit online — they're booked.</p>`,
    `<p><strong>Note:</strong> their card is saved in the Valor Vault. Charge the remaining balance (${usdExact(
      balance,
    )}) MANUALLY in the Valor portal after install.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Deposit paid', usdExact(input.depositUsd)),
    row('Order total', usdExact(input.totalUsd)),
    row('Balance due', usdExact(balance)),
    row('Transaction id', escapeHtml(input.txnId || '—')),
    row('Approval code', escapeHtml(input.approvalCode || '—')),
    `</table>`,
    input.receiptUrl
      ? `<p><a href="${escapeHtml(input.receiptUrl)}">Valor receipt →</a> &nbsp;|&nbsp; <a href="${input.adminUrl}">Open in quote tool →</a></p>`
      : `<p><a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

// ─── Card-declined staff alert (#175) ────────────────────────────────────────
// A signed Valor webhook for a non-approved (declined) deposit or balance
// charge previously only console.warned — staff discovered a decline a day
// later on the Valor dashboard while the quote sat approved-but-unpaid with
// zero explanation. The webhook route fires this (throttled — see
// claimDeclineNotifySlot there) so the decline surfaces immediately instead.

const DECLINE_CODE_TEXT: Record<string, string> = {
  '05': "Do not honor — the customer's bank refused; they should call their bank or use another card",
  '51': 'Insufficient funds',
  '14': 'Invalid card number',
  '54': 'Expired card',
  '41': 'Lost card',
  '43': 'Stolen card',
};

// Pure + exported so the code→human mapping is unit-testable on its own,
// and so the admin quote page (#175 stretch) can render the same text.
export function depositDeclineReasonText(code: string | null): string {
  if (!code) return 'Bank declined (no code given)';
  return DECLINE_CODE_TEXT[code] ?? `code ${code} — bank declined`;
}

export function internalDepositDeclinedEmailSubject(input: {
  customerName: string | null;
  quoteNumber: number | null;
  amountUsd: number;
  // 'balance' for the #83 pay-link leg — defaults to the deposit wording.
  kind?: 'deposit' | 'balance';
}): string {
  const who = input.customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  const quoteLabel = input.quoteNumber != null ? ` quote #${input.quoteNumber}` : '';
  const label = input.kind === 'balance' ? 'balance' : 'deposit';
  return `❌ Card DECLINED — ${who}${quoteLabel} ${label} (${usdExact(input.amountUsd)})`;
}

export function internalDepositDeclinedEmailHtml(input: {
  customerName: string | null;
  quoteNumber: number | null;
  amountUsd: number;
  declineCode: string | null;
  adminUrl: string;
  portalUrl: string;
  // 'balance' for the #83 pay-link leg — defaults to the deposit wording.
  kind?: 'deposit' | 'balance';
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const label = input.kind === 'balance' ? 'balance' : 'deposit';
  const quoteLabel = input.quoteNumber != null ? ` (quote #${input.quoteNumber})` : '';
  const row = (labelText: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${labelText}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  return [
    `<p><strong>${name}</strong>${quoteLabel}'s card was DECLINED trying to pay their ${label} (${usdExact(
      input.amountUsd,
    )}).</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Amount', usdExact(input.amountUsd)),
    row('Decline code', escapeHtml(input.declineCode || '—')),
    row('What it means', escapeHtml(depositDeclineReasonText(input.declineCode))),
    `</table>`,
    `<p>No money moved. The customer's portal still shows ${
      label === 'balance' ? 'Pay balance' : 'Complete deposit'
    } — they can retry the same link.</p>`,
    `<p><a href="${input.adminUrl}">${label === 'balance' ? 'Open invoice →' : 'Open in quote tool →'}</a> &nbsp;|&nbsp; <a href="${input.portalUrl}">Customer portal →</a></p>`,
  ].join('\n');
}

// ─── Possible double-charge alert (#110 W1-006) ──────────────────────────────
// A second APPROVED Valor deposit txn arrived for a quote that's already marked
// paid, with a DIFFERENT txn id than the one on file — two live hosted checkout
// pages both got paid. Staff must check Valor and refund the extra charge.

export function duplicatePaymentEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `⚠️ Possible double charge: ${who}`;
}

export function duplicatePaymentEmailHtml(input: {
  customerName: string | null;
  amountUsd: number;
  newTxnId: string | null;
  existingTxnId: string | null;
  adminUrl: string;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  return [
    `<p><strong>${name}</strong>'s deposit was already marked paid, but a SECOND approved Valor charge just came in with a different transaction id — likely two open checkout tabs both got paid.</p>`,
    `<p><strong>Action needed:</strong> check the Valor portal and refund the duplicate charge (${usdExact(
      input.amountUsd,
    )}) manually.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('New (duplicate) txn', escapeHtml(input.newTxnId || '—')),
    row('Existing txn on file', escapeHtml(input.existingTxnId || '—')),
    row('Amount', usdExact(input.amountUsd)),
    `</table>`,
    `<p><a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

// ─── Refund-due alert (#110 W1-008) ──────────────────────────────────────────
// A booked (deposit-paid) order was cancelled — the deposit must be refunded
// manually in Valor. Mirrors the "deposit received" staff alert so a cancelled
// refund obligation is never left to a response the operator might miss.

export function refundDueEmailSubject(customerName: string | null): string {
  const who = customerName?.replace(/[\r\n]+/g, ' ').trim() || 'A customer';
  return `↩️ Refund owed: ${who}`;
}

export function refundDueEmailHtml(input: {
  customerName: string | null;
  amountUsd: number;
  adminUrl: string;
  // WT-17: true when the invoice was already paid IN FULL (deposit + balance
  // both collected — e.g. a completed-then-cancelled order), so the refund
  // owed is the whole order, not just the deposit. Defaults to the original
  // deposit-only copy when omitted.
  full?: boolean;
}): string {
  const name = escapeHtml(input.customerName?.trim() || 'Unknown');
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
  const collectedPhrase = input.full
    ? 'the full order balance was already collected'
    : 'a deposit was already charged';
  const rowLabel = input.full ? 'Full order refund' : 'Deposit to refund';
  return [
    `<p><strong>${name}</strong>'s booked order was cancelled after ${collectedPhrase}.</p>`,
    `<p><strong>Action needed:</strong> issue the refund (${usdExact(
      input.amountUsd,
    )}) manually in the Valor portal.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row(rowLabel, usdExact(input.amountUsd)),
    `</table>`,
    `<p><a href="${input.adminUrl}">Open in quote tool →</a></p>`,
  ].join('\n');
}

// ─── Referral earned notification (ledger #41 follow-up) ────────────────────
// Fired (best-effort, fail-open — see src/lib/referrals.ts notifyReferrerEarned)
// when a referrer's friend books and the referrer earns their $125 next-season
// credit — nudges them to refer again while the win is fresh.

export const REFERRAL_EARNED_EMAIL_SUBJECT = 'You just earned a referral credit! 🎁';

export function referralEarnedSmsBody(friendFirstName: string, amountUsd: number, referLink: string): string {
  return `Great news! ${friendFirstName} just booked with Yule Love Lights, so you've earned ${usd(
    amountUsd,
  )} off next season. Refer another friend anytime: ${referLink}`;
}

export function referralEarnedEmailHtml(friendFirstName: string, amountUsd: number, referLink: string): string {
  const friend = escapeHtml(friendFirstName);
  return [
    `<p>Great news!</p>`,
    `<p><strong>${friend}</strong> just booked with Yule Love Lights, so you've earned <strong>${usd(
      amountUsd,
    )}</strong> off next season.</p>`,
    `<p>There's no limit, refer another friend anytime:</p>`,
    `<p><a href="${escapeHtml(referLink)}">${escapeHtml(referLink)}</a></p>`,
    `<p>Thank you for spreading the word,<br>Yule Love Lights</p>`,
  ].join('\n');
}

// ─── Low-stock alert (#82 stock loop) ────────────────────────────────────────
// A daily digest emailed to staff/purchasing when SKUs hit their reorder point.

export type LowStockEmailRow = { sku: string; name: string; onHand: number; reorderPoint: number };

export function lowStockEmailSubject(count: number): string {
  return `⚠️ Low stock — ${count} item${count === 1 ? '' : 's'} at/below reorder point`;
}

export function lowStockEmailHtml(rows: LowStockEmailRow[]): string {
  const td = (s: string, extra = '') => `<td style="padding:4px 12px 4px 0;${extra}">${s}</td>`;
  const body = rows
    .map(
      (r) =>
        `<tr>${td(escapeHtml(r.sku), 'font-family:monospace;font-size:12px;')}${td(escapeHtml(r.name))}${td(
          String(r.onHand),
          'text-align:right;color:#b45309;font-weight:bold;',
        )}${td(String(r.reorderPoint), 'text-align:right;color:#666;')}</tr>`,
    )
    .join('\n');
  return [
    `<p>${rows.length} item${rows.length === 1 ? ' is' : 's are'} at or below the reorder point — time to restock:</p>`,
    `<table style="border-collapse:collapse;font-size:13px;">`,
    `<tr style="text-align:left;border-bottom:1px solid #999;"><th style="padding:4px 12px 4px 0;">SKU</th><th style="padding:4px 12px 4px 0;">Item</th><th style="padding:4px 12px 4px 0;text-align:right;">On hand</th><th style="padding:4px 12px 4px 0;text-align:right;">Reorder at</th></tr>`,
    body,
    `</table>`,
    `<p style="color:#666;font-size:12px;">Generate a purchase order in the tool: /inventory/orders</p>`,
  ].join('\n');
}

// ─── Colour change applied (ledger #163, staff apply half) ──────────────────
// Fired (best-effort) when staff APPLY a booked customer's requested colour
// change (apply-color-request/route.ts) — confirms the new colour is locked in
// for the install. NOT sent on a dismiss (staff reaches out themselves).

export const COLOR_CHANGE_APPLIED_EMAIL_SUBJECT = 'Your colour change is confirmed';

export function colorChangeAppliedSmsBody(label: string): string {
  return `Yule Love Lights: your light colour change to ${label} is confirmed! It will be reflected on your install.`;
}

export function colorChangeAppliedEmailHtml(firstName: string, label: string): string {
  const name = escapeHtml(firstName);
  const safeLabel = escapeHtml(label);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Your light colour change to <strong>${safeLabel}</strong> is confirmed! It will be reflected on your install.</p>`,
    `<p>Questions? Just reply here or text/call us at (631) 517-0186, we're happy to help!</p>`,
    `<p>Warm wishes,<br>Yule Love Lights team</p>`,
  ].join('\n');
}
