# Yule Love Lights — AI Training Guide

**For Jason + install team**

Our quote tool uses AI to look at a photo of a house and estimate how much lighting it needs. The more real jobs we feed it, the better it gets. This guide explains how to capture the data that makes the AI smarter.

There are **two places** you'll add data:

1. **Product Library** — canonical photos of what our wreaths, spritzers, and garland look like up close. Done once per product, then maintained as the catalog changes.
2. **Completed Job Training** — full record of every completed install (photos + measurements + notes).

---

## 1. Product Library (`/training/references`)

The AI looks at these every time it analyzes a house. Think of it as the "visual glossary" — it teaches the AI: *"A 30-inch noble wreath looks like THIS. A 24-inch spritzer looks like THAT."*

### What to upload

For **each product size/tier**, upload **one clean reference photo**:

- **Wreaths** — every size we sell (24", 30", 36", 48" noble + 36" Oregon) **and** every tier (labor / bow / fullDecor). That's up to 15 photos total.
- **Spritzers** — each size: 16", 24", 32". 3 photos minimum.
- **Garland** — 9ft and 6ft sections, in each tier (labor / bow / fullDecor).

### How to photograph

- **Plain background.** A wall, a garage door, a blank fence. Not a busy yard.
- **Product filling the frame.** Zoom in. The product should be the main thing in the picture.
- **Daylight, not dark.** Shoot during install, before it gets dark.
- **One product per photo.** Don't put a wreath and a spritzer in the same shot.
- **Write a caption.** "30in noble with red velvet bow, installed on front door" — helps the AI understand context.

### What NOT to upload

- Photos where the product is half-obscured.
- Blurry night shots.
- Photos with the product lit up at night (we want to identify them in daytime Google Street View images, so daytime photos train the AI better).

---

## 1a. Placement Rules — where wreaths and spritzers go

**This is the most important change to how the AI thinks about wreaths and spritzers.** They are NOT things we *detect* in a daytime photo — the customer doesn't have them up yet. The AI's job is to *suggest* where they SHOULD go, based on real install patterns. Then the renderer drops the transparent sprite on those spots for the nighttime preview.

### Wreath placement — typical spots (ranked by how common they are on LI installs)

1. **Portico** — most common. A small roof over the front door / entry area. One large wreath centered on the front face of the portico.
2. **Peak / front gable** — the triangular face at the top of a gabled roof. One large wreath centered on the peak. Common on capes, colonials, splits.
3. **Above the garage door** — centered on the siding above a single garage, OR one above each door on a double garage (so: 2 wreaths side by side).
4. **Front door** — one medium wreath on the door itself. Almost always paired with one of the above.
5. **Eyebrow roof / overhang** — a small roof projection over a window or bay. Wreath centered under the eyebrow.
6. **Between upper windows** — on tall blank wall sections between two second-story windows.

**Default sizes by location:**
- Peak / portico / above-garage: **36" noble** (large, visible from street)
- Front door: **30" noble**
- Eyebrow / between-windows: **30" noble** or **24" noble**

**Default tier:** `bow` (red velvet + gold trim bow is the house style). `fullDecor` only when customer specifically asks for ornaments.

### Spritzer placement — typical spots

Spritzers are **metallic starburst stakes** that plant into garden soil. They are used to **add depth and light to empty spots** — places that don't have a bush to wrap. Think of them as "decorative fill light" for the front-of-house landscaping.

1. **Flower bed in front of the house** — most common. A row of 4-6 spritzer stakes spaced ~3ft apart across a foundation flower bed.
2. **Walkway edges** — a line of spritzers flanking the path from driveway to front door (3-5 per side).
3. **Front door / stoop area** — 2-4 spritzers flanking the stoop / porch.
4. **Between foundation shrubs** — filling gaps in an otherwise mini-light-wrapped bush line.

**Default size:** `24"` (most common stake). Use `16"` for small accent fills, `32"` for wide open beds where you want more visual impact.

**Default quantity:** 4 stakes per empty bed. If the bed is long (say, runs the full front of the house), bump to 5 or 6.

### What the AI should NOT do

- Do NOT suggest a wreath or spritzer where one is already visible in the daytime photo.
- Do NOT suggest a wreath on an asymmetric spot that would look odd (e.g., on the left half of the peak — always center).
- Do NOT suggest spritzers in a flower bed that is already fully wrapped with mini-lights (they'd be redundant).
- Do NOT suggest spritzers on a bare lawn with no bed boundary — they need a landscaped spot to plant into.

### Sprite assets (`public/sprites/`)

These are the transparent PNGs the renderer uses to draw wreaths and spritzers on the nighttime preview. Keep them fresh — when we change our product lineup (new bow color, new spritzer color), swap these files.

- `wreath-bow.png` — default wreath (green noble + red/gold bow), used for `tier = 'bow'`.
- `wreath-decor.png` — fullDecor wreath (bow + mixed ornaments), used for `tier = 'fullDecor'`.
- `spritzer.png` — default warm-white starburst stake.
- Future: `spritzer-red.png`, `spritzer-multi.png` — once we offer color variants, drop them here and we'll wire color-aware rendering.

### Reference photos (`public/references/`)

Real nighttime install photos the renderer cites ("make it look like these"). More variety here = better renders. Naming convention: `install-{what}-{where}.png`. Examples already loaded:
- `install-wreath-peak.png` — wreath on gable peak
- `install-wreath-portico.png` — wreath under portico
- `install-wreaths-above-garage.png` — twin wreaths over double garage
- `install-spritzers-flowebed.png` — spritzers in foundation flower bed
- `install-spritzers-walkway.png` — spritzers flanking walkway

---

## 2. Completed Job Training (`/training/new`)

This is the money-maker. Every completed job you log here makes the next quote more accurate.

### What to capture on site

#### Photos — take ALL of these for every job:

1. **`front_install`** — straight-on front of the house, lights installed, daytime if possible.
2. **`front_takedown`** — same angle, lights still up, captured on takedown day. Compare-and-contrast gold.
3. **`side`** — left or right side showing roofline that isn't visible from street.
4. **`detail`** — close-up shots of any tricky spots: cut-up rooflines, the wreath on a second-story window, a spritzer in a weird place.

**Tip:** Take the `front_install` photo from the SAME spot Google Street View would. Stand in the street, phone at chest height, shoot the whole house. The AI mostly gets street-view images to work with, so our training photos need to match that perspective.

#### Required measurements (confirmed from takedown):

- **Santa's Roofline (gutter) footage** — actual linear feet of 5MM bulb run.
- **Gingerbread Ridge footage** — actual ridgeline feet.
- **Spritzers used** — size + quantity.
- **Wreaths used** — size + tier + quantity.
- **Garland used** — length + tier + quantity.
- **Mini-light strings used on bushes/trees/columns** — confirmed strand count per item.

#### Required context fields (these are new — please use them):

- **Scale Anchor** — what object in the photo tells the AI the real-world size? Example: *"front door is 36in wide, garage door is 7ft tall, porch columns are 8ft"*. This is HUGE for accuracy.
- **Didn't Install** — any items visible in the photo that the customer skipped. Example: *"customer declined ridgeline, skipped the lamp post bushes"*. Stops the AI from "learning" that those items don't exist on this kind of house.
- **AI Failure Notes** — after the AI auto-analyzes the photo, where did it get this house wrong? Example: *"missed the back-side gutter run, over-counted the side bushes as 5 strings when 3 was enough"*. This is pure gold — it teaches the AI its own weak spots.
- **Materials Cost, Labor Hours, Revenue** — for margin analysis. Not used by the AI directly but lets us track which job types actually make money.

### Workflow on the form

1. Upload photos.
2. Click **"Auto-analyze photo"** — Claude takes a first pass at measurements.
3. **Verify and correct** every number. Move the gutter line, resize the bush boxes, delete wrong wreath detections.
4. Fill in the context fields (scale anchor, didn't install, AI failure notes, cost/revenue).
5. Save.

### House Style — please pick one

When saving a job, tag its style: cape, ranch, colonial, split, tudor, custom. The AI uses style to pick similar training examples for future quotes. A cape that matches another cape gets smarter predictions than a cape compared to a colonial.

---

## 3. Common Mistakes to Avoid

### ❌ Skipping the takedown photo
The `front_takedown` shot is the single most valuable image we can capture. The roof is identical to install day but the lights are *confirmed installed*. It's the AI's truth signal.

### ❌ Photographing from too close
If you're standing 10 feet from the house, the scale in the photo won't match a Google Street View shot. Back up to the street.

### ❌ Leaving "AI Failure Notes" blank
Even if the AI got everything right, write "accurate" in this box so we know it was reviewed. If it got things wrong, be specific about WHAT it missed.

### ❌ Uploading night-lit photos as training
We analyze daytime Street View photos to quote houses. Training on night-lit photos confuses the AI. Shoot before dark.

### ❌ Forgetting scale anchors
"Front door 36in" takes 5 seconds to type and can cut AI measurement error by 30%. Always fill it in.

### ❌ Not tagging photos correctly
Leaving everything as "other" kills the training value. Use `front_install`, `front_takedown`, `side`, `detail`.

---

## 4. Priority Order (Where to Start)

If you only have time for 20 jobs this week:

1. **Pick 20 varied houses** from the last 2 seasons — mix of cape, ranch, colonial, split, big custom.
2. **For each:** upload front_install + side photo + measurements + scale anchor + house style.
3. **Then** go back and add takedown photos as they happen this season.

If you want to go deeper:
- Upload every completed job from last season.
- After each install this year, log the job same-day while details are fresh.
- Once a month, review a few AI-generated quotes against actual install outcomes and fill in **AI Failure Notes** for any that were off.

---

## 5. What Good Data Looks Like (Example)

A perfect training entry:

```
Address: 245 Birch Ln, Smithtown NY
Year: 2025
Style: colonial
Photos:
  - front_install (daytime, from street, full house visible)
  - front_takedown (same angle, 3 weeks later)
  - side (right side showing dormer + second-story gutter)
  - detail (closeup of front door wreath + spritzers)
Santa's: 135 ft, medium difficulty
Gingerbread: 82 ft, medium
Wreaths: 2× 30noble bow (front door, garage)
Spritzers: 4× 24 (along walkway)
Mini-lights: 3 bushes (4, 5, 3 strings) + 2 columns (3 strings each)
Scale Anchor: "front door 36in wide, garage door 7ft tall, columns 8ft"
Didn't Install: "customer declined ridgeline on back of garage wing"
AI Failure Notes: "AI under-measured gutter by 15ft — missed the return over front porch. Over-counted side bush as 5 strings when 3 was accurate."
Materials: $680
Labor Hours: 5.5
Revenue: $2,950
```

---

## Questions

Text Naldo. We'll keep this guide updated as the AI evolves.
