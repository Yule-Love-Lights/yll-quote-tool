import { describe, it, expect } from 'vitest';
import {
  BOOKING_CALENDARS,
  GHL_FORM_EMBED_SCRIPT,
  GHL_WIDGET_ORIGIN,
  bookingWidgetSrc,
  findBookingCalendar,
} from './calendars';
import { BACKDROP_PHOTOS } from './backdropPhotos';

describe('booking calendar registry', () => {
  it('finds the virtual hot chocolate calendar by its slug', () => {
    const calendar = findBookingCalendar('virtual-hot-chocolate');
    expect(calendar?.calendarId).toBe('fKmPiTBJ0QES6rrETQYe');
    expect(calendar?.heading).toBeTruthy();
    expect(calendar?.subheading).toBeTruthy();
  });

  // The page 404s on undefined, so this is the guard that stops an arbitrary
  // URL segment reaching the iframe.
  it('returns undefined for a slug that is not registered', () => {
    for (const slug of ['', 'nope', 'fKmPiTBJ0QES6rrETQYe', '../portal', 'VIRTUAL-HOT-CHOCOLATE']) {
      expect(findBookingCalendar(slug), slug).toBeUndefined();
    }
  });

  it('keeps slugs unique, since the first match wins', () => {
    const slugs = BOOKING_CALENDARS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // Both the widget and its resize script have to come from the same
  // GoHighLevel white-label host, or the script cannot talk to the frame.
  it('builds widget and script URLs on the GoHighLevel widget origin', () => {
    expect(bookingWidgetSrc('abc123')).toBe(`${GHL_WIDGET_ORIGIN}/widget/booking/abc123`);
    expect(GHL_FORM_EMBED_SCRIPT.startsWith(`${GHL_WIDGET_ORIGIN}/`)).toBe(true);
    expect(GHL_WIDGET_ORIGIN.startsWith('https://')).toBe(true);
  });
});

describe('booking page backdrop photos', () => {
  it('resolves every chosen id against the shared gallery list', () => {
    expect(BACKDROP_PHOTOS).toHaveLength(5);
    for (const photo of BACKDROP_PHOTOS) {
      expect(photo.src.startsWith('/references/'), photo.id).toBe(true);
    }
  });

  // The image URL is the only text from these photos that actually ships: the
  // backdrop renders alt="" because the photos are decorative, so the filename
  // is the one string about them a stranger can read. It must never carry a
  // street address, which is exactly the shape the source photos are named in
  // before anyone renames them for the web.
  const STREET = new RegExp(
    String.raw`\d+[-_\s]+(?:[a-z0-9]+[-_\s]+)*(street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|place|pl|blvd)(?=[-_.\s]|$)`,
    'i',
  );

  // Pins that the pattern above can actually fire. Without this the privacy
  // test below passes just as happily against a pattern that matches nothing,
  // which is a guard that only looks like one.
  it('recognises an address-shaped filename', () => {
    for (const bad of [
      '/references/40-glen-cove-rd.webp',
      '/references/6_Carman_Mill_Dr.webp',
      '/references/391-15th-st.webp',
      '/references/12-oak-street.webp',
      '/references/208 Wyngate Dr.jpg',
    ]) {
      expect(STREET.test(bad), bad).toBe(true);
    }
  });

  it('carries no street address in any image filename', () => {
    for (const photo of BACKDROP_PHOTOS) {
      expect(photo.src, photo.id).not.toMatch(STREET);
    }
  });
});
