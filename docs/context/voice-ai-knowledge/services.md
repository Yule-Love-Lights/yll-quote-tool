# YLL services (source of truth: src/lib/pricing/pricingEngine.ts, src/lib/serviceType.ts)

## The four service lines (QuoteInputs.serviceType)
- **Holiday** (`holiday`) — seasonal roofline + accessory lighting. Default line of business.
- **Permanent** (`permanent`) — installed year-round smart lighting.
- **Event** (`event`) — temporary lighting for a specific date (weddings, parties). Includes
  bistro/café string lights and barrel/box temporary supports.
- **Bistro** (`permanent_bistro`) — permanent bistro/café lighting installation.

## Roofline patterns (holiday)
- **Santa's** — front roofline only.
- **Gingerbread** — front + ridge/sides (always includes the front component).
- **Winter Wonderland** — a separate lighting style, priced by footage + difficulty.
- **Stake Lighting** — staked ground runs, independent of roofline choice.

## Bulb types (src/lib/design/sceneTypes.ts BulbType)
- `c9` — large traditional bulbs.
- `mini` — mini lights (per-unit items: bushes, trees, railings, etc — this is
  the accessory category that needs a photo, per #170).
- `permanent` — the permanent-lighting bulb/fixture type.
- `bistro` — café string lights (event + bistro verticals).

## Colors
Colors are a LIVE, staff-editable palette (BulbColor), not a fixed list — do not
hardcode specific color names into the AI's script. Ask the caller their color
preference in their own words (warm white, multicolor, a specific holiday
theme, etc) and capture it as free text; staff match it to the real palette.

## Accessories (per-unit items, need a PHOTO — do not attempt to price or count
these on the call; this is exactly the #170 problem)
- Mini light items, spritzers, wreaths, garland, bows, and any custom items.
- **Bushes and trees specifically**: if the caller mentions bushes or trees,
  tell them clearly this needs a photo for an accurate measurement — this is
  a known gap, not a stall tactic. Confirm you'll text them for a photo.

## Add-ons / policy
- Takedown service is available and is its own line item.
- Rush install fee applies unless an early-install promo (Sept/Oct) is active —
  confirm the current promo status with staff before quoting it verbally at all.
