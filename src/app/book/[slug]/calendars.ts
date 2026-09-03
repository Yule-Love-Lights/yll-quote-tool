// Branded booking pages that wrap a GoHighLevel calendar widget.
//
// GoHighLevel's own booking page is unbranded, so a customer clicking a link to
// book a call lands on a blank white widget. These routes put the same widget
// on a Yule Love Lights page with real completed-install photography behind it.
//
// Why a registry instead of reading the calendar id from the URL: the id goes
// straight into an <iframe src>. Taking it from the path would let anyone frame
// any GoHighLevel calendar, or any other page on that host, under our branding.
// The slug is the only thing the URL controls, and an unknown slug 404s.
//
// Adding a calendar: copy its embed code out of GoHighLevel, take the id out of
// the widget/booking/<id> URL, and add an entry here.

export type BookingCalendar = {
  /** The URL segment, e.g. /book/virtual-hot-chocolate */
  slug: string;
  /** GoHighLevel calendar id, from its widget/booking/<id> embed URL. */
  calendarId: string;
  heading: string;
  subheading: string;
};

export const BOOKING_CALENDARS: BookingCalendar[] = [
  {
    slug: 'virtual-hot-chocolate',
    calendarId: 'fKmPiTBJ0QES6rrETQYe',
    heading: 'Grab a virtual hot chocolate with us',
    subheading:
      'Pick a time that works for you. We will walk through your house, your ideas, and what a display would look like.',
  },
];

export function findBookingCalendar(slug: string): BookingCalendar | undefined {
  return BOOKING_CALENDARS.find((c) => c.slug === slug);
}

/** The white-label GoHighLevel host serving both the widget and its resize script. */
export const GHL_WIDGET_ORIGIN = 'https://lights.yulelovelights.com';

export function bookingWidgetSrc(calendarId: string): string {
  return `${GHL_WIDGET_ORIGIN}/widget/booking/${calendarId}`;
}

export const GHL_FORM_EMBED_SCRIPT = `${GHL_WIDGET_ORIGIN}/js/form_embed.js`;
