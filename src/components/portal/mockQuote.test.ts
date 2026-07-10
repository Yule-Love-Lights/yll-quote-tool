import { describe, it, expect, afterEach } from 'vitest';
import {
  galleryItemsFor,
  MOCK_GALLERY_ITEMS,
  EVENT_GALLERY_ITEMS,
  PERMANENT_GALLERY_ITEMS,
} from './mockQuote';
import type { GalleryItem } from './dark/Gallery';

// Ledger #121: the portal's "Completed Work" gallery must be per-service-type
// with a holiday fallback — never blank for a vertical that has no photos yet.

describe('galleryItemsFor', () => {
  it('returns the full holiday set for holiday', () => {
    expect(galleryItemsFor('holiday')).toBe(MOCK_GALLERY_ITEMS);
    expect(galleryItemsFor('holiday')).toHaveLength(11);
  });

  it('falls back to the holiday set for event while EVENT_GALLERY_ITEMS is empty', () => {
    expect(EVENT_GALLERY_ITEMS).toHaveLength(0);
    expect(galleryItemsFor('event')).toBe(MOCK_GALLERY_ITEMS);
  });

  it('falls back to the holiday set for permanent while PERMANENT_GALLERY_ITEMS is empty', () => {
    expect(PERMANENT_GALLERY_ITEMS).toHaveLength(0);
    expect(galleryItemsFor('permanent')).toBe(MOCK_GALLERY_ITEMS);
  });

  describe('once a typed list is populated (e.g. Naldo supplies event photos)', () => {
    const testItem: GalleryItem = {
      id: 'e1',
      neighborhood: 'Test Venue',
      src: '/references/test.webp',
      alt: 'test',
    };

    afterEach(() => {
      EVENT_GALLERY_ITEMS.length = 0;
    });

    it('returns the typed list itself instead of the holiday fallback', () => {
      EVENT_GALLERY_ITEMS.push(testItem);
      expect(galleryItemsFor('event')).toBe(EVENT_GALLERY_ITEMS);
      expect(galleryItemsFor('event')).not.toBe(MOCK_GALLERY_ITEMS);
    });
  });
});
