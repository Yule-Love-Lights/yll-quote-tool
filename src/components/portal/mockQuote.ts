// Mock quote data for the customer portal — replace with real DB fetch
// when wiring. Keeps the page fully renderable during iteration.
// All prices in USD.

import type { PortalQuote } from './types';
import type { ServiceType } from '@/lib/serviceType';

// Placeholder imagery — large suburban home via Unsplash.
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
    // The mutually-exclusive roofline pair (#17 Phase 2). Both show in the
    // grid; picking one deselects the other (see `roofline` below). No footage
    // on the customer portal. Santa's = front; Gingerbread = front + ridge + sides.
    { id: 'roofline-santas', kind: 'roofline', label: "Santa's Roofline", detail: '', price: 900 },
    { id: 'roofline-gingerbread', kind: 'ridge', label: 'Gingerbread', detail: '', price: 1440 },
    { id: 'tree-l', kind: 'tree', label: 'Front-left tree', detail: '4 strands', price: 180 },
    { id: 'tree-r', kind: 'tree', label: 'Front-right tree', detail: '3 strands', price: 135 },
    { id: 'bush-1', kind: 'bush', label: 'Front bush 1', detail: '2 strands', price: 70 },
    { id: 'bush-2', kind: 'bush', label: 'Front bush 2', detail: '2 strands', price: 70 },
    { id: 'wreath', kind: 'wreath', label: '36" Noble Wreath with Bow', detail: '1 wreath', price: 350 },
    { id: 'garland', kind: 'garland', label: '9ft Noble Garland with Bow', detail: '2 pieces', price: 390 },
    { id: 'spritzers', kind: 'spritzer', label: '24" Spritzers', detail: '3 stakes', price: 255 },
  ],
  // Tiers mirror derivePackages (Jason S12): Tier 1 = Santa's (900) + spritzers
  // (255) to clear $1,000; Tier 2 = the same set on Gingerbread (1440); Tier 3 =
  // everything on Gingerbread; D = "Build Your Own" (no staff rec in the mock).
  // Totals are tax-inclusive at 8.625%.
  packages: [
    {
      id: 'A',
      name: 'Classic Glow',
      tagline: "Santa's roofline + spritzers. Clean, simple, elegant.",
      total: 1254.62, // (900 + 255) * 1.08625
      deposit: 627.31,
      includedItemIds: ['roofline-santas', 'spritzers'],
    },
    {
      id: 'B',
      name: 'Full Festive',
      tagline: 'Gingerbread roofline + spritzers. The fuller look.',
      total: 1841.19, // (1440 + 255) * 1.08625
      deposit: 920.6,
      includedItemIds: ['roofline-gingerbread', 'spritzers'],
    },
    {
      id: 'C',
      name: 'The Full Yule',
      tagline: 'Everything — Gingerbread roofline, trees, wreaths, garland and more.',
      total: 3139.26, // 2890 * 1.08625, rounded to cents
      deposit: 1569.63,
      aLaCarteTotal: 2890,
      includedItemIds: [
        'roofline-gingerbread',
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
      total: 0, // populated by applyOurRecommendation when staff recommend items
      deposit: 0,
      includedItemIds: [],
    },
  ],
  // The mutually-exclusive roofline group (#17 Phase 2): Santa's + Gingerbread
  // both render as grid line items; picking one deselects the other. The staff
  // pick (recommendedItemId) is the default-selected roofline for toggling.
  roofline: {
    itemIds: ['roofline-santas', 'roofline-gingerbread'],
    recommendedItemId: 'roofline-santas',
  },
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
  // #122 — additional holiday completed-work photos (Naldo, S30).
  { id: 'g12', neighborhood: 'Candy Cane',     src: '/references/candy-cane-christmas.webp',                            alt: 'Home wrapped in alternating red and white candy-cane roofline bulbs' },
  { id: 'g13', neighborhood: 'Pure White',     src: '/references/pure-white-christmas.webp',                            alt: 'Two-story home outlined in crisp pure-white roofline bulbs' },
  { id: 'g14', neighborhood: 'Crisp White',    src: '/references/pure-white-christmas-2.webp',                          alt: 'Home edged in bright pure-white roofline lighting against the night sky' },
  { id: 'g15', neighborhood: 'Warm White Classic', src: '/references/warm-white-christmas.webp',                        alt: 'Home outlined in classic warm-white roofline bulbs' },
  { id: 'g16', neighborhood: 'Golden Glow',    src: '/references/warm-white-christmas-2.webp',                          alt: 'Home glowing in warm-white roofline lighting' },
  { id: 'g17', neighborhood: 'Estate Trees',   src: '/references/holiday-estate-warm-white.webp',                       alt: 'Brick estate with warm-white roofline, fully wrapped trees and driveway pillars, and lit landscape beds' },
];

type GalleryItemData = (typeof MOCK_GALLERY_ITEMS)[number];

// Event Lighting completed work (ledger #121; photos supplied by Naldo S30).
export const EVENT_GALLERY_ITEMS: GalleryItemData[] = [
  { id: 'e1',  neighborhood: 'Ceremony Canopy',   src: '/references/event-bistro.webp',            alt: 'Backyard wedding ceremony under warm bistro lights radiating from a center pole, with a draped floral arch and a lit aisle' },
  { id: 'e2',  neighborhood: 'Reception Bistro',  src: '/references/event-bistro-2.webp',          alt: 'Warm bistro string lights strung between the trees over an outdoor evening celebration' },
  { id: 'e3',  neighborhood: 'Dinner Under Lights', src: '/references/event-bistro-3.webp',        alt: 'Guests dining beneath a canopy of warm bistro lights at an outdoor event' },
  { id: 'e4',  neighborhood: 'Pond-Edge Party',   src: '/references/event-bistro-stake.webp',      alt: 'Stake lights tracing a backyard pond at night with bistro-lit reception tables under the trees' },
  { id: 'e5',  neighborhood: 'Lakeside Wedding',  src: '/references/event-backyard-wedding.webp',  alt: 'Backyard wedding reception by a pond at dusk with bistro strings overhead, a glowing dance floor, and a dock in the foreground' },
  { id: 'e6',  neighborhood: 'Curtain Lights',    src: '/references/event-curtain-lights.webp',    alt: 'Two-story home draped floor-to-roof in warm-white curtain lights for a celebration' },
  { id: 'e7',  neighborhood: 'Curtain Glow',      src: '/references/event-curtain-lights-2.webp',  alt: 'Warm-white curtain lights falling from the rooflines of a home lit for an event' },
  { id: 'e8',  neighborhood: 'Curtain Facade',    src: '/references/event-curtain-lights-3.webp',  alt: 'Curtain lights covering the front facade of a home for a special occasion' },
  { id: 'e9',  neighborhood: 'Curtain Detail',    src: '/references/event-curtain-lights-4.webp',  alt: 'Close view of warm-white curtain lights draping a home for an event' },
  { id: 'e10', neighborhood: 'Party-Ready Home',  src: '/references/event-install-home.webp',      alt: 'Brick home lit for an event with a warm-white roofline, wrapped evergreens, and glowing stone driveway pillars' },
  { id: 'e11', neighborhood: 'Mini-Light Trees',  src: '/references/event-mini-lights.webp',       alt: 'Trees and greenery wrapped in warm mini lights for an outdoor event' },
  { id: 'e12', neighborhood: 'Tent Minis',        src: '/references/event-mini-lights-tent.webp',  alt: 'Event tent trimmed in warm mini lights at night' },
];

// Permanent Lighting completed work (ledger #121; photos supplied by Naldo
// S30) — the same home showing different SCENES, the permanent selling point:
// one install, every holiday.
export const PERMANENT_GALLERY_ITEMS: GalleryItemData[] = [
  { id: 'p1', neighborhood: 'Christmas Scene',   src: '/references/perm-christmas.webp',      alt: 'Split-level home with permanent roofline lighting running a red, green, and white Christmas scene' },
  { id: 'p2', neighborhood: 'July 4th Scene',    src: '/references/perm-fourth-of-july.webp', alt: 'The same permanent roofline lighting switched to a red, white, and blue Independence Day scene' },
  { id: 'p3', neighborhood: 'Red, White & Blue', src: '/references/perm-patriotic.webp',      alt: 'Permanent puck lights running a patriotic red, white, and blue pattern along the roofline and lower trim' },
  // More permanent completed-work photos (Naldo, S31). p4 and p10 are fourth
  // and fifth scenes on the p1–p3 split-level (p10 sits here, out of id order,
  // to keep that home's scenes adjacent in the grid); p5–p7 are one colonial
  // in three scenes; p8 and p9 are new properties (p9 = first commercial tile).
  { id: 'p4', neighborhood: 'Blue & Purple',      src: '/references/perm-blue-purple.webp',         alt: 'The same split-level home washed in blues and purples from its permanent roofline and lower-trim lighting' },
  { id: 'p10', neighborhood: 'Teal Scene',        src: '/references/perm-teal-scene.webp',          alt: 'The same split-level home again, running an everyday teal scene on its permanent roofline and trim lights' },
  { id: 'p5', neighborhood: 'Spring Scene',       src: '/references/perm-spring-scene.webp',        alt: 'Colonial home with permanent lights split into soft blue, warm yellow, and green zones across its three gables' },
  { id: 'p6', neighborhood: 'Patriotic Colonial', src: '/references/perm-patriotic-colonial.webp',  alt: 'Two-story colonial running a red, white, and blue patriotic scene on its permanent roofline lights' },
  { id: 'p7', neighborhood: 'Rainbow Scene',      src: '/references/perm-rainbow.webp',             alt: 'Colonial home running a full rainbow scene, each gable a different color from one permanent install' },
  { id: 'p8', neighborhood: 'Teal Dusk',          src: '/references/perm-teal-dusk.webp',           alt: 'White brick home at dusk with permanent roofline lighting glowing teal across the gables and garage' },
  { id: 'p9', neighborhood: 'Commercial',         src: '/references/perm-commercial.webp',          alt: 'Commercial storefront with permanent blue and white roofline lighting shining over the parking lot' },
];

// Per-service-type "Completed Work" gallery selector (ledger #121). Positive
// match on the non-holiday types (never `!== 'holiday'` — see AGENTS.md
// service-type seam convention); holiday is the default/fallback case, and
// any type whose own list is still empty (event, permanent today) falls back
// to it too, so the portal gallery section never renders empty.
export function galleryItemsFor(serviceType?: ServiceType): GalleryItemData[] {
  switch (serviceType) {
    case 'event':
      return EVENT_GALLERY_ITEMS.length > 0 ? EVENT_GALLERY_ITEMS : MOCK_GALLERY_ITEMS;
    case 'permanent':
      return PERMANENT_GALLERY_ITEMS.length > 0 ? PERMANENT_GALLERY_ITEMS : MOCK_GALLERY_ITEMS;
    // Permanent Bistro Lighting (#117) has no completed-work photos of its own
    // yet — reuses the Event gallery as a placeholder until real bistro assets
    // exist (#117 follow-up).
    case 'permanent_bistro':
      return EVENT_GALLERY_ITEMS.length > 0 ? EVENT_GALLERY_ITEMS : MOCK_GALLERY_ITEMS;
    case 'holiday':
    default:
      return MOCK_GALLERY_ITEMS;
  }
}

// Cross-sell strip at the bottom of the Completed Work gallery (ledger #121,
// S30 extension): show the two OTHER service types so a customer on one
// vertical's portal sees we also do the other two. Curated (not auto-picked)
// so the tiles are always a strong showcase, not whatever happens to sort
// first in each list.
export type CrossSellBlock = {
  serviceType: ServiceType;
  heading: string;
  items: GalleryItemData[];
};

const CROSS_SELL_DISPLAY_NAMES: Record<ServiceType, string> = {
  holiday: 'Holiday Lighting',
  permanent: 'Permanent Lighting',
  event: 'Event Lighting',
  permanent_bistro: 'Bistro Lighting',
};

// Preserves the given id order (rather than the source list's own order) and
// drops any id that fails to resolve, so a future data edit degrades to a
// shorter block instead of a crash.
function pickItems(list: GalleryItemData[], ids: string[]): GalleryItemData[] {
  return ids
    .map((id) => list.find((item) => item.id === id))
    .filter((item): item is GalleryItemData => item !== undefined);
}

function crossSellBlock(serviceType: ServiceType, items: GalleryItemData[]): CrossSellBlock {
  return {
    serviceType,
    heading: `Light up your life with ${CROSS_SELL_DISPLAY_NAMES[serviceType]}`,
    items,
  };
}

const HOLIDAY_CROSS_SELL_ITEMS = pickItems(MOCK_GALLERY_ITEMS, ['g1', 'g3', 'g12']);
const PERMANENT_CROSS_SELL_ITEMS = pickItems(PERMANENT_GALLERY_ITEMS, ['p1', 'p2', 'p3']);
const EVENT_CROSS_SELL_ITEMS = pickItems(EVENT_GALLERY_ITEMS, ['e1', 'e5', 'e6']);

// Ordered per the viewed service type; holiday is the default/fallback case
// (never a negative `!== 'holiday'` gate — see AGENTS.md seam convention).
// Blocks whose curated picks resolve empty are skipped (future-proofing; all
// three are non-empty today).
export function crossSellFor(serviceType?: ServiceType): CrossSellBlock[] {
  const holidayBlock = crossSellBlock('holiday', HOLIDAY_CROSS_SELL_ITEMS);
  const permanentBlock = crossSellBlock('permanent', PERMANENT_CROSS_SELL_ITEMS);
  const eventBlock = crossSellBlock('event', EVENT_CROSS_SELL_ITEMS);

  let blocks: CrossSellBlock[];
  switch (serviceType) {
    case 'event':
      blocks = [holidayBlock, permanentBlock];
      break;
    case 'permanent':
      blocks = [holidayBlock, eventBlock];
      break;
    // Permanent Bistro Lighting (#117) mirrors permanent's cross-sell choice
    // (holiday + event) — no dedicated bistro cross-sell block yet.
    case 'permanent_bistro':
      blocks = [holidayBlock, eventBlock];
      break;
    case 'holiday':
    default:
      blocks = [permanentBlock, eventBlock];
      break;
  }
  return blocks.filter((b) => b.items.length > 0);
}

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

// Event Lighting (#96) — the FAQ shown on an event quote's portal (draft copy;
// Naldo can revise). Same { q, a } shape as MOCK_FAQ; the portal page passes this
// instead of MOCK_FAQ when the quote's service_type is 'event'.
export const EVENT_FAQ = [
  { q: 'How far ahead should I book?',
    a: 'As early as you can — dates fill up fast, especially in wedding season. Reach out and we will hold your date.' },
  { q: 'Can you light a venue, not just a house?',
    a: 'Yes — backyards, barns, tents, gardens, and more. Tell us about the space and we will design the lighting to fit it.' },
  { q: 'What if it rains?',
    a: 'Our lights and connectors are weather-rated for outdoor use. If severe weather threatens your install, we coordinate the timing with you.' },
  { q: 'Can I choose the colors?',
    a: 'Absolutely. Warm white is the most popular for events, but we will match your palette.' },
  { q: 'How long can the lights stay up?',
    a: 'As long as your event window needs — we install before your event and take everything down after, on the date we agreed.' },
  { q: 'Do you bring power and poles?',
    a: 'Yes — we bring everything, including freestanding poles and bases wherever there is nothing to hang lights from.' },
];

// Permanent Lighting (#88, ledger #120) — the FAQ shown on a permanent quote's
// portal (draft copy; Naldo can revise). Same { q, a } shape as MOCK_FAQ; the
// portal page passes this instead of MOCK_FAQ when service_type is 'permanent'
// (permanent otherwise inherited the holiday seasonal-install Q&A, which is wrong
// for a year-round, track-mounted system).
export const PERMANENT_FAQ = [
  { q: 'Do the lights stay up all year?',
    a: 'Yes. Permanent lighting is mounted in a discreet track along your roofline and stays up year-round — there is no takedown. You control colors, patterns, and scheduling from your phone.' },
  { q: 'What can the lights do?',
    a: 'Warm white for everyday curb appeal, full color for the holidays, game day, or any celebration — millions of colors, patterns, and animations, all from the app. Set a schedule and forget it.' },
  { q: 'Is the track visible during the day?',
    a: 'Barely. The low-profile track is color-matched to your fascia and tucks under the roofline, so the pucks disappear in daylight and only the light shows at night.' },
  { q: 'What is the warranty?',
    a: 'We back the materials for life — the lights and track carry a lifetime materials warranty for the original homeowner. Service labor is billed separately. Full terms are in your agreement.' },
  { q: 'How is it priced?',
    a: 'By the foot — a flat per-foot rate for the front, sides, and back you choose to light. Do the whole home, or start with the front and add on later.' },
  { q: 'How long does installation take?',
    a: 'Most homes are done in a day. We mount the track, set the pucks, wire the transformer and controller, and walk you through the app before we leave.' },
];

export const MOCK_TEAM = {
  // "Naldo" is the friendly short form used elsewhere (e.g. the WalkthroughVideo intro).
  // The company bio refers to the founder by his full name, Naldoven.
  // The main portal contact card uses the team voice ("Reach out to the Yule Love Lights Team").
  leaderName: 'Naldo',
  phone: '(631) 517-0186',
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
