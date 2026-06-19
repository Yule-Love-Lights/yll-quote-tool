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
