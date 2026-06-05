---
name: project-ai-quote-tool
description: "Jason's OTHER project — the AI Quote Tool that generates customer quotes with photo analysis + AI-rendered previews. Future integration target for this design tool ([[project-design-tool]])."
metadata: 
  node_type: memory
  type: project
  originSessionId: f1094160-a945-4c44-9963-e22a7e3a9905
---

> **⚠️ Naming note:** This is the **AI QUOTE TOOL** (`yll-quote-tool` — Next.js + Supabase + Claude Vision + Gemini), Jason's **separate** quoting app. It is **NOT** the design/canvas tool, which lives in [[project-design-tool]] (file `project_design_tool.md`).

Separate project Jason runs alongside this design tool. **Not maintained by me** — this is a reference summary of an existing tool he shared, captured so we can plan the integration.

## What it does
End-to-end customer quoting:
1. Operator opens `/quote/new`, picks a HighLevel CRM contact (yulelovelights), enters address.
2. Google Maps → Street View + satellite photos → Claude Vision measures the property (roofline footage, ridge footage, tree/bush/column counts).
3. Operator reviews/corrects measurements (correction loop stores per-property overrides for next time).
4. Pricing engine (pure function) computes quote total, deposit, balance due, line items.
5. Async render pipeline (Gemini 3 Pro Image + Replicate FLUX inpaint + `sharp` compositing) generates a photoreal "after" image of the lit-up house.
6. Customer portal at `/portal/<quoteId>` shows the rendered design, package picker (A/B/C/D), Approve button.
7. Approval fires Zapier → home.works for contract signing → HL opportunity moves through pipeline stages.

## Tech stack
- Next.js 16.2.4 (App Router, Turbopack), TypeScript 5 strict
- React 19 + Tailwind 4
- Supabase (Postgres + Storage + RLS)
- Anthropic Claude (vision: measurement extraction)
- Google Gemini 3 Pro Image (REST) — scene generation
- Replicate FLUX inpaint — bush mini-lights
- `sharp` — server-side compositing
- HighLevel CRM + Zapier ↔ home.works (estimating)

## Key files in that codebase
- `src/lib/photoAnalysis.ts` — Claude Vision prompt
- `src/lib/rendering/orchestrator.ts` — Gemini → sharp → FLUX → Storage pipeline
- `src/lib/rendering/gemini.ts`, `compositor.ts`, `inpaint.ts`, `variants.ts`, `storage.ts`
- `src/lib/referenceAssets.ts` + `public/references/*.png` — few-shot prompt library
- `src/lib/pricing/pricingEngine.ts` — pure-function quote math
- DB: `quotes` table (single row owns full lifecycle) + `renders` table (async render jobs)

Convention: routes in `src/app/api/*/route.ts` are 30-line thin wrappers; real logic in `src/lib/`. Library code does the work.

## Integration goal
End product = **a quote presented to the customer that includes a picture of their house fully designed**. The design tool ([[project-design-tool]]) draws the install on the photo; the AI Quote Tool consumes the resulting footage/counts/image to compute price + build the portal.

## Recommended integration seam (smallest first cut, ~1 day of work)
1. Add a `surface` tag to `StrandItem` so each strand is labeled by the quote tool's surface taxonomy (Santa's Roofline, Gingerbread, Winter Wonderland, mini-lights, etc.). Picker in the editor sidebar.
2. Add `GET /api/designs/:id/export` returning a structured summary:
   ```json
   {
     "design_id": "...",
     "photo_url": "/photos/<file>",
     "rendered_jpg_url": "/api/designs/:id/render.jpg",
     "summary": {
       "strands_ft_by_surface": { "santas-roofline": 184.5, ... },
       "garland_ft": 32.0,
       "wreath_count_by_size": { "36": 3, "48": 2 },
       "bow_count": 3,
       "spritzer_count": 4,
       "text_count": 1,
       "custom_count": 0,
       "pole_count_by_base": { "cube": 4, "barrel": 0, "none": 0 }
     }
   }
   ```
3. Quote tool ingests this blob into `quotes.measurements` jsonb + `quotes.photo_url` (no DB migration on either side).

## Other integration paths considered
- **Replace quote tool's photo-render pipeline** with this tool's manual canvas (high-fidelity but loses the auto-AI-render feel HHC clones expect). Probably NOT what Jason wants.
- **Quote tool's Claude Vision produces a suggested Scene** that opens in this tool's editor for operator review. `POST /api/designs/:id/suggest` could accept a partial Scene. Useful later, not v1.
- **Unify auth** — swap this tool's Fastify session for a Supabase JWT verifier. One login across both tools. ~1 file change.
- **Unify DB** — move this tool's `designs.scene` into Supabase as `quotes.scene` jsonb. The Fastify backend collapses into a static file server, or goes away. Bigger refactor.

## Where this slots in the roadmap
- **Prerequisite:** the Clients/Projects/Designs refactor on THIS tool (currently next-up in [[project-design-tool]]). Quote tool keys off HighLevel contacts; this tool needs the same customer mental model so designs can be looked up by client when the quote tool calls in.
- **Then:** add `surface` tag + export endpoint here.
- **Then:** quote tool side reads from `/api/designs/:id/export` and stores the result in `quotes.measurements`.

## NOT doing yet
Jason flagged this 2026-05-26 as future work — wants the awareness now so the Clients refactor design takes the integration into account, but no implementation yet. Don't start coding the export endpoint or the surface tag until he says go.
