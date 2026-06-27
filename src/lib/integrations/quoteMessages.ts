// Customer-facing copy for the "quote sent" notifications (#37), delivered via
// GHL (SMS + Email) when staff hit "Send Quote." Kept in one place so the
// wording is easy to tweak. The caller fills in the customer's first name and
// the portal link.

export const QUOTE_EMAIL_SUBJECT = 'Your Yule Love Lights quote is ready 🎄';

export function quoteSmsBody(firstName: string, portalUrl: string): string {
  return `Hi ${firstName}! 🎄 Your custom Yule Love Lights quote is ready — view your design, see the price, and approve here: ${portalUrl}  Reply with any questions!`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function quoteEmailHtml(firstName: string, portalUrl: string): string {
  const name = escapeHtml(firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Your custom holiday lighting quote is ready.</p>`,
    `<p>We've put together a design showing exactly how your home will look, with a full line-item breakdown and your price. You can review it, adjust what's included, and approve right from the page:</p>`,
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

export function approvalSmsBody(firstName: string, depositUsd: number, phone: string): string {
  return `Hi ${firstName}! 🎄 Thanks for approving your Yule Love Lights quote. We'll reach out shortly to collect your 50% deposit (about ${usd(depositUsd)}) and lock in your install date — nothing to do right now. Questions? Call or text us at ${phone}.`;
}

export function approvalEmailHtml(
  firstName: string,
  depositUsd: number,
  portalUrl: string,
  phone: string,
): string {
  const name = escapeHtml(firstName);
  return [
    `<p>Hi ${name},</p>`,
    `<p>Thanks for approving your holiday lighting quote! 🎄</p>`,
    `<p>Here's what happens next: a member of our team will reach out to you shortly to collect your <strong>50% deposit (about ${usd(depositUsd)})</strong> and lock in your install date.</p>`,
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
    `<p><strong>Action:</strong> reach out to collect the 50% deposit (${usdExact(input.depositUsd)}) to lock them in on the schedule.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    row('Customer', name),
    row('Phone', escapeHtml(input.phone || '—')),
    row('Email', escapeHtml(input.email || '—')),
    row('Address', escapeHtml(input.address || '—')),
    row('Package', escapeHtml(input.packageName)),
    row('Total', usdExact(input.totalUsd)),
    row('Deposit (50%)', usdExact(input.depositUsd)),
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

// ─── Deposit-paid receipt + alert (#38 ValorPay) ────────────────────────────
// Fired from the Valor payment webhook once a deposit is confirmed (NOT on the
// Approve click). The customer gets a receipt; staff get a "deposit received"
// alert with the txn details for reconciliation against the Valor portal.

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
    `<p><strong>${name}</strong> just paid their 50% deposit online — they're booked.</p>`,
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
