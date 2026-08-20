// Row 321 — smoke coverage for the /inbox "Pending colour requests" section,
// same no-jsdom renderToStaticMarkup approach as ActivityLog.test.tsx /
// InboxList.test.tsx / InWorksSection.test.tsx (see their own header
// comments). This component is server-rendered with no client interactivity,
// so a static-markup render exercises everything it does.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PendingColorRequestsSection } from './PendingColorRequestsSection';
import type { PendingColorRequestItem } from '@/lib/dashboard/inbox/types';

const NOW = new Date('2026-08-20T12:00:00Z').getTime();

describe('PendingColorRequestsSection (row 321)', () => {
  it('renders nothing when there are no pending requests', () => {
    const html = renderToStaticMarkup(<PendingColorRequestsSection items={[]} nowMs={NOW} />);
    expect(html).toBe('');
  });

  it('renders customer, quote number, requested colour, age, and a link to the admin quote page', () => {
    const items: PendingColorRequestItem[] = [
      {
        quoteId: '61807a29-1359-42cc-a0c2-8c22fb4c1aa6',
        quoteNumber: 1129,
        customerName: 'Kristie Tibbetts',
        label: "Staff's pick",
        requestedAt: '2026-07-29T15:15:41.787Z', // 22 days before NOW
      },
    ];
    const html = renderToStaticMarkup(<PendingColorRequestsSection items={items} nowMs={NOW} />);
    expect(html).toContain('Kristie Tibbetts');
    expect(html).toContain('#1129');
    expect(html).toContain('Staff&#x27;s pick');
    expect(html).toContain('21d ago');
    expect(html).toContain('/admin/quotes/61807a29-1359-42cc-a0c2-8c22fb4c1aa6');
    expect(html).toContain('Pending colour requests (1)');
  });

  it('renders "today" for a request made less than a day ago', () => {
    const items: PendingColorRequestItem[] = [
      { quoteId: 'q-1', quoteNumber: 1, customerName: 'Same Day', label: 'Champagne', requestedAt: new Date(NOW - 60_000).toISOString() },
    ];
    const html = renderToStaticMarkup(<PendingColorRequestsSection items={items} nowMs={NOW} />);
    expect(html).toContain('today');
  });

  it('falls back to "Unknown" when the customer name is missing, and omits the age when requestedAt is null', () => {
    const items: PendingColorRequestItem[] = [
      { quoteId: 'q-2', quoteNumber: null, customerName: null, label: 'Custom pattern', requestedAt: null },
    ];
    const html = renderToStaticMarkup(<PendingColorRequestsSection items={items} nowMs={NOW} />);
    expect(html).toContain('Unknown');
    expect(html).not.toContain('d ago');
    expect(html).not.toContain('undefined');
  });

  // Row 321 fix-round FIX 4 (staff LOW): the section used to render every row
  // full-width with no cap or scroll. Caps the render at MAX_VISIBLE (20) and
  // shows a WT-41-style "more not shown" note for the overflow.
  describe('cap (row 321 fix-round FIX 4)', () => {
    // The component trusts its `items` prop is already oldest-first (store.ts
    // listPendingColorRequests' own sort) and never re-sorts — index 0 here is
    // deliberately the OLDEST (smallest requestedAt), matching that contract,
    // so slice(0, MAX_VISIBLE) is provably "the oldest N".
    function makeItems(n: number): PendingColorRequestItem[] {
      return Array.from({ length: n }, (_, i) => ({
        quoteId: `q-${i}`,
        quoteNumber: i,
        customerName: `Customer ${i}`,
        label: 'Champagne',
        requestedAt: new Date(NOW - (n - i) * 86_400_000).toISOString(),
      }));
    }

    it('shows no truncation note when the population is at or below the cap', () => {
      const html = renderToStaticMarkup(<PendingColorRequestsSection items={makeItems(20)} nowMs={NOW} />);
      expect(html).toContain('Customer 19');
      expect(html).not.toContain('more not shown');
    });

    it('caps the render at 20 rows and names the overflow count', () => {
      const items = makeItems(25);
      const html = renderToStaticMarkup(<PendingColorRequestsSection items={items} nowMs={NOW} />);
      // The first 20 (indices 0-19, the OLDEST 20 per makeItems' construction)
      // are shown; the 5 newest (indices 20-24) are the overflow.
      expect(html).toContain('Customer 19');
      expect(html).not.toContain('Customer 20');
      expect(html).not.toContain('Customer 24');
      expect(html).toContain('Showing the oldest 20 of 25');
      expect(html).toContain('5 more not shown');
      // The heading count is still the TRUE total, not the capped render count.
      expect(html).toContain('Pending colour requests (25)');
    });
  });
});
