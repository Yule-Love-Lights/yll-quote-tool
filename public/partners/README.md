# Partner / client logos (#70)

Logos for the **"Trusted Decorating Partner With"** row at the bottom of the
customer portal (`src/components/portal/dark/TrustSection.tsx`).

**Upload one image file per company.** Guidelines for the dark portal theme:

- **Transparent-background PNG** (SVG also fine).
- **White / light version preferred** — the portal background is dark, so
  dark-colored logos disappear. Full-color logos work too; they can be rendered
  in a uniform white/cream treatment so the row stays consistent.
- **Simple lowercase filenames**, e.g. `marriott.png`, `wells-fargo.png`,
  `cvs.png`, `mattress-firm.png`.
- Any reasonable resolution is fine (display height is ~28–40px; 2–3× that for
  crispness).

After uploading, tell Claude the full list of companies and it will wire each
file into `TrustSection`. Any company without a logo file keeps a clean text
wordmark as a fallback, so nothing breaks if a file is missing.
