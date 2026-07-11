// Ledger #41 — smoke coverage for the quote builder's "Referred by" picker.
// Renders with react-dom/server (same approach as ReferralSection.test.tsx —
// no jsdom needed for these two static states).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferredByPicker } from './ReferredByPicker';

describe('ReferredByPicker', () => {
  it('shows the search input when nothing is picked yet', () => {
    const html = renderToStaticMarkup(<ReferredByPicker value={null} onChange={() => {}} />);
    expect(html).toContain('Referred by (optional)');
    expect(html).toContain('Search existing customers');
  });

  it('shows a "Referred by <name>" chip with a Change control once a customer is picked', () => {
    const html = renderToStaticMarkup(
      <ReferredByPicker value={{ id: 'c1', name: 'Jordan Smith' }} onChange={() => {}} />,
    );
    expect(html).toContain('Referred by Jordan Smith');
    expect(html).toContain('Change');
    expect(html).not.toContain('Search existing customers');
  });
});
