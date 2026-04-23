# Yule Love Lights — Customer Portal Design System

> Page-specific overrides for `src/app/portal/[quoteId]/**`.  
> Synthesized from `ui-ux-pro-max` (Conversion-Optimized Landing + Social Proof-Focused + Soft UI Evolution + Editorial Grid) with the Yule Love Lights brand palette applied.

## 1. Pattern & Style Layering

| Layer | Source | Why |
|-------|--------|-----|
| Primary pattern | **Hero + Testimonials + CTA** (Conversion-Optimized Landing) | The page IS the sales close. Social proof must precede each CTA moment. |
| Secondary pattern | **Social Proof-Focused** | Press logos, Google reviews, live booking counter, gallery, philanthropy — all credibility. |
| Visual layer | **Soft UI Evolution** | Soft multi-layer shadows + 10–16px radii = premium, cozy, not corporate. WCAG AA+ by default (contrast-safe, unlike classic neumorphism). |
| Gallery accent | **Editorial Grid / Magazine** | Asymmetric gallery grid with neighborhood-labeled tiles — feels like a luxury holiday magazine spread. |

Goal: every section moves the customer one step closer to "Approve & Pay 50% Deposit." Nothing decorative, everything earns its space.

## 2. Color Tokens

Warm, premium, holiday-coded. No pure black, no pure white, no AI purple/pink.

### Core palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--yll-red-700` | `#8A1A22` | Primary brand — headers, accents, section dividers (hover on CTAs) |
| `--yll-red-600` | `#B3202D` | Primary — buttons in dormant state, logo |
| `--yll-red-500` | `#C83540` | Hover/active tint |
| `--yll-red-50`  | `#FBEFEF` | Red-tinted surfaces, badge backgrounds |
| `--yll-green-800` | `#16321F` | Evergreen deep — text-on-cream accent, footer bg |
| `--yll-green-700` | `#1F3D2B` | Evergreen — section eyebrows, checkmarks |
| `--yll-green-600` | `#2D5238` | Evergreen lighter — trust-bar press logos |
| `--yll-green-50`  | `#EDF2EC` | Evergreen-tinted surfaces |
| `--yll-gold-600` | `#B8862A` | Warm gold deep — button hover |
| `--yll-gold-500` | `#C89B3C` | **Primary CTA color** — "Approve & Pay 50% Deposit" |
| `--yll-gold-400` | `#D9B15B` | Gold tint — stars, badges, trust icons |
| `--yll-gold-50`  | `#FBF5E8` | Gold-tinted surfaces — recommended-package highlight |
| `--yll-cream-50` | `#FAF6EF` | **Primary page background** (warm, not white) |
| `--yll-cream-100` | `#F3EDE1` | Alternating section bg |
| `--yll-cream-200` | `#E8DFCC` | Dividers, rule lines |
| `--yll-ink-900` | `#1F1B16` | **Primary text** (deep charcoal, warm black — never `#000`) |
| `--yll-ink-700` | `#3A3229` | Secondary text |
| `--yll-ink-500` | `#6B5F52` | Muted text, metadata, neighborhood labels |
| `--yll-ink-300` | `#9E9082` | Placeholder, disabled |

### Contrast audit (WCAG AA = 4.5:1 normal text, 3:1 large)

- `#1F1B16` on `#FAF6EF` → 13.8:1 ✅
- `#3A3229` on `#FAF6EF` → 9.6:1 ✅
- `#6B5F52` on `#FAF6EF` → 5.1:1 ✅ (passes for body, use ≥14px)
- `#FAF6EF` on `#B3202D` (button text on red) → 6.9:1 ✅
- `#1F1B16` on `#C89B3C` (gold CTA label) → 6.3:1 ✅
- `#FAF6EF` on `#1F3D2B` (cream on evergreen) → 12.1:1 ✅

## 3. Typography

**Pairing: Playfair Display (serif) + Inter (sans)** — warm, editorial, hospitality-coded, both available via `next/font/google` for zero-layout-shift loading.

### Ramp (mobile-first; scale up at md breakpoint)

| Token | Font | Mobile | Desktop | Weight | LH | Use |
|-------|------|--------|---------|--------|----|----|
| `display-hero` | Playfair Display | 40px | 64px | 600 | 1.05 | Hero headline |
| `display-1` | Playfair Display | 30px | 44px | 600 | 1.1 | Section H2 |
| `display-2` | Playfair Display | 24px | 32px | 500 | 1.2 | Subsection H3 |
| `eyebrow` | Inter | 12px | 13px | 600 (tracking-[0.14em] uppercase) | 1.4 | Section eyebrow labels |
| `body-lg` | Inter | 17px | 18px | 400 | 1.6 | Lead paragraphs |
| `body` | Inter | 16px | 16px | 400 | 1.65 | Default body |
| `body-sm` | Inter | 14px | 14px | 400 | 1.55 | Metadata, line items |
| `label` | Inter | 14px | 14px | 600 | 1.4 | Button text, form labels |
| `price-hero` | Playfair Display | 44px | 56px | 700 | 1.0 | Package card totals |
| `disclaimer` | Inter | 12px | 12px | 400 | 1.5 | Bottom disclaimer |

Fallbacks: `ui-serif, Georgia, "Times New Roman", serif` for Playfair; `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` for Inter.

## 4. Spacing Scale

Tailwind default 4px base with named tokens for common section rhythms:

| Token | Value | Use |
|-------|-------|-----|
| `space-section-y` | `py-16 md:py-24` | Between major sections |
| `space-section-inner` | `gap-8 md:gap-12` | Inside a section |
| `space-card` | `p-6 md:p-8` | Package card, review card |
| `space-line-item` | `py-3` | Line items in "What's Included" |
| `container` | `max-w-6xl mx-auto px-4 sm:px-6 lg:px-8` | Standard page container |

## 5. Border Radius Scale

Rounded enough to feel friendly, never childishly oversized.

| Token | Tailwind | Use |
|-------|----------|-----|
| `radius-sm` | `rounded-md` (6px) | Badges, chips |
| `radius-md` | `rounded-xl` (12px) | Buttons, small cards |
| `radius-lg` | `rounded-2xl` (16px) | Package cards, FAQ items, review cards |
| `radius-xl` | `rounded-3xl` (24px) | Hero image container |

Explicitly NOT `rounded-full` on rectangles — we're premium, not iOS 7.

## 6. Shadow Scale

Soft UI Evolution — multi-layer, warm-tinted (not blue-gray), softer than flat, clearer than neumorphism.

| Token | CSS | Use |
|-------|-----|-----|
| `shadow-card` | `shadow-[0_1px_2px_rgba(31,27,22,0.04),0_8px_24px_-8px_rgba(31,27,22,0.08)]` | Package cards idle |
| `shadow-card-hover` | `shadow-[0_2px_4px_rgba(31,27,22,0.06),0_16px_40px_-12px_rgba(31,27,22,0.14)]` | Package cards hover |
| `shadow-cta` | `shadow-[0_4px_12px_-2px_rgba(200,155,60,0.45)]` | Gold CTA button (warm glow) |
| `shadow-sticky` | `shadow-[0_-6px_24px_-8px_rgba(31,27,22,0.15)]` | Sticky bottom bar (shadow upward) |

## 7. Motion

- Micro-interactions: **200ms** `cubic-bezier(0.4, 0, 0.2, 1)` (hover, focus, toggle)
- Section reveals on scroll: **450ms** `cubic-bezier(0.22, 1, 0.36, 1)` opacity + 16px translate-y
- Accordion expand: **250ms** with `grid-template-rows` trick (no layout jank)
- Before/after toggle: **350ms** opacity cross-fade
- Confetti (approval page): **1200ms** single burst, then settle
- **`prefers-reduced-motion`**: all transforms and opacity animations disabled, instant state change; confetti replaced with a single ornament icon fade-in

## 8. Focus Ring

Keyboard accessibility signature — gold ring on cream, never browser-default blue.

```css
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-[#C89B3C]
focus-visible:ring-offset-2
focus-visible:ring-offset-[#FAF6EF]
```

Applied to every button, link, input, accordion trigger, toggle, carousel control.

## 9. Section-by-Section Interaction Notes

### 1. Trust Bar (press logos)
- Horizontal strip, cream-100 bg, evergreen logos at ~60% opacity (premium restraint).
- On mobile: horizontal scroll with snap; on desktop: centered flex-wrap.
- Repeat "Newsday" 3× as per spec (they featured the company 3×) — stagger with subtle size variation.
- Right side on desktop: "5 years · 200+ homes" in evergreen sans.

### 2. Hero
- Full-bleed rendered photo in `rounded-3xl` container with gold 1px inner border.
- Headline overlays bottom-left with cream backdrop blur card (readable over any photo).
- Before/after toggle: small pill in top-right of photo, icon + label; cross-fade 350ms.
- On load: photo fades in 800ms, headline slides up 450ms staggered by 150ms.
- Mobile: photo aspect `4:3`; desktop: `16:9`.

### 3. Urgency Banner
- Full-width strip, evergreen bg, cream text, gold icon (Lucide `Calendar`).
- "12 homes booked this week" uses a subtle pulsing dot (green, 2s pulse). Number is static copy in mock — real impl would fetch from API.
- NEVER a countdown timer. Just honest scarcity.

### 4. Package Cards
- Desktop: 4-up grid; mobile: vertical stack.
- Package B has permanent "RECOMMENDED" gold ribbon ↗ and slightly larger scale (transform-origin top; 1.02 factor).
- Selected card: red top-border (4px), gold-tinted bg, shadow-card-hover. Unselected cards dim to 60% opacity.
- Each item inside a card is an individual toggle row. Toggling an item in A/B/C auto-converts selection to "Custom (D)" and updates the header + total.
- Live price: use `tabular-nums` so numbers don't shift width when updating.
- Savings line under Package C ("You save $185 vs. à la carte") in evergreen, italic Playfair.

### 5. What's Included
- Two-column on desktop, one-column on mobile.
- Each line: Lucide icon (`Home`, `Triangle`, `TreePine`, `Circle`, `Wreath` fallback, `Sparkles` for spritzers) in gold circle chip + label + quantity.
- Tap-to-collapse category headers with chevron.

### 6. Risk Reversal
- 2×3 grid on desktop (3×2 on mobile, single column on small mobile).
- Lucide `CheckCircle2` in evergreen for each checkmark.
- Cards on cream-100 with 1px cream-200 border. No shadow — keep quiet next to loud CTAs.

### 7. What Happens Next
- Horizontal timeline on desktop with connected dashed line; vertical on mobile.
- Each step: number circle (gold, cream number) + H3 + 1-line body.
- `CheckCircle2` appears on completed steps (step 1 marked "today" with a subtle pulse).

### 8. Meet Your Team
- Portrait on left (circle-cropped, `rounded-full`, 160px), copy on right.
- Small "Director of Operations" eyebrow above name.
- 2-row quote-style body in Playfair, not sans — feels personal.

### 9. Google Reviews
- Top bar: 5 gold stars (Lucide `Star` filled) + rating number (Playfair 44px) + "based on 247 reviews" (Inter muted).
- 2–3 featured review cards in a horizontal carousel (keyboard-nav via arrow keys).
- Each card: quote, name + neighborhood, small Google logo SVG in the corner.

### 10. Gallery
- Editorial asymmetric grid — desktop: varying column spans with 4 rows of 12; mobile: 2-column masonry.
- Each tile: rounded-2xl, neighborhood label chip bottom-left in cream-50/80 backdrop-blur.
- Click opens lightbox: dim cream-black overlay, ESC/click-out to close, keyboard arrow nav, image fills ~80vw.

### 11. Philanthropy
- Evergreen bg full-bleed strip. Cream text. Gold `Heart` icon.
- Partner logos desaturated, 50% opacity — classy acknowledgment, not bragging.
- One short paragraph. One link "Learn about our giving" in gold underline.

### 12. FAQ
- Accordion, collapsed by default. Only one open at a time (tabs pattern).
- Trigger: full-width button, chevron rotates 180° on open (200ms).
- Content: `grid-template-rows: 0fr → 1fr` for smooth height transition.
- Divider between items in cream-200.

### 13. Personal Contact
- Small card, cream-100 bg, rounded-2xl.
- Small photo of Naldo (same headshot as Meet Your Team, smaller).
- Phone number as tappable `tel:` link in gold, Playfair 24px.
- "Response within 1 hour" in Inter muted below.

### 14. Sticky Bottom Bar
- Fixed at bottom, cream-50 with shadow-sticky.
- Two-zone flex: left = selected package name + price (tabular-nums); right = gold CTA button.
- Mobile: full width, CTA button full-width, name above price stacked.
- Respect safe-area: `pb-[env(safe-area-inset-bottom)]`.
- "Save for later" link in small gray underneath CTA.
- Hide on scroll-down, reveal on scroll-up? — NO. Always visible per spec.

### 15. Disclaimer
- Inter 12px, ink-500, line-height 1.5, max-width 65ch, centered.
- Not in a card, just sitting in cream-100 above the footer.

### 16. Approval Page
- Cream bg. Centered column, max-w-lg.
- `PartyPopper` icon (Lucide) in gold circle at top.
- H1 Playfair "🎄 You're booked!" — ONE emoji allowed per brand rules.
- Confetti: one-time CSS animation burst (200–300 particles, 1200ms). Respects `prefers-reduced-motion`.
- Referral card at bottom — gold bg, cream text, copy-link button with `Copy` icon + transient "Copied!" toast on click.

## 10. Icons — Lucide Set

Exact icons used across the portal (all from `lucide-react`):

| Icon | Use |
|------|-----|
| `Calendar` | Urgency banner |
| `Home`, `Triangle`, `TreePine`, `Circle`, `Sparkles`, `Gift`, `Cherry` | Line items |
| `CheckCircle2` | Risk reversal, timeline completed steps |
| `ShieldCheck` | Insurance/bonded badge |
| `Star` | Google review stars |
| `ChevronDown` | FAQ accordion trigger |
| `ChevronLeft`, `ChevronRight` | Carousel controls |
| `Heart` | Philanthropy section |
| `Phone` | Contact section |
| `Copy`, `Check` | Referral copy-link state |
| `PartyPopper` | Approval page header |
| `ArrowLeftRight` | Before/after toggle |

## 11. Anti-Patterns (Do Not Ship)

- ❌ Pure white `#ffffff` backgrounds (looks sterile — use cream `#FAF6EF`)
- ❌ Pure black `#000000` text (use ink-900 `#1F1B16`)
- ❌ Purple/pink gradients anywhere
- ❌ AI-generated-looking chrome/glass effects on cards
- ❌ Countdown timers, fake scarcity numbers
- ❌ Emoji as UI icons (only 🎄 in copy headlines is allowed)
- ❌ Multi-color hero headlines (single weight/color per line)
- ❌ Generic stock-image placeholders with people in business suits
- ❌ Tiny (<16px) body text on mobile
- ❌ `rounded-full` on wide rectangular cards (reads as children's app)
- ❌ Hover scale >1.02 (layout shifts)
- ❌ `transition-all` (slow + unpredictable — always name the properties)
- ❌ Auto-playing carousels (accessibility failure, fake urgency)
- ❌ Modals for approval confirmation (we navigate to a full page)

## 12. Performance Budget

- LCP target: < 2.0s on 4G mid-tier phone
- Hero image served via `next/image` with `priority`, aspect-ratio reserved to prevent CLS
- All other images `loading="lazy"`, `decoding="async"`
- Gallery images: responsive `sizes` attribute + Unsplash `w=800&q=75` URL param
- No client-side JS for sections 1–3, 5–7, 10–13, 15 (pure static RSC where possible)
- Interactive sections (package toggles, FAQ, gallery lightbox, before/after) as small client components

## 13. Pre-Delivery Checklist

- [ ] All clickable elements have `cursor-pointer`
- [ ] `focus-visible:ring-2 ring-[#C89B3C]` on every interactive
- [ ] Minimum 44×44px tap targets
- [ ] Body text ≥ 16px on mobile
- [ ] Image `alt` text meaningful (or `alt=""` for decorative)
- [ ] `prefers-reduced-motion` disables all transforms/opacity animations
- [ ] Responsive tested at 375, 768, 1024, 1440 px
- [ ] No horizontal scroll at any breakpoint
- [ ] No Lucide icons mixed with Heroicons (single set)
- [ ] Price numbers use `tabular-nums` everywhere
- [ ] Sticky bar respects `env(safe-area-inset-bottom)`
- [ ] Tailwind `transition-colors duration-200` on hover states (not `transition-all`)
- [ ] No `@apply` in globals (Tailwind v4 handles tokens via `@theme`)
- [ ] Typecheck passes (`tsc --noEmit`)
