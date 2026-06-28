import { describe, it, expect } from 'vitest';
import {
  APPROVAL_EMAIL_SUBJECT,
  approvalSmsBody,
  approvalEmailHtml,
  internalApprovalEmailSubject,
  internalApprovalEmailHtml,
  orderEmailSubject,
  orderEmailHtml,
  supplierOrderEmailSubject,
  supplierOrderEmailHtml,
  lowStockEmailSubject,
  lowStockEmailHtml,
} from './quoteMessages';

describe('supplier purchase order email (#82 Phase 3)', () => {
  it('subject names the job count', () => {
    expect(supplierOrderEmailSubject(3, 'Jun 28, 2026')).toContain('3 jobs');
    expect(supplierOrderEmailSubject(1, 'Jun 28, 2026')).toContain('1 job,');
  });
  it('renders order rows (qty) and escapes names', () => {
    const html = supplierOrderEmailHtml({
      jobCount: 2,
      date: 'Jun 28, 2026',
      lines: [
        { sku: '14147', name: 'C9 Flex Clip', order: 300 },
        { sku: '50036-30', name: 'Noble <Wreath>', order: 4 },
      ],
    });
    expect(html).toContain('2 booked jobs');
    expect(html).toContain('14147');
    expect(html).toContain('C9 Flex Clip');
    expect(html).toContain('300');
    expect(html).toContain('Noble &lt;Wreath&gt;'); // <> escaped
  });
});

describe('inventory order email (#82 Slice 3)', () => {
  it('subject names the job number + customer, strips newlines', () => {
    expect(orderEmailSubject(1042, 'Jane Doe')).toBe('📦 Materials order — Job #1042 (Jane Doe)');
    expect(orderEmailSubject(null, null)).toBe('📦 Materials order — Job #—');
    expect(orderEmailSubject(7, 'Bad\nName')).toBe('📦 Materials order — Job #7 (Bad Name)');
  });

  it('renders the materials rows, flags short stock, and escapes names', () => {
    const html = orderEmailHtml({
      jobNumber: 1042,
      customerName: 'A & B <Co>',
      address: '1 Main St',
      installDate: 'Dec 1, 2026',
      materials: [
        { sku: '14147', name: 'C9 Flex Clip', qty: 40, onHand: 10, short: true },
        { sku: '50036-30', name: '36" Noble', qty: 1, onHand: 5, short: false },
      ],
      unbound: [{ label: 'Warm White C9 bulb × 30', qty: 30 }],
    });
    expect(html).toContain('Job #1042');
    expect(html).toContain('14147');
    expect(html).toContain('C9 Flex Clip');
    expect(html).toContain('SHORT'); // short stock flagged
    expect(html).toContain('A &amp; B &lt;Co&gt;'); // escaped
    expect(html).toContain('Unbound');
    expect(html).toContain('Warm White C9 bulb × 30');
  });

  it('handles an empty materials list', () => {
    const html = orderEmailHtml({ jobNumber: 1, customerName: null, address: null, installDate: null, materials: [], unbound: [] });
    expect(html).toContain('No bound materials projected');
  });
});

describe('low-stock alert email (#82)', () => {
  it('subject counts items (singular/plural)', () => {
    expect(lowStockEmailSubject(1)).toContain('1 item ');
    expect(lowStockEmailSubject(3)).toContain('3 items');
  });
  it('renders the rows (on-hand + reorder) and escapes names', () => {
    const html = lowStockEmailHtml([
      { sku: '14147', name: 'C9 Flex Clip', onHand: 5, reorderPoint: 100 },
      { sku: '50036-30', name: 'Noble <Wreath>', onHand: 0, reorderPoint: 6 },
    ]);
    expect(html).toContain('14147');
    expect(html).toContain('C9 Flex Clip');
    expect(html).toContain('Reorder at');
    expect(html).toContain('Noble &lt;Wreath&gt;'); // escaped
  });
});

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
