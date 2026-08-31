// The header search box (Naldo, 2026-08-30). Node-env static render, the same
// idiom as OperatorNav.test.tsx: no jsdom here, so this pass sees the empty,
// unfocused state. The matching and ranking are tested for real in
// src/lib/search/globalSearch.test.ts; the typing, the keyboard walk and the
// jump are driven in the PR's browser leg.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { HeaderSearch } from './HeaderSearch';

const SOURCE = readFileSync(new URL('./HeaderSearch.tsx', import.meta.url), 'utf8');

describe('HeaderSearch — empty initial render', () => {
  const html = renderToStaticMarkup(<HeaderSearch variant="desktop" />);

  it('renders a labelled combobox', () => {
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Search customers, quotes, jobs and invoices');
  });

  it('shows no results panel until something is typed', () => {
    expect(html).not.toContain('role="listbox"');
  });
});

describe('HeaderSearch — the two instances must not collide', () => {
  it('gives each variant its own ids, since both exist in the tree at once', () => {
    // Tailwind HIDES one of the two with CSS, it does not unmount it. Two
    // elements sharing an id would break the combobox aria wiring on every
    // width, which is exactly the kind of defect a static render can catch.
    const desktop = renderToStaticMarkup(<HeaderSearch variant="desktop" />);
    const mobile = renderToStaticMarkup(<HeaderSearch variant="mobile" />);
    expect(desktop).toContain('id="header-search-desktop"');
    expect(desktop).toContain('aria-controls="header-search-results-desktop"');
    expect(mobile).toContain('id="header-search-mobile"');
    expect(mobile).toContain('aria-controls="header-search-results-mobile"');
  });

  it('binds the Ctrl+K shortcut on one instance only, so a keystroke cannot race two boxes', () => {
    expect(SOURCE).toContain("variant === 'desktop' && e.key.toLowerCase() === 'k'");
  });
});

describe('HeaderSearch — the behaviours a static render cannot see', () => {
  it('debounces before it asks the server', () => {
    expect(SOURCE).toContain('const DEBOUNCE_MS = 200');
    expect(SOURCE).toContain('setTimeout(');
    expect(SOURCE).toContain('clearTimeout(timer)');
  });

  it('drops a superseded answer instead of letting it overwrite a newer one', () => {
    // Two reads of one endpoint can be in flight while someone types, so a
    // slow answer for "Kri" must never replace a fast one for "Kristie".
    expect(SOURCE).toContain('const sequence = ++sequenceRef.current');
    expect(SOURCE.match(/if \(sequence !== sequenceRef\.current\) return/g) ?? []).toHaveLength(2);
  });

  it('reports a failed search rather than rendering it as "nothing matches"', () => {
    expect(SOURCE).toContain('Search is not answering right now');
    expect(SOURCE).toContain('setFailed(true)');
  });

  it('opens the top hit on Enter when nothing is highlighted, which is what the ranking promised', () => {
    expect(SOURCE).toContain('hits[activeIndex >= 0 ? activeIndex : 0]');
  });
});
