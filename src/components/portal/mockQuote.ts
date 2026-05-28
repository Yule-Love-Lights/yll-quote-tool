// Mock quote data for the customer portal — replace with real DB fetch
// when wiring. Keeps the page fully renderable during iteration.
// All prices in USD.

import type { PortalQuote } from './types';

// Placeholder imagery — large suburban home via Unsplash. Real renders
// will flow in from /api/renders/[quoteId]/latest once wired.
const BEFORE_PHOTO =
  'https://images.unsplash.com/photo-1568605114967-8130f3a36994?auto=format&fit=crop&w=1600&q=80';
const AFTER_PHOTO =
  'https://images.unsplash.com/photo-1482192596544-9eb780fc7f66?auto=format&fit=crop&w=1600&q=80';

export const MOCK_QUOTE: PortalQuote = {
  id: 'YLL-2026-0142',
  customer: {
    firstName: 'Jasmine',
    fullName: 'Jasmine Smith',
    address: '45 Main Street, Huntington, NY 11743',
  },
  photo: {
    before: BEFORE_PHOTO,
    after: AFTER_PHOTO,
    alt: 'The Smith residence at 45 Main Street, Huntington',
  },
  // Mock has no per-package variant images — every card falls back to the
  // 'after' hero. Real production data flows through fetchPortalPhotos
  // and populates this map from the renders table.
  variantPhotos: {},
  // Sample walkthrough video — a short Gary Vee clip as placeholder.
  // In production Naldo records a ~90s Loom/phone clip per quote that
  // walks through what he designed and why. Flip `kind` to 'mp4' and
  // paste a direct URL when hosting on Supabase Storage / R2 instead.
  video: {
    kind: 'youtube',
    src: 'dQw4w9WgXcQ',
    title: 'Your personal walkthrough',
    durationSec: 92,
    leaderName: 'Naldo',
  },
  lineItems: [
    { id: 'roofline', kind: 'roofline', label: "Santa's Roofline (gutterline)", detail: '180 ft', price: 900 },
    { id: 'ridge', kind: 'ridge', label: 'Gingerbread Ridge (ridgeline)', detail: '90 ft', price: 540 },
    { id: 'tree-l', kind: 'tree', label: 'Front-left tree', detail: '4 strands', price: 180 },
    { id: 'tree-r', kind: 'tree', label: 'Front-right tree', detail: '3 strands', price: 135 },
    { id: 'bush-1', kind: 'bush', label: 'Front bush 1', detail: '2 strands', price: 70 },
    { id: 'bush-2', kind: 'bush', label: 'Front bush 2', detail: '2 strands', price: 70 },
    { id: 'wreath', kind: 'wreath', label: '36" Noble Wreath with Bow', detail: '1 wreath', price: 350 },
    { id: 'garland', kind: 'garland', label: '9ft Noble Garland with Bow', detail: '2 pieces', price: 390 },
    { id: 'spritzers', kind: 'spritzer', label: '24" Spritzers', detail: '3 stakes', price: 255 },
  ],
  packages: [
    {
      id: 'A',
      name: 'Classic Glow',
      tagline: 'Roofline only. Clean, simple, elegant.',
      total: 1480,
      deposit: 740,
      includedItemIds: ['roofline'],
    },
    {
      id: 'B',
      name: 'Full Festive',
      tagline: 'Roofline + trees and bushes. Most popular.',
      total: 2150,
      deposit: 1075,
      recommended: true,
      includedItemIds: ['roofline', 'tree-l', 'tree-r', 'bush-1', 'bush-2'],
    },
    {
      id: 'C',
      name: 'The Full Yule',
      tagline: 'Everything — roofline, trees, bushes, wreaths, garland.',
      total: 2985,
      deposit: 1492.5,
      aLaCarteTotal: 3170,
      includedItemIds: [
        'roofline',
        'ridge',
        'tree-l',
        'tree-r',
        'bush-1',
        'bush-2',
        'wreath',
        'garland',
        'spritzers',
      ],
    },
    {
      id: 'D',
      name: 'Build Your Own',
      tagline: 'Custom — toggle anything.',
      total: 0, // computed from selected items at runtime
      deposit: 0,
      includedItemIds: [],
    },
  ],
  weeklyBookings: 12,
  seasonCapacity: {
    installedThisWeek: 12,
    bookedThroughDate: 'early November',
  },
};

// Gallery — REAL Yule Love Lights night installs (public/references/*).
// The chip label uses the lighting STYLE rather than a neighborhood,
// because we don't have verified addresses for these specific homes.
// Swap the `neighborhood` values for real town names (Huntington,
// Garden City, etc.) once Naldo confirms which house is which.
export const MOCK_GALLERY_ITEMS: Array<{
  id: string;
  src: string;
  neighborhood: string;
  alt: string;
}> = [
  { id: 'g1', neighborhood: 'Warm White Classic', src: '/references/install-night-1.jpg',              alt: 'Two-story Long Island home outlined in warm-white C9 bulbs with a lit wreath on the peak and illuminated trees' },
  { id: 'g2', neighborhood: 'Red & White',        src: '/references/install-night-2.jpg',              alt: 'Colonial home with alternating red and white roofline bulbs, a lit wreath, and snowflake spritzer stakes' },
  { id: 'g3', neighborhood: 'Full Bush Wrap',     src: '/references/install-bushes-and-spritzers.png', alt: 'Home with warm-white roofline and front bushes fully wrapped in mini-lights with spritzer stakes' },
  { id: 'g4', neighborhood: 'Blue & White',       src: '/references/install-wreath-peak.png',          alt: 'Two-story home edged in blue and white bulbs with a lit bow wreath at the peak and snowflake stakes' },
  { id: 'g5', neighborhood: 'Walkway Spritzers',  src: '/references/install-spritzers-walkway.png',    alt: 'Home with warm-white roofline, garland-wrapped columns, and lit spritzer stakes lining the walkway' },
  { id: 'g6', neighborhood: 'Portico Columns',    src: '/references/install-wreath-portico.png',       alt: 'Home with warm-white roofline, light-wrapped portico columns, a peak wreath, and snowflake stakes' },
];

export const MOCK_REVIEWS = [
  {
    id: 'r1',
    name: 'Sarah M.',
    neighborhood: 'Garden City',
    body: 'Naldo and his team transformed our home. The install was fast, quiet, and spotless. Every bulb still going strong in January.',
  },
  {
    id: 'r2',
    name: 'David K.',
    neighborhood: 'Huntington',
    body: 'We had a bulb go out on Christmas Eve. Text at 4pm. They were at our house by 6pm. That is the service difference.',
  },
  {
    id: 'r3',
    name: 'Elizabeth T.',
    neighborhood: 'Muttontown',
    body: 'Fourth year with Yule Love Lights. The warm-white C9 look is unmatched on our block. Worth every dollar.',
  },
];

export const MOCK_FAQ = [
  { q: 'How long do installs take?',
    a: 'Most homes take 2–4 hours. Large estates may run 5–6 hours with our full crew. We confirm a 2-hour arrival window via text the day before.' },
  { q: 'What if it rains on install day?',
    a: 'Light rain — we install. Heavy rain or lightning — we reschedule to the next clear day and notify you by 7am. No charge for weather delays.' },
  { q: 'Do you work on weekends?',
    a: 'Yes. Our install window runs Saturday and Sunday through mid-December. Weekend slots book first, so reserve early.' },
  { q: 'Can I customize the colors?',
    a: 'Absolutely. Warm white, multi-color, red/green, or a custom blend — we carry commercial-grade C9 and mini-light strands in every palette.' },
  { q: 'What voltage/electrical do you need?',
    a: 'Standard 120V outdoor-rated exterior outlets. We bring commercial-grade extension cords, timers, and splitters. We verify your breaker capacity on arrival.' },
  { q: 'What about HOA approval?',
    a: 'We work with every major LI HOA and provide the documentation they need on request. If your HOA needs advance notice, text Naldo and we will prep it.' },
  { q: 'Can I add items after I book?',
    a: 'Yes — up to 7 days before your install date. Text Naldo and we will send an updated line-item sheet for approval.' },
];

export const MOCK_TEAM = {
  leaderName: 'Naldo',
  title: 'Director of Operations',
  subtitle: "Former Director of Operations at a $13M Chick-fil-A.",
  // Real team photo — the full crew in front of the branded YLL trailer.
  // This is a wide group shot, not a headshot, so MeetYourTeam renders it
  // in a landscape frame (not the old circular portrait).
  photo: '/team.jpeg',
  body:
    "That's the standard we bring to your home. Our crew installs every property with the same care we'd give our own.",
  phone: '(555) 123-4567',
};
