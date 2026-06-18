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
