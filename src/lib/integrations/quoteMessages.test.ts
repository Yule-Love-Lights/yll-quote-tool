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
  BALANCE_LINK_EMAIL_SUBJECT,
  balanceLinkSmsBody,
  balanceLinkEmailHtml,
  quoteEmailSubject,
  quoteSmsBody,
  quoteEmailHtml,
} from './quoteMessages';

describe('quote-ready notifications, per service type (S26)', () => {
  const PORTAL_URL = 'https://quote.yulelovelights.com/portal/abc';

  it('holiday SMS is the exact copy', () => {
    expect(quoteSmsBody('Jordan', PORTAL_URL, 'holiday')).toBe(
      'Hi Jordan! 🎄 Your custom Yule Love Lights quote is ready! View your design, see the price, and approve here: https://quote.yulelovelights.com/portal/abc Reply with any questions!',
    );
  });

  it('permanent SMS is the exact copy', () => {
    expect(quoteSmsBody('Jordan', PORTAL_URL, 'permanent')).toBe(
      'Hi Jordan! ✨ Your custom Yule Love Lights Permanent Lighting quote is ready! View your design, see the price, and approve here: https://quote.yulelovelights.com/portal/abc Reply with any questions!',
    );
  });

  it('event SMS is the exact copy', () => {
    expect(quoteSmsBody('Jordan', PORTAL_URL, 'event')).toBe(
      'Hi Jordan! ✨ Your custom Yule Love Lights Event Lighting quote is ready! View your design, see the price, and approve here: https://quote.yulelovelights.com/portal/abc Reply with any questions!',
    );
  });

  it('event SMS/email are the permanent copy with Event/event substituted for Permanent/permanent', () => {
    const perm = quoteSmsBody('Jordan', PORTAL_URL, 'permanent');
    const evt = quoteSmsBody('Jordan', PORTAL_URL, 'event');
    expect(evt).toBe(perm.replace('Permanent Lighting', 'Event Lighting'));

    const permHtml = quoteEmailHtml('Jordan', PORTAL_URL, 'permanent');
    const evtHtml = quoteEmailHtml('Jordan', PORTAL_URL, 'event');
    expect(evtHtml).toBe(permHtml.replace('permanent lighting', 'event lighting'));

    expect(quoteEmailSubject('event')).toBe(quoteEmailSubject('permanent').replace('Permanent', 'Event'));
  });

  it('per-type subjects', () => {
    expect(quoteEmailSubject('holiday')).toBe('Your Yule Love Lights quote is ready 🎄');
    expect(quoteEmailSubject('permanent')).toBe('Your Yule Love Lights Permanent Lighting quote is ready ✨');
    expect(quoteEmailSubject('event')).toBe('Your Yule Love Lights Event Lighting quote is ready ✨');
    expect(quoteEmailSubject('permanent_bistro')).toBe('Your Yule Love Lights Bistro Lighting quote is ready ✨');
  });

  it('permanent_bistro gets its own distinct copy (not byte-identical to any other type, S26 carrier-dedup lesson)', () => {
    const subjects = ['holiday', 'permanent', 'event', 'permanent_bistro'].map((t) => quoteEmailSubject(t));
    expect(new Set(subjects).size).toBe(subjects.length);
    const sms = ['holiday', 'permanent', 'event', 'permanent_bistro'].map((t) => quoteSmsBody('Jordan', PORTAL_URL, t));
    expect(new Set(sms).size).toBe(sms.length);
  });

  it('defaults to holiday for an unknown/missing service_type', () => {
    expect(quoteEmailSubject(null)).toBe(quoteEmailSubject('holiday'));
    expect(quoteEmailSubject(undefined)).toBe(quoteEmailSubject('holiday'));
    expect(quoteEmailSubject('not-a-real-type')).toBe(quoteEmailSubject('holiday'));
    expect(quoteSmsBody('Jordan', PORTAL_URL, 'bogus')).toBe(quoteSmsBody('Jordan', PORTAL_URL, 'holiday'));
    expect(quoteEmailHtml('Jordan', PORTAL_URL, undefined)).toBe(quoteEmailHtml('Jordan', PORTAL_URL, 'holiday'));
  });

  it("holiday email keeps its ORIGINAL wording byte-for-byte (line-item breakdown, 'holiday lighting')", () => {
    const html = quoteEmailHtml('Jordan', PORTAL_URL, 'holiday');
    expect(html).toContain('Your custom holiday lighting quote is ready.');
    expect(html).toContain('with a full line-item breakdown and your price.');
    expect(html).toContain(`<p><a href="${PORTAL_URL}">View my quote →</a></p>`);
    expect(html).toContain("we're happy to help!");
  });

  it('permanent/event email bodies use "item breakdown" (no line- prefix) and the right lighting noun', () => {
    const perm = quoteEmailHtml('Jordan', PORTAL_URL, 'permanent');
    expect(perm).toContain('Your custom permanent lighting quote is ready.');
    expect(perm).toContain('with a full item breakdown and your price.');

    const evt = quoteEmailHtml('Jordan', PORTAL_URL, 'event');
    expect(evt).toContain('Your custom event lighting quote is ready.');
    expect(evt).toContain('with a full item breakdown and your price.');
  });

  it('escapes HTML in the first name', () => {
    const html = quoteEmailHtml('<script>', PORTAL_URL, 'permanent');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

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
  it('does NOT carry a "replaces the prior order" disclaimer (#110 W7-002 fixed by the P8 on-order ledger — each order is a delta, additive to earlier ones)', () => {
    const html = supplierOrderEmailHtml({ jobCount: 1, date: 'Jul 6, 2026', lines: [{ sku: 'X', name: 'Y', order: 5 }] });
    expect(html).not.toContain('replaces');
    expect(html).not.toMatch(/not in addition/i);
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
    it('greets by first name, names the deposit percent + amount, and gives the phone', () => {
      const sms = approvalSmsBody('Jordan', 2700, '(631) 517-0186', 50);
      expect(sms).toContain('Jordan');
      expect(sms).toContain('50% deposit');
      expect(sms).toContain('$2,700'); // whole-dollar, comma-grouped
      expect(sms).toContain('(631) 517-0186');
      // It must NOT imply an immediate online payment.
      expect(sms.toLowerCase()).toContain('nothing to do right now');
    });

    it('rounds the deposit to whole dollars in customer copy', () => {
      const sms = approvalSmsBody('Sam', 2700.5, '(631) 517-0186', 50);
      expect(sms).toContain('$2,701');
      expect(sms).not.toContain('.50');
    });

    // #177 — a staff-set per-quote deposit override renders its OWN percent,
    // not a hardcoded 50%.
    it('renders a per-quote deposit percent override', () => {
      const sms = approvalSmsBody('Jordan', 675, '(631) 517-0186', 25);
      expect(sms).toContain('25% deposit');
      expect(sms).not.toContain('50%');
    });
  });

  describe('approvalEmailHtml', () => {
    it('includes the name, deposit amount, portal link, and phone', () => {
      const html = approvalEmailHtml('Jordan', 2700, 'https://quote.yulelovelights.com/portal/abc', '(631) 517-0186', 50);
      expect(html).toContain('Jordan');
      expect(html).toContain('$2,700');
      expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc"');
      expect(html).toContain('(631) 517-0186');
      expect(html).toContain('50% deposit');
    });

    it('escapes HTML in the first name', () => {
      const html = approvalEmailHtml('<script>', 100, 'https://x/portal/1', '(631) 517-0186', 50);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders a per-quote deposit percent override', () => {
      const html = approvalEmailHtml('Jordan', 675, 'https://x/portal/1', '(631) 517-0186', 25);
      expect(html).toContain('25% deposit');
      expect(html).not.toContain('50%');
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
        depositPercent: 50,
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
        depositPercent: 50,
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

    // #177 — a staff-set per-quote deposit override renders its OWN percent in
    // both the action line and the table row label.
    it('renders a per-quote deposit percent override', () => {
      const html = internalApprovalEmailHtml({
        customerName: 'Jordan Smith',
        address: null,
        phone: null,
        email: null,
        totalUsd: 2700,
        depositUsd: 675,
        depositPercent: 25,
        packageName: 'Package C',
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
        portalUrl: 'https://x/portal/1',
        adminUrl: 'https://x/quote/1',
      });
      expect(html).toContain('collect the 25% deposit');
      expect(html).toContain('Deposit (25%)');
      expect(html).not.toContain('50%');
    });
  });

  it('approval email subject is stable copy', () => {
    expect(APPROVAL_EMAIL_SUBJECT).toMatch(/approved/i);
  });
});

describe('balance pay-link notifications (#83)', () => {
  describe('balanceLinkSmsBody', () => {
    it('greets by first name, shows the EXACT balance (cents), the pay link, and the phone', () => {
      const sms = balanceLinkSmsBody('Jordan', 551.91, 'https://quote.yulelovelights.com/portal/abc/pay-balance', '(631) 517-0186');
      expect(sms).toContain('Jordan');
      expect(sms).toContain('$551.91'); // exact cents — it's a real payment amount
      expect(sms).toContain('https://quote.yulelovelights.com/portal/abc/pay-balance');
      expect(sms).toContain('(631) 517-0186');
    });
  });

  describe('balanceLinkEmailHtml', () => {
    it('includes the name, exact balance, pay link, and phone', () => {
      const html = balanceLinkEmailHtml({
        firstName: 'Jordan',
        balanceUsd: 551.91,
        payUrl: 'https://quote.yulelovelights.com/portal/abc/pay-balance',
        phone: '(631) 517-0186',
      });
      expect(html).toContain('Jordan');
      expect(html).toContain('$551.91');
      expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc/pay-balance"');
      expect(html).toContain('(631) 517-0186');
    });

    it('escapes HTML in the first name', () => {
      const html = balanceLinkEmailHtml({
        firstName: '<script>',
        balanceUsd: 100,
        payUrl: 'https://x/portal/1/pay-balance',
        phone: '(631) 517-0186',
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  it('subject is stable copy about the balance', () => {
    expect(BALANCE_LINK_EMAIL_SUBJECT).toMatch(/balance/i);
  });
});
