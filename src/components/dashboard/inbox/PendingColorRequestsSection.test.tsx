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
});
