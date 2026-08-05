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

I could not read the profile's service list — it isn't reliably exposed in
search results and there's no connector for it here. **Paste the current
services list and I'll diff it.** In the meantime, this is the list to
reconcile against:

- Christmas light installation
- Christmas light removal
- Holiday lighting
- Permanent holiday lighting
- Roofline lighting
- Landscape lighting
- Outdoor lighting installation
- Event lighting
- Commercial holiday lighting

Two structural notes:

1. Some of these sit under a **different category** than the main holiday
   lighting one — landscape lighting and event lighting in particular. A second
   category unlocks service slots the primary category doesn't offer.
2. Verify each name exists in Google's picker before assuming it can be added;
   the category and service lists are fixed vocabularies and they change.

---

## Suggested order of work

1. Build `/services/permanent-lighting/` — highest value, year-round demand,
   currently zero coverage.
2. Fix the service-area title template — enumerate from the REST API first.
3. Retitle `/services/` and `/service-areas/`.
4. Build `/services/holiday-lighting/` with the cost and removal sub-sections.
5. Reconcile the Google Business Profile services list.
6. The comparison page (drafted separately — see
   `permanent-lighting-comparison-page.md`).

Items 1–4 are title and copy changes to a WordPress/Elementor site; none touch
this repo's application code.
