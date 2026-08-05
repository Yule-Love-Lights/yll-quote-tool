# Elementor build guide — permanent lighting pages

Date: 2026-08-05

## Read this first: what this guide can and can't guarantee

`yulelovelights.com` is unreachable from the session environment that produced
this. Both the apex and `www` hosts are refused at the network layer, and so is
most of the public web — `github.com` connects, `wordpress.org` does not. It's a
restrictive egress allowlist on the environment, not a problem with the site.

**Consequence:** the structure below is a conventional Elementor service-page
layout. It is **not** matched against the real `/services/landscape-lighting/`
or `/services/event-lighting/` pages, because those could not be read.

To actually match the site's styling, one of these has to happen first:

1. **Allowlist `yulelovelights.com`** on the environment, and I'll read the
   existing service pages, mirror their exact section and widget structure, and
   verify the result in place. This also unblocks the REST API enumeration the
   audit needs before the ~40-page title fix.
2. **Export an existing service page** (Elementor → hamburger → Export Template)
   and send the JSON. I'll return importable template JSON for both new pages
   with the styling inherited from the real page rather than approximated.

Until then, build from this by hand — and take the *global* styles from a
Duplicate rather than starting from a blank page. See below.

---

## The shortcut that solves most of the style-matching problem

**Don't build these from blank pages.** Duplicate `/services/landscape-lighting/`
twice and replace the content.

Landscape Lighting is the closest structural sibling: same service-page family,
same likely hero/sections/CTA rhythm, and it already carries whatever global
colors, fonts, section padding, and button styles the site uses. Duplicating
inherits all of it. Replacing text inside existing widgets keeps the styling and
costs a fraction of the effort of rebuilding and re-styling.

Rename, re-slug, and swap the copy. Delete any section that has no equivalent
below; add sections only where the outline calls for something the sibling
doesn't have.

---

# Page 1 — Permanent lighting service page

## WordPress page settings

| Field | Value |
|---|---|
| Title | Permanent Christmas Lights on Long Island |
| Slug | `permanent-lighting` |
| Parent | Services |
| Resulting URL | `/services/permanent-lighting/` |
| Template | Elementor Full Width (match the sibling service pages) |

## Rank Math / SEO fields

| Field | Value |
|---|---|
| SEO title | `Permanent Christmas Lights Long Island \| Yule Love Lights` |
| Meta description | `Permanent app-controlled LED roofline lighting on Long Island — invisible by day, any color at night. Installed once, used all year. $2,500–$5,000 typical. Nassau & Suffolk.` |
| Focus keyword | `permanent christmas lights long island` |

## Section outline

Each row is one Elementor section. Widget types named where it matters.

### S1 — Hero
- **Heading (H1):** Permanent Christmas Lights on Long Island
- **Text Editor:**
  > Put lights on the house once. Use them all year.
  >
  > Permanent roofline lighting is a slim track of individually controlled LEDs
  > mounted along your roofline and trim. It's there year-round, but you'd have
  > to look for it in daylight. At night it does whatever you tell it from your
  > phone — warm white on an ordinary evening, red and green in December, orange
  > for Halloween, red white and blue on the Fourth.
  >
  > No ladder in November. No tangled boxes in the garage. No January morning
  > wondering when you'll get to it.
- **Button:** `Get my roofline quoted` → *(CTA target — see open items)*
- **Background:** IMG_6561 (the red/blue night shot) if the sibling hero uses a
  background image. Add a dark overlay so the H1 stays legible.

### S2 — What you actually get
Four icon-box or text widgets. Bold lead-in, then the sentence.

| Bold lead-in | Body |
|---|---|
| Any color, and more than one at a time. | Each LED is controlled on its own, so a single roofline can run red across one section and blue across another — not one color for the whole house. That's the difference between doing a flag on the Fourth and only being able to do red. |
| Warm white for the other eleven months. | Most people think they're buying holiday lights and end up living on warm white year-round, because it makes the house look finished at night. It's the setting worth caring most about. |
| Controlled from your phone. | Colors, brightness, patterns, speed, and schedules. Set it to come on at sunset and turn itself off at midnight, and then forget it exists until December. |
| Invisible when it's off. | The track follows lines your house already has — tucked under the fascia along the roof edge, and along existing trim bands. It reads as part of the trim, not as a strip someone added. |

### S3 — Daylight proof (two-column Image widgets)
- **Heading (H2):** What it looks like in daylight
- **Left — Image:** IMG_6575. Caption: *The same house with the system off. The
  track follows the fascia and the trim band.*
- **Right — Image:** IMG_6561. Caption: *The same house at night. Two colors on
  one continuous run.*
- Alt text left: `Permanent roofline lighting with the system off, Long Island home`
- Alt text right: `Permanent roofline lighting at night showing two colors on one roofline`

### S4 — Homes
- **Heading (H2):** Permanent lighting for homes
- **Text Editor:**
  > We install permanent lighting across Nassau and Suffolk on single-family
  > homes — capes, splits, colonials, waterfront properties. We design to your
  > actual roofline rather than quoting a per-foot number and hoping.
  >
  > Typical residential systems run **$2,500–$5,000** installed for
  > small-to-medium homes. Larger or more complex rooflines cost more, and we'll
  > tell you that before we start, not after.

### S5 — Multi-family
- **Heading (H2):** Multi-family buildings
- **Text Editor:**
  > Apartment buildings, condos, co-ops, and townhouse communities. One system
  > across the whole property means a building that looks deliberate instead of
  > lit unit by unit — and one point of contact, one schedule, one invoice.
  >
  > Boards and property managers tend to care most about two things here: that
  > the lighting runs itself on a schedule nobody has to remember, and that
  > there's a local crew who answers when a section goes out.

### S6 — Commercial
- **Heading (H2):** Businesses and commercial properties
- **Text Editor:**
  > Storefronts, restaurants, offices, and multi-building properties. Same
  > system, same scheduling, same local service.
  >
  > We also handle **commercial architectural lighting** — accent and façade
  > lighting that isn't tied to a holiday at all.

### S7 — Cost
- **Heading (H2):** What it costs, honestly
- **Text Editor:**
  > **$2,500–$5,000** for most small-to-medium homes, installed. Bigger and more
  > complicated rooflines run higher.
  >
  > It pays for itself against seasonal installs somewhere around year four or
  > five, depending on the size of the display you'd otherwise be buying. And
  > unlike a seasonal install, there's no annual line item after that.

### S8 — Fit
- **Heading (H2):** Is it right for you?
- **Text Editor:**
  > **It's a good fit if** you want the house lit for more than Christmas,
  > you're tired of the yearly install-and-takedown cycle, or you like the idea
  > of the house looking finished on an ordinary Tuesday in March.
  >
  > **It's not the better choice if** what you love is the classic C9 look with
  > garland, wreaths, and lit trees. Permanent systems do rooflines beautifully;
  > they don't do the rest of a designed display. Plenty of our customers have
  > both — permanent on the roofline, and we come out each season for the trees
  > and the greenery.

### S9 — Why us
- **Heading (H2):** Why us
- **Text Editor:** We're family-owned and based on Long Island, and we've been
  lighting homes here since 2022 — Nassau and Suffolk, Elmont and Great Neck out
  to Montauk.
- **Icon List** (3 items):
  - **Service is us.** The people who installed it are the people who come fix
    it. No national dispatch number.
  - **Licensed, insured, CLIPA-certified.**
  - **We do the whole year.** Permanent lighting, Christmas installs, landscape
    lighting, event lighting. One vendor, one crew.

### S10 — FAQ (Accordion or Toggle widget)
Use the same FAQ widget the existing `/faqs/` page uses, so the schema markup
stays consistent.

| Question | Answer |
|---|---|
| Do I still need Christmas lights? | For the roofline, no — that's what this replaces. If you want lit trees, garland, or wreaths, we do those seasonally alongside your permanent system. |
| Can I see it before I commit? | Yes. Ask and we'll show you real installed homes near you, in daylight and at night. |
| What happens if a section goes out? | Call us. We come fix it. |
| How long does it last? | **UNCONFIRMED — see open items. Do not publish this answer as drafted.** |

### S11 — CTA
- **Heading (H2):** See what permanent lighting would cost on your roofline
- **Button:** `Get my quote` → *(CTA target — see open items)*
- **Text link:** Still comparing systems? Read our guide to comparing permanent
  roofline lighting. → `/permanent-roofline-lighting-comparison/`

---

# Page 2 — Comparison guide

## WordPress page settings

| Field | Value |
|---|---|
| Title | Permanent Roofline Lighting on Long Island: How to Compare Systems |
| Slug | `permanent-roofline-lighting-comparison` |
| Parent | **None — top level.** It's a guide, not a service. |
| Resulting URL | `/permanent-roofline-lighting-comparison/` |

## Rank Math / SEO fields

| Field | Value |
|---|---|
| SEO title | `Permanent Roofline Lighting on Long Island: How to Compare Systems` |
| Meta description | `Comparing permanent Christmas light systems on Long Island? Here's what actually differs between them, what to ask any installer, and what it costs. From a local, family-owned installer.` |
| Focus keyword | `permanent roofline lighting long island` |

**Do not put competitor brand names in the title tag or the slug.** They belong
in body copy where the comparison is genuine. A title built from someone else's
trademark invites a complaint and doesn't rank better for it.

## Section outline

This page is prose, not a service page. If a blog-post template exists, it's a
better base than a service page — narrower measure, no hero image, no pricing
band. Full copy is in `permanent-lighting-comparison-page.md`; the section order:

1. **H1 + intro** — three paragraphs, ending "What follows is what we'd tell you
   to check anyway."
2. **H2 What actually differs between systems** — five bold lead-ins: how
   visible the track is when it's off · how the light throws at night · color
   capability · the app · who installs it and who services it.
3. **H2 The questions worth asking any installer** — Icon List, 6 items.
4. **H2 Where we fit** — intro paragraph + Icon List, 5 items.
5. **H2 Is permanent lighting right for you?** — two paragraphs.
6. **CTA** — same button as page 1, linking to the estimate flow.

---

## After both pages are live

1. **Update the six GBP service entries** to link to
   `/services/permanent-lighting/` — Permanent Lighting, Residential Permanent
   Lighting, Commercial Permanent Lighting, Architectural Lighting, Residential
   Architectural Lighting, Commercial Architectural Lighting. This is the whole
   point of building the page; skipping it leaves the dead end in place.
2. **Add to the Services nav** alongside Event and Landscape.
3. **Link from `/services/`** — the Permanent Lighting section there should now
   link to the dedicated page.
4. **Link from the homepage** if it mentions permanent or architectural lighting.
5. **Submit both URLs** in Search Console for indexing.

## Open items — do not publish without these

1. **The FAQ durability answer.** The drafted text ("commercial-grade LED
   systems built for year-round outdoor exposure…") is a longevity claim written
   by me, not given by Naldo. It must match what's actually warranted. Asked
   twice, still unanswered.
2. **The CTA target URL.** Both pages end in a button with nowhere to point.
3. **Photo placement** is proposed, not verified — the hero background only
   works if the sibling service pages use one.

## Confirmed and safe to publish

CLIPA certification · "since 2022" and the Nassau/Suffolk coverage language ·
$2,500–$5,000 · the year-four-or-five payback · homeowner permission for the
photos · the customer mix (single-family, multi-family, businesses).
