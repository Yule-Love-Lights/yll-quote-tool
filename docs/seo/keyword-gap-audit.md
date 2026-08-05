# Keyword gap audit — yulelovelights.com

Date: 2026-08-05

## Method and its limits (read this first)

`yulelovelights.com` is blocked by this environment's egress policy, so the site
could not be fetched directly — neither the pages nor the WordPress REST API.
Everything below is derived from **what Google has actually indexed**: title
tags and search snippets, gathered across eight queries.

What that means for how much to trust each finding:

- **Title tags, URL structure, and which pages exist — high confidence.** These
  come straight from the index and are the highest-leverage on-page elements
  anyway.
- **Body copy — not verified.** I can see what Google surfaces in a snippet, not
  the full text of a page. So "this page never says X" is a *strong inference*
  from the title and snippets, not a byte-level fact.

To close that gap, either allowlist the domain for the session environment, or
paste the body copy of `/services/` and the homepage and I'll finish the pass.

The page list below is a **sample of what surfaced (16 pages)**, not the full
population. Prior experience on this site says the Rank Math sitemap omits
published pages; the authoritative enumeration is
`/wp-json/wp/v2/pages?per_page=100`. Enumerate from there before acting on
anything template-wide.

---

## Finding 1 — The two biggest-ticket services have no page of their own

This is worth more than the entire keyword list below.

`/services/` presents four services: Permanent, Holiday, Event, Landscape.
Three of the four spin out to a dedicated URL. The two that earn the most do not:

| Service | Dedicated page? | Indexed title |
|---|---|---|
| Event Lighting | Yes | `Event Lighting Long Island \| Yule Love Lights` |
| Landscape Lighting | Yes | `Landscape Lighting Long Island \| Yule Love Lights` |
| Municipal Holiday Lighting | Yes | `Municipal Holiday Lighting – Yule Love Lights` |
| **Permanent Lighting** | **No** | — (a section on `/services/`) |
| **Holiday Lighting** | **No** | — (a section on `/services/` + the homepage) |

**Permanent lighting is the sharp one.** It is a $2,500–$5,000 ticket, it is the
one service with *year-round* search demand rather than a Sept–Dec spike, and it
currently has no URL that can rank for it. The best Google can do is a section on
a page whose title tag is the word "Services."

Holiday is half-covered, because the homepage is titled
`Christmas Light Installation Long Island, NY`. That's a defensible choice, but
it makes the homepage do double duty and leaves no home for the sub-searches
(cost, removal, commercial, specific towns).

**Recommendation:** build `/services/permanent-lighting/` first — before any of
the keyword edits below. Title it for the search, not the internal name:
`Permanent Christmas Lights Long Island | Yule Love Lights`. Then
`/services/holiday-lighting/` as the deep page the homepage links into.

---

## Finding 2 — The service-area pages use two different title patterns

Of the seven town pages that surfaced, two carry the service in the title and
five do not:

| Page | Indexed title | Carries the keyword? |
|---|---|---|
| `/service-areas/commack-ny/` | `Commack, NY Christmas Light Installation \| Yule Love Lights` | Yes |
| `/service-areas/seaford-ny/` | `Seaford, NY Christmas Light Installation \| Yule Love Lights` | Yes |
| `/service-areas/huntington-ny/` | `Huntington, NY – Yule Love Lights` | No |
| `/service-areas/levittown-ny/` | `Levittown, NY – Yule Love Lights` | No |
| `/service-areas/syosset-ny/` | `Syosset, NY – Yule Love Lights` | No |
| `/service-areas/smithtown-ny/` | `Smithtown, NY – Yule Love Lights` | No |
| `/service-areas/deer-park-ny/` | `Deer Park, NY – Yule Love Lights` | No |
| `/suffolk-county/` | `Suffolk County \| Yule Love Lights` | No |

A page titled `Huntington, NY` is asking Google to infer what it's for. This is
the exact "explicit beats inferred" principle — and Huntington is not a town to
be vague in.

**Two cautions before fixing this:**

1. **Enumerate first.** Seven pages surfaced; the real population is likely
   40+. Pull the full list from the REST API before touching anything.
2. **Fix at the template, not page by page.** A hand-built list of page IDs went
   wrong on this exact site before, because the list was harvested from an
   incomplete source. If these pages share a template, change the title format
   once so towns added later inherit it.

Target format: `{Town}, NY Christmas Light Installation | Yule Love Lights`

---

## Finding 3 — Two hub pages carry no keyword at all

- `/services/` → `Services - Yule Love Lights`
- `/service-areas/` → `Service Areas - Yule Love Lights`
- `/faqs/` → `FAQs – Yule Love Lights`

These are internal labels, not searches. Nobody types "services."

Suggested: `Holiday & Permanent Lighting Services | Long Island | Yule Love
Lights` and `Christmas Light Installation Service Areas | Nassau & Suffolk`.

---

## Finding 4 — Nothing targets the January search

Removal and takedown appear only as *features included* inside other pages
("post-season takedown, free off-season storage"). No page is aimed at someone
searching for removal as its own job.

That's half the season with nobody home:
`christmas light removal long island`, `christmas light takedown service`,
`take down christmas lights service near me`.

It also happens to be the cheapest lead type to serve and a direct path into
next season's install.

---

## Finding 5 — Everything says Christmas; the business is broader

Every keyword-bearing title uses "Christmas." But `/services/` says the company
lights Ramadan, Diwali, Hanukkah, and 4th of July. The business is broader than
its own title tags.

`holiday light installation long island` is a distinct search from
`christmas light installation long island`, with a materially different searcher.
Right now the site leans hard on one and mostly infers the other.

---

## The keyword bank

Organized by the three passes, with the page that should own each.

### Horizontal variations — top-level service

Owner: homepage + `/services/holiday-lighting/`

- christmas light installation
- christmas light installation cost *(cost intent — currently unserved; the
  pricing is already public in snippets, so a page could own this outright)*
- christmas light installers
- christmas light hanging service
- professional christmas light installation
- christmas light company
- holiday light display design
- christmas decorating service

### Synonym pass

- lights ↔ lighting
- installation ↔ install ↔ hanging ↔ hang ↔ putting up ↔ setup ↔ decorating
- installer ↔ company ↔ service ↔ contractor ↔ professional
- removal ↔ takedown ↔ take down ↔ taking down *(Finding 4)*
- christmas ↔ holiday ↔ xmas *(Finding 5)*

### One word different

- home christmas lights ↔ house christmas lights
- outdoor ↔ exterior ↔ outside
- roof ↔ rooftop ↔ roofline
- yard ↔ lawn ↔ property

### Permanent side — the widest split

Owner: the new `/services/permanent-lighting/`

Customers have no settled name for this product, which is exactly why explicit
coverage wins:

- permanent christmas lights
- permanent holiday lights
- permanent outdoor lighting
- permanent roofline lighting
- year round christmas lights
- app controlled roofline lighting
- architectural lighting *(the term used internally — keep it, but it should not
  be the only one on the page)*

Note: "architectural lighting" is the technician's word. It appears to be doing
load-bearing work in the current copy. Customers type "permanent christmas
lights."

### Geo modifiers

Pair every term above with: `long island`, `nassau county`, `suffolk county`,
and the town name on town pages. `near me` needs no page — it resolves to
proximity and the Google Business Profile.

---

## Google Business Profile

Read from screenshots of the profile's Services screen, 2026-08-05. Five screens
captured; two further screens exist and are not yet reviewed, so the service
count below is a floor, not a total.

### Current state

**Categories**

| Category | Role | Services attached |
|---|---|---|
| Lighting contractor | Primary | The bulk of the list |
| Christmas store | Additional | None visible |
| Lighting consultant | Additional | None visible |
| Landscape lighting designer | Additional | A set that appears to duplicate the primary's |

**Services (~32 visible)**

General: Residential Holiday Light Installation · Residential Christmas Light
Installation · Commercial Holiday Light Installation · Commercial Christmas
Light Installation · Event/Party Light Installation · Event Lighting · Party
Lighting · Bistro/Patio Lighting · Bistro Lighting · Patio Lighting ·
Architectural Lighting · Residential Architectural Lighting · Commercial
Architectural Lighting · Permanent Lighting · Residential Permanent Lighting ·
Commercial Permanent Lighting · Landscape Lighting · Backyard Lighting ·
Outdoor Wedding Lighting · Holiday Light Installation — Nassau and Suffolk

Town-specific: Babylon · Huntington · Amityville · Massapequa · Smithtown ·
Islip · Bay Shore · Patchogue · Commack · Deer Park · Dix Hills · Farmingdale ·
Garden City

Every entry is priced **"From $1,000."**

### The profile is ahead of the website

This inverts the assumption behind Findings 1 and 5.

The synonym and variant work the framework asks for has **already been done on
the profile**. Holiday and Christmas both carried. Residential and Commercial
split. Permanent and Architectural both present. Event, Party, Bistro and Patio
each given their own slot rather than collapsed. That is the right instinct,
executed.

The website is the side that hasn't caught up. Which produces the actual problem:

**The profile sells permanent lighting; the website has no page for it.** The
profile carries Permanent Lighting, Residential Permanent Lighting, Commercial
Permanent Lighting, and three Architectural Lighting entries. A customer who taps
any of those lands on a site with no permanent lighting page — the homepage or
`/services/` at best. That is a conversion leak on the highest-ticket service,
and it makes Finding 1 more urgent rather than less.

### Gap 1 — the town lists don't match

Thirteen towns are sold on the profile. The website's service-area pages cover a
different set. Only four appear in both:

| | Towns |
|---|---|
| **Both** | Huntington · Smithtown · Commack · Deer Park |
| **Profile only — no landing page** | Farmingdale · Garden City · Amityville · Massapequa · Islip · Bay Shore · Patchogue · Dix Hills · Babylon |
| **Website only — not sold on the profile** | Levittown · Seaford · Syosset |

Nine towns are being promoted with nowhere to send the click. Three pages exist
that the profile never points at. Reconciling these two lists is cheap and is
probably the single highest-return item in this document.

Caveat: the website column comes from a 16-page indexed sample, so pages may
exist for some of those nine. Enumerate from the REST API before concluding a
page is missing.

### Gap 2 — nothing about removal, again

The same hole as Finding 4, in the same place. Nothing in the visible list
mentions removal, takedown, storage, repair, or mid-season service. The profile
covers installation thoroughly and the back half of the season not at all.

Add: Christmas Light Removal · Christmas Light Takedown · Holiday Light Storage ·
Christmas Light Repair.

### Gap 3 — customer words still missing

Words the profile doesn't use that customers do:

- **Hanging** — "christmas light hanging" is a common search; the word appears
  nowhere.
- **Roofline** — covered only as "Architectural" and "Permanent," which are our
  words, not theirs.
- **Tree wrapping / tree lighting** — a distinct search, absent.
- **Wreath and garland installation** — absent.
- **Outdoor Lighting Installation** — the umbrella term. Backyard, Patio,
  Landscape and Bistro are all present; the word that covers them isn't.

### Two things worth questioning

**"Christmas store" as a category.** That's a retail category, and this is a
service business. It may be pulling "where to buy Christmas decorations" intent —
shoppers, not homeowners booking installs. It also has no services attached, so
it isn't earning a slot. Worth testing whether removing it changes anything.

**"From $1,000" on permanent lighting.** The real range is $2,500–$5,000. A
customer who arrives anchored on $1,000 and gets quoted $3,800 is a bad
conversation and a lost lead. Consider per-service price floors that reflect the
actual service, or removing the floor from the permanent entries.

**"Lighting consultant"** has no services attached either — either attach some or
drop it.

### Before editing

Verify each new service name exists in Google's picker. The category and service
vocabularies are fixed lists and they change.

---

## Suggested order of work

1. **Reconcile the town lists** (GBP Gap 1) — nine towns are sold with no landing
   page. Cheapest fix, highest return, and it needs no new positioning.
2. Build `/services/permanent-lighting/` — highest value, year-round demand, zero
   website coverage, and the profile is already selling it into a dead end.
3. Fix the service-area title template — enumerate from the REST API first.
4. Add the removal services to the profile and a removal section to the site.
5. Retitle `/services/` and `/service-areas/`.
6. Build `/services/holiday-lighting/` with the cost and removal sub-sections.
7. The comparison page (drafted separately — see
   `permanent-lighting-comparison-page.md`).

Note the direction of travel: the profile is ahead of the website on nearly every
axis. Most of the work below is bringing the site up to what the profile already
promises, not the reverse.

Items 1–4 are title and copy changes to a WordPress/Elementor site; none touch
this repo's application code.
