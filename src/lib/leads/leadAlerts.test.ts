// Tests for the staff email lead-alert builder + sender (leadAlerts.ts).
// buildLeadAlertEmail is pure and exercised directly; sendLeadAlertEmail's
// contact-resolution fallback is covered with sendEmail mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn<
    (input: { contactId: string; subject: string; html: string; emailFrom?: string }) => Promise<unknown>
  >(async () => ({})),
}));

vi.mock('@/lib/integrations/highlevel', () => ({ sendEmail }));
vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));

import { buildLeadAlertEmail, sendLeadAlertEmail, type LeadAlertInput } from './leadAlerts';

const BASE_LEAD: LeadAlertInput = {
  name: 'Jordan Lead',
  email: 'jordan@example.com',
  phone: '+16315551234',
  address: '12 Candy Cane Ln',
  service: 'christmas',
  formVariant: 'bar',
  notes: 'Wants icicle lights',
  landingUrl: 'https://yulelovelights.com/christmas',
};

describe('buildLeadAlertEmail', () => {
  it('full lead: subject has no PARTIAL prefix and body has no callout', () => {
    const { subject, html } = buildLeadAlertEmail(BASE_LEAD, { partial: false });
    expect(subject).toBe('New website lead — Jordan Lead (christmas)');
    expect(html).not.toContain('PARTIAL');
    expect(html).toContain('tel:+16315551234');
    expect(html).toContain('mailto:jordan@example.com');
    expect(html).toContain('12 Candy Cane Ln');
    expect(html).toContain('Wants icicle lights');
    expect(html).toContain('https://yulelovelights.com/christmas');
    expect(html).toContain('https://quote.yulelovelights.com/admin/leads');
  });

  it('partial lead: subject says Partial and body has the abandoned callout', () => {
    const { subject, html } = buildLeadAlertEmail(BASE_LEAD, { partial: true });
    expect(subject).toBe('Partial website lead — Jordan Lead (christmas)');
    expect(html).toContain('PARTIAL — abandoned before submitting');
  });

  it('escapes a hostile name (HTML injection) in the HTML body', () => {
    // Subject is a plain-text email header field (not rendered as HTML), so
    // the raw name is expected there — only the HTML body needs escaping.
    const hostile: LeadAlertInput = { ...BASE_LEAD, name: '<img src=x onerror=alert(1)>' };
    const { html } = buildLeadAlertEmail(hostile, { partial: false });
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes hostile values in every other field too', () => {
    const hostile: LeadAlertInput = {
      ...BASE_LEAD,
      address: '<script>evil()</script>',
      notes: '<b>bold</b>',
      formVariant: '"><script>x</script>',
    };
    const { html } = buildLeadAlertEmail(hostile, { partial: false });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
  });

  it('escapes double-quotes so phone/email cannot break out of the href attribute', () => {
    // phone/email are interpolated inside href="tel:…"/href="mailto:…" — a
    // quote in the value must not terminate the attribute and inject markup.
    const hostile: LeadAlertInput = {
      ...BASE_LEAD,
      phone: '555" onmouseover="alert(1)',
      email: 'a"b@example.com',
    };
    const { html } = buildLeadAlertEmail(hostile, { partial: false });
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).not.toContain('555" onmouseover');
    expect(html).toContain('tel:555&quot; onmouseover=&quot;alert(1)');
    expect(html).toContain('mailto:a&quot;b@example.com');
  });

  it('renders — for missing address and notes', () => {
    const sparse: LeadAlertInput = {
      name: 'No Extras',
      service: 'permanent',
      formVariant: 'sidebar',
      email: 'noextras@example.com',
      phone: '5551234567',
      address: null,
      notes: null,
    };
    const { html } = buildLeadAlertEmail(sparse, { partial: false });
    // Two "—" cells: address and notes only (phone/email are present).
    expect(html.match(/>—</g)?.length).toBe(2);
  });

  it('renders — for missing phone/email instead of a broken link', () => {
    const noContact: LeadAlertInput = {
      name: 'Only Name',
      service: 'landscape',
      formVariant: 'footer',
      email: '',
      phone: null,
    };
    const { html } = buildLeadAlertEmail(noContact, { partial: false });
    expect(html).not.toContain('tel:');
    expect(html).not.toContain('mailto:');
  });

  it('omits the landing-page row when none is given', () => {
    const noLanding: LeadAlertInput = { ...BASE_LEAD, landingUrl: null };
    const { html } = buildLeadAlertEmail(noLanding, { partial: false });
    expect(html).not.toContain('Landing page');
  });
});

describe('sendLeadAlertEmail — contact-resolution fallback order', () => {
  const ENV_KEYS = ['HIGHLEVEL_LEADS_ALERT_CONTACT_ID', 'HIGHLEVEL_INTERNAL_CONTACT_ID', 'HIGHLEVEL_EMAIL_FROM'];

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it('prefers HIGHLEVEL_LEADS_ALERT_CONTACT_ID when both are set', async () => {
    process.env.HIGHLEVEL_LEADS_ALERT_CONTACT_ID = 'leads-contact';
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-contact';
    const result = await sendLeadAlertEmail(BASE_LEAD, { partial: false });
    expect(result).toBe('sent');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ contactId: 'leads-contact' });
  });

  it('falls back to HIGHLEVEL_INTERNAL_CONTACT_ID when the leads-alert id is unset', async () => {
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-contact';
    const result = await sendLeadAlertEmail(BASE_LEAD, { partial: false });
    expect(result).toBe('sent');
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ contactId: 'internal-contact' });
  });

  it('skips silently when neither env var is set', async () => {
    const result = await sendLeadAlertEmail(BASE_LEAD, { partial: false });
    expect(result).toBe('skipped');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never throws — a send failure is caught and reported as skipped', async () => {
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-contact';
    sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    await expect(sendLeadAlertEmail(BASE_LEAD, { partial: false })).resolves.toBe('skipped');
  });

  it('passes emailFrom through when configured', async () => {
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-contact';
    process.env.HIGHLEVEL_EMAIL_FROM = 'sales@yulelovelights.com';
    await sendLeadAlertEmail(BASE_LEAD, { partial: false });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ emailFrom: 'sales@yulelovelights.com' });
  });
});
