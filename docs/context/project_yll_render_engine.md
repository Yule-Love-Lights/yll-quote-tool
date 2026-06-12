---
name: YLL Render Engine project
description: Rendering engine for the Ai Quote Tool — generates premium photoreal visualizations of finished holiday light installs for proposals
type: project
originSessionId: 9a796ca6-9b85-4647-b1fd-90436e9d1ffd
---
> **⚰️ HISTORICAL (2026-06-12): this entire pipeline was REMOVED in task #36** — code (`src/lib/rendering/*`, routes, admin pages), the `renders` table + bucket, and the Gemini/Replicate env vars are all gone. The portal visual is the live Konva design (#27/#35). Keep this doc only as the record of what was built and why; do NOT use it to guide new work.

**Project:** Premium render engine that takes a daytime house photo + Claude Vision detections (polylines, bounding boxes) and outputs a photoreal nighttime "this is what your install will look like" image for the proposal page.

**Why:** The render IS the sales close at this price point (multi-million-dollar LI homes, $1,500+ quotes). Holiday Home Concepts (competitor, Konva-based) ships fake-looking bulbs and illustrated skies; YLL's render needs to feel photographed, not clipart.

**How to apply:** When working on `src/lib/rendering/` or anything near the quote/proposal flow, respect these locked-in decisions:

- **Tier:** Gold (~10 weeks, Phase 1–5). Deadline before June 2026.
- **Approach:** Option D — server-side sharp canvas composite (bulbs along polylines, mask PNG) → single Gemini 3 Pro Image pass with photo + composite + mask as reference images. The mask is what gives pixel-precise placement; text coordinates alone drift.
- **Framing:** "Artist's rendering — actual install may vary" disclaimer visible on the proposal page. This is intentional — gives AI drift room to breathe and is legally protective.
- **Approval flow:** Internal-first. Render generates → Jason/Naldo reviews in `/admin/renders` → approves → customer slug URL activates. Unapproved URLs show holding page.
- **Storage:** Supabase (extends existing `renders` table + bucket), not Vercel Blob. One vendor.
- **Cache key:** `hash(photo + visionData + style + palette)` — same inputs never re-bill Gemini.
- **Additive only:** new `src/lib/rendering/` folder. Never modify `photoAnalysis.ts`, `pricingEngine.ts`, `corrections.ts`, `training.ts`.
- **Bulb sprites:** AI-generated (Naldo's choice) — not vendor-designed. Generate candidates in Phase 1 using Gemini 3 Pro Image itself.
- **No Homeworks wiring this cycle.** Approve button is a design placeholder only.
- **Subdomain:** `quotes.yulelovelights.com` or `portal.yulelovelights.com` (decide later).

**Brand aesthetic (from reference install photos Naldo sent 2026-04-22):**
- **Signature look = warm white C9 everywhere.** No multi-color in any reference photo.
- **Red bow on wreaths** is the only color pop. Wreaths go on front gable, not always above door.
- **Heavy dense bush/tree wrapping** — warm white canopy drape, not scattered dots. Trunk wraps on select trees.
- **Porch column spiral wraps** in warm white.
- **Interior window glow preserved** — warm yellow interior light through windows is a recurring cinematic element and the prompt must not darken it.
- **Dark-but-not-pitch-black sky** with subtle tonal gradient. No stars prominent. No fake illustrated sky.
- **Color switching in final version:** yes — Phase 2 palette system (warm-white / multi / red-green) lets Jason flip palettes per quote. Warm-white is the default because it matches the reference aesthetic.

**Infra to set up BEFORE Phase 1 build starts:**
- `GEMINI_API_KEY` from Google AI Studio, billing ceiling $200/mo
- `HF_API_TOKEN` from Hugging Face (for Depth Anything v2 in Phase 3)
- Supabase migration: `renders` table (id, quote_id, version, style, status, approved_at, photo_hash, vision_hash, storage_path, ssim_score, created_at) + `renders` storage bucket with RLS
- ffmpeg in Vercel build for Phase 5 bloom-pulse video export

**Phase order:**
1. Foundation — sharp compositor + mask builder + Gemini client + admin gallery (wks 1–2)
2. Precision & polish — palettes, tree-wrap logic, sprite library, SSIM drift guard (wks 3–4) **← first shippable internally**
3. Depth-aware lighting — Depth Anything v2 surface glow (wks 5–6)
4. Atmosphere & controls — weather moods, per-element intensity (wks 7–8)
5. Delivery — proposal page, bloom video export, approval workflow (wks 9–10)

**Daylight source corpus (Naldo sent 2026-04-22):** 4 daylight Street View photos covering LI archetypes — low-slope ranch, colonial-with-solar-panels, large craftsman with wrap-around porch, cape with mature landscaping. Prompt implications:
- Solar panels must be preserved, not removed. Compositor masks them out of any "light placement" zone.
- Wrap-around porches → column-wrap sprite density scales with visible column count.
- Mature foundation plantings → Phase 2 needs a "wrap this / leave this" signal per plant region.
- Daytime sky replacement must be full, not tint — overcast and clear-blue source skies must both yield the dark-gradient night sky.

**Still missing (soft ask, not blocking):** a matched before/after PAIR (daytime source + finished night photo of the same house). Useful for prompt calibration; can proceed without it.

**Phase 1 status (as of 2026-04-22): SHIPPED + VALIDATED.** First end-to-end render produced a photoreal nighttime output Naldo rated "literally looks amazing." This validates Option D (sharp composite + mask-guided Gemini 3 Pro Image refinement) as the right architecture. Key working specs to preserve:
- Model ID: `gemini-3-pro-image-preview` (NOT `gemini-3-pro-image` — that 404s)
- Response parsing: Google REST API returns `inlineData` (camelCase) in responses but accepts `inline_data` (snake) in requests. Parse both defensively.
- Nano Banana Pro has **no free tier** — API key needs billing attached. Typical cost ~$0.134/image.
- Supabase RLS: the `renders` table + `renders` bucket use permissive `FOR ALL USING (true)` policies matching existing training_houses/photo_corrections pattern. The restrictive service-role-only policies I wrote initially broke the anon-key insert path — had to drop them in `2026-04-22-renders-fix-rls.sql`.
- Smoke test UI lives at `/admin/renders/new` — upload photo, analyze + render in one click. `/admin/renders` gallery shows 4-up Source/Composite/Mask/Final.
