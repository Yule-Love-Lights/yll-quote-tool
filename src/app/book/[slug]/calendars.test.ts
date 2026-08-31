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
      expect(photo.alt.length, photo.id).toBeGreaterThan(0);
    }
  });

  // The page names no customer, and these alt strings are the one place on it
  // where free text from another file gets rendered.
  it('carries no street number in any alt text', () => {
    for (const photo of BACKDROP_PHOTOS) {
      expect(photo.alt, photo.id).not.toMatch(/\d+\s+\w+\s+(Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr)\b/i);
    }
  });
});
