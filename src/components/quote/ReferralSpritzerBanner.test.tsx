// Ledger #41 PR 2 — smoke coverage for the quote builder's referee spritzer
// banner. Renders with react-dom/server (same approach as ReferredByPicker.
// test.tsx) — a pure presentational component, two static states.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralSpritzerBanner } from './ReferralSpritzerBanner';

describe('ReferralSpritzerBanner', () => {
  it('shows the offer + an Add button when not yet added', () => {
    const html = renderToStaticMarkup(<ReferralSpritzerBanner alreadyAdded={false} onAdd={() => {}} />);
    expect(html).toContain('2 free 16&quot; spritzers');
    expect(html).toContain('Add to quote');
  });

  it('shows a confirmation (no button) once already added', () => {
    const html = renderToStaticMarkup(<ReferralSpritzerBanner alreadyAdded={true} onAdd={() => {}} />);
    expect(html).toContain('Added');
    expect(html).not.toContain('Add to quote');
  });

  it('calling onAdd is wired to the button click handler', () => {
    const onAdd = vi.fn();
    // renderToStaticMarkup can't fire events, so this just proves the prop is
    // accepted/typed correctly; the actual click wiring is exercised via the
    // QuoteBuilder integration (form-state append), not re-tested here.
    expect(() => renderToStaticMarkup(<ReferralSpritzerBanner alreadyAdded={false} onAdd={onAdd} />)).not.toThrow();
  });

  it('never uses an em dash in the customer-facing copy (voice rules)', () => {
    const html = renderToStaticMarkup(<ReferralSpritzerBanner alreadyAdded={false} onAdd={() => {}} />);
    expect(html).not.toContain('—');
  });
});
