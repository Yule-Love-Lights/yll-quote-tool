import { describe, it, expect, afterEach } from 'vitest';
import {
  galleryItemsFor,
  crossSellFor,
  MOCK_GALLERY_ITEMS,
  EVENT_GALLERY_ITEMS,
  PERMANENT_GALLERY_ITEMS,
} from './mockQuote';
import type { GalleryItem } from './dark/Gallery';

// Ledger #121: the portal's "Completed Work" gallery is per-service-type with
// a holiday fallback — never blank for a vertical whose list is empty. All
// three lists are populated as of S30 (#121 event/permanent + #122 holiday
// additions), so the fallback path is exercised by draining a list in-test.

describe('galleryItemsFor', () => {
  it('returns the full holiday set for holiday (11 originals + 6 #122 additions)', () => {
    expect(galleryItemsFor('holiday')).toBe(MOCK_GALLERY_ITEMS);
    expect(galleryItemsFor('holiday')).toHaveLength(17);
  });

  it('returns the event list for event', () => {
    expect(EVENT_GALLERY_ITEMS).toHaveLength(12);
    expect(galleryItemsFor('event')).toBe(EVENT_GALLERY_ITEMS);
    expect(galleryItemsFor('event')).not.toBe(MOCK_GALLERY_ITEMS);
  });

  it('returns the permanent list for permanent', () => {
    expect(PERMANENT_GALLERY_ITEMS).toHaveLength(9);
    expect(galleryItemsFor('permanent')).toBe(PERMANENT_GALLERY_ITEMS);
    expect(galleryItemsFor('permanent')).not.toBe(MOCK_GALLERY_ITEMS);
  });

  it('every entry has a unique id and a /references/ src', () => {
    const all = [...MOCK_GALLERY_ITEMS, ...EVENT_GALLERY_ITEMS, ...PERMANENT_GALLERY_ITEMS];
    const ids = new Set(all.map((i) => i.id));
    expect(ids.size).toBe(all.length);
    for (const item of all) {
      expect(item.src).toMatch(/^\/references\/[\w.-]+\.webp$/);
      expect(item.alt.length).toBeGreaterThan(10);
      expect(item.neighborhood.length).toBeGreaterThan(0);
    }
  });

  describe('holiday fallback when a typed list is empty', () => {
    let saved: GalleryItem[] = [];

    afterEach(() => {
      EVENT_GALLERY_ITEMS.push(...saved);
      saved = [];
    });

    it('falls back to the holiday set rather than rendering an empty gallery', () => {
      saved = EVENT_GALLERY_ITEMS.splice(0, EVENT_GALLERY_ITEMS.length);
      expect(EVENT_GALLERY_ITEMS).toHaveLength(0);
      expect(galleryItemsFor('event')).toBe(MOCK_GALLERY_ITEMS);
    });
  });
});

// Cross-sell strip (ledger #121, S30 extension): the two OTHER service
// types' completed work, below the main gallery grid.
describe('crossSellFor', () => {
  it('viewing event shows holiday then permanent (never itself)', () => {
    const blocks = crossSellFor('event');
    expect(blocks.map((b) => b.serviceType)).toEqual(['holiday', 'permanent']);
  });

  it('viewing holiday shows permanent then event (never itself)', () => {
    const blocks = crossSellFor('holiday');
    expect(blocks.map((b) => b.serviceType)).toEqual(['permanent', 'event']);
  });

  it('viewing permanent shows holiday then event (never itself)', () => {
    const blocks = crossSellFor('permanent');
    expect(blocks.map((b) => b.serviceType)).toEqual(['holiday', 'event']);
  });

  it('undefined serviceType behaves like holiday', () => {
    expect(crossSellFor(undefined)).toEqual(crossSellFor('holiday'));
  });

  it('every block has exactly 3 items', () => {
    for (const serviceType of ['event', 'holiday', 'permanent'] as const) {
      for (const block of crossSellFor(serviceType)) {
        expect(block.items).toHaveLength(3);
      }
    }
  });

  it('heading strings are exact', () => {
    const blocks = crossSellFor('event');
    const byType = Object.fromEntries(blocks.map((b) => [b.serviceType, b.heading]));
    expect(byType.holiday).toBe('Light up your life with Holiday Lighting');
    expect(byType.permanent).toBe('Light up your life with Permanent Lighting');

    const eventHeading = crossSellFor('holiday').find((b) => b.serviceType === 'event')?.heading;
    expect(eventHeading).toBe('Light up your life with Event Lighting');
  });
});
