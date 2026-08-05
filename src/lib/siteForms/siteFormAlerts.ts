// Staff alerts for non-lead website submissions (#195).
//
// Deliberately a sibling of leadAlerts.ts rather than a reuse of it: a lead
// alert is a sales alert ("call this person"), while these are "a newsletter
// signup came in", "someone applied for a job", "a neighbour was nominated".
// Same fail-open contract though: an email outage must never break the
// submission, so nothing here throws.

import { sendEmail } from '@/lib/integrations/highlevel';
import type { SiteFormType } from './siteFormService';

export type SiteFormAlertInput = {
  formType: SiteFormType;
  formVariant: string;
  name?: string | null;
  email: string;
  phone?: string | null;
  payload?: Record<string, unknown>;
  hasResume?: boolean;
  landingUrl?: string | null;
};

const SUBJECTS: Record<SiteFormType, string> = {
  newsletter: 'New newsletter signup',
  careers: 'New job application',
  intern: 'New intern application',
  nomination: 'New Light Up For Hope nomination',
};

// Labels for the payload keys the forms actually send, so the email reads like
// a form rather than a database row.
const FIELD_LABELS: Record<string, string> = {
  holidayMemory: 'Favorite holiday memory',
  role: 'Role applying for',
  message: 'Message',
  nomineeName: "Nominee's name",
  nomineeAddress: "Nominee's home address",
  nomineeEmail: "Nominee's email",
  nomineePhone: "Nominee's phone",
  relationship: 'Your relationship to them',
  story: 'Their story',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildSiteFormAlertEmail(input: SiteFormAlertInput): {
  subject: string;
  html: string;
} {
  const who = input.name?.trim() || input.email;
  const subject = `${SUBJECTS[input.formType]}: ${who}`;

  const rows: Array<[string, string]> = [];
  if (input.name) rows.push(['Name', input.name]);
  rows.push(['Email', input.email]);
  if (input.phone) rows.push(['Phone', input.phone]);

  for (const [key, value] of Object.entries(input.payload ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    rows.push([FIELD_LABELS[key] ?? key, String(value)]);
  }

  if (input.hasResume) {
    rows.push(['Resume', 'Attached, open the submission in the tool to download it']);
  }
  if (input.landingUrl) rows.push(['Submitted from', input.landingUrl]);
  rows.push(['Form', `${input.formType} (${input.formVariant})`]);

  const html = [
    `<h2>${esc(SUBJECTS[input.formType])}</h2>`,
    '<table cellpadding="6" style="border-collapse:collapse">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="border:1px solid #ddd"><strong>${esc(label)}</strong></td>` +
        `<td style="border:1px solid #ddd">${esc(value)}</td></tr>`,
    ),
    '</table>',
    input.formType === 'nomination'
      ? '<p style="color:#666">The nominated person has not been contacted and is not in any automation. ' +
        'Reach out to them yourself if this goes ahead.</p>'
      : '',
  ].join('\n');

  return { subject, html };
}

export type SiteFormAlertResult = 'sent' | 'skipped';

/** Best-effort staff email. Never throws. */
export async function sendSiteFormAlertEmail(
  input: SiteFormAlertInput,
): Promise<SiteFormAlertResult> {
  const contactId =
    process.env.HIGHLEVEL_LEADS_ALERT_CONTACT_ID || process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
  if (!contactId) {
    console.warn(
      '[siteFormAlerts] no HIGHLEVEL_LEADS_ALERT_CONTACT_ID / HIGHLEVEL_INTERNAL_CONTACT_ID set — alert email skipped',
    );
    return 'skipped';
  }
  try {
    const { subject, html } = buildSiteFormAlertEmail(input);
    await sendEmail({
      contactId,
      subject,
      html,
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    return 'sent';
  } catch (err) {
    console.error('[siteFormAlerts] send failed:', err);
    return 'skipped';
  }
}

/** Short Telegram line. Kept deliberately free of the nominee's contact details. */
export function siteFormTelegramMessage(input: SiteFormAlertInput): string {
  const who = input.name?.trim() || input.email;
  switch (input.formType) {
    case 'newsletter':
      return `Newsletter signup: ${who}`;
    case 'careers':
      return `Job application: ${who}${input.hasResume ? ' (resume attached)' : ''}`;
    case 'intern':
      return `Intern application: ${who}${input.hasResume ? ' (resume attached)' : ''}`;
    case 'nomination': {
      const nominee = String(input.payload?.nomineeName ?? '').trim();
      return `Light Up For Hope nomination from ${who}${nominee ? ` for ${nominee}` : ''}`;
    }
  }
}
