# Website lead forms (embed) — WordPress rollout guide

Phase 2 of the #leads project. This is the paste-ready guide for dropping the
new lead-capture forms into yulelovelights.com (Elementor) via **HTML
widgets**. The forms POST to `POST /api/leads` on the quote tool
(`src/app/api/leads/route.ts`) and are served as one static script from the
quote tool itself:

```
https://quote.yulelovelights.com/lead-form.js
```

No plugin, no build step. The script finds every `[data-yll-lead-form]` div
on the page and renders the matching variant into it.

## 1. Homepage hero bar

Elementor → add an **HTML** widget where the current hero-area Gravity Form
sits, and paste:

```html
<div data-yll-lead-form="bar"></div>
<script src="https://quote.yulelovelights.com/lead-form.js" async></script>
```

Renders as one horizontal row on desktop (name / email / phone / address /
service dropdown / consent / submit) and stacks on mobile. Heading: "Get A
Fast Quote - Takes Only 5 Seconds".

## 2. Sitewide sticky bar

Add this **once**, in a template that runs on every page (Elementor
**Theme Builder → Footer**, or a global HTML widget), so it isn't duplicated
per-page:

```html
<div data-yll-lead-form="sticky"></div>
<script src="https://quote.yulelovelights.com/lead-form.js" async></script>
```

Stays hidden until the visitor scrolls past 600px, then slides up from the
bottom. Has its own dismiss (×) — once dismissed it stays hidden for the
rest of that browser session (sessionStorage), even across page navigations,
but reappears on a new visit/session.

**Only include the sticky snippet on one place site-wide.** If it's also
pasted into individual pages, the same visitor could see two independent
sticky bars stack. The `bar`/`full` snippets are fine to repeat per-page —
each is scoped to its own container.

## 3. "Get A Quote" page — full form

Elementor → HTML widget on `/get-a-quote/` (replacing the current
`[gravityform id="1"]` shortcode widget):

```html
<div data-yll-lead-form="full"></div>
<script src="https://quote.yulelovelights.com/lead-form.js" async></script>
```

Card-style service picker (Christmas / Permanent / Event & Wedding /
Landscape), name/email/phone/address/notes, consent checkbox, and the
"LET'S MAKE YOUR SEASON BRIGHT!" submit button — matching the live Gravity
Form's copy and green (`#1E7A42`).

## 4. Service-specific landing pages (`data-service`)

For a page that's already about one service (e.g. a "Permanent Lighting"
landing page), pre-select that service and hide the picker entirely so the
visitor doesn't have to choose it again:

```html
<div data-yll-lead-form="full" data-service="permanent"></div>
<script src="https://quote.yulelovelights.com/lead-form.js" async></script>
```

Valid `data-service` values (must match exactly — anything else is ignored
and the picker shows normally, with a console warning for us to catch it):

| value | maps to |
|---|---|
| `christmas` | Christmas Lighting |
| `permanent` | Permanent Lighting |
| `event-wedding` | Event & Wedding Lighting |
| `landscape` | Landscape Lighting |

Works on any variant (`full`, `bar`, `sticky`) — e.g. `data-yll-lead-form="bar" data-service="event-wedding"`.

## 5. Local / staging testing (`data-api-base`)

Point a form at a local dev server instead of production:

```html
<div data-yll-lead-form="full" data-api-base="http://localhost:3000"></div>
<script src="http://localhost:3000/lead-form.js"></script>
```

(Note the script `src` also has to point at the dev server — the file only
exists in `public/` on whichever host is running it.)

## 6. Test submissions (`yll_test=1`)

Add `?yll_test=1` to any page URL before submitting a form and the lead is
saved with `is_test: true` — visible in the data but excluded from the rate
limiter and (per existing convention) any real-lead reporting. Use this for
any live click-through testing so QA submissions don't look like real leads:

```
https://yulelovelights.com/get-a-quote/?yll_test=1
```

## Rollout / rollback

**Old Gravity Forms stay installed and untouched.** Phase 2 only swaps the
Elementor **widget** on each page from the Gravity Forms shortcode widget to
an HTML widget with the snippet above — Gravity Forms itself, its form
definitions, and its stored entries are not removed or modified.

**To roll back a page:** in the Elementor editor, delete the HTML widget and
re-add the original Gravity Forms widget (or restore it from the page's
Elementor revision history, which keeps prior versions of the layout). No
plugin reinstall, no data migration — the old form's shortcode
(`[gravityform id="1"]` etc.) still works exactly as before.

**Rolling back everything at once:** since every placement is just a
one-line HTML snippet, reverting is page-by-page in Elementor; there's no
global switch to flip. If `quote.yulelovelights.com/lead-form.js` itself
needs to come down (e.g. a bad deploy), every embedded form silently stops
rendering (the container div stays empty) rather than breaking the page —
but leads stop being captured on that placement until it's fixed, so treat a
`lead-form.js` outage as urgent.

### Overlap window

While a page still has the OLD Gravity Form live at the same time the NEW
embed is also live elsewhere on the site (mid-swap, or intentionally kept as
a fallback), a visitor who fills out BOTH ends up with two separate
opportunity cards in GHL — the old form's own tag-triggered workflows still
create their Christmas-pipeline card exactly as before, independent of
anything this embed does. Neither system knows about the other's
submission, and nothing here dedupes across them.

Keep the side-by-side window as short as possible and swap **page by
page** (remove the old widget the same time you add the new one) rather
than running both indefinitely — the longer both stay live, the more
duplicate cards pile up for staff to notice and merge by hand.

## What's NOT in this file

The request contract (exact field names, validation, honeypot, rate
limiting, GHL pipeline routing) lives in `src/app/api/leads/route.ts` and is
pinned by its test suite (`route.test.ts`) — this doc is only about placing
the embed on the WordPress side.
