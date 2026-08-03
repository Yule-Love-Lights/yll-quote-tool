// Staff email alert for a new website lead — full (POST /api/leads) or
// partial/abandoned (POST /api/leads/partial). The business previously only
// learned about leads via Telegram; this adds an email delivered through GHL
// (sendEmail → a GHL contact) to sales@yulelovelights.com, mirroring the
// internal-alert mechanism the low-stock cron uses (src/app/api/inventory/
// low-stock-alert/route.ts) and the row/table HTML style of the internal
// approval/decline alerts (src/lib/integrations/quoteMessages.ts).

import { sendEmail } from '@/lib/integrations/highlevel';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';

export type LeadAlertInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  service: string;
  formVariant: string;
  notes?: string | null;
  landingUrl?: string | null;
};

// No HTML-escape helper is exported anywhere in the codebase (quoteMessages.ts
// keeps its own private copy) — minimal local copy, same behavior (&, <, >
// only, matching that existing precedent). Leads are untrusted website input.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:2px 14px 2px 0;color:#666;">${label}</td><td style="padding:2px 0;"><strong>${value}</strong></td></tr>`;
}

/** Pure: builds the subject + HTML body. No IO. */
export function buildLeadAlertEmail(
  lead: LeadAlertInput,
  opts: { partial: boolean },
): { subject: string; html: string } {
  const name = lead.name?.trim() || 'Unknown';
  const safeName = escapeHtml(name);
  const subject = `${opts.partial ? 'Partial website lead' : 'New website lead'} — ${name} (${lead.service})`;

  const phone = lead.phone?.trim() || '';
  const email = lead.email?.trim() || '';
  const phoneValue = phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : '—';
  const emailValue = email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : '—';

  const rows = [
    row('Name', safeName),
    row('Phone', phoneValue),
    row('Email', emailValue),
    row('Address', escapeHtml(lead.address?.trim() || '—')),
    row('Service', escapeHtml(lead.service)),
    row('Form variant', escapeHtml(lead.formVariant)),
    row('Notes', escapeHtml(lead.notes?.trim() || '—')),
  ];
  if (lead.landingUrl) rows.push(row('Landing page', escapeHtml(lead.landingUrl)));

  const html = [
    opts.partial
      ? `<p style="color:#b45309;font-weight:bold;">⚠️ PARTIAL — abandoned before submitting</p>`
      : '',
    `<table style="border-collapse:collapse;font-size:14px;">`,
    rows.join('\n'),
    `</table>`,
    `<p><a href="${appBaseUrl()}/admin/leads">Open in leads inbox →</a></p>`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject, html };
}

export type LeadAlertResult = 'sent' | 'skipped';

/**
 * Best-effort staff email alert. Resolves the target GHL contact from
 * HIGHLEVEL_LEADS_ALERT_CONTACT_ID, falling back to HIGHLEVEL_INTERNAL_CONTACT_ID
 * (the same sales@ contact the deposit-approval alert uses) — if neither is
 * set, this silently no-ops ('skipped'). NEVER throws: an email/GHL outage
 * must never break lead capture, mirroring notifyTelegram's fail-open contract.
 */
export async function sendLeadAlertEmail(
  lead: LeadAlertInput,
  opts: { partial: boolean },
): Promise<LeadAlertResult> {
  const contactId = process.env.HIGHLEVEL_LEADS_ALERT_CONTACT_ID || process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!contactId) return 'skipped';
  try {
    const { subject, html } = buildLeadAlertEmail(lead, opts);
    await sendEmail({
      contactId,
      subject,
      html,
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    return 'sent';
  } catch (err) {
    console.error('[leadAlerts] send failed:', err);
    return 'skipped';
  }
}
