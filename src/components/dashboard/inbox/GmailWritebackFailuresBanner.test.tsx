// Row 342 fix round — smoke coverage for the Gmail write-back failure banner,
// same no-jsdom renderToStaticMarkup approach as its siblings (InboxList.test.tsx
// et al. — see their own header comments). useRouter (next/navigation) throws
// outside an app-router context, mocked the same way InboxList.test.tsx does.
// This proves the STATIC render only: the headline, the drill-down list
// (label + error text per row), the truncation note, and the Retry button's
// presence. The click-then-fetch retry flow itself isn't exercised here (no
// jsdom in this repo) — same limitation InboxList.test.tsx's own header
// comment documents for act().
//
// Second fix round (delta-verify MED): gmailWritebackHeadline is exported and
// tested DIRECTLY (not just through rendered markup) specifically so a mixed
// failed+unconfigured population — the gap that let the "prints the combined
// total under a condition-specific sentence" bug through undetected — is
// pinned as its own fixture, both at the pure-function level and through a
// full render.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { GmailWritebackFailuresBanner, gmailWritebackHeadline } from './GmailWritebackFailuresBanner';
import type { GmailWritebackFailure } from '@/lib/dashboard/inbox/store';

describe('gmailWritebackHeadline (pure)', () => {
  it('failed-only: names failedCount, never unconfiguredCount, plural', () => {
    const h = gmailWritebackHeadline(5, 0);
    expect(h).toContain('Gmail write-back failing — 5 Handled items never got the YLL/Handled label');
  });

  it('failed-only: singular phrasing for exactly 1', () => {
    const h = gmailWritebackHeadline(1, 0);
    expect(h).toContain('Gmail write-back failing — 1 Handled item never got the YLL/Handled label');
    expect(h).not.toContain('1 Handled items');
  });

  it('unconfigured-only: names unconfiguredCount, never failedCount', () => {
    const h = gmailWritebackHeadline(0, 7);
    expect(h).toContain("Gmail isn't connected right now — 7 Handled items couldn't sync to Gmail AT ALL");
    expect(h).not.toContain('Gmail write-back failing —');
  });

  // The exact defect the delta-verify caught: a mixed population must not
  // collapse to either single-condition sentence, and each number in the
  // sentence must be the count that condition actually names — not
  // failedCount+unconfiguredCount combined.
  it('mixed: names BOTH counts, each attached to its own condition, and picks neither single-condition sentence', () => {
    const h = gmailWritebackHeadline(9, 3);
    expect(h).toContain('3 Handled items');
    expect(h).toContain("couldn't sync because Gmail wasn't connected at all");
    expect(h).toContain('and 9 more failed for other reasons');
    // Neither single-condition headline appears (would misstate the count):
    expect(h).not.toContain('Gmail write-back failing —');
    expect(h).not.toContain("Gmail isn't connected right now —");
    // The combined total (12) never appears anywhere in the sentence:
    expect(h).not.toContain('12');
  });

  it('mixed with exactly 1 of each: singular phrasing on the unconfigured count', () => {
    const h = gmailWritebackHeadline(4, 1);
    expect(h).toContain('1 Handled item');
    expect(h).not.toContain('1 Handled items');
    expect(h).toContain('4 more failed');
  });
});

describe('GmailWritebackFailuresBanner (rendered)', () => {
  it('renders a labeled row per failing item, its error text, and a Retry button', () => {
    const items: GmailWritebackFailure[] = [
      { id: 'i1', label: 'Jane Doe', error: 'invalid_grant: token expired', status: 'failed' },
      { id: 'i2', label: 'bob@example.com', error: null, status: 'failed' },
    ];
    const html = renderToStaticMarkup(
      <GmailWritebackFailuresBanner items={items} total={2} failedCount={2} unconfiguredCount={0} truncated={false} />,
    );

    expect(html).toContain('2 Handled items never got the YLL/Handled');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('invalid_grant: token expired');
    expect(html).toContain('bob@example.com');
    expect(html).toContain('Retry');
    expect(html).not.toContain('the rest aren');
  });

  it('names the developer contact (no in-app Gmail reconnect exists) rather than telling staff to fix the token themselves', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'failed' }];
    const html = renderToStaticMarkup(
      <GmailWritebackFailuresBanner items={items} total={1} failedCount={1} unconfiguredCount={0} truncated={false} />,
    );
    expect(html).toContain('tell Jason or Naldo');
  });

  it('the truncation note uses the COMBINED total ("...of {total}"), independent of the headline counts', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'failed' }];
    const html = renderToStaticMarkup(
      <GmailWritebackFailuresBanner items={items} total={25} failedCount={20} unconfiguredCount={5} truncated={true} />,
    );
    expect(html).toContain('Showing the 1 most recently handled of 25');
  });

  it('per-row: shows "Gmail wasn\'t connected" for an unconfigured item instead of a blank/null error', () => {
    const items: GmailWritebackFailure[] = [{ id: 'i1', label: 'Jane Doe', error: null, status: 'unconfigured' }];
    const html = renderToStaticMarkup(
      <GmailWritebackFailuresBanner items={items} total={1} failedCount={0} unconfiguredCount={1} truncated={false} />,
    );
    expect(html).toContain("Gmail wasn&#x27;t connected when this was handled");
  });

  // The rendered-through version of the mixed-headline fixture above — proves
  // the component actually passes failedCount/unconfiguredCount to
  // gmailWritebackHeadline rather than deriving anything from `items` or
  // `total` for the headline text.
  it('mixed population end to end: the rendered headline carries the right number for each condition, not the combined total', () => {
    const items: GmailWritebackFailure[] = [
      { id: 'i1', label: 'Jane Doe', error: 'boom', status: 'failed' },
      { id: 'i2', label: 'Bob Baker', error: null, status: 'unconfigured' },
    ];
    // total (12) deliberately != failedCount (9) + unconfiguredCount (3) is
    // NOT the point here — total legitimately combines them; the point is
    // that 12 must never appear in the HEADLINE sentence, only 9 and 3 do.
    const html = renderToStaticMarkup(
      <GmailWritebackFailuresBanner items={items} total={12} failedCount={9} unconfiguredCount={3} truncated={true} />,
    );
    expect(html).toContain('3 Handled items');
    expect(html).toContain('and 9 more failed for other reasons');
    expect(html).toContain('Showing the 2 most recently handled of 12'); // truncation note: combined total is correct HERE
  });
});
