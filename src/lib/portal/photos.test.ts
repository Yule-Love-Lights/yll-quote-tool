import { describe, it, expect } from 'vitest';
import { portalPhotos } from './photos';
import type { PortalDesign } from '@/components/portal/types';

function design(over: Partial<PortalDesign> = {}): PortalDesign {
  return {
    scene: { yardsticks: [], items: [] },
    photoUrl: 'https://example.com/base.jpg',
    photoW: 800,
    photoH: 600,
    ...over,
  };
}

describe('portalPhotos (#110 W4-019)', () => {
  it('returns just the base photo as "Photo 1" when there are no extras', () => {
    expect(portalPhotos(design())).toEqual([
      { id: null, url: 'https://example.com/base.jpg', w: 800, h: 600, title: 'Photo 1' },
    ]);
  });

  it('appends extras in order, numbered 2..N, after the base photo', () => {
    const d = design({
      extraPhotos: [
        { id: 'a', url: 'https://example.com/a.jpg', w: 100, h: 50, title: null },
        { id: 'b', url: 'https://example.com/b.jpg', w: 200, h: 100, title: 'Backyard' },
      ],
    });
    expect(portalPhotos(d)).toEqual([
      { id: null, url: 'https://example.com/base.jpg', w: 800, h: 600, title: 'Photo 1' },
      { id: 'a', url: 'https://example.com/a.jpg', w: 100, h: 50, title: 'Photo 2' },
      { id: 'b', url: 'https://example.com/b.jpg', w: 200, h: 100, title: 'Backyard' },
    ]);
  });

  // W4-022: a url-less extra must not shift the numbering of the extras after
  // it — the label is computed from the CANONICAL (unfiltered) index, matching
  // the staff-facing photoLabels.extraPhotoLabels, then url-less ones drop out.
  it('numbers extras by their canonical index, not their post-filter index', () => {
    const d = design({
      extraPhotos: [
        { id: 'a', url: null, w: 100, h: 50, title: null }, // broken signed URL, dropped
        { id: 'b', url: 'https://example.com/b.jpg', w: 200, h: 100, title: null },
        { id: 'c', url: 'https://example.com/c.jpg', w: 300, h: 150, title: null },
      ],
    });
    const result = portalPhotos(d);
    // 'a' is filtered out entirely (no url to render), but 'b' keeps its
    // canonical "Photo 3" label (index 2 in the unfiltered array + 2) rather
    // than sliding down to "Photo 2".
    expect(result.map((p) => [p.id, p.title])).toEqual([
      [null, 'Photo 1'],
      ['b', 'Photo 3'],
      ['c', 'Photo 4'],
    ]);
  });

  it('drops url-less extras from the list entirely', () => {
    const d = design({
      extraPhotos: [{ id: 'a', url: null, w: 100, h: 50, title: null }],
    });
    expect(portalPhotos(d)).toEqual([
      { id: null, url: 'https://example.com/base.jpg', w: 800, h: 600, title: 'Photo 1' },
    ]);
  });

  it('handles a missing extraPhotos array the same as an empty one', () => {
    expect(portalPhotos(design({ extraPhotos: undefined }))).toHaveLength(1);
  });

  it('a staff title always wins over the numbered fallback', () => {
    const d = design({
      extraPhotos: [{ id: 'a', url: 'https://example.com/a.jpg', w: 100, h: 50, title: '  Front yard  ' }],
    });
    expect(portalPhotos(d)[1].title).toBe('Front yard');
  });
});
