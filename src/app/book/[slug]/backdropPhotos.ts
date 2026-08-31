// The photos behind the booking page.
//
// These are real completed installs that already ship with the app in
// public/references, curated in MOCK_GALLERY_ITEMS alongside the customer
// portal's Completed Work gallery. Reading from that one list means the booking
// page can never drift onto a photo the gallery has retired, and it adds no new
// image files to the repo.
//
// The five ids below were chosen for this page specifically: all landscape (the
// portrait shots crop badly full bleed) and all shot against a dark or dusk sky,
// which is what lets white text sit over them and stay readable. The commercial
// Chick-fil-A shot is deliberately left out, since this page is for homeowners.
// Change the ids here to change the page.

import { MOCK_GALLERY_ITEMS } from '@/components/portal/mockQuote';

export type BackdropPhoto = { id: string; src: string; alt: string };

const BACKDROP_IDS = [
  'g5', // Roslyn estate at dusk, wrapped driveway trees
  'g17', // brick estate, wrapped trees and lit landscape beds
  'g16', // colonial glowing warm white against a deep blue sky
  'g15', // classic warm-white roofline with a lit driveway
  'g2', // Amityville, warm-white roofline and a lit walkway
];

/**
 * Resolves the chosen ids against the shared gallery list, preserving the order
 * above and dropping any id that no longer resolves. A future edit to the
 * gallery therefore shortens this page rather than crashing it.
 */
export const BACKDROP_PHOTOS: BackdropPhoto[] = BACKDROP_IDS.map((id) =>
  MOCK_GALLERY_ITEMS.find((item) => item.id === id),
)
  .filter((item): item is (typeof MOCK_GALLERY_ITEMS)[number] => item !== undefined)
  .map((item) => ({ id: item.id, src: item.src, alt: item.alt }));
