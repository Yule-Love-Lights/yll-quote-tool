# S79 (Naldo) — 2026-08-29 — the marketing site: accessibility to 100, agentic audit cleared, and a paid speed tool that had silently stopped working

**Zero repo changes.** Everything this session shipped is on the live WordPress site
(yulelovelights.com). The close PR is documents only.

## What prompted it

Naldo ran PageSpeed Insights on the marketing site and asked three things: fix the
failing "Agentic Browsing" accessibility-tree audit, explain what the WebMCP items mean
and whether they matter, and give an honest answer on whether the weak performance score
hurts SEO, plus what else we should measure.

## What shipped, all on the live site

- **New Elementor Custom Code snippet 4792, "A11y Contrast and Agentic Browsing Fixes"**
  (entire site, body end). One CSS block and one `<script nitro-exclude>` block. Undo
  lever: delete the snippet.
  - Contrast: global body text `#777E90` to `#6b7182` (4.06 to 4.87 against white); the
    two top contact bars and the lead-form submit button `#33995F` to `#2b8251` (3.58 to
    4.76). `transition:none` was needed because those containers animate background-color
    and fought the override.
  - Agentic fix: Elementor stamps an invalid `role="presentation"` on the hero background
    video; swapped for `aria-hidden="true"`.
  - Carousel: `aria-label` "Previous slide" / "Next slide" on the Elementor swiper
    buttons, which had `role="button"` and no accessible name.
  - Lead-form honeypot: `tabindex="-1"` on the hidden `input[name=company]` spam traps.
    **CORRECTED at close:** this was reported mid-session as closing a real lead-loss
    hazard, and that claim was wrong. The wrap technical lens found the widget already
    bakes `tabindex: '-1'` into the honeypot, and `git log` confirms it has done so in
    `public/lead-form.js` since 2026-07-11, before this session started. The live page and
    a Lighthouse `aria-hidden-focus` failure both showed the attribute absent at the time,
    most likely a stale cached copy of that script being served, but the widget was never
    actually unprotected. The change is harmless belt-and-braces, not a hazard closed.
- **Edit to pre-existing snippet 3559** (April's accessibility fixes): added
  `nitro-exclude` to its script tag. No logic change.
- **NitroPack**: Naldo renewed the lapsed subscription and upgraded to Plus (40,000
  pageviews, 25GB CDN). Cache purged and rebuilt several times.

- **CORRECTION shipped inside the close:** the `!important` background added for the
  contact bars was also applied to the lead-form submit button, which silently killed that
  button's hover darken, because `!important` beats the widget's own non-`!important`
  `:hover` rule regardless of specificity. Found by the wrap technical lens with a real
  hover in a headless browser, not by reading CSS. The rule was split so the bars keep the
  override and the button gets its own `:hover`/`:focus` state at `#21633e` (contrast 7.19).
  This was a regression introduced by this session on the site's primary conversion CTA.

## Results, measured

Google PageSpeed mobile: **Performance 39 to 85**, FCP 4.2s to 1.7s, **LCP 10.2s to
3.7s**, TBT 840ms to 180ms, SI 8.0s to 3.0s. Best Practices 100, SEO 100.
Lighthouse mobile **Accessibility 97 to 100**. Page weight ~9,355 KiB to ~817 KiB;
stylesheets on the homepage 62 to 7. The hero video was left untouched throughout, at
Naldo's explicit instruction. One audit still fails: `td-has-header` on the towns
comparison table, deliberately left because fixing it could visibly change that table.

## The real root cause, after two wrong ones

The cache had been missing on **every** request and NitroPack reported **0 optimized
pages**. Two confident diagnoses were given before the right one:

1. The Meta pixel plugin's server-side `Set-Cookie: _fbp` on every response, with nginx
   skipping cache on any Set-Cookie. Refuted by test: a request already carrying `_fbp`
   gets a response with no Set-Cookie and still missed.
2. SiteGround's edge WAF returning 403 to bot-format user agents, blocking NitroPack's
   optimizer. This one was **sent to NitroPack support before it was tested**. The 403 is
   real and reproducible (control-tested against interleaved current-Chrome requests) but
   was not the cause.

NitroPack support answered it in one message: **the Business plan's renewal had failed,
so they stopped serving cache.** Pure billing. The evidence was visible from the start —
renewal cancellation emails in the info@ inbox and "Next billing: N/A" on the dashboard —
and was treated as a footnote while technical theories were chased.

## The trap worth inheriting

Once optimization came back on, **both accessibility snippets went completely dead** and
Lighthouse accessibility fell 100 to 94. NitroPack rewrites inline scripts to
`type="nitropack/inlinescript"` and defers them until the visitor interacts, so nothing
ran for a crawler, a screen reader, or an AI agent, while the page looked fine in a
browser. NitroPack's `nitro-exclude` attribute on the script tag fixes it. **Any future
accessibility or structural script on this site needs that attribute or it silently does
nothing.**

## Also delivered

A four-lens audit of the site (performance, AI/GEO visibility, local SEO, structured
data) with a ranked backlog, published as an artifact plus four detailed files. Highlights
still open for Naldo to action: the Yelp listing slug says "hicksville" while the site's
schema says Amityville (a top-tier citation mismatch), the Google Business Profile primary
category and hours need an owner-only check, the 5.0/172 review rating is displayed but
absent from structured data, and seven live town permanent-lighting pages are set to
noindex. Answered directly: WebMCP is a draft standard with no real traffic yet and is
worth skipping for now; and the performance score costs nothing in rankings today because
the origin has no CrUX field data, but 10 seconds on a phone was costing real customers.

## Session review

Four lenses (customer, technical, admin, staff) run against a written description of the
live-surface changes, since there is no git diff to review.
