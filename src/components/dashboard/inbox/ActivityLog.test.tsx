// Smoke coverage for the #58/#308/#311 activity log, same no-jsdom
// renderToStaticMarkup approach as InboxList.test.tsx / InWorksSection.test.tsx
// (see their own header comments) — this only proves the INITIAL render, not
// the interactive Reverse flow (handleReverse's fetch/click choreography is
// not driveable without jsdom, matching this repo's established convention).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityLog } from './ActivityLog';
import type { ActivityRow } from '@/lib/dashboard/inbox/store';

const base: ActivityRow = {
  id: 'a1',
  action: 'handled',
  actor: null,
  actorName: null,
  itemId: 'item-1',
  customerName: 'Jane Doe',
  at: '2026-08-20T12:00:00Z',
  reversible: true,
};

describe('ActivityLog — row 311 fix-round FIX 2 (action_failed rendering)', () => {
  it('renders "Action failed" (not the raw literal) for an action_failed row', () => {
    const rows: ActivityRow[] = [
      { ...base, id: 'a2', action: 'action_failed', reversible: false, detail: { action: 'followed', error: 'Item is completed or dismissed; cannot mark followed' } },
    ];
    const html = renderToStaticMarkup(<ActivityLog initialRows={rows} />);
    expect(html).toContain('Action failed');
    expect(html).not.toMatch(/>action_failed</);
  });

  it("renders the detail line as '{friendly verb} failed: {error}' for a guard refusal", () => {
    const rows: ActivityRow[] = [
      { ...base, id: 'a3', action: 'action_failed', reversible: false, detail: { action: 'followed', error: 'Item is completed or dismissed; cannot mark followed' } },
    ];
    const html = renderToStaticMarkup(<ActivityLog initialRows={rows} />);
    expect(html).toContain('Followed up failed: Item is completed or dismissed; cannot mark followed');
  });

  it('renders the detail line for a real DB error the same way — the two read differently without a separate classifier', () => {
    const rows: ActivityRow[] = [
      { ...base, id: 'a4', action: 'action_failed', reversible: false, detail: { action: 'handled', error: 'connection reset' } },
    ];
    const html = renderToStaticMarkup(<ActivityLog initialRows={rows} />);
    expect(html).toContain('Handled failed: connection reset');
  });

  it('never renders a detail line for an ordinary (non-action_failed) row', () => {
    const rows: ActivityRow[] = [{ ...base, detail: { action: 'handled', error: 'should never render' } }];
    const html = renderToStaticMarkup(<ActivityLog initialRows={rows} />);
    expect(html).not.toContain('should never render');
  });

  it('never renders a detail line for an action_failed row with no detail (defensive — should not happen in practice)', () => {
    const rows: ActivityRow[] = [{ ...base, id: 'a5', action: 'action_failed', reversible: false }];
    const html = renderToStaticMarkup(<ActivityLog initialRows={rows} />);
    expect(html).toContain('Action failed');
    expect(html).not.toContain('failed:');
  });
});
