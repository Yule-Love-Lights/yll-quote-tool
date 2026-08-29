// The header View-as menu (Naldo's design, 2026-08-29). Node-env static
// render, same idiom as OperatorNav.test.tsx: the closed-by-default state is
// the one a static pass can see, and it pins the pieces a refactor could
// silently drop — the trigger, its menu semantics, and that the dropdown
// content stays out of the tree until opened. The open-state behavior
// (choose navigates, Sign out inside) is covered by the browser leg and the
// pure OPERATOR_VIEWS/navItemsForView tests it delegates to.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { ViewAsMenu } from './ViewAsMenu';

describe('ViewAsMenu — closed initial render', () => {
  const html = renderToStaticMarkup(<ViewAsMenu onSignOut={() => {}} />);

  it('renders the compact trigger with menu semantics', () => {
    expect(html).toContain('View as');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('keeps the dropdown out of the tree until opened (no layout or content cost when closed)', () => {
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('Sign out');
    expect(html).not.toContain('not built yet');
  });

  it('announces the current view for screen readers (office by context default)', () => {
    expect(html).toContain('Current view: Office');
  });

  it('stays single-line in the header slot (whitespace-nowrap, the #1043 fit discipline)', () => {
    const trigger = html.match(/<button[^>]*aria-haspopup[^>]*>/);
    expect(trigger).not.toBeNull();
    expect(trigger![0]).toContain('whitespace-nowrap');
  });
});
