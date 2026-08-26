import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { SkeletonBar, SkeletonRows } from './LoadingSkeleton';

// Row 410 — these placeholders exist to stop a panel jumping when its fetch
// lands, and to keep the text a screen reader used to hear. Both properties are
// easy to lose in a later edit, so both are pinned here.

describe('SkeletonRows (row 410)', () => {
  it('announces itself as busy and keeps the old text for screen readers', () => {
    const html = renderToStaticMarkup(<SkeletonRows label="Loading stock…" rows={2} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading stock…');
    expect(html).toContain('sr-only');
  });

  it('renders exactly the number of rows asked for, at the height asked for', () => {
    const html = renderToStaticMarkup(<SkeletonRows label="x" rows={4} rowClassName="h-16" />);
    expect(html.split('animate-pulse').length - 1).toBe(4);
    expect(html.split('h-16').length - 1).toBe(4);
  });

  it('is not an empty box when a caller forgets the row count', () => {
    const html = renderToStaticMarkup(<SkeletonRows label="x" />);
    expect(html.split('animate-pulse').length - 1).toBeGreaterThan(0);
  });
});

describe('SkeletonBar (row 410)', () => {
  it('carries the pulse and the caller class', () => {
    const html = renderToStaticMarkup(<SkeletonBar className="h-28 w-40" />);
    expect(html).toContain('animate-pulse');
    expect(html).toContain('h-28 w-40');
  });
});
