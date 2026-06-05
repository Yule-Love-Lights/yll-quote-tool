---
name: project-hhc-architecture
description: "Observed tech stack, data model, and UX of HHC ([[reference-hhc]]) — basis for our clone"
metadata: 
  node_type: memory
  type: project
  originSessionId: f873dbf4-c7e5-42d7-9853-231824d98139
---

Notes captured 2026-05-25 from live inspection of https://new.holidayhomeconcepts.com. See [[reference-hhc]] for URLs.

**Why:** We are cloning this app ([[project-design-tool]]); this is the source-of-truth model.

**How to apply:** Treat these as the target spec unless Jason tells you otherwise.

## Tech stack
- Svelte SPA mounted on `#app`; bundle at `/static/users/spa/js/index.js`.
- **Konva.js 9.2.3** for the design canvas — 3 stacked canvases (bg image, overlay, draw layer).
- Backend: Django (csrftoken cookie). REST under `/api/v1/`.
- Project payload (design JSON + rendered preview image) stored in a **cloud bucket** via signed upload/download URLs; only metadata lives in the DB.

## Konva render trick (the "wow" of the tool)
Bulbs are Konva Groups containing two `Shape`s with `globalCompositeOperation: "lighten"`. This blends the bulb sprite onto the background photo so it looks like a real glowing light. Strands are Konva Groups (x/y/rotation/draggable) with a transparent Rect that defines the strand path; bulbs are spawned along the rect at the configured spacing.

## Data model
```
Company → Clients (name, email?, address?, phone?)
        → Projects (name)
          → Designs (1..4 per project)
            ├── photo_id, chosen_background (Night Sky/Sunset/Sunrise/Cloudy Night/Dark Night/Grey Sky/Night Snow)
            ├── elements (Konva-style JSON, stored in bucket)
            ├── inventories (per-design item counts)
            ├── proposal { total, showDesign, includeTotal, logoPosition, areItemsEdited }
            └── status (draft/approved), has_design_in_bucket, processing_status
Inventory: per (asset_type, color|spacing) → base, used (auto-derived), available
Prices:    per (asset_type, size_in_inches) → price (per foot for strands)
Settings:  company name, contact email, phone, website, address, logo, fine print
```

## Asset catalog (from `<script id="asset-map-hhc">`)
| Asset | Sizes | Variations |
|---|---|---|
| bow | 12/18/24/36/48 | red, red-buffalo-plaid, red-with-gold-trim |
| garland | 12/18/24/36 | with-lights, without-lights |
| light (individual) | — | blue, cool-white, green, orange, pink, purple, red, teal, warm-white, yellow, blank |
| lights-c7, lights-c9 | 6/9/12/15/18/24/36 (spacing in inches) | — |
| lights-mini | 4/6/9/12/18; spool 17/24/33/50 | — |
| lights-permanent | 6/8/9/12/15/18/24/36 | — |
| ornament-round | 6/10/15/24/36 | 9 colors |
| ornament-star | 12/24/36/48/60/72 | blue, gold |
| ornament-swirl, teardrop, other | varies | varies |
| reindeer | 60/90/120/150/180 | buck/doe × left/right × standing/grazing |
| sphere, spotlight-narrow, spotlight-wide, spritzer, tree | varies | multiple light colors |
| swag | 24/30/36/44/48 | — |
| wreath | 24/36/48/60 | with-lights, without-lights |
| menu | — | reindeer, text, tree |

## Selection / edit / zoom (observed in Test project 2026-05-25)
- **Click a strand** → sidebar swaps to "Edit Selected …" panel; Konva-Transformer-style box appears with **8 red anchor dots** (4 corners + 4 midpoints) for resize, plus a small **blue square** at top connected by a thin line to the bounding-box top — that's the rotation handle.
- "Edit Selected" panel exposes ALL strand props (light type toggle, color palette, color pattern, spacing slider) plus **Remove from Design** and **Duplicate** buttons.
- Permanent lights' edit panel has nested accordions: **Group Settings** (Color, Pattern), **Light Settings → Spacing, Height (Beam Length + Distance to Surface), Width (Beam Width), Opacity, Other**.
- **Zoom:** ctrl+wheel on the canvas zooms in/out around the cursor. Maximize button (top-right) hides chrome but is not zoom.

## Permanent light rendering (the key visual)
Each fixture renders as 3 stacked elements:
1. **Top fixture dot** — small bright disk where the puck sits.
2. **Downward light cone** — wedge/teardrop projecting straight down with a gradient (bright at top → soft at bottom), edges fade, color comes from the pattern (alternating per fixture).
3. **Floor wash** — soft horizontal smear at the bottom of the cones where the light "lands."

Per-strand controls: Beam Length, Beam Width, Distance to Surface, Opacity. The cone always points "down" (positive Y in image space).

## Core UX flow
1. Create Client (name required; email/address/phone optional).
2. Create Project (just name).
3. Per Design: upload home photo → pick Background tint (day/night preset) → drop a **Yardstick** (user picks a known feature of known real width in feet, drags a rect to match; sets pixel→feet scale) → pick asset from bottom tabs (Lights / Ornaments / Decor / Text / Custom) → configure right panel (color, spacing, drawing style: Strand/Trace/Single light) → click-drag on canvas to place.
4. List All shows per-yardstick items list (e.g. "Permanent 21x", strand lengths in feet) and total with optional prices.
5. Estimate dialog = Quick Estimate table (Name, Color, Spacing, Amount, Length, Price) + Export.
6. Show Proposal = client-facing shareable page (`/proposal/<id>/?access_token=<token>`) with company branding, each design photo, per-design subtotal toggle, grand total.
7. Approve locks the design.

## Calculator (separate from project canvas)
Wrap Calculator: pick Type (Round Pillar / Rectangular Pillar / Pine Tree / Deciduous Tree), enter Diameter/Width (in), Height (ft), Spacing (in) → outputs Total Length of Lights Required (ft). Used to estimate footage for vertical wraps.
