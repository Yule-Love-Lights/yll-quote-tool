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
  depositDeclineReasonText,
  internalDepositDeclinedEmailSubject,
  internalDepositDeclinedEmailHtml,
  amendmentSmsBody,
  amendmentEmailHtml,
  amendmentDeclinedInternalEmailSubject,
  amendmentDeclinedInternalEmailHtml,
  internalReopenRequestedEmailSubject,
  internalReopenRequestedEmailHtml,
  receiptSmsBody,
  receiptEmailHtml,
  referralLinkEmailHtml,
  referralEarnedSmsBody,
  referralEarnedEmailHtml,
  colorChangeAppliedEmailHtml,
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

  // #192 review fix (parity) — the purchasing email gets the same "Booked
  // scope" note as the crew print sheet / board modal / admin BOM panel.
  it('#192 — renders a "Booked scope" note ABOVE the materials table when scopedSides is set', () => {
    const html = orderEmailHtml({
      jobNumber: 1042,
      customerName: 'Jane Doe',
      address: '1 Main St',
      installDate: 'Dec 1, 2026',
      materials: [{ sku: 'APL11012-5', name: 'RGBW set of 5', qty: 3, onHand: 10, short: false }],
      unbound: [],
      scopedSides: ['front', 'back'],
    });
    expect(html).toContain('Booked scope: Front, Back — accessories/gaps remain whole-job.');
    // Above the materials table, not after it.
    expect(html.indexOf('Booked scope')).toBeLessThan(html.indexOf('APL11012-5'));
  });

  it('#192 — no scopedSides (undefined/null/empty) renders no note', () => {
    const base = {
      jobNumber: 1,
      customerName: null,
      address: null,
      installDate: null,
      materials: [],
      unbound: [],
    };
    expect(orderEmailHtml(base)).not.toContain('Booked scope');
    expect(orderEmailHtml({ ...base, scopedSides: null })).not.toContain('Booked scope');
    expect(orderEmailHtml({ ...base, scopedSides: [] })).not.toContain('Booked scope');
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

describe('declined deposit/balance staff alert (#175)', () => {
  describe('depositDeclineReasonText', () => {
    it('translates the common decline codes', () => {
      expect(depositDeclineReasonText('05')).toMatch(/do not honor/i);
      expect(depositDeclineReasonText('51')).toMatch(/insufficient funds/i);
      expect(depositDeclineReasonText('14')).toMatch(/invalid card number/i);
      expect(depositDeclineReasonText('54')).toMatch(/expired card/i);
      expect(depositDeclineReasonText('41')).toMatch(/lost card/i);
      expect(depositDeclineReasonText('43')).toMatch(/stolen card/i);
    });

    it('falls back to a generic "code N" message for an unrecognized code', () => {
      expect(depositDeclineReasonText('99')).toBe('code 99 — bank declined');
    });

    it('handles a missing code', () => {
      expect(depositDeclineReasonText(null)).toMatch(/no code given/i);
    });
  });

  describe('internalDepositDeclinedEmailSubject', () => {
    it('names the customer, with a fallback', () => {
      expect(internalDepositDeclinedEmailSubject({ customerName: 'Jordan Smith', quoteNumber: 12, amountUsd: 1350 })).toContain(
        'Jordan Smith',
      );
      expect(internalDepositDeclinedEmailSubject({ customerName: null, quoteNumber: null, amountUsd: 1350 })).toContain(
        'A customer',
      );
    });

    it('includes the quote number when present, omits it when absent', () => {
      expect(
        internalDepositDeclinedEmailSubject({ customerName: 'Jordan', quoteNumber: 42, amountUsd: 100 }),
      ).toContain('quote #42');
      expect(
        internalDepositDeclinedEmailSubject({ customerName: 'Jordan', quoteNumber: null, amountUsd: 100 }),
      ).not.toContain('quote #');
    });

    it('says "deposit" by default and "balance" for the #83 pay-link leg', () => {
      const deposit = internalDepositDeclinedEmailSubject({ customerName: 'Jordan', quoteNumber: null, amountUsd: 100 });
      const balance = internalDepositDeclinedEmailSubject({
        customerName: 'Jordan',
        quoteNumber: null,
        amountUsd: 100,
        kind: 'balance',
      });
      expect(deposit).toContain('deposit');
      expect(balance).toContain('balance');
    });
  });

  describe('internalDepositDeclinedEmailHtml', () => {
    it('carries the customer, amount, decline code + human translation, and both links', () => {
      const html = internalDepositDeclinedEmailHtml({
        customerName: 'Jordan Smith',
        quoteNumber: 42,
        amountUsd: 1350,
        declineCode: '05',
        adminUrl: 'https://quote.yulelovelights.com/admin/quotes/abc',
        portalUrl: 'https://quote.yulelovelights.com/portal/abc',
      });
      expect(html).toContain('Jordan Smith');
      expect(html).toContain('quote #42');
      expect(html).toContain('$1,350.00');
      expect(html).toContain('05');
      expect(html).toMatch(/do not honor/i);
      expect(html).toContain('No money moved');
      expect(html).toContain('Complete deposit');
      expect(html).toContain('href="https://quote.yulelovelights.com/admin/quotes/abc"');
      expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc"');
    });

    it('shows "Unknown" and an em-dash for a missing name/code', () => {
      const html = internalDepositDeclinedEmailHtml({
        customerName: null,
        quoteNumber: null,
        amountUsd: 500,
        declineCode: null,
        adminUrl: 'https://x/admin/quotes/1',
        portalUrl: 'https://x/portal/1',
      });
      expect(html).toContain('Unknown');
      expect(html).toContain('—');
    });

    it('swaps to balance copy + "Open invoice" for kind: balance', () => {
      const html = internalDepositDeclinedEmailHtml({
        customerName: 'Jordan',
        quoteNumber: null,
        amountUsd: 500,
        declineCode: '51',
        adminUrl: 'https://x/admin/invoices/1',
        portalUrl: 'https://x/portal/1',
        kind: 'balance',
      });
      expect(html).toContain('Pay balance');
      expect(html).not.toContain('Complete deposit');
      expect(html).toContain('Open invoice');
    });

    it('escapes HTML in the customer name', () => {
      const html = internalDepositDeclinedEmailHtml({
        customerName: '<script>',
        quoteNumber: null,
        amountUsd: 100,
        declineCode: '05',
        adminUrl: 'https://x/admin/quotes/1',
        portalUrl: 'https://x/portal/1',
      });
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});


// Jason 2026-08-19 (live amendment for a booked customer): the text and the
// email were quoting DIFFERENT numbers for the same balance — the SMS rounds to
// whole dollars, the email printed exact cents — and neither said WHEN the
// balance is due. Both now round and both say "after installation". The
// greeting is also cased, because customer_name is stored as staff typed it.
//
// REWRITE (Jason 2026-08-19, same day, a real live send): the SMS above still
// shipped with no portal link, no mention that anything changed, and no
// indication the customer needed to do anything — she had to phone in to
// decline verbally because there was no decline path either. Both messages now
// carry the portal link, state the signed direction/size of the change, and
// say plainly that approval is needed (worded calmer for a decrease — see the
// "no rush" tests below).
describe('amendment notice copy (Jason 2026-08-19, portal link + direction/size)', () => {
  const phone = '(631) 517-0186';
  const portalUrl = 'https://quote.yulelovelights.com/portal/1';

  // The brief's own worked example: $1,428.16 → $1,770.72 (deposit $714.08,
  // balance $1,056.64) for an INCREASE; the reverse for a DECREASE.
  const smsIncrease = () =>
    amendmentSmsBody({
      firstName: 'susan',
      newBalanceUsd: 1056.64,
      phone,
      dueAfterInstall: true,
      portalUrl,
      deltaUsd: 342.56,
      newTotalUsd: 1770.72,
    });
  const smsDecrease = () =>
    amendmentSmsBody({
      firstName: 'susan',
      newBalanceUsd: 714.08,
      phone,
      dueAfterInstall: true,
      portalUrl,
      deltaUsd: -342.56,
      newTotalUsd: 1428.16,
    });
  const htmlIncrease = (dueAfterInstall: boolean) =>
    amendmentEmailHtml({
      firstName: 'susan',
      newTotalUsd: 1770.72,
      newBalanceUsd: 1056.64,
      portalUrl,
      phone,
      dueAfterInstall,
      deltaUsd: 342.56,
    });
  const htmlDecrease = () =>
    amendmentEmailHtml({
      firstName: 'susan',
      newTotalUsd: 1428.16,
      newBalanceUsd: 714.08,
      portalUrl,
      phone,
      dueAfterInstall: true,
      deltaUsd: -342.56,
    });

  it('the increase SMS is the exact copy: direction, size, link, approval-needed', () => {
    // FIX8 (review MED): the order total and the balance owed are now
    // explicitly labeled ("a new order total of X" / "You'll owe Y"),
    // replacing the old unlabeled "to X (balance Y)" pairing.
    expect(smsIncrease()).toBe(
      "Hi Susan! Your Yule Love Lights order was changed — the total went up by $342.56 to a new order total of $1,770.72. You'll owe $1,056.64 after installation. This needs your approval before we charge anything at the new amount — nothing changes until you approve it. Review & respond: https://quote.yulelovelights.com/portal/1 Questions? Call or text (631) 517-0186.",
    );
  });

  it('the decrease SMS is the exact copy: calm, no urgency, still links the portal', () => {
    expect(smsDecrease()).toBe(
      "Hi Susan! Good news — your Yule Love Lights order was changed and the total went down by $342.56 to a new order total of $1,428.16. You'll owe $714.08 after installation. Nothing you owe is going up. Please confirm on your portal whenever it's convenient, no rush: https://quote.yulelovelights.com/portal/1 Questions? Call or text (631) 517-0186.",
    );
  });

  it('the SMS includes the portal link (the live-incident gap — email had one, SMS did not)', () => {
    expect(smsIncrease()).toContain(portalUrl);
    expect(smsDecrease()).toContain(portalUrl);
  });

  it('an increase demands approval before charging; a decrease never uses urgency language', () => {
    const inc = smsIncrease();
    const dec = smsDecrease();
    expect(inc).toContain('This needs your approval');
    expect(dec).not.toMatch(/needs your approval|before we charge/i);
    expect(dec).not.toMatch(/urgent|hurry|act now|right away|as soon as possible/i);
    expect(dec).toContain('no rush');
  });

  it('the email mirrors the SMS tone: approval-needed for an increase, no-rush for a decrease', () => {
    const incHtml = htmlIncrease(true);
    const decHtml = htmlDecrease();
    expect(incHtml).toContain('This needs your approval');
    expect(incHtml).not.toContain('no rush');
    expect(decHtml).not.toContain('This needs your approval');
    expect(decHtml).toContain('no rush');
    expect(decHtml).toContain('Nothing you owe is going up');
    expect(decHtml).toContain('$1,428.16');
    expect(decHtml).toContain('$714.08');
  });

  // FIX8 (review MED): "to $1,770.72 (balance $1,056.64...)" ran two
  // unlabeled dollar figures together — nothing distinguished the order
  // total from what's actually owed.
  it('labels the order total and the balance owed distinctly (not two unlabeled figures)', () => {
    const sms = smsIncrease();
    expect(sms).toContain('a new order total of $1,770.72');
    expect(sms).toContain("You'll owe $1,056.64");
    // The old unlabeled pairing is gone.
    expect(sms).not.toContain('to $1,770.72 (balance');
  });

  it('quotes cents, matching the portal card and the invoice rather than rounding', () => {
    // The regression this guards: rounding to whole dollars made the SMS and
    // email agree with each other but DISAGREE with the portal's
    // AmendmentConsentCard (its own 2-decimal formatter) that the email links
    // to for signing, and with the exact-cents invoice.
    const sms = smsIncrease();
    const html = htmlIncrease(true);
    expect(sms).toContain('$1,056.64');
    expect(html).toContain('$1,056.64');
    expect(html).toContain('$1,770.72');
    expect(sms).not.toContain('$1,057');
    expect(html).not.toContain('$1,771');
  });

  it('a balance whose cents would round DOWN still quotes the real figure', () => {
    // usd() rounding is not monotonic in the customer's favour: $842.10 would
    // render "$842", i.e. 10c LESS than what is actually billed.
    const sms = amendmentSmsBody({
      firstName: 'susan',
      newBalanceUsd: 842.1,
      phone,
      dueAfterInstall: true,
      portalUrl,
      deltaUsd: 342.56,
      newTotalUsd: 1770.72,
    });
    expect(sms).toContain('$842.10');
  });

  it('the email labels the balance as due after installation and cases the greeting', () => {
    const html = htmlIncrease(true);
    expect(html).toContain('Remaining balance (due after installation)');
    expect(html).toContain('Hi Susan,');
  });

  it('leaves an already-capitalised name alone and does not re-case the rest of it', () => {
    expect(
      amendmentSmsBody({
        firstName: 'McDonough',
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain('Hi McDonough!');
    expect(
      amendmentSmsBody({
        firstName: "O'Brien",
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain("Hi O'Brien!");
  });

  it('capitalises the first letter ONLY — it does not fix interior capitals', () => {
    // Documents the real limitation rather than implying a full name-caser.
    expect(
      amendmentSmsBody({
        firstName: "o'brien",
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain("Hi O'brien!");
    expect(
      amendmentSmsBody({
        firstName: 'mary-jane',
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain('Hi Mary-jane!');
  });

  it('falls back to the existing "there" greeting without throwing on an empty name', () => {
    expect(
      amendmentSmsBody({
        firstName: '',
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain('Hi !');
    expect(() =>
      amendmentEmailHtml({
        firstName: '',
        newTotalUsd: 1,
        newBalanceUsd: 1,
        portalUrl,
        phone,
        dueAfterInstall: true,
        deltaUsd: 1,
      }),
    ).not.toThrow();
  });

  // Review lens HIGH (original): amending an ALREADY-INSTALLED, already-invoiced
  // job is an ordinary case, and "after installation" would tell that customer
  // a balance they already owe is not due yet.
  it('drops the after-installation clause once the job is already installed', () => {
    const sms = amendmentSmsBody({
      firstName: 'susan',
      newBalanceUsd: 1056.64,
      phone,
      dueAfterInstall: false,
      portalUrl,
      deltaUsd: 342.56,
      newTotalUsd: 1770.72,
    });
    expect(sms).toContain("You'll owe $1,056.64.");
    expect(sms).not.toContain('after installation');
    const html = htmlIncrease(false);
    expect(html).toContain('Remaining balance</td>');
    expect(html).not.toContain('due after installation');
  });

  it('does not capitalise the no-name fallback greeting', () => {
    // route.ts resolves a blank customer_name to the literal 'there' BEFORE
    // calling, so capitalising would produce "Hi There!".
    expect(
      amendmentSmsBody({
        firstName: 'there',
        newBalanceUsd: 100,
        phone,
        dueAfterInstall: true,
        portalUrl,
        deltaUsd: 50,
        newTotalUsd: 150,
      }),
    ).toContain('Hi there!');
  });

  it('escapes HTML in the customer name', () => {
    const html = amendmentEmailHtml({
      firstName: '<script>',
      newTotalUsd: 1,
      newBalanceUsd: 1,
      portalUrl,
      phone,
      dueAfterInstall: true,
      deltaUsd: 1,
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not repeat the staff-typed reason in either message (portal link carries it)', () => {
    // Deliberate design choice — see the module-level comment above
    // amendmentSmsBody/amendmentEmailHtml for why: reason is free text meant
    // for the portal sign-off card, not a carrier-filtered SMS or a second
    // unvetted surface.
    const reasonLikeText = 'added a 36" wreath to the front door';
    expect(smsIncrease()).not.toContain(reasonLikeText);
    expect(htmlIncrease(true)).not.toContain(reasonLikeText);
  });
});

// FIX5 (review HIGH, ledger #83 follow-up): a decline used to write to the DB
// and return JSON to the customer's own browser — nothing told staff. Same
// shape as the Valor webhook's card-declined staff alert (above).
describe('amendmentDeclinedInternalEmailSubject', () => {
  it('names the customer, with a fallback', () => {
    expect(
      amendmentDeclinedInternalEmailSubject({ customerName: 'Jordan Smith', quoteNumber: 12, refusedTotalUsd: 2400 }),
    ).toContain('Jordan Smith');
    expect(
      amendmentDeclinedInternalEmailSubject({ customerName: null, quoteNumber: null, refusedTotalUsd: 2400 }),
    ).toContain('A customer');
  });

  it('includes the quote number when present, omits it when absent', () => {
    expect(
      amendmentDeclinedInternalEmailSubject({ customerName: 'Jordan', quoteNumber: 42, refusedTotalUsd: 100 }),
    ).toContain('quote #42');
    expect(
      amendmentDeclinedInternalEmailSubject({ customerName: 'Jordan', quoteNumber: null, refusedTotalUsd: 100 }),
    ).not.toContain('quote #');
  });

  it('says DECLINED and states the refused amount', () => {
    const subject = amendmentDeclinedInternalEmailSubject({
      customerName: 'Jordan',
      quoteNumber: 42,
      refusedTotalUsd: 2400,
    });
    expect(subject).toContain('DECLINED');
    expect(subject).toContain('$2,400.00');
  });
});

describe('amendmentDeclinedInternalEmailHtml', () => {
  const base = {
    customerName: 'Jordan Smith',
    quoteNumber: 42,
    previousTotalUsd: 2000,
    refusedTotalUsd: 2400,
    deltaUsd: 400,
    adminUrl: 'https://quote.yulelovelights.com/admin/quotes/abc',
    portalUrl: 'https://quote.yulelovelights.com/portal/abc',
  };

  it('carries the customer, both totals, the signed delta, and both links', () => {
    const html = amendmentDeclinedInternalEmailHtml(base);
    expect(html).toContain('Jordan Smith');
    expect(html).toContain('quote #42');
    expect(html).toContain('$2,000.00'); // stays-at (previous) total
    expect(html).toContain('$2,400.00'); // the refused total
    expect(html).toContain('+$400.00'); // signed delta
    expect(html).toContain(base.adminUrl);
    expect(html).toContain(base.portalUrl);
  });

  it('shows a NEGATIVE sign for a declined price decrease', () => {
    const html = amendmentDeclinedInternalEmailHtml({ ...base, deltaUsd: -400 });
    expect(html).toContain('-$400.00');
    expect(html).not.toContain('+-$400.00');
  });

  it('includes the customer-typed reason when given, safely HTML-escaped', () => {
    const html = amendmentDeclinedInternalEmailHtml({
      ...base,
      reason: 'too expensive <script>alert(1)</script>',
    });
    expect(html).toContain('Their reason');
    expect(html).toContain('too expensive');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits the reason row entirely when no reason was given', () => {
    const html = amendmentDeclinedInternalEmailHtml(base);
    expect(html).not.toContain('Their reason');
  });

  it('falls back to "Unknown" for a null customer name', () => {
    const html = amendmentDeclinedInternalEmailHtml({ ...base, customerName: null });
    expect(html).toContain('Unknown');
  });
});

// Ledger row 236, fix round (four-lens LOW) — the quote number is threaded
// through in the SAME subject/body format as the money-alert siblings above
// (amendmentDeclinedInternalEmail*/internalDepositDeclinedEmail*).
describe('internalReopenRequestedEmailSubject (row 236)', () => {
  it('names the customer, with a fallback', () => {
    expect(internalReopenRequestedEmailSubject({ customerName: 'Jordan Smith', quoteNumber: 12 })).toContain(
      'Jordan Smith',
    );
    expect(internalReopenRequestedEmailSubject({ customerName: null, quoteNumber: null })).toContain('A customer');
  });

  it('includes the quote number when present, omits it when absent', () => {
    expect(internalReopenRequestedEmailSubject({ customerName: 'Jordan', quoteNumber: 42 })).toContain('quote #42');
    expect(internalReopenRequestedEmailSubject({ customerName: 'Jordan', quoteNumber: null })).not.toContain(
      'quote #',
    );
  });
});

describe('internalReopenRequestedEmailHtml (row 236)', () => {
  const base = {
    customerName: 'Jordan Smith',
    quoteNumber: 42,
    address: '1 Main St',
    phone: '+15555550123',
    email: 'jordan@example.com',
    status: 'declined',
    portalUrl: 'https://quote.yulelovelights.com/portal/abc',
    adminUrl: 'https://quote.yulelovelights.com/quote/abc',
  };

  it('carries the customer, quote number, status, and both links', () => {
    const html = internalReopenRequestedEmailHtml(base);
    expect(html).toContain('Jordan Smith');
    expect(html).toContain('(quote #42)');
    expect(html).toContain('declined');
    expect(html).toContain('href="https://quote.yulelovelights.com/quote/abc"');
    expect(html).toContain('href="https://quote.yulelovelights.com/portal/abc"');
  });

  it('omits the quote-number label entirely when quoteNumber is null', () => {
    const html = internalReopenRequestedEmailHtml({ ...base, quoteNumber: null });
    expect(html).not.toContain('(quote #');
  });

  it('shows "Unknown" for a missing name and reflects an abandoned status', () => {
    const html = internalReopenRequestedEmailHtml({ ...base, customerName: null, status: 'abandoned' });
    expect(html).toContain('Unknown');
    expect(html).toContain('abandoned');
  });

  it('escapes HTML in the customer name', () => {
    const html = internalReopenRequestedEmailHtml({ ...base, customerName: '<script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// Row 315: greetingName (the first-letter-only casing helper, shipped #805)
// was wired into ONLY the amendment SMS/email — every other customer greeting
// still rendered the raw stored name, so one customer could read "Hi susan!"
// on the quote-ready text and "Hi Susan!" on the amendment text in the same
// thread. Every customer-greeting builder below now routes through the same
// helper. Each function gets BOTH directions: a lowercase name gets
// capitalised, and an already-capitalised name is byte-identical to before
// (greetingName only ever touches the first character).
describe('greeting casing sweep (row 315): every customer greeting routes through greetingName', () => {
  it('quoteSmsBody capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(quoteSmsBody('susan', 'https://x/portal/1', 'holiday')).toContain('Hi Susan!');
    expect(quoteSmsBody('Susan', 'https://x/portal/1', 'holiday')).toContain('Hi Susan!');
  });

  it("the literal 'there' fallback passes through every swept builder uncapitalised (value-based exemption)", () => {
    expect(quoteSmsBody('there', 'https://x/portal/1', 'holiday')).toContain('Hi there!');
    expect(quoteEmailHtml('there', 'https://x/portal/1', 'holiday')).toContain('Hi there,');
    expect(approvalSmsBody('there', 2700, '(631) 517-0186', 50)).toContain('Hi there!');
  });

  it('quoteEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(quoteEmailHtml('susan', 'https://x/portal/1', 'holiday')).toContain('Hi Susan,');
    expect(quoteEmailHtml('Susan', 'https://x/portal/1', 'holiday')).toContain('Hi Susan,');
  });

  it('approvalSmsBody capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(approvalSmsBody('susan', 2700, '(631) 517-0186', 50)).toContain('Hi Susan!');
    expect(approvalSmsBody('Susan', 2700, '(631) 517-0186', 50)).toContain('Hi Susan!');
  });

  it('approvalEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(approvalEmailHtml('susan', 2700, 'https://x/portal/1', '(631) 517-0186', 50)).toContain('Hi Susan,');
    expect(approvalEmailHtml('Susan', 2700, 'https://x/portal/1', '(631) 517-0186', 50)).toContain('Hi Susan,');
  });

  it('balanceLinkSmsBody capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(balanceLinkSmsBody('susan', 551.91, 'https://x/portal/1/pay-balance', '(631) 517-0186')).toContain('Hi Susan!');
    expect(balanceLinkSmsBody('Susan', 551.91, 'https://x/portal/1/pay-balance', '(631) 517-0186')).toContain('Hi Susan!');
  });

  it('balanceLinkEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    const args = (firstName: string) => ({
      firstName,
      balanceUsd: 551.91,
      payUrl: 'https://x/portal/1/pay-balance',
      phone: '(631) 517-0186',
    });
    expect(balanceLinkEmailHtml(args('susan'))).toContain('Hi Susan,');
    expect(balanceLinkEmailHtml(args('Susan'))).toContain('Hi Susan,');
  });

  it('receiptSmsBody capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(receiptSmsBody('susan', 2700, '(631) 517-0186')).toContain('Hi Susan!');
    expect(receiptSmsBody('Susan', 2700, '(631) 517-0186')).toContain('Hi Susan!');
  });

  it('receiptEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    const args = (firstName: string) => ({
      firstName,
      depositUsd: 2700,
      totalUsd: 5400,
      receiptUrl: null,
      confirmationUrl: 'https://x/portal/1',
      phone: '(631) 517-0186',
    });
    expect(receiptEmailHtml(args('susan'))).toContain('Hi Susan,');
    expect(receiptEmailHtml(args('Susan'))).toContain('Hi Susan,');
  });

  // Review fix 4: the SMS/email fired the moment a referrer actually earns
  // are the exact moment someone assumes they were given money, so both
  // must say plainly, next to the amount, that it is a credit, not cash.
  it('referralEarnedSmsBody states the credit-not-cash distinction next to the amount', () => {
    const body = referralEarnedSmsBody('Riley', 125, 'https://x/refer/abc');
    expect(body).toContain('$125');
    expect(body).toContain("It's a credit, not cash");
    expect(body).not.toContain('—');
  });

  it('referralEarnedEmailHtml states the credit-not-cash distinction next to the amount', () => {
    const html = referralEarnedEmailHtml('Riley', 125, 'https://x/refer/abc');
    expect(html).toContain('$125');
    expect(html).toContain('credit, not cash');
    expect(html).toContain('any Yule Love Lights service');
    expect(html).not.toContain('—');
  });

  const REFERRAL_LINK_REWARD_TERMS = { creditUsd: 125, creditExpiryYears: 2, spritzerCount: 2, spritzerSizeInches: 16 };

  it('referralLinkEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    const referralUrl = 'https://x/refer/abc';
    expect(referralLinkEmailHtml({ firstName: 'susan', referralUrl, ...REFERRAL_LINK_REWARD_TERMS })).toContain(
      'Hi Susan,',
    );
    expect(referralLinkEmailHtml({ firstName: 'Susan', referralUrl, ...REFERRAL_LINK_REWARD_TERMS })).toContain(
      'Hi Susan,',
    );
  });

  it("referralLinkEmailHtml still falls back to 'there' (unchanged) for a missing/blank name", () => {
    const referralUrl = 'https://x/refer/abc';
    expect(referralLinkEmailHtml({ firstName: null, referralUrl, ...REFERRAL_LINK_REWARD_TERMS })).toContain(
      'Hi there,',
    );
    expect(referralLinkEmailHtml({ firstName: '   ', referralUrl, ...REFERRAL_LINK_REWARD_TERMS })).toContain(
      'Hi there,',
    );
  });

  it('referralLinkEmailHtml states the credit toward ANY service (not a same-service repeat) and dollarizes the spritzer reward', () => {
    const html = referralLinkEmailHtml({
      firstName: 'Susan',
      referralUrl: 'https://x/refer/abc',
      ...REFERRAL_LINK_REWARD_TERMS,
    });
    expect(html).toContain('$125 in credit');
    expect(html).toContain('any Yule Love Lights service');
    expect(html).toContain('$170');
    expect(html).toContain('$150 off');
    expect(html).not.toContain('next YLL job');
    expect(html).not.toContain('—');
  });

  // Review fix 5: this email is sent before any friend has booked, so a
  // bare "good for 2 years" reads as "from today." The expiry actually
  // stamps at the friend's booking (accrueOnBooking, src/lib/referrals.ts).
  // Also proves the year count is a real parameter, never a hardcoded
  // "two years" literal (it used to be one).
  it('referralLinkEmailHtml derives the expiry years from a real parameter and says the clock starts at the friend\'s booking', () => {
    const html = referralLinkEmailHtml({
      firstName: 'Susan',
      referralUrl: 'https://x/refer/abc',
      ...REFERRAL_LINK_REWARD_TERMS,
    });
    expect(html).toContain('good for 2 years from when they book');

    const htmlWithDifferentExpiry = referralLinkEmailHtml({
      firstName: 'Susan',
      referralUrl: 'https://x/refer/abc',
      ...REFERRAL_LINK_REWARD_TERMS,
      creditExpiryYears: 3,
    });
    expect(htmlWithDifferentExpiry).toContain('good for 3 years from when they book');
    expect(htmlWithDifferentExpiry).not.toContain('good for 2 years');
  });

  // Review fix 9: "you get $X in credit... They get $Y in free lighting"
  // used to read as a direct comparison in one sentence. Now split into two
  // paragraphs, and the friend's reward is framed as something the
  // referrer is GIVING, not a competing prize.
  it('referralLinkEmailHtml does not present the referrer credit and the friend gift as a side-by-side comparison', () => {
    const html = referralLinkEmailHtml({
      firstName: 'Susan',
      referralUrl: 'https://x/refer/abc',
      ...REFERRAL_LINK_REWARD_TERMS,
    });
    expect(html).not.toContain('book. They get');
    expect(html).toContain('also be giving them');
  });

  it('colorChangeAppliedEmailHtml capitalises a lowercase name and leaves an already-capitalised one alone', () => {
    expect(colorChangeAppliedEmailHtml('susan', 'Warm White')).toContain('Hi Susan,');
    expect(colorChangeAppliedEmailHtml('Susan', 'Warm White')).toContain('Hi Susan,');
  });

  it('never fixes interior capitals (documents the shared limitation, not a full name-caser)', () => {
    expect(quoteSmsBody("o'brien", 'https://x/portal/1', 'holiday')).toContain("Hi O'brien!");
    expect(receiptSmsBody("o'brien", 2700, '(631) 517-0186')).toContain("Hi O'brien!");
  });
});
