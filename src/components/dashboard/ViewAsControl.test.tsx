// Ops hub workstream A slice 2: the admin-only "View as" control. Same
// node-env renderToStaticMarkup idiom as OperatorNav.test.tsx (no jsdom in
// this suite): a single static render pass, which is exactly the state under
// test here because the control is pure props+context with no effects.
//
// The admin gate (role !== 'admin' renders nothing) is negative-controlled:
// removing the gate makes "renders nothing for a plain operator" fail alone.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ViewAsControl } from './ViewAsControl';

describe('ViewAsControl — admin-only gate', () => {
  it('renders the control for an admin', () => {
    const html = renderToStaticMarkup(<ViewAsControl role="admin" />);
    expect(html).toContain('View as');
  });

  it('renders nothing for a plain operator', () => {
    expect(renderToStaticMarkup(<ViewAsControl role="operator" />)).toBe('');
  });

  it('renders nothing before the session check resolves (role null)', () => {
    expect(renderToStaticMarkup(<ViewAsControl role={null} />)).toBe('');
  });
});

describe('ViewAsControl — contents for an admin', () => {
  const html = renderToStaticMarkup(<ViewAsControl role="admin" />);

  it('lists Office, Crew, and Advertising', () => {
    expect(html).toContain('>Office<');
    expect(html).toContain('>Crew<');
    expect(html).toContain('>Advertising<');
  });

  it('marks Office as the active view (default office, aria-pressed)', () => {
    const officeBtn = html.match(/<button[^>]*>Office<\/button>/);
    expect(officeBtn).not.toBeNull();
    expect(officeBtn![0]).toContain('aria-pressed="true"');
    // The attribute, not the 'disabled:' Tailwind variant in the class list —
    // renderToStaticMarkup emits the boolean attribute as disabled="".
    expect(officeBtn![0]).not.toContain('disabled=""');
  });

  it('renders Crew and Advertising disabled, with honest not-built copy', () => {
    for (const label of ['Crew', 'Advertising']) {
      const btn = html.match(new RegExp(`<button[^>]*>${label}</button>`));
      expect(btn).not.toBeNull();
      expect(btn![0]).toContain('disabled=""');
      expect(btn![0]).toContain('aria-pressed="false"');
    }
    expect(html).toContain('Crew and Advertising views are not built yet.');
  });
});
