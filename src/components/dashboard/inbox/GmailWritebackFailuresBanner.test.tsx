// Row 342 fix round — smoke coverage for the Gmail write-back failure banner,
// same no-jsdom renderToStaticMarkup approach as its siblings (InboxList.test.tsx
// et al. — see their own header comments). useRouter (next/navigation) throws
// outside an app-router context, mocked the same way InboxList.test.tsx does.
// This proves the STATIC render only: the drill-down list (label + error text
// per row), the truncation note, and the Retry button's presence. The
// click-then-fetch retry flow itself isn't exercised here (no jsdom in this
// repo) — same limitation InboxList.test.tsx's own header comment documents
// for act().

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { GmailWritebackFailuresBanner } from './GmailWritebackFailuresBanner';
import type { GmailWritebackFailure } from '@/lib/dashboard/inbox/store';

describe('GmailWritebackFailuresBanner', () => {
  it('renders the total, a labeled row per failing item, its error text, and a Retry button', () => {
    const items: GmailWritebackFailure[] = [
      { id: 'i1', label: 'Jane Doe', error: 'invalid_grant: token expired', status: 'failed' },
      { id: 'i2', label: 'bob@example.com', error: null, status: 'failed' },
    ];
    const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={2} truncated={false} />);

    expect(html).toContain('2 Handled items never got the YLL/Handled');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('invalid_grant: token expired');
    expect(html).toContain('bob@example.com');
    expect(html).toContain('Retry');
    expect(html).not.toContain('the rest aren');
  });

  it('singular phrasing for exactly one failure', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'failed' }];
    const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={1} truncated={false} />);
    expect(html).toContain('1 Handled item never got the YLL/Handled');
    expect(html).not.toContain('1 Handled items');
  });

  it('names the developer contact (no in-app Gmail reconnect exists) rather than telling staff to fix the token themselves', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'failed' }];
    const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={1} truncated={false} />);
    expect(html).toContain('tell Jason or Naldo');
  });

  it('shows a truncation note naming the shown vs. true total when the list is capped', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'failed' }];
    const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={25} truncated={true} />);
    expect(html).toContain('Showing the 1 most recently handled of 25');
  });

  // Fix round MED 1: an 'unconfigured' item (Gmail had no credentials at all)
  // gets a DISTINCT leading sentence from a plain per-item 'failed' error —
  // conflating "the whole channel is down" with "a handful of items errored"
  // would bury the worse case.
  describe('unconfigured (fix round MED 1 — total Gmail outage)', () => {
    it('leads with the "Gmail isn\'t connected" sentence, not the per-item "write-back failing" one, when any item is unconfigured', () => {
      const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'unconfigured' }];
      const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={1} truncated={false} />);
      expect(html).toContain("Gmail isn&#x27;t connected right now");
      expect(html).not.toContain('Gmail write-back failing —');
    });

    it('shows "Gmail wasn\'t connected" per-row instead of a blank/null error', () => {
      const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'unconfigured' }];
      const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={1} truncated={false} />);
      expect(html).toContain("Gmail wasn&#x27;t connected when this was handled");
    });

    it('uses the plain per-item copy when every item is a real failure (no unconfigured rows present)', () => {
      const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: 'boom', status: 'failed' }];
      const html = renderToStaticMarkup(<GmailWritebackFailuresBanner items={items} total={1} truncated={false} />);
      expect(html).toContain('Gmail write-back failing —');
      expect(html).not.toContain("Gmail isn&#x27;t connected right now");
    });
  });
});
