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

// Neighborhoods for the gallery — real Long Island zip codes.
export const MOCK_GALLERY_ITEMS: Array<{
  id: string;
  src: string;
  neighborhood: string;
  alt: string;
}> = [
  { id: 'g1', neighborhood: 'Huntington',           src: 'https://images.unsplash.com/photo-1482192596544-9eb780fc7f66?auto=format&fit=crop&w=1000&q=75', alt: 'Festive home in Huntington' },
  { id: 'g2', neighborhood: 'Muttontown',           src: 'https://images.unsplash.com/photo-1512915922686-57c11dde9b6b?auto=format&fit=crop&w=1000&q=75', alt: 'Estate in Muttontown' },
  { id: 'g3', neighborhood: 'Cold Spring Harbor',   src: 'https://images.unsplash.com/photo-1608889825103-eb5ed706fc64?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Cold Spring Harbor' },
  { id: 'g4', neighborhood: 'Garden City',          src: 'https://images.unsplash.com/photo-1574362848149-11496d93a7c7?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Garden City' },
  { id: 'g5', neighborhood: 'Lloyd Harbor',         src: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Lloyd Harbor' },
  { id: 'g6', neighborhood: 'Oyster Bay',           src: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Oyster Bay' },
  { id: 'g7', neighborhood: 'Dix Hills',            src: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Dix Hills' },
  { id: 'g8', neighborhood: 'Old Westbury',         src: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Old Westbury' },
  { id: 'g9', neighborhood: 'Sands Point',          src: 'https://images.unsplash.com/photo-1628624747186-a941c476b7ef?auto=format&fit=crop&w=1000&q=75', alt: 'Home in Sands Point' },
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
  photo: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80',
  body:
    "That's the standard we bring to your home. Our 5-person team installs every property with the same care we'd give our own.",
  phone: '(555) 123-4567',
};
