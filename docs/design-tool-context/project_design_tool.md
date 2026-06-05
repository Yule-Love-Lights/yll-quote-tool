---
name: project-design-tool
description: "Yule Love Lights' internal light-design tool — upload house photo, draw glowing lights over it, download the image"
metadata: 
  node_type: memory
  type: project
  originSessionId: f873dbf4-c7e5-42d7-9853-231824d98139
---

> **⚠️ Naming note (2026-06-02):** This file — previously `project_quote_tool.md`, now **`project_design_tool.md`** — is the **DESIGN TOOL**: the internal canvas app for drawing glowing lights on customer house photos and downloading the image. It is **NOT** the separate AI Quote Tool (the Next.js + Supabase quoting app, `yll-quote-tool`), which lives in [[project-ai-quote-tool]]. The old "quote_tool" name was a legacy artifact from the earliest sessions.

Building an internal-only design tool for Yule Love Lights ([[user-profile]]). Inspired by HHC ([[reference-hhc]]) but **much smaller in scope** — see clarifications below.

**Why:** Jason wants his own tool to mock up Christmas/permanent light installations on customer home photos and send the finished images to customers as a sales aid.

**How to apply:** This is NOT a quoting/proposal/inventory app. Don't add pricing, inventory, proposals, PDFs, multi-user roles, or invoicing features unless Jason asks. Match HHC's *canvas experience* but skip its business-management surface.

## Current state at a glance (read this first)
**Working:** Login • **Clients → Projects → Designs** dashboard (clients w/ optional contact info, nested projects, search + sort; project page = breadcrumb + design tabs + embedded editor) • Editor with photo upload, brightness slider, yardsticks (multi, selectable, deletable with reassign), strand draw (C9/Mini/Permanent/Bistro — perm has beam controls, bistro has catenary sag), Wreath/Bow (PNG variants), Garland (PNG-tiled strand-like, sizable), Spritzer (procedural radial spray, sizable, color pattern + Multi shortcut), Text (4 Google Fonts, lit-up glow, optional outline, dblclick to edit in place), Custom uploads (own category; server-side library; Glow / Flip H / Flip V), Poles (own category; cube/barrel/no base; top-anchor-only resize for height) • Marquee multi-select filtered by active type • Konva.Transformer resize/rotate/move • Per-strand yardstick binding • Per-type "Sized using" dropdown • Ctrl+C / Ctrl+V copy-paste at cursor • Undo/redo (Ctrl+Z / Ctrl+Shift+Z) • Settings page tabbed by category (Palette / Lights / Decor / Text / Custom / Poles) • Auto-save (debounced) • Photo-quality JPG download (yardsticks hidden in export) • "Select All [Type]" button in every item edit panel.

**Next up:** **AI Quote Tool integration** ([[project-ai-quote-tool]]) — now unblocked since the Clients/Projects/Designs refactor shipped. First cut: `surface` tag on `StrandItem` + `GET /api/designs/:id/export`. Not started — awaiting Jason's go.

**Image assets** live in `client/public/items/` — wreath/wreathbow/bow + garland-with/without-lights PNGs all present and in use. Spritzer/text/poles are procedural (no PNG). Custom uploads are stored server-side under `data/photos/` and served at `/photos/...`.

**Session continuity:** see [[session-log]] for the running per-session log (what shipped, where each session left off). Read it at the start of a session; append/expand the current session's entry when wrapping up (especially near context limit).

**Memory snapshot in the repo (set up 2026-05-29):** these memory `.md` files are mirrored into the repo at `docs/context/` so the project context travels with the repo — for backup and so Naldo (who currently works on the Quote Tool on his own machine) can onboard onto the design tool with full AI context if/when he joins it. The live copy Claude reads is still `~/.claude/projects/.../memory/`; `docs/context/` is a **manual periodic snapshot** that can drift. **Re-snapshot when wrapping up a session or after a big change:** copy `~/.claude/projects/C--Users-Jason-Desktop-YuleLoveLights-Claude/memory/*.md` → `<repo>/docs/context/`, then Jason pushes. See `docs/context/README.md` for the teammate-onboarding steps.

**Git is initialized.** Branch `main`, initial commit `52e41c2` covers everything through Wreath + Bow + per-type defaults. Local user: `Jason <naldoven@yulelovelights.com>`. `.gitignore` excludes `node_modules/`, `dist/`, `server/data/` (customer photos + DB), `.claude/settings.local.json` (per-machine Claude Code config).

**Git workflow for this project:** never commit without Jason's explicit yes. Instead, *proactively suggest* commits at logical checkpoints — after each logical chunk lands (e.g. after Garland, after a refactor, after a multi-fix round) and periodically during longer work as a safety net. Surface the suggestion ("good checkpoint — commit?") and wait for yes/no.

**GitHub (set up 2026-05-26):** Pushed to a private GitHub org **`Yule-Love-Lights`**. This repo = **`design-tool`** at `https://github.com/Yule-Love-Lights/design-tool` (remote `origin`, branch `main` tracks `origin/main`). The Quote Tool ([[project-ai-quote-tool]]) is the org's other repo (`yll-quote-tool`). The earlier "paused pending Naldo" hold is LIFTED.
- **I (Claude) CANNOT push** — the auto-mode data-exfiltration guard hard-blocks pushing to this org (it's not a configured trusted source-control org). So: I commit locally as normal; **Jason runs `git push` himself** in his own terminal. If he wants me to push routinely, he can add a Bash permission rule / trust the org in Claude Code settings (use the update-config skill) — his call, it loosens a safety setting.
- **Flow is direct-to-`main`, NO pull requests.** Jason confirmed 2026-05-26 he doesn't want a PR flow (he's effectively the sole committer). Don't create branches/PRs; commit to `main` and let him push. (`gh` CLI is not installed.)
- Auth on Jason's PC: Git Credential Manager 2.6.1, browser OAuth (cached after first sign-in). Gotcha hit during setup: GitHub rejects account-password auth — must use the browser sign-in, not type a password.
- `data/` (photos + SQLite DB) is gitignored — customer data never gets pushed.

## Scope (confirmed 2026-05-25)
**Primary goal:** Upload a customer's house photo → draw glowing Christmas/permanent light designs over it → download the finished image to send to the customer.

**Secondary goal:** Show strand-length measurements in feet so they know how much wire they have drawn.

**Explicitly NOT in scope:**
- Inventory tracking
- Pricing / price-per-foot / per-item prices
- Proposals with totals / share links
- PDF generation
- Labor / hardware / tax lines
- Per-staff accounts or role separation

## Confirmed decisions
- **Auth:** single shared login for all Yule Love Lights staff.
- **Bulb visuals:** procedural/canvas-generated glow (radial gradient + `globalCompositeOperation: "lighten"`). No sprite assets to license or source.
- **Output:** download the rendered image (PNG/JPG of photo + light overlay). No web share link, no PDF.
- **Asset categories (day 1):** strand lights (C7, C9, Mini, Permanent), ornaments + wreaths + bows + garland, spotlights + spritzers + trees + spheres. (Reindeer and custom text deferred.)
- **Photoreal glow is non-negotiable** — that's the whole point of the tool.

## Stack (built 2026-05-25)
- **Frontend** (`client/`): Vite + TypeScript + Konva.js 9, vanilla TS with a hash router.
- **Backend** (`server/`): Fastify 5 + `node:sqlite` (Node 22+ built-in, no native compile) + filesystem photo storage. Sessions via `@fastify/session`, single shared password via env var `APP_PASSWORD`.
- **Repo:** `C:\Users\Jason\Desktop\YuleLoveLights\Claude` (npm workspaces).
- **Node:** v24 at `C:\Program Files\nodejs\node.exe` (not on PATH by default — prepend in PowerShell: `$env:Path = "$env:ProgramFiles\nodejs;$env:Path"`).

## How to run
```powershell
$env:Path = "$env:ProgramFiles\nodejs;$env:Path"
$env:APP_PASSWORD = "lights"
$env:SESSION_SECRET = "dev-session-secret-at-least-32-characters-long-ok"
npm run dev
```
Client on http://localhost:5173, server on http://localhost:3000.

## Implementation gotchas (saved so we don't re-trip them)
- Tried `better-sqlite3` first — needs Visual Studio C++ build tools, which Jason doesn't have. Switched to `node:sqlite`.
- Konva's `Stage({ container })` clears the container on mount. Use a separate inner div for the canvas; keep empty-state overlay outside it.
- Strand-draw mousedown must seed `drawingPts` with two identical points (`[x,y,x,y]`). Otherwise the first mousemove overwrites the start point and the strand has zero length.
- Bulbs use `Konva.Circle` with radial gradient + `globalCompositeOperation: "lighten"` — that's the trick that makes them look like real glowing lights blended onto the photo.
- Yardsticks must be `node.visible(false)` before `stage.toDataURL()` and restored after, or they end up in the downloaded image.

## What works today (v1 + first round of polish)
- Login (single shared password).
- Designs list: create, open, delete.
- Editor: photo upload, **brightness slider** (moon→sun, continuous) overlaid at bottom-center of the canvas, replacing the old preset-button.
- Yardstick tool: drag a rect, enter real-world feet → sets pixel→feet scale.
- Strand draw: **C9 / Permanent / Mini** (dropped C7), per-type spacings, 10 colors, multi-color patterns.
- Drawing styles:
  - **Strand** = click-and-drag a straight line.
  - **Trace** = click to start, click each bend, **Enter** or move off the photo to finish (polyline).
  - **Single** = click to place one bulb.
- Bulbs: each type has a distinct size + halo profile. C9 = bigger with pronounced halo; Permanent = small bright LED puck; Mini = pinpoint. Crisp opaque core + soft `lighten`-blended halo (no longer blurry).
- Per-strand and total length readout in feet.
- Strand × button deletes the strand (was broken, fixed).
- Color picker replaces a single-color pattern when tapped (Add to pattern / Clear still work for multi-color).
- Esc cancels in-progress yardstick/drag; Esc/Enter commit during Trace.
- Download exports clean JPG at native photo resolution (no yardsticks).
- Auto-save on every change (debounced 600ms).

## Decor items: Wreath + Bow (rounds 6–8)
- **Image-asset pipeline:** `client/src/editor/assets.ts` is a tiny loader/cache. PNGs live at `client/public/items/*.png` and load via `/items/...` at runtime. Renderers ask `getAssetSync(key)`; if not in cache yet, they trigger `loadAsset(key)` and a `requestRedraw` callback fires when the file arrives. Missing files show a placeholder labelled with the expected filename so it's obvious what to drop in.
- **Wreath** (`WreathItem`, kind `"wreath"`):
  - Fields: `{ x, y, sizeIn, withLights, withBow?, rotation?, colorId? (legacy) }`.
  - Asset variants (4): `wreath-with-lights.png`, `wreath-without-lights.png`, `wreathbow-with-lights.png`, `wreathbow-without-lights.png`. Picker keys off both flags.
  - `withBow ?? true` — old wreaths without the field render with a bow (matches Jason's "98% have one" rule).
  - Sizes: 24 / 36 / 48 / 60 inches (diameter).
  - Single-click to place. Click selects. Transformer is keep-ratio (round shape).
  - Edit panel: Size, With lights, Include bow, Duplicate, Delete. Light Color picker was removed when we moved to PNGs.
- **Bow** (`BowItem`, kind `"bow"`):
  - Fields: `{ x, y, sizeIn, rotation? }`. Single asset `bow.png`.
  - Sizes: 12 / 18 / 24 / 36 / 48 inches (width).
  - Standalone bows are rare (most are part of wreaths via withBow) but exist for "bow on a window" cases.
  - Same single-click-to-place / keep-ratio Transformer / per-kind edit panel.
- **Sidebar Category picker** (Lights / Decor). Decor sub-picker now shows **Wreath** | **Bow**. Strand-only sections (Spacing, Drawing Style, Color, Strands list) are inside the Lights branch only — they don't bleed into Decor.
- **Mixed-selection edit panel** counts each kind ("3 strands + 2 wreaths + 1 bow"), offers Delete only.
- **Per-type defaults** persisted server-side at `/api/settings/defaults`. Schema-driven UI in `pages/settings.ts` (`SECTIONS` array of `{key, label, fields}`). Editor reads on init, re-reads when user picks a different bulb type OR decor type. Adding a new item type's defaults section = one entry in `SECTIONS` + entry in `FACTORY_DEFAULTS` (client) + `DEFAULT_TOOL_DEFAULTS` (server). All wired data-driven.
- **Settings back button** returns to wherever you came from (`window.history.back()` with a 60 ms fallback to the dashboard).
- **Editor topbar Settings button** added so you don't have to bounce through the dashboard.

## Clients → Projects → Designs refactor (shipped 2026-05-26)
Replaced the flat designs dashboard with a 3-level hierarchy (HHC-modeled). Old test designs were discarded (Jason's call) via a boot migration that drops the pre-`project_id` designs table.

- **DB** ([server/src/db.ts](server/src/db.ts)): `clients` (id, name req, email/address/phone opt) + `projects` (id, client_id FK, name) + `designs` gains `project_id` FK. Cascade deletes (client→projects→designs). Indices on the FKs.
- **Server routes**: [clients.ts](server/src/routes/clients.ts) (list w/ nested projects, create, patch, delete), [projects.ts](server/src/routes/projects.ts) (GET :id → project + client + design summaries, create, rename, delete), [designs.ts](server/src/routes/designs.ts) now creates under a `projectId` and exports `toDesignSummary`. Creating a project/design bumps the client's `updated_at` for the recent-activity sort.
- **Dashboard** = [pages/clients.ts](client/src/pages/clients.ts): client blocks with optional contact lines (shown only when filled), nested project links, Add Project per client, edit/delete on both, in-memory search (name+contact+project) + sort (recent / name A–Z / Z–A). Create-client modal chains into create-first-project (Back = client with no project). Enter submits both modals.
- **Project page** = [pages/project.ts](client/src/pages/project.ts): the **HHC inline-tabs layout (Option B)** — breadcrumb (Clients › Client › Project) + design tabs (each with an × delete) + "+ New" + the **embedded editor** below. Tab switch tears down + remounts the editor; deep-linkable at `#/project/:projectId/:designId` (tab switches use history.replaceState so the router doesn't remount).
- **Editor made embeddable**: `renderEditor(root, id, { embedded?, onBack? })` now returns a `destroy()` that removes ALL window listeners (keydown, pan handlers, hashchange), disconnects the ResizeObserver, clears timers, destroys the Konva stage. Standalone `#/editor/:id` route still self-destroys on hashchange. `.editor.embedded { height:100% }` so it fills the project page's host instead of 100vh.
- **Router** ([main.ts](client/src/main.ts)): only remounts the project page when the *project* changes (keyed), so tab switches don't re-route.

## Bistro lights (shipped 2026-05-26)
NOTE: bistro hit-testing follows the catenary curve (not the straight chord) so clicks on the sagging middle select the span — see `bistroCurvePoints` in [strand.ts](client/src/editor/strand.ts).
Bistro is a 4th `BulbType` (`"bistro"`) — lives under Lights → Bulb Type, reuses `StrandItem` model. Adds `sagFactor?` field (defaults to 0.10).

- **Catenary rendering**: when `bulbType === "bistro"`, [client/src/editor/strand.ts](client/src/editor/strand.ts) walks each chord segment as a parabolic curve, with sag = `sagFactor × |dx|` at midpoint, sag direction = screen-down (gravity). Vertical spans automatically have ~0 sag because `|dx|` is small — matches real-world taut vertical cables.
- **Faint dark cord**: drawn behind the bulbs along the same catenary, ~24 samples per chord for smoothness. `rgba(20,20,20,0.6)`, 1.2px stroke.
- **Bigger Edison-style bulbs** via a new entry in `bulb.ts` TYPE table (`radiusFt: 0.11`, `haloMul: 3.0`).
- **Sag slider** in both draw panel and edit panel (range 0–0.25, step 0.005). Live updates on the edit panel; history snapshot on slider release.
- **Default spacing 12"** (typical bistro spacing).
- **Trace mode is the natural fit** — each click→click becomes its own taut span with its own catenary, matching how real installs work pole-to-pole.

## Poles (shipped 2026-05-26)
`PoleItem` kind: `{ id, kind:"pole", x, y (ground contact), heightIn (default 120 = 10ft), baseType ("none"|"cube"|"barrel"), yardstickId }`. Renderer at [client/src/editor/pole.ts](client/src/editor/pole.ts) draws a thin dark vertical shaft from (x,y) up by `heightIn × pxPerFoot`, optional planter/barrel base shape at the bottom, small cap at the top.

- **Own top-level category** alongside Lights / Decor / Text / Custom / Poles.
- **Three base types**:
  - "none" — bare shaft (permanent in-ground or attached to existing structure)
  - "cube" — wooden planter box, warm-brown rect with seam lines
  - "barrel" — wine-barrel-style rounded ellipse with stave hoops
- **Heights**: 8 / 10 / 12 / 15 ft (96 / 120 / 144 / 180 inches).
- **Click-to-place** — click sets the BASE position on the ground.
- **Transformer**: only the `top-center` anchor is enabled when poles are selected (rotateEnabled=false). Dragging the top up/down changes height; the base stays put because Konva scales around the opposite anchor. Drag the body to move.

## Custom uploads (shipped 2026-05-26)
`CustomItem` kind: `{ id, kind:"custom", x, y, imagePath, widthIn, rotation?, flipH?, flipV?, autoHalo?, yardstickId }`. Renderer at [client/src/editor/custom.ts](client/src/editor/custom.ts) loads the PNG/JPG/etc and draws a `Konva.Image` at `widthIn × pxPerFoot`; flip flags negate scaleX/Y; when `autoHalo` is true, a blurred copy of the same image is stacked underneath with `globalCompositeOperation: "lighten"` to give a glow around bright pixels (no pixel-scanning needed).

- **Own top-level category** (Lights / Decor / Text / Custom — 4 buttons).
- **Server-persisted library** — new `/api/uploads` endpoints (GET / POST / DELETE :id) at [server/src/routes/uploads.ts](server/src/routes/uploads.ts). File storage reuses `PHOTO_DIR` and `/photos/` static prefix; library metadata stored in `app_settings.user_uploads`.
- **Library UX** — sidebar grid of thumbnails, click to arm an upload for placement, × on each thumb to delete from library (existing placed copies keep working — `imagePath` is stored on the item directly, not via id, so library deletes don't break scenes).
- **No width buttons** — default 36" wide, resize via 8-anchor keep-ratio Transformer + rotation handle.
- **Glow checkbox** per item (defaults from Settings → Custom uploads → "Glow by default"). Flip H / Flip V checkboxes.
- **Items don't darken with brightness slider** by default — they live in drawLayer above the tint layer (same as every other item).
- **Accepted formats**: JPG, JPEG, PNG, WebP, GIF, SVG. 25 MB limit (multipart server cap).

## Text (shipped 2026-05-26)
`TextItem` kind: `{ id, kind:"text", x, y, text, fontFamily, sizeIn (default 60), rotation?, colorId, outline?, yardstickId }`. Renderer at [client/src/editor/text.ts](client/src/editor/text.ts) uses `Konva.Text` with `fill` = chosen hex, `shadowColor` = glow tint with wide `shadowBlur` (lit-up halo). When `outline` is true, `stroke` = glow color with a small strokeWidth proportional to fontSize.

- **Top-level category** alongside Lights and Decor (NOT under Decor — Jason wanted it as its own first-class category).
- **Single color** (no pattern). Outline checkbox toggles a contrasting stroke around each letter.
- **4 fonts** loaded via Google Fonts in [client/index.html](client/index.html): **Bebas Neue**, **Oswald**, **Pacifico**, **Inter**. Picker buttons preview each font in its own typeface so users don't need to know font names.
- **Default size 60" cap height** (matches biggest wreath). Jason explicitly skipped per-size buttons in favor of "default big, resize via Transformer corners."
- **Click-to-place**. 8-anchor keep-ratio Transformer + rotation handle. Resize bakes scale into `sizeIn`.
- **Text content** is edited via a `<input>` in the draw panel (pre-place) and the edit panel (per-selected-item). Edit input does instant live updates on `input` and snapshots history on `change` (blur) so a typing burst is one Undo step.
- **Stays visible when the photo is darkened** because text lives in the drawLayer which sits above the tint layer — same as every other item.
- **Font load**: editor awaits `document.fonts.ready` and triggers `requestCanvasRedraw` so the first text paint uses the correct typeface (otherwise it'd flash serif then snap to the right font).

## Spritzer (shipped 2026-05-26)
`SpritzerItem` kind: `{ id, kind:"spritzer", x, y, sizeIn (16/24/36/48), colorPattern[], yardstickId }`. Renderer at [client/src/editor/spritzer.ts](client/src/editor/spritzer.ts) is fully **procedural** (no PNG asset): radial halo + ~20+sizeIn rays from center to varied tips (deterministic angle/length jitter seeded by item ID) + glowing bulb at each ray tip + bright central glow. All using `globalCompositeOperation: "lighten"` for photoreal blending.

- **Under Decor**, alongside Wreath/Bow/Garland. 4th sub-type button.
- **Click-to-place** (no rotation handle — radial shape, orientation doesn't matter).
- **8-anchor Transformer with keep-ratio on** (treated like other "image-backed" round items — wreath/bow). Resize bakes into `sizeIn`.
- **Color picker is the same as strands** (palette + Add-to-pattern + Clear). Single color → monochrome spray. Multi-color → rays cycle through pattern.
- **Multi shortcut button** sets the pattern to every color in the active palette (one-click rainbow).
- **Halo color:** matches color for single-color; warm-white-ish (`#ffe6c0`) for multi-color (no clean way to gradient ten colors).
- **Settings** page has a Spritzers section (size + default colorPattern).

## Garland (shipped 2026-05-26)
`GarlandItem` kind: `{ id, kind:"garland", points[], drawingStyle, withLights, sizeIn?, yardstickId }`. Renderer at [client/src/editor/garland.ts](client/src/editor/garland.ts) tiles the chosen PNG (`garland-with-lights.png` / `garland-without-lights.png`) along the polyline with 8% stamp overlap, rotated to local tangent. Stamp thickness = `sizeIn / 12` ft; older items without `sizeIn` fall back to ~9.6" so they don't visually shift.

- **Lives under Decor**, alongside Wreath/Bow (originally proposed under Lights, but Jason course-corrected — it's decor, not a light type, even though it *draws* strand-like).
- **Draws strand-like** — Strand mode = straight line, Trace = per-segment garlands (mirrors strand `commitTraceSegments`; one Undo removes the whole trace), Single = one stamp.
- **Sizes:** 6 / 9 / 12 / 18 / 24 inches (rope thickness). Default 12". Size buttons appear in BOTH the draw panel (sets next garland's size) and the edit panel (resizes already-drawn garlands).
- **Selection:** blue Transformer, **rotate-only** (no resize anchors — would distort the tiled PNG). Drag body to move, drag rotation handle to rotate.
- **No color picker, no spacing** — lights are baked into the with-lights asset variant.
- **Garland footage** is shown in the bottom-bar total separately from strand footage.
- **Settings** page has a Garland section (size / with-lights / drawing style) via the SECTIONS array.

## SceneItem refactor + editable palette (fifth round)
**Data model change** — `Scene.strands[]` is now `Scene.items[]`, a discriminated union keyed by `kind`. Only kind today is `"strand"`. New variants will be `"decor"`, `"text"`, `"custom"`, etc. — adding one is a TypeScript change plus a renderer dispatcher, not a migration. The server normalizes any old `{strands: [...]}` payloads to `{items: [...]}` on read; the in-place DB migration in `db.ts` runs at startup (idempotent).

**Helpers added**:
- `api.isStrand(item)` — type guard
- `editor.ts` private `allStrands()` — filter scene.items by isStrand for strand-only reads
- For writes, code uses `scene.items` directly with `isStrand(s) && …` guards where mut callbacks expect StrandItem

**Editable color palette**:
- Server: new `app_settings` table; `/api/settings/colors` GET/PUT
- Client: `editor/colors.ts` exports a live mutable `COLORS` array + `setPalette(list)` + `colorOf(id)` + `suggestGlow(hex)`
- Strands store `colorId`, never hex — editing a color updates it everywhere on next render
- `/settings` page on the client — color editor with hex + label + glow inputs, add/delete, "Reset to defaults" (builtins are editable but not deletable)
- Editor fetches palette on init; settings page mutates and PUTs

## Yardsticks (fourth round, 2026-05-25)
- **Each strand stays bound to its own yardstick.** `Strand.yardstickId` is now actually used for rendering and length math (was being stored but ignored). Adding new yardsticks no longer re-scales existing strands. Falls back to the first yardstick if a strand's own was deleted.
- **Click a yardstick to select** — orange Konva.Transformer with 8 anchors for resize (rotation disabled, since yardsticks are axis-aligned). Drag the body to move. Single-select only.
- **Edit Yardstick sidebar:** numeric input for real-world feet (rescales bulbs live), readonly `px/ft` and `WxH px` readouts, "Strands using this: N", and **Delete**.
- **Delete behavior:**
  - 0 strands tied → just deletes.
  - Strands tied but other yardsticks exist → modal with "Reassign to [dropdown] & delete" vs "Delete strands too" vs Cancel.
  - Strands tied and no other yardsticks → confirm "this will delete N strand(s) too".
- **Strand sidebar gets a "Sized using" dropdown** to reassign one or more selected strands to a different yardstick.
- Yardsticks numbered 1, 2, 3… by their position in `scene.yardsticks`. Labels show on canvas as `Yardstick 1 · 8 ft` (orange when selected, blue otherwise).
- Implementation: separate `yardstickTransformer` on the uiLayer (so the strand transformer stays untouched). `bakeYardstickTransform` reads scaleX/scaleY off the group, multiplies width/height, resets scale to 1, commits.

## Undo / smooth sliders / coverage toggle (third round, 2026-05-25)
- **Undo / Redo:** topbar `↶ Undo` / `↷ Redo` buttons; `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`. History via past[]/future[] snapshots (JSON deep clones). `commit()` is called only at discrete user actions (create / delete / drag end / slider change / button click), NOT on every transient input event — so one slider drag = one history entry.
- **Smooth sliders:** the perm-light beam sliders previously did full `redrawScene()` on every `input` event, which destroys/recreates hundreds of cone shapes and the sidebar HTML. Now:
  - `redrawCanvas()` was split out from `redrawScene()` (canvas-only, no sidebar re-render).
  - `requestCanvasRedraw()` uses `requestAnimationFrame` to coalesce to one redraw per frame.
  - Slider value labels update inline (no DOM rebuild) via `liveUpdateSelected()`.
  - `commit()` snapshot taken on the slider's `change` event (mouseup), not `input` events.
- **Show floor coverage** checkbox per perm-light strand. `Strand.showCoverage` (default true). `createPermanentLight()` skips the floor ellipse when false.

## Editing UX (second round, 2026-05-25)
- **Permanent lights** now render as a real spotlight: top fixture dot + downward cone with vertical+horizontal fade + floor wash. Per-strand controls: Beam Length, Beam Width, Distance to Surface, Opacity (see [[project-hhc-architecture]]).
- **Mini lights** bumped up: still small but with a clear warm halo.
- **C9 glow** bumped to a softer, brighter halo (`haloMul` ~2.6).
- **Selection:** click a strand to select it; Konva Transformer appears with 8 resize anchors + rotation handle on a dedicated `uiLayer` above the bulb-glow blending. Drag anchors to resize/rotate; drag body to move. Shift/Ctrl-click adds to selection. Esc clears; Delete/Backspace removes selected.
- **Edit Strand sidebar:** when 1+ strands are selected, sidebar swaps to per-strand edit panel — bulb type, spacing, color (replaces pattern), and for permanent: beam length / beam width / distance to surface / opacity sliders. Plus Duplicate + Delete buttons.
- **Zoom + pan:** topbar has `−` `100%` `+` buttons; ctrl+wheel zooms around the cursor; space-bar+drag (or middle-mouse) pans. Reset by clicking the 100% pill.

## Konva gotcha (saved)
- Transparent strokes are NOT drawn to the hit canvas, so a `stroke: 'transparent'` Line ignores clicks even when visible thickness is large. Use a near-invisible color (`rgba(0,0,0,0.001)`) and `hitStrokeWidth` to get hit-testing on an invisible line.
- Put the Transformer on a dedicated top layer; otherwise `globalCompositeOperation: 'lighten'` on bulb shapes in the same layer washes its border out.

## Known refinements still on the table
- Some tweaking of bulb sizes vs. spacing on low-resolution photos (pixel-per-foot < ~15) may still feel cramped — recommend higher-res customer photos.
- Wreaths/bows don't have a yardstick-specific binding yet (they always use the active/first yardstick). Same pattern as strands → small follow-up.
- Production hosting (currently dev-only on localhost). Jason wants to move to a small VPS eventually (~4–8 staff users); plan to do it after the new-item-types push is done.
- Duplicate design (not duplicate strand — duplicate the whole design including photo).
- **Animated export (LOW PRIORITY — not soon; noted 2026-06-02):** ability to download a **GIF or MP4** of the design that plays an animation of the lights on the house (e.g. twinkle / chase / fade). Aspirational, explicitly not scheduled — Jason just wants it on the list. Likely approach when we get to it: drive the Konva bulb opacities/glow over a timeline and capture frames (stage.toCanvas per frame → encode to GIF/MP4), exported at the photo's native resolution like the existing JPG download.

## Not yet built (Jason's roadmap — items first, then project org)
**Items still queued (in his preferred order):**
1. ~~Garland~~ — shipped 2026-05-26 (under Decor; strand-like drawing; sizable).
2. ~~Spritzers~~ — shipped 2026-05-26 (under Decor; procedural radial spray; sizes 16/24/36/48").
3. ~~Text~~ — shipped 2026-05-26 (own top-level category; 4 fonts via Google Fonts; single color; optional outline; resize via Transformer; default 60" tall).
4. ~~Custom uploads~~ — shipped 2026-05-26 (own top-level category; server-persisted library; Glow checkbox per item; Flip H/V; Transformer-only resize, default 36" wide).
5. ~~Bistro lights~~ — shipped 2026-05-26 (4th bulb type under Lights; catenary sag rendering with per-strand slider; faint dark cord drawn along the curve; Edison-style bigger warmer bulbs; default 10% sag, 12" spacing). Comes with Poles — new top-level category for the vertical supports (None / Cube / Barrel base; heights 8/10/12/15 ft; Transformer top-anchor-only resizes height while base stays put).

**After items done — start the project-organization refactor:** Dashboard → Clients (name req, email/address/phone opt) → Projects → Designs. Search + sort. See [[reference-hhc]] for the HHC UX Jason wants to model on. This is also the prerequisite for the AI Quote Tool integration — see [[project-ai-quote-tool]].

**After the refactor — integrate with the AI Quote Tool:** Jason runs a separate Next.js/Supabase quoting tool that does Claude Vision photo analysis + Gemini-rendered previews + pricing + customer portal. End product = customer quote with this tool's drawn-on-photo image. First cut: add `surface` tag to `StrandItem` + `GET /api/designs/:id/export` returning a structured measurement summary. See [[project-ai-quote-tool]] for the full plan. **NOT starting yet** — awareness only so the Clients refactor design accounts for it.

**After items done — Jason's project-organization refactor:**
Dashboard becomes Clients (not Designs). Client has name (req) + email/address/phone (opt). Client has multiple Projects (named e.g. "Christmas Lights"). Project has multiple Designs — **UNLIMITED per project** (confirmed 2026-05-26; HHC caps at 1–4 but our tool does not). Multiple photos per client, including reusing a previous photo when they come back next season. Search bar (name/phone/email/address). Sort by name asc/desc or most-recent-activity (default). Rename/delete clients/projects/designs. Structure is otherwise final per Jason — no client notes / project status fields wanted for v1. See [[reference-hhc]] for the HHC reference UX — Jason likes it and asked me to research more before implementing.

## Decisions confirmed (don't re-ask)
- **Tech stack:** Vite + TS + Konva (client), Fastify + node:sqlite (server). No framework.
- **Quoting / pricing / proposals: NOT in scope** for this tool. Yule Love Lights has a separate quote tool that may connect later, but built by someone else. Don't add invoice/PDF/share-link features here.
- **Measurements:** Jason said feet-readout is nice-to-have, low priority. He uses Google Maps for real measurements. Don't spend effort improving accuracy unless asked.
- **Multi-user:** single shared password is fine forever. No audit trail. No per-staff accounts.
- **Hosting:** stays on Jason's PC until a deploy push. He's aware he needs to restart `npm run dev` after every reboot. Long-running task notifications already wired.
- **Customer-facing:** none. Staff use the tool internally; customers only see downloaded JPGs.
