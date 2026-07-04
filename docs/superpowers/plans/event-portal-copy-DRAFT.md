# Event Portal — copy DRAFT (for Naldo's review)

> Customer-facing wording for the **Event Lighting** portal variant. Same premium
> skin as the holiday portal; every string re-voiced for events. **Leads with the
> feeling, not the trade term** (a bride doesn't know "C9 / spritzer / bistro") —
> council/Outsider note. **DRAFT — Naldo edits + approves before Phase-2 build.**
>
> Both open decisions are RESOLVED (Naldo, S22): primary CTA = self-serve deposit
> (option A); venue visual = reuse the SAME design/photo hero as the holiday portal
> (the operator uploads the venue image and designs on it — the design tool already
> supports uploaded images). See the resolved notes at the bottom.

---

## Tab title / metadata
**Your Yule Love Lights Event** — *Lighting designed for your celebration*

## Hero (headline)
- **Headline:** *Your celebration, beautifully lit.*
- **Subhead:** Here's the lighting design we put together for your event. Take a
  look, keep what you love, and we'll make it glow.

## Choose your glow (color picker)
- **Heading:** Choose your glow
- **Body:** Most events shine in warm white — but your lights can be any color to
  match your celebration. Tap a color to see it on your design.

## What's included (the single package)
- **Heading:** What's included
- **Body:** Everything below is part of your quote. Not sure about a piece? Tap to
  add or remove it and build the exact look you want.

## Want to add a little more? (suggestions)
- **Heading:** Want to add a little more?
- **Body:** A few touches that pair beautifully with your design — just say the
  word and we'll add them.
- *(each suggestion card shows a feeling-first label + one-liner; drafts live in
  `src/lib/event/packages.ts` — e.g. "Curtain lights — a glowing curtain of light
  draping down the front of the house.")*

## Your event schedule (the 3 dates)
- **Heading:** Your event schedule
- **Timeline (3 steps):**
  - **We install** — {install date}
  - **Your event** — {event date}
  - **We take down** — {takedown date}
- **Note:** We're on standby the day of, and everything comes down cleanly after —
  no ladders, no cleanup, nothing left behind.

## Our guarantees (Risk Reversal — 5 cards)
- **Something out? We fix it fast.** If a bulb or strand goes dark before your
  event, we're on it — usually the same day.
- **Every bulb, guaranteed lit.** We test the whole display before your event, and
  again the day of.
- **We handle takedown.** Everything comes down on the date we agreed after your
  event — you never touch a light. *(replaces the Christmas "Jan 9–Feb 3".)*
- **Careful with your space.** Professional install with no damage to your home,
  venue, or landscaping.
- **Fully insured.** Licensed and insured, so you and your venue are covered.

## What happens next (timeline)
- **Heading:** From approval to your big night
- **Steps:**
  1. **Reserve your date** — lock in your design with a 50% deposit.
  2. **Confirm the details** — we lock your install, event, and takedown dates and
     walk your venue if it helps.
  3. **We install** — our team sets everything up before your event and tests every
     light.
  4. **Your event shines** — we're on standby, then take it all down after —
     clean and complete.

## Trust / social proof (logos)
- Reuse as-is (generic): *Trusted by* … / *As seen in* … (no seasonal wording).

## About / meet your team
- Reuse, one line widened: *"…from holiday displays to weddings and celebrations."*

## Recent events (gallery)
- **Heading:** Recent events we've lit

## FAQ (event-specific)
- **How far ahead should I book?** As early as you can — dates fill up, especially
  in wedding season. Reach out and we'll hold yours.
- **Can you light a venue, not just a house?** Yes — backyards, barns, tents,
  gardens, and more. Tell us about the space.
- **What if it rains?** Our lights and connectors are weather-rated for outdoor use.
- **Can I choose the colors?** Absolutely — warm white is most popular, but we'll
  match your palette.
- **How long can the lights stay up?** As long as your event window needs — we
  install before and take down after.
- **Do you bring power and poles?** Yes — we bring everything, including
  freestanding poles and bases where there's nothing to hang from.

## Personal contact
- Reuse as-is.

## Disclaimer
- Final pricing may adjust after a site visit. Your install, event, and takedown
  dates are confirmed with you before your event. *(+ standard terms.)*

## Sticky bottom bar (CTA)
- **Primary button:** **Reserve your date — 50% deposit**
- **Booked state:** **You're booked!** — *See you on {event date}.*

## ✅ DECISION 1 — RESOLVED: self-serve deposit (option A)
Primary CTA = **"Reserve your date — 50% deposit"**, same self-serve flow as the
holiday portal. (Naldo chose A over the consult-first variant.)

## ✅ DECISION 2 — RESOLVED: reuse the SAME design/photo hero
The event portal uses the **exact same design/photo hero as the holiday portal**
(`InteractiveHero` — no new component). The design tool already accepts an
**uploaded image**, so the operator uploads the actual venue photo (backyard,
barn, tent, wherever the event is) and designs the lighting on it — just like the
existing upload-image design flow. No special venue handling, no fake house; the
event hero inherits the holiday hero as-is. (Naldo confirmed.)

## Vocabulary fixes carried into the copy
- "Barrels / boxes" → **"Freestanding light poles & bases"** (already in the pricing
  engine label).
- No "C9 / spritzer / bistro" in customer-facing headings — lead with the look
  ("warm rooflines", "curtain of light", "café lights overhead"); the trade term
  can sit in small print if useful.
