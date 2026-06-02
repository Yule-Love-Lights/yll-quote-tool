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
  // The global walkthrough video every customer sees. Real production data
  // uses NEXT_PUBLIC_PORTAL_WALKTHROUGH_VIDEO_ID (with optional per-quote
  // override). This mock mirrors that default so v2/v6 (which read
  // MOCK_QUOTE directly) show the same real video.
  video: {
    kind: 'youtube',
    src: 'IT_ijiewMBg',
    title: 'Your Yule Love Lights walkthrough',
    leaderName: 'Naldo',
  },
  lineItems: [
    { id: 'roofline', kind: 'roofline', label: "Santa's Roofline (gutterline)", detail: '180 ft', price: 900 },
    { id: 'ridge', kind: 'ridge', label: 'Gingerbread (ridgeline)', detail: '90 ft', price: 540 },
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
  // Per-quote fee config for the portal. Mock leaves rush + premium-takedown
  // off by default (customer can toggle them on); amounts match BUSINESS_RULES,
  // taxRate matches BUSINESS_RULES.taxRate so dev totals look like production.
  charges: {
    taxRate: 0.08625,
    rush: { amount: 150, defaultOn: false },
    takedown: { amount: 150, defaultOn: false },
  },
  // Mock items total well over $1,000, so the $1,000 approval gate is active.
  minimumOrderSubtotal: 1000,
  weeklyBookings: 12,
  seasonCapacity: {
    installedThisWeek: 12,
    bookedThroughDate: 'early November',
  },
};

// Gallery — REAL Yule Love Lights installs (public/references/*).
// Chips use real Long Island town names where Naldo tagged the photo;
// the remaining tiles fall back to a lighting-style label. Order is tuned
// to the editorial grid: portraits land in the tall slots (index 0, 6),
// estates get the widest slots (index 4, 10).
//
// NOTE: Roslyn.png and Syosset.png are byte-identical (same estate). Using
// Roslyn only — drop in the real Syosset photo and add a tile when ready.
export const MOCK_GALLERY_ITEMS: Array<{
  id: string;
  src: string;
  neighborhood: string;
  alt: string;
}> = [
  { id: 'g1',  neighborhood: 'Nesconset',      src: '/references/Nesconset.webp',                                       alt: 'Large brick colonial in Nesconset with warm-white roofline bulbs, a lit peak wreath, and uplit columns' },
  { id: 'g2',  neighborhood: 'Amityville',     src: '/references/Amityville.webp',                                      alt: 'Amityville home with warm-white roofline, lit walkway, snowflake stakes, and wrapped bushes' },
  { id: 'g3',  neighborhood: 'Massapequa',     src: '/references/Massapequa.webp',                                      alt: 'Massapequa home in full multicolor lights with a lit wreath, fence garland, and pathway lights' },
  { id: 'g4',  neighborhood: 'Blue & White',   src: '/references/install-wreath-peak.webp',                             alt: 'Two-story home edged in blue and white bulbs with a lit bow wreath at the peak and snowflake stakes' },
  { id: 'g5',  neighborhood: 'Roslyn',         src: '/references/Roslyn.webp',                                          alt: 'Roslyn estate at dusk with warm-white roofline, multiple lit wreaths, and light-wrapped trees lining the driveway' },
  { id: 'g6',  neighborhood: 'Window Wreaths', src: '/references/install-spritzers-front-of-house-no-bushes.webp',      alt: 'Stately white home with warm-white roofline, a lit wreath on every window, columns, and gift-box lawn decor' },
  { id: 'g7',  neighborhood: 'Full Bush Wrap', src: '/references/install-bushes-and-spritzers.webp',                    alt: 'Home with warm-white roofline and front bushes fully wrapped in mini-lights with spritzer stakes' },
  { id: 'g8',  neighborhood: 'Red & White',    src: '/references/install-night-2.webp',                                 alt: 'Colonial home with alternating red and white roofline bulbs, a lit wreath, and snowflake spritzer stakes' },
  { id: 'g9',  neighborhood: 'Warm White',     src: '/references/install-wreaths-above-garage.webp',                    alt: 'Home with warm-white roofline, a lit wreath above the garage, illuminated walkway, and snowflake stakes' },
  { id: 'g10', neighborhood: 'Portico',        src: '/references/install-spritzers-wreath-portico-spritzers-flower-bed.webp', alt: 'Home with red and white roofline bulbs, a lit portico wreath, and snowflake stakes in the flower beds' },
  { id: 'g11', neighborhood: 'Chick-fil-A',    src: '/references/Eisenhower.webp',                                      alt: 'Commercial Chick-fil-A restaurant lit by Yule Love Lights with warm-white roofline and wrapped columns at dusk' },
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
  // "Naldo" is the friendly short form used in CTAs ("Text Naldo directly").
  // The company bio refers to the founder by his full name, Naldoven.
  leaderName: 'Naldo',
  phone: '(555) 123-4567',
  // Real team photo — the full crew in front of the branded YLL trailer.
  // Wide group shot, rendered in a landscape frame in the About section.
  photo: '/team.jpeg',
  // Scannable credential chips pulled from the company story.
  badges: ['Family-Owned', 'CLIPA-Certified', 'Licensed & Insured', 'Est. 2022', 'Nassau & Suffolk'],
  // Company bio — rendered as stacked paragraphs in the v1 About section.
  companyBio: [
    "Yule Love Lights is Long Island's trusted family-owned, CLIPA-certified holiday and permanent lighting installation company, serving homeowners and businesses across Nassau County and Suffolk County. From Elmont and Great Neck all the way east to Montauk, our licensed and insured crews design, install, maintain, and remove professional outdoor lighting for Christmas, permanent LED rooflines, outdoor weddings, corporate events, and year-round landscape illumination.",
    "Founded in 2022, we started out bringing holiday cheer to a few homes on the South Shore. Since then, we've become one of Long Island's most recognized lighting companies — featured three times in Newsday, as well as on 1010 WINS, iHeart Radio, and News12 Long Island. Today we handle multi-million dollar residential estates, commercial properties, luxury weddings, Sweet 16s, Quinceañeras, Diwali celebrations, and everything in between.",
    "Our founder, Naldoven, believes that everyone deserves a joyful, stress-free holiday. That's why every Yule Love Lights Christmas light installation includes professional design consultation, commercial-grade lights, clean installation, mid-season maintenance, post-season takedown, and free off-season storage — all backed by our Grinch-Proof Guarantee.",
  ],
  // Legacy single-person fields — still consumed by the dormant v2 (dark),
  // v4 (concierge), and v6 (snowglobe) designs. v1 ignores these in favor
  // of companyBio above. Safe to delete once those versions are retired.
  title: 'Director of Operations',
  subtitle: 'Former Director of Operations at a $13M Chick-fil-A.',
  body:
    "That's the standard we bring to your home. Our crew installs every property with the same care we'd give our own.",
};
