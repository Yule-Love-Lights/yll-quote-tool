// Generic "Your Protection" warranty card copy (WT-56 / WT-65 / WT-07). Same
// shape + mechanism permanent's warranty (#88 P6b-2, lib/permanent/types.ts)
// pioneered — Settings-editable, versioned, frozen into a quote's approval
// snapshot — generalized here for holiday / event / permanent-bistro, whose
// RiskReversal copy was previously hardcoded with no settings hook, version, or
// freeze. `bullets` is a fixed-slot list; each slot pairs with a FIXED icon by
// index in the portal component (RiskReversal.tsx); a blank slot hides that
// bullet. `version` is server-managed — putAppSettings bumps it whenever the
// displayed copy changes; clients never set it.
//
// Pure type module with NO imports (mirrors lib/permanent/types.ts) so both the
// server appSettings and the client Settings editor / portal component can share
// this without pulling server-only code into the client bundle. Structurally
// identical to (but kept separate from) permanent's own `PermanentWarranty` —
// permanent already shipped and is left untouched; this covers the other three
// verticals.
export type ServiceWarranty = {
  eyebrow: string;
  heading: string;
  bullets: string[];
  version: number;
};

// The factory "Your Protection" copy for each vertical — byte-identical to what
// RiskReversal.tsx hard-coded (GUARANTEES / EVENT_GUARANTEES / BISTRO_GUARANTEES)
// before this became Settings-editable, so an unconfigured business sees the
// exact same card. Bullet order is paired with each vertical's fixed icon list
// in RiskReversal.tsx. All start at version 1.

export const DEFAULT_HOLIDAY_WARRANTY: ServiceWarranty = {
  eyebrow: 'Your Protection',
  heading: 'Take the risk out of the decision.',
  bullets: [
    'Free maintenance all season — 48-hour fix guarantee.',
    'Every bulb guaranteed — we replace burnouts free.',
    'Standard takedown included (Jan 9 – Feb 3).',
    'Zero roof damage — clips only, no nails or staples.',
    '$2M liability insurance — licensed and bonded.',
  ],
  version: 1,
};

export const DEFAULT_EVENT_WARRANTY: ServiceWarranty = {
  eyebrow: 'Your Protection',
  heading: 'Take the risk out of the decision.',
  bullets: [
    "Something out? We fix it fast. If a bulb or strand goes dark before your event, we're on it — usually the same day.",
    'Every bulb, guaranteed lit. We test the whole display before your event, and again the day of.',
    'We handle takedown. Everything comes down on the date we agreed after your event — you never touch a light.',
    'Careful with your space. Professional install with no damage to your home, venue, or landscaping.',
    'Fully insured. Licensed and insured, so you and your venue are covered.',
  ],
  version: 1,
};

export const DEFAULT_BISTRO_WARRANTY: ServiceWarranty = {
  eyebrow: 'Your Protection',
  heading: 'Take the risk out of the decision.',
  bullets: [
    'Every install backed by a workmanship warranty.',
    'Commercial-grade, weather-rated hardware built to stay outside year-round.',
    'Something goes dark? We come fix it. We service everything we hang.',
    'Nothing is charged until you approve your quote.',
  ],
  version: 1,
};
