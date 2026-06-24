import { describe, it, expect } from 'vitest';
import {
  APPROVAL_EMAIL_SUBJECT,
  approvalSmsBody,
  approvalEmailHtml,
  internalApprovalEmailSubject,
  internalApprovalEmailHtml,
  RECEIPT_EMAIL_SUBJECT,
  receiptSmsBody,
  receiptEmailHtml,
  internalPaidEmailSubject,
  internalPaidEmailHtml,
} from './quoteMessages';

describe('approval notifications (pre-Valor deposit flow)', () => {
  describe('approvalSmsBody', () => {
    it('greets by first name, names the 50% deposit + amount, and gives the phone', () => {
      const sms = approvalSmsBody('Jordan', 2700, '(631) 517-0186');
      expect(sms).toContain('Jordan');
      expect(sms).toContain('50% deposit');
      expect(sms).toContain('$2,700'); // whole-dollar, comma-grouped
      expect(sms).toContain('(631) 517-0186');
      // It must NOT imply an immediate online payment.
      expect(sms.toLowerCase()).toContain('nothing to do right now');
    });

    it('rounds the deposit to whole dollars in customer copy', () => {
      const sms = approvalSmsBody('Sam', 2700.5, '(631) 517-0186');
      expect(sms).toContain('$2,701');
      expect(sms).not.toContain('.50');
    });
  });

  describe('approvalEmailHtml', () => {
    it('includes the name, deposit amount, portal link, and phone', () => {
      const html = approvalEmailHtml('Jordan', 2700, 'https://quote.yulelovelights.com/portal/abc', '(631) 517-0186');
      expect(html).toContain('Jordan');
      expect(html).toContain('$2,700');
      expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc"');
      expect(html).toContain('(631) 517-0186');
      expect(html).toContain('50% deposit');
    });

    it('escapes HTML in the first name', () => {
      const html = approvalEmailHtml('<script>', 100, 'https://x/portal/1', '(631) 517-0186');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('internal notification', () => {
    it('subject names the customer, with a fallback', () => {
      expect(internalApprovalEmailSubject('Jordan Smith')).toContain('Jordan Smith');
      expect(internalApprovalEmailSubject(null)).toContain('A customer');
      expect(internalApprovalEmailSubject('   ')).toContain('A customer');
    });

    it('body carries the full quote detail + action + links', () => {
      const html = internalApprovalEmailHtml({
        customerName: 'Jordan Smith',
        address: '12 Main St, Kings Park NY',
        phone: '631-555-0123',
        email: 'jordan@example.com',
        totalUsd: 5400,
        depositUsd: 2700,
        packageName: 'Build Your Own',
        installTiming: 'september',
        rushSelected: false,
        takedownSelected: true,
        portalUrl: 'https://quote.yulelovelights.com/portal/abc',
        adminUrl: 'https://quote.yulelovelights.com/quote/abc',
      });
      expect(html).toContain('Jordan Smith');
      expect(html).toContain('12 Main St, Kings Park NY');
      expect(html).toContain('631-555-0123');
      expect(html).toContain('jordan@example.com');
      expect(html).toContain('$5,400.00'); // exact (cents) for internal record
      expect(html).toContain('$2,700.00');
      expect(html).toContain('Build Your Own');
      expect(html).toContain('September'); // early-install label
      expect(html).toContain('collect the 50% deposit');
      expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc"');
      expect(html).toContain('href="https://quote.yulelovelights.com/quote/abc"');
      // premium takedown was true, rush false
      expect(html).toContain('Premium takedown');
    });

    it('shows em-dash placeholders for missing contact fields', () => {
      const html = internalApprovalEmailHtml({
        customerName: null,
        address: null,
        phone: null,
        email: null,
        totalUsd: 1000,
        depositUsd: 500,
        packageName: 'Package C',
        installTiming: 'none',
        rushSelected: true,
        takedownSelected: false,
        portalUrl: 'https://x/portal/1',
        adminUrl: 'https://x/quote/1',
      });
      expect(html).toContain('Unknown'); // customer name fallback
      expect(html).toContain('Standard (Nov–Dec)'); // install timing 'none'
    });
  });

  it('approval email subject is stable copy', () => {
    expect(APPROVAL_EMAIL_SUBJECT).toMatch(/approved/i);
  });
});

describe('payment-confirmed notifications (Valor deposit flow)', () => {
  it('receipt SMS confirms the deposit landed (not "we will reach out")', () => {
    const sms = receiptSmsBody('Jordan', 2700, '(631) 517-0186');
    expect(sms).toContain('Jordan');
    expect(sms).toContain('$2,700');
    expect(sms).toContain('(631) 517-0186');
    expect(sms.toLowerCase()).toContain('received your');
    expect(sms.toLowerCase()).toContain('booked');
  });

  it('receipt email shows deposit, total, balance, and the Valor receipt link when present', () => {
    const html = receiptEmailHtml({
      firstName: 'Jordan',
      depositUsd: 2700,
      totalUsd: 5400,
      receiptUrl: 'https://valor/receipt/abc',
      confirmationUrl: 'https://quote.yulelovelights.com/portal/abc/approved',
      phone: '(631) 517-0186',
    });
    expect(html).toContain('Jordan');
    expect(html).toContain('$2,700.00'); // deposit
    expect(html).toContain('$5,400.00'); // total
    expect(html).toContain('$2,700.00'); // balance == total - deposit
    expect(html).toContain('href="https://valor/receipt/abc"');
    expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc/approved"');
  });

  it('receipt email omits the receipt-link line when no URL is available', () => {
    const html = receiptEmailHtml({
      firstName: 'Sam',
      depositUsd: 500,
      totalUsd: 1000,
      receiptUrl: null,
      confirmationUrl: 'https://x/portal/1/approved',
      phone: '(631) 517-0186',
    });
    expect(html).not.toContain('view receipt');
    expect(html).toContain('$500.00');
  });

  it('receipt email escapes HTML in the first name', () => {
    const html = receiptEmailHtml({
      firstName: '<script>',
      depositUsd: 100,
      totalUsd: 200,
      receiptUrl: null,
      confirmationUrl: 'https://x/portal/1/approved',
      phone: '(631) 517-0186',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('internal paid subject names the customer with a fallback', () => {
    expect(internalPaidEmailSubject('Jordan Smith')).toContain('Jordan Smith');
    expect(internalPaidEmailSubject(null)).toContain('A customer');
  });

  it('internal paid email carries txn details + the manual-balance instruction', () => {
    const html = internalPaidEmailHtml({
      customerName: 'Jordan Smith',
      depositUsd: 2700,
      totalUsd: 5400,
      txnId: 'TXN-123',
      approvalCode: 'AUTH99',
      receiptUrl: 'https://valor/receipt/abc',
      adminUrl: 'https://quote.yulelovelights.com/quote/abc',
    });
    expect(html).toContain('Jordan Smith');
    expect(html).toContain('$2,700.00'); // deposit
    expect(html).toContain('$2,700.00'); // balance
    expect(html).toContain('TXN-123');
    expect(html).toContain('AUTH99');
    expect(html).toContain('MANUALLY'); // staff instruction to charge balance in Valor
    expect(html).toContain('href="https://valor/receipt/abc"');
    expect(html).toContain('href="https://quote.yulelovelights.com/quote/abc"');
  });

  it('receipt email subject references the deposit/booking', () => {
    expect(RECEIPT_EMAIL_SUBJECT).toMatch(/deposit|booked/i);
  });
});
