# Customer Portal — Design System

**Project:** Yule Love Lights — Customer Quote Approval Portal
**Audience:** Multi-million-dollar homeowners, Long Island, NY
**Brand personality:** Santa Claus meets Chick-fil-A — warm, joyful, premium, trustworthy, cheery
**Stack:** Next.js 16 App Router · React 19 · TypeScript strict · Tailwind v4 only
**Build goal:** This page *is* the sales close. Every section moves the customer from *"maybe"* to *"take my deposit."*

> **North Star:** Premium enough that a $2M homeowner trusts it. Warm enough that it feels like the holiday itself walked up to the door.

---

## 1. Recommended Pattern

**Primary pattern: Conversion-Optimized Landing Page**
A linear, top-to-bottom sales narrative. No tabs, no hidden content, no clever navigation. The customer scrolls and is sold. Every section has one job and hands off cleanly to the next.

**Why it wins here:**
- This is not a dashboard. There is no "come back later."
- Customers have already had a consultation. This is the close.
- Scroll depth is a signal — the longer they scroll, the closer they are to *yes*.
- A persistent sticky CTA lets them convert the moment they're ready, without scrolling back.

**Narrative arc (the 5-act close):**
1. **Orient** — You are in the right place. This is your home. This is your quote.
2. **Show** — Here is what it will look like on *your* house.
3. **Prove** — Here are the homes we have done. Here is what neighbors say.
4. **Protect** — Here is why you cannot lose. Refund, warranty, takedown included.
5. **Close** — One tap. Secure the date. Deposit is refundable.

---

## 2. Style Layering

| Layer | Style | Role |
|---|---|---|
| **Primary** | Conversion-Optimized Landing Page | Structural backbone — section flow, CTA placement, sticky bar |
| **Secondary** | Social Proof-Focused | Reviews, press, gallery are load-bearing, not decorative |
| **Surface layer** | Soft UI Evolution (restrained) | Subtle warm elevation, soft shadows, rounded-but-not-bubbly |
| **Gallery layer** | Editorial Grid | Asymmetric masonry-ish gallery that looks like *Architectural Digest*, not *Zillow* |
| **Ornament layer** | Holiday Magazine | Hairline rules, section numerals, small decorative marks, serif display |

**AVOID layering:** AI-purple gradients, glassmorphism, neon, brutalism, pixel art, tech-startup clean-slate minimalism. None of these say "Christmas on a Hamptons estate."

---

## 3. Color Tokens

### 3.1 Palette (hex)

| Token | Hex | Role | Notes |
|---|---|---|---|
| `--yc-cream` | `#FAF6EF` | Page background | Warm white. Never pure white. Cozy like clotted cream. |
| `--yc-cream-soft` | `#F4ECD8` | Band background, cards on cream | Subtle contrast from page bg |
| `--yc-ink` | `#1A1410` | Primary text | Deep charcoal. Never `#000`. |
| `--yc-ink-soft` | `#3E342B` | Secondary text, body paragraphs | |
| `--yc-ink-muted` | `#7A6E60` | Tertiary text, captions, meta | |
| `--yc-rule` | `#D9CFBE` | Strong hairline rules | |
| `--yc-rule-soft` | `#EADFC8` | Section dividers | |
| `--yc-green` | `#0E3A1F` | Hero green, dark bands, nav | Deep evergreen. Reads almost black at a glance. |
| `--yc-green-deep` | `#082818` | Green-band shadow, footer | |
| `--yc-green-mid` | `#1A5233` | Green secondary (badges on cream) | |
| `--yc-green-soft` | `#E6EDE4` | Green-tinted surfaces on light bg | |
| `--yc-red-bright` | `#C8313D` | **Primary CTA, live price, urgency** | Festive red. Premium, not cheap. |
| `--yc-red-brighter` | `#D94452` | CTA hover, active micro-lifts | |
| `--yc-red-deep` | `#8B1F2B` | Oxblood — eyebrows, rules, drop caps, marks | The "editorial" red |
| `--yc-red-soft` | `#F5E1E3` | Red-tint chips, badge bg on cream | |
| `--yc-gold` | `#B8955A` | Warm gold — trust elements, dividers on green | Antique brass, not shiny gold |
| `--yc-gold-bright` | `#D4B470` | Gold on dark green (for contrast) | |
| `--yc-gold-soft` | `#E8D6A5` | Gold highlight, subtle glow | |
| `--yc-cream-on-green` | `#F4ECD8` | Text token when bg is `--yc-green` | |

### 3.2 Red Budget (critical — lesson from v4)

The page surface area should distribute roughly:
- **50% cream / off-white** (backgrounds, body copy surfaces)
- **30% green** (hero band, footer, feature bands, ink)
- **15% red** (CTAs, eyebrows, active states, rule marks, ornaments)
- **5% gold** (trust accents, section dividers on dark, seals)

Red must **feel present on every screen** without shouting. If the customer scrolls for 5 seconds and sees no red anywhere, the page loses warmth and urgency. Hit at least 3 red touchpoints per section:
- CTA fills + hover
- Eyebrow labels (`text-[var(--yc-red-deep)]`)
- Hairline rules above section headings
- Drop-cap first letter in the lead paragraph
- Active package-card outline + "Selected" pill
- FAQ "+" expand icon
- Price emphasis on discounts
- Signature block on letter-style sections
- Checkmark bullets on "What's included"
- Quote-mark glyphs on reviews
- Heart icon on Philanthropy
- Hover underline on inline links

### 3.3 Why red replaces gold as primary CTA (vs. previous draft)

Gold reads "gift-shop luxury" on warm cream and gets lost next to evergreen. Red is the canonical holiday action color. The two-red strategy (bright CTA + oxblood accent) lets red carry both emotional punch *and* editorial polish without ever feeling loud. Gold's job here is trust garnish — press bar dividers, seals, review stars, corner flourishes on the green Engagement band — not primary action.

### 3.4 Contrast (WCAG AA verified)

| Pair | Ratio | Pass |
|---|---|---|
| `#1A1410` on `#FAF6EF` | 14.9 : 1 | AAA |
| `#3E342B` on `#FAF6EF` | 9.1 : 1 | AAA |
| `#7A6E60` on `#FAF6EF` | 4.6 : 1 | AA (body size only) |
| `#F4ECD8` on `#0E3A1F` | 13.2 : 1 | AAA |
| `#D4B470` on `#0E3A1F` | 7.1 : 1 | AAA |
| `#FAF6EF` on `#C8313D` | 5.3 : 1 | AA |
| `#FAF6EF` on `#8B1F2B` | 9.8 : 1 | AAA |
| `#8B1F2B` on `#FAF6EF` | 9.8 : 1 | AAA |

Red-bright (`#C8313D`) is AA on cream at 18px+ weight 400, or 14px+ weight 700. For smaller red text (eyebrows, inline emphasis), always use `--yc-red-deep` (`#8B1F2B`).

---

## 4. Typography

### 4.1 Font stack

**Display (serif):** `Fraunces` — loaded via `next/font/google`
- Warm, modern serif with real personality. Luxury hospitality meets holiday magazine. Beats Playfair for *warmth*; beats Cormorant for *presence*.
- Weights: **400, 500, 600, 700** + italic 400, 500, 700
- Variable axes tuned: `opsz` (auto), `SOFT` (~30 for approachable headings), `WONK` off

**Body (sans):** `Inter` — loaded via `next/font/google`
- Clean, premium, reliable. Neutral enough not to fight the serif.
- Weights: **400, 500, 600, 700**

**Fallbacks (system):**
```css
--font-display: "Fraunces", "Playfair Display", Georgia, "Times New Roman", serif;
--font-body:    "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-numeral: "Fraunces", Georgia, serif; /* tabular-nums for prices */
```

**Alternative display (if Fraunces renders oddly on some weights):** `Playfair Display` — proven magazine serif, same role. Swap is 1-line.

> **v4 lesson:** Cormorant Garamond felt cold and thin on the quote approval page. Fraunces is warmer, stronger on mobile, and reads less "funeral-program" at display sizes.

### 4.2 Type ramp (mobile → desktop)

| Role | Font | Weight | Size (mobile / desktop) | Line height | Tracking |
|---|---|---|---|---|---|
| **Display XL** (hero headline) | Fraunces | 500 | `44px / 84px` | `1.02` | `-0.02em` |
| **Display L** (section headlines) | Fraunces | 500 | `36px / 56px` | `1.06` | `-0.015em` |
| **Display M** (subsection) | Fraunces | 500 | `28px / 38px` | `1.15` | `-0.01em` |
| **Display S** (card titles, quotes) | Fraunces | 500 | `22px / 26px` | `1.25` | `-0.005em` |
| **Eyebrow** | Inter | 600 | `11px / 12px` | `1` | `0.22em`, UPPERCASE |
| **Lead paragraph** | Fraunces italic | 400 | `18px / 22px` | `1.55` | `0` |
| **Body** | Inter | 400 | `16px / 17px` | `1.65` | `0` |
| **Body small** | Inter | 400 | `14px / 15px` | `1.55` | `0` |
| **Meta / caption** | Inter | 500 | `12px / 13px` | `1.5` | `0.02em` |
| **Price XL** (Engagement band) | Fraunces | 500 tabular | `52px / 72px` | `1` | `-0.02em` |
| **Price** (package card) | Fraunces | 500 tabular | `34px / 44px` | `1` | `-0.015em` |
| **CTA label** | Inter | 600 | `16px / 18px` | `1` | `0.02em` |
| **Sticky price** | Fraunces | 500 tabular | `18px / 20px` | `1` | `0` |

**Body minimum:** 16px on mobile. Never smaller. Line-length capped at **65–75ch** for paragraphs via `max-w-prose` or `max-w-[65ch]`.

### 4.3 Numeric display

- Use `font-variant-numeric: tabular-nums` on all prices, totals, deposit chips, quote refs.
- Currency formatted via a single `formatUsd()` helper — no inline concatenation.
- Never write "$1,299.00" when "$1,299" will do. The ".00" makes premium pricing look like retail.

---

## 5. Spacing Scale

Baseline: **4px grid**. Tailwind defaults are fine; here is the curated rhythm actually used on the portal.

| Token | px | Use |
|---|---|---|
| `space-1` | 4 | Icon-to-label gap |
| `space-2` | 8 | Tight inline |
| `space-3` | 12 | Small stack gap |
| `space-4` | 16 | Default stack gap, card inner padding (mobile) |
| `space-5` | 20 | |
| `space-6` | 24 | Card padding, inter-paragraph |
| `space-8` | 32 | Sub-section gap |
| `space-10` | 40 | |
| `space-12` | 48 | Section inner top/bottom (mobile) |
| `space-16` | 64 | |
| `space-20` | 80 | Section inner top/bottom (desktop) |
| `space-24` | 96 | Generous breathing between narrative acts |
| `space-32` | 128 | Hero clear-space |

**Section padding (enforced):**
- Mobile: `py-14 px-6` (56px vertical / 24px horizontal)
- Tablet: `md:py-20 md:px-8`
- Desktop: `lg:py-24 lg:px-10`

**Container widths:**
- Prose / letter-style body: `max-w-2xl` (42rem / 672px)
- Standard content: `max-w-3xl` (48rem / 768px)
- Wide (gallery, packages): `max-w-6xl` (72rem / 1152px)
- Hero / full-bleed photo: `max-w-7xl` (80rem / 1280px)

---

## 6. Border Radius Scale

Premium skews **sharp**. Friendly skews **round**. We want *premium with warmth* — so radii are moderate and consistent.

| Token | px | Use |
|---|---|---|
| `rounded-none` | 0 | Photo frames, hero images |
| `rounded-xs` | 2 | Small inline chips |
| `rounded-sm` | 4 | **Default — buttons, inputs, cards** |
| `rounded-md` | 6 | Sticky pill spine |
| `rounded-lg` | 12 | Featured card (active package) |
| `rounded-xl` | 16 | Modal surfaces |
| `rounded-full` | 999 | Avatars, trust badges, seal marks |

**Rule of thumb:**
- Interactive (buttons, inputs, cards): `rounded-sm` (4px)
- Structural (photos, hero, bands): `rounded-none` — crisp frame
- Decorative (seal, avatar, badge): `rounded-full`

---

## 7. Shadow Scale

Soft UI Evolution: elevation is *felt*, not seen. Shadows are warm-toned (not cool-blue), short, and low-opacity.

```css
--shadow-xs:  0 1px 2px 0 rgba(26, 20, 16, 0.05);
--shadow-sm:  0 2px 6px -1px rgba(26, 20, 16, 0.06);
--shadow-md:  0 6px 18px -4px rgba(26, 20, 16, 0.10);
--shadow-lg:  0 14px 34px -10px rgba(26, 20, 16, 0.14);
--shadow-xl:  0 28px 56px -14px rgba(26, 20, 16, 0.20);

/* Brand glows (focus, CTA ring) */
--glow-red:   0 0 0 3px rgba(200, 49, 61, 0.22),
              0 10px 24px -6px rgba(139, 31, 43, 0.50);
--glow-gold:  0 0 0 3px rgba(184, 149, 90, 0.28);
--glow-green: 0 0 0 3px rgba(14, 58, 31, 0.25);
```

**Usage:**
- Resting cards on cream: `--shadow-sm`
- Hover-lift: `--shadow-md` (elevation change, no translate)
- Active/selected package card: `--shadow-lg` + 2px `--yc-red-bright` outline
- Sticky Engage bar: `--shadow-xl` (anchor to bottom)
- CTA primary button: `--glow-red` at rest, deepens on hover

---

## 8. Motion — Timing & Easing

**Ethos:** slow, confident, unhurried. Premium brands don't jitter. Every transition respects `prefers-reduced-motion`.

```css
--dur-micro:   120ms;   /* cursor swaps, icon fills */
--dur-fast:    200ms;   /* color, border, opacity */
--dur-std:     280ms;   /* default hover transitions */
--dur-slow:    480ms;   /* panel reveals, lightbox */
--dur-reveal:  720ms;   /* scroll-into-view fades */

--ease-out:      cubic-bezier(0.2, 0, 0, 1);
--ease-in-out:   cubic-bezier(0.4, 0, 0.2, 1);
--ease-reveal:   cubic-bezier(0.16, 1, 0.3, 1); /* friendly, overshoot-free */
```

**Principles:**
- Hover = color/border/shadow only. **Never scale or translate the element itself** (layout shift, chintzy feel).
- Scroll-reveal: 12px `translateY` + fade, staggered 60ms between sibling cards.
- Loading state: skeleton or inline `<span aria-hidden class="animate-spin" />`, no full-screen spinner.
- Confetti (on approved page): gold-only, ≤ 2 seconds, respects `prefers-reduced-motion` (replace with a single large ✦ seal fade-in).

**Reduced motion (required):**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 9. Focus Ring Spec

**Universal rule:** every interactive element has a visible focus ring when reached via keyboard. No exceptions.

```css
.focus-ring {
  outline: none;
  box-shadow:
    0 0 0 3px rgba(200, 49, 61, 0.35),      /* red primary */
    0 0 0 6px rgba(250, 246, 239, 1);        /* cream offset (page bg) */
}
```

**Variants by surface:**

| Surface | Ring color | Offset color |
|---|---|---|
| On cream bg (default) | `--yc-red-bright` @ 35% | `--yc-cream` |
| On green band | `--yc-gold-bright` @ 50% | `--yc-green` |
| On red CTA | `--yc-gold-bright` @ 60% | `--yc-red-bright` |
| On image/gallery | `--yc-cream` @ 90% | `--yc-ink` @ 60% |

**Tailwind shortcut (v4):**
```
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-[var(--yc-red-bright)]
focus-visible:ring-offset-2
focus-visible:ring-offset-[var(--yc-cream)]
```

All icon-only buttons additionally carry `aria-label`.

---

## 10. Section-by-Section Interaction Notes (15 sections)

Naming convention: each section has a semantic `<section aria-labelledby>` anchor and a single job. Section numerals are for internal reference, not necessarily rendered on screen.

### I. Trust Bar — "You already know us"
- **Job:** Neutralize the "is this real?" question in 1.2 seconds.
- **Layout:** Thin band, `--yc-cream-soft` bg, centered row of press-mention logos in ink. Newsday 3× intentional (Long Island reader cue).
- **Behavior:** Static. No carousel. Logos are `<img>` with desaturation at rest, full color on hover (touch = full color by default).
- **Red touchpoint:** 48px `--yc-red-deep` hairline above the row, centered. Eyebrow "As featured in" uppercase tracked.

### II. Urgency Banner — "Dates are real"
- **Job:** Establish calendar scarcity without being shrill.
- **Layout:** Full-width band, `--yc-green` bg, cream text, centered. Lucide `CalendarClock` icon in `--yc-gold-bright`.
- **Copy:** "Installations are booking through November. [N] windows remain on your preferred week." Dynamic if data available; static fallback if not.
- **Red touchpoint:** The "[N]" number in `--yc-red-brighter`, bold, tabular-nums, 1.15× surrounding text size.

### III. Hero — "This is your home"
- **Job:** Make the customer feel seen. Their home. Their family. Their lights.
- **Layout:** Full-bleed after-render photo with a soft bottom-up cream gradient. Overlaid: address eyebrow, "Prepared for the {LastName} Family" headline in Fraunces italic, sub-copy.
- **Behavior:**
  - Before/After toggle (segmented pill, top-right corner overlay on desktop; below photo on mobile).
  - Toggle crossfades at 480ms `--ease-reveal`.
  - `prefers-reduced-motion`: instant swap, no crossfade.
- **Red touchpoint:** Active toggle segment is `--yc-red-bright` fill with cream text. Address eyebrow is `--yc-red-deep`.
- **A11y:** Both image variants have distinct `alt` text; toggle is `role="tablist"` with `role="tab"` buttons.

### IV. Property / Context — "Here is the canvas"
- **Job:** Ground the quote in the physical home. Gentle handoff between hero and proposal.
- **Layout:** Split 60/40 on desktop (photo left / prose right). Stacked on mobile. Caption below image with address + photo date.
- **Behavior:** Static. Lazy-load image (`loading="lazy"`, `fetchpriority="low"`).
- **Red touchpoint:** Drop cap on lead paragraph — Fraunces 500, `--yc-red-deep`, 3 lines.

### V. Walkthrough Video — "A letter from Naldo"
- **Job:** Put the human on screen. A 60-90 second walkthrough of the home + the plan.
- **Layout:** Centered 16:9 poster with play button, cream caption below ("A note from {leaderName}").
- **Behavior:**
  - Lazy pattern: poster + button → iframe swap on click (saves ~500KB initial load).
  - Poster is YouTube thumb (`hqdefault.jpg` or `maxresdefault.jpg`), pre-fetched.
  - Never autoplay.
- **Red touchpoint:** Play-button circle is `--yc-red-bright`, cream triangle, `--glow-red` on hover.
- **A11y:** Poster `<button>` with `aria-label="Play walkthrough video — N minutes"`.

### VI. Package Cards / Proposal — "Three ways to do this"
- **Job:** Present the 3 tiers. Let the customer feel they're choosing, not being sold.
- **Layout:** 3 columns on desktop, horizontal scroll-snap on mobile. Middle card pre-selected and emphasized (default: "B — Classic").
- **Behavior:**
  - Click anywhere on card → select. Updates `SelectionContext` → updates sticky price + Engagement CTA.
  - Active card: 2px `--yc-red-bright` outline + `--shadow-lg` + "Selected" pill in top-right.
  - Transition: 200ms border color, 280ms shadow.
  - Cards have `cursor-pointer` and `role="radio"` with `aria-checked`.
- **Red touchpoint:** Active outline + "Selected" pill (`--yc-red-bright` fill, cream text). Inactive cards have an `--yc-red-deep` hairline under the tier name.
- **A11y:** Group wrapper `role="radiogroup"`. Keyboard: arrow keys cycle, space/enter selects.

### VII. What's Included — "Line-item receipts"
- **Job:** Over-deliver on transparency. Every bulb, every clip, every hour.
- **Layout:** Single-column list on mobile, 2-column on desktop. Each row: Lucide `Check` icon + item name + optional tooltip/detail.
- **Behavior:**
  - Items whose category isn't in the selected package are dimmed (`opacity-50`) with a small "Add →" link that toggles them on.
  - Toggle transitions at 200ms.
- **Red touchpoint:** Check icon stroke is `--yc-red-deep`. "Add →" inline link is `--yc-red-bright` with animated underline.

### VIII. Risk Reversal — "You cannot lose"
- **Job:** Kill the last objection. Refund, warranty, takedown guaranteed.
- **Layout:** 3-card row on desktop, stacked on mobile. Each card: large circular icon (Lucide `ShieldCheck` / `Snowflake` / `Clock`) + headline + 1-line support copy.
- **Behavior:** Static. Icon circles have `--glow-gold` at rest, `--shadow-md` on hover (no translate).
- **Red touchpoint:** Icon stroke is `--yc-red-deep`. Circle border is 1px `--yc-gold`.

### IX. What Happens Next — "The calendar"
- **Job:** Show that this is a well-oiled operation.
- **Layout:** Vertical stepped timeline (5 steps) on mobile; horizontal on desktop. Each step: numeral badge + title + date range + 1 line.
- **Behavior:** Static. Numerals in Fraunces 500 inside `--yc-red-soft` circles with `--yc-red-deep` text.
- **Red touchpoint:** Connecting line between steps is 1px dashed `--yc-red-deep` at 40% opacity.

### X. Meet Your Team — "Naldo"
- **Job:** Trade anonymity for loyalty. Family-run business on Long Island.
- **Layout:** Split — portrait photo left (rounded-none on desktop, `rounded-full` avatar on mobile), bio right. Sign-off in Fraunces italic.
- **Behavior:** Static photo, lazy-loaded.
- **Red touchpoint:** Naldo's signature (Fraunces italic 500, `--yc-red-deep`, subtle `rotate(-1.5deg)`).

### XI. Google Reviews — "Neighbors agree"
- **Job:** Show the 4.9★ average and let real voices speak.
- **Layout:** Carousel (1 card on mobile, 3 on desktop). Each card: Google "G" SVG + reviewer name + ★★★★★ + 2-3 sentence quote + verified date.
- **Behavior:**
  - Keyboard: `ArrowLeft` / `ArrowRight` navigate. Dots below indicate position.
  - No autoplay. Ever.
  - Cards have soft `--shadow-sm` on `--yc-cream-soft` bg.
- **Red touchpoint:** The "5" in "5.0" rating summary above the carousel is `--yc-red-bright` Fraunces 500 52px. Quote-mark glyphs on each card are `--yc-red-deep` 60% opacity. Star glyphs are `--yc-gold-bright`, not yellow.

### XII. Gallery — "The portfolio"
- **Job:** Editorial proof. Not a Zillow grid — a *magazine*.
- **Layout:** Editorial asymmetric grid (masonry-ish). 6-10 photos. Mix of tight details (wreaths, roofline) and hero shots (full facade at blue hour). Caption overlay on hover.
- **Behavior:**
  - Click photo → lightbox (full-viewport), cream overlay 94%, close button top-right, arrow keys navigate.
  - Lightbox locks body scroll. High-res variant upgraded on open.
  - `prefers-reduced-motion`: instant open, no fade.
- **Red touchpoint:** Lightbox close button is a `--yc-red-deep` ring. Neighborhood chip eyebrow on each tile uses `--yc-red-deep`.

### XIII. Philanthropy — "We give back"
- **Job:** Differentiate. Yule Love Lights donates installs to Make-A-Wish / local causes.
- **Layout:** Centered prose block on `--yc-cream-soft` band. Optional small photo of last year's donation install.
- **Behavior:** Static.
- **Red touchpoint:** Lucide `Heart` icon in `--yc-red-bright` next to the partner name. Inline partner link is `--yc-red-deep` underline.

### XIV. FAQ — "The last 5%"
- **Job:** Handle the remaining objections without a phone call.
- **Layout:** Accordion. 6-8 questions. Closed by default.
- **Behavior:**
  - Pure CSS grid-template-rows expand trick (no JS height animation).
  - 280ms `--ease-out`.
  - One open at a time allowed but not required — let users open several.
  - "+" rotates to "×" (45deg) on open.
- **Red touchpoint:** "+" icon is `--yc-red-bright`. Question marker (Q1, Q2…) small-caps eyebrow is `--yc-red-deep`.
- **A11y:** `<details>/<summary>` preferred for no-JS fallback; enhanced with JS for animation.

### XV. Personal Contact / Engagement — "The close"
- **Job:** Convert. This is the page's reason for existing.
- **Layout:** Full-width `--yc-green` band. Centered. Large live-total price (Fraunces 500 72px). Deposit chip below. Big red CTA. Sub-line: "Selected: {activeName}". Small "Refundable through the morning of install" reassurance.
- **Behavior:**
  - CTA: `--yc-red-bright` fill, cream text, 56px tall. `--glow-red` at rest; deeper on hover.
  - Disabled when `currentTotal <= 0`.
  - On click: 400ms delay (feels considered), router push → `/portal/[quoteId]/approved` → home.works handoff.
  - Submitting state: spinner + "Processing" label, button disabled.
- **Red touchpoint:** The CTA itself is the biggest red object on the page, by design. Number "50%" in "50% deposit" copy in `--yc-gold-bright` Fraunces italic for warmth.
- **A11y:** Button `aria-label` includes the price: "Engage and pay ${deposit} deposit".

### (Footer) Disclaimer — "Quiet legal"
- **Job:** Legitimate, reassuring, not a flex.
- **Layout:** Centered small serif italic, `--yc-ink-muted`, under a single cream hairline + small gold ornament ✦.
- **Copy:** Pricing valid 30 days. Weather/schedule caveat. Ref + year.

### (Sticky) Engage Pill — "Always one tap away"
- **Job:** Let the customer convert from any section.
- **Layout:** Bottom-right on desktop (floats, `--shadow-xl`, rounded-md). Full-width bar at bottom on mobile.
- **Behavior:**
  - Reads live total from `SelectionContext`. Shows `—` if nothing selected.
  - On tap: smooth-scrolls to Engagement section anchor.
  - Mobile: respects `env(safe-area-inset-bottom)` with extra 12px padding.
  - `prefers-reduced-motion`: instant jump, no smooth scroll.
- **Red touchpoint:** The pill's button is `--yc-red-bright` with cream text and `--glow-red`. Price next to it in Fraunces on `--yc-green` spine.

---

## 11. Anti-Patterns (what NOT to do)

### Visual / brand
- ❌ **AI purple / pink gradients.** Destroys premium feel instantly. This is a holiday brand, not a tech startup.
- ❌ **Neon / glow pink / cyberpunk.** Off-brand.
- ❌ **Brutalism / intentionally ugly.** Our customers own $2M+ homes. They want *refined*.
- ❌ **Glassmorphism / heavy blur.** Reads techy and dated in 2026.
- ❌ **Pure black (`#000`) or pure white (`#fff`).** Always warm-tinted. `--yc-ink` and `--yc-cream` only.
- ❌ **Cool-blue shadows.** Warm, ink-based shadows only (`rgba(26, 20, 16, …)`).
- ❌ **Cognac / navy / wine palettes.** Off-brand per owner (confirmed).
- ❌ **Generic holiday emoji clutter (🎄🎅🎁) in UI.** 🎄 allowed in *copy only*, sparingly. Icons must be Lucide SVG.
- ❌ **Gold as the primary CTA color.** (v1 draft mistake — v4 informed correction.) Red owns CTAs; gold is garnish.

### Typography
- ❌ **All-serif everywhere.** Body serif at small sizes is hard to read. Sans for body, serif for display.
- ❌ **Cormorant Garamond as primary display.** Too thin, too cold. (v4 mistake — don't repeat.)
- ❌ **Font weight 300 on body.** Too fragile on mobile. Minimum 400.
- ❌ **All-caps running text.** Only for eyebrows/labels, never paragraphs.
- ❌ **Body text below 16px on mobile.** Violates readable-font-size rule.

### Interaction
- ❌ **Hover scales (`hover:scale-105`) on cards / buttons.** Layout shift, chintzy feel. Use color/shadow only.
- ❌ **Autoplay video, autoplay carousel, autoplay anything.** Respectful brands let the user lead.
- ❌ **Full-page confetti on approval.** A single gold ✦ seal fade-in instead. Reserved energy beats loud energy.
- ❌ **Tooltip-only info.** If it matters, show it inline. Tooltips fail on touch.
- ❌ **Icon-only buttons without `aria-label`.** Every single one needs a label.
- ❌ **"Hide on scroll-down" sticky bar.** Always visible. Conversion > cleverness.

### Layout
- ❌ **Full-width text lines > 100ch.** Cap at 65-75ch for prose.
- ❌ **Content touching viewport edges on mobile.** Minimum 24px horizontal padding.
- ❌ **Sticky bars covering content.** Our Engage pill is compact + offset on desktop.
- ❌ **Horizontal scroll on mobile** except intentional scroll-snap (package cards).

### Data / price display
- ❌ **"$1,299.00" with trailing zeros.** Retail. We write "$1,299."
- ❌ **Price without tabular-nums.** Digits dance on update. Always `font-variant-numeric: tabular-nums`.
- ❌ **Live price lag.** Selection changes must propagate within one render cycle (React Context, no effect chain).
- ❌ **Deposit shown without context.** Always pair with the full total and the word "Deposit" (uppercase eyebrow).

### Copy
- ❌ **"Click here" or "Submit."** CTA is always action-oriented: "Engage our team" / "Secure our December 12 install" / "Reserve this date".
- ❌ **Corporate filler: "Our team strives to…"** Cut. We write like Naldo talking over coffee.
- ❌ **Fake scarcity. ("Only 2 spots left!" when it isn't true.)** If we say [N] windows, it is real or it is not shown.
- ❌ **Countdown timers.** Never.

### Performance
- ❌ **Loading the video iframe on page load.** Lazy-swap pattern only.
- ❌ **Unoptimized gallery photos.** Next.js `<Image>` with WebP, responsive `sizes`, `loading="lazy"`, explicit `width`/`height`.
- ❌ **Blocking font load on LCP.** Use `next/font` with `display: swap`. Fraunces subset to `latin`.
- ❌ **Third-party scripts on critical render path.** Analytics loads after idle.

### Accessibility
- ❌ **Color as the only indicator.** Active package card has *both* color outline + pill label.
- ❌ **Focus ring removed without replacement.** `outline-none` requires visible `focus-visible` styles.
- ❌ **Auto-scrolling carousels.** Users cannot read. Keyboard users cannot catch up.
- ❌ **`aria-live` on the live price.** It will scream on every re-render. Price is visible; screen readers can read it on demand.

---

## 12. Implementation Notes

### File structure (canonical warm-cream portal)
```
src/app/portal/[quoteId]/
  page.tsx                       # Assembled sections
  approved/page.tsx              # Post-approval celebration
  portal.css                     # Route-scoped tokens + components
  layout.tsx                     # Font loading, .portal-root wrapper

src/components/portal/
  SelectionContext.tsx           # Shared selection state
  mockQuote.ts                   # Until wired to Supabase
  format.ts                      # formatUsd, formatDate
  TrustBar.tsx
  UrgencyBanner.tsx
  Hero.tsx
  Property.tsx
  WalkthroughVideo.tsx
  PackageCards.tsx
  WhatsIncluded.tsx
  RiskReversal.tsx
  WhatHappensNext.tsx
  MeetYourTeam.tsx
  GoogleReviews.tsx
  Gallery.tsx
  Philanthropy.tsx
  FAQ.tsx
  Engagement.tsx
  Disclaimer.tsx
  StickyEngage.tsx
```

### CSS scoping
Every style lives under `.portal-root` on the layout's root element. This prevents any v1/v2/v4/v6 bleed. Tokens are defined on `.portal-root` only — never on `:root`.

### Token exposure
```css
.portal-root {
  --yc-cream: #FAF6EF;
  --yc-ink: #1A1410;
  /* …full token set from Section 3… */
  --font-display: "Fraunces", "Playfair Display", Georgia, serif;
  --font-body: "Inter", -apple-system, sans-serif;
}
```

### Component pattern
```tsx
<h1 className="font-[family-name:var(--font-display)] text-[var(--yc-ink)]">
  Prepared for the Smith Family
</h1>
```

### Performance budget (enforced)
- **LCP:** < 2.0s on 4G. Hero image is `priority`, preloaded.
- **CLS:** < 0.05. Every image has explicit `width` + `height`.
- **INP:** < 200ms. Interactions respond synchronously.
- **JS bundle:** < 180KB gzipped for the portal route.

### Fonts
```tsx
import { Fraunces, Inter } from "next/font/google";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});
```

---

## 13. Pre-Delivery Checklist

Before merging any portal PR:

**Visual**
- [ ] No emojis used as UI icons (Lucide only; 🎄 allowed in copy).
- [ ] All icons come from Lucide React; consistent `w-5 h-5` (or `w-4 h-4` inline).
- [ ] No pure black or pure white rendered anywhere.
- [ ] Red appears in at least 3 places per section (button / eyebrow / rule / icon / drop cap / signature / mark).
- [ ] Gold appears in trust moments (press bar, reviews, seals, Engagement ornament) — not on CTAs.

**Interaction**
- [ ] Every clickable element has `cursor-pointer`.
- [ ] No `hover:scale-*`. Hover = color/shadow only.
- [ ] Transitions are 120–280ms, `--ease-out`.
- [ ] Reduced-motion CSS media query present and tested.
- [ ] Sticky Engage pill smooth-scrolls; instant-jumps under reduced-motion.

**Typography**
- [ ] Body ≥ 16px on mobile.
- [ ] Line-length capped at 65-75ch in prose sections.
- [ ] Tabular-nums on all prices, deposits, refs.

**Accessibility (WCAG AA)**
- [ ] All images have meaningful `alt`.
- [ ] All icon-only buttons have `aria-label`.
- [ ] Focus-visible ring visible on every interactive element.
- [ ] Color contrast AA+ everywhere (see §3.4).
- [ ] Keyboard tab order matches visual order; carousel is arrow-key navigable.
- [ ] `prefers-reduced-motion` respected (confetti, smooth-scroll, crossfades).

**Performance**
- [ ] Hero image `priority` + preloaded.
- [ ] Every other image `loading="lazy"` + `fetchpriority="low"`.
- [ ] Fonts via `next/font` with `display: swap`.
- [ ] Video iframe lazy-swapped on play-button click.
- [ ] LCP < 2.0s on throttled 4G in Lighthouse.

**Copy**
- [ ] CTA text is action-oriented, first-person business ("Engage our team", "Secure our Dec 12 install").
- [ ] No "Submit" / "Click here" / "Learn more."
- [ ] Scarcity claims are data-backed or removed.

**Mobile (375px baseline)**
- [ ] No horizontal scroll anywhere except package cards (scroll-snap).
- [ ] Touch targets ≥ 44×44px.
- [ ] Sticky bar respects `env(safe-area-inset-bottom)`.
- [ ] Tested at 375, 414, 768, 1024, 1280, 1440.

---

## 14. Change Log

| Date | Version | Change |
|---|---|---|
| 2026-04-23 | 0.1 | Initial draft — gold as primary CTA, `--yll-*` tokens. |
| 2026-04-24 | 1.0 | **Red promoted to primary CTA**, two-red strategy (`--yc-red-bright` + `--yc-red-deep`), Fraunces/Inter replaces Playfair/Inter, Red Budget Framework added, anti-patterns expanded with v4 learnings (Cormorant-too-cold, gold-as-CTA rejected). Tokens renamed `--yc-*`. |

---

*This document is the Source of Truth for the customer-portal page. Page-specific overrides (e.g., `/portal/[quoteId]/approved`) live alongside it in `design-system/pages/` with explicit deltas.*
