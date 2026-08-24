### Naldo S64: eight separate quote-tool fixes and suggestions built as draft PRs, none merged (2026-08-21)

> This conversation worked through Naldo's mixed bug and suggestion list. Each item stayed in its own branch and PR. All eight PRs remain draft, so none of this code is on `master` or deployed.

## What was built

- **PR #849, bug:** Permanent Lighting manual satellite uploads and traces persist through Calculate and quote reopen. It is now conflicted with newer `master` and must be reconciled before review.
- **PR #858, bug:** Permanent colour requests use the live Permanent scheme label across the pending marker, inbox, internal email, amendment, customer notices, and staff confirmation.
- **PR #859, suggestion:** staff can enter a booked Permanent customer's colour request from the admin quote page. It is intentionally stacked on #858, which must merge first.
- **PR #866, suggestion:** independent customer-portal visibility controls for the house design and satellite plan. Stored photos, traces, and measurements stay available to staff. Its additive columns were applied and verified live before code deployment.
- **PR #871, bug:** each design photo keeps its own brightness through editor save/reopen and all three multi-photo portal renderers.
- **PR #872, suggestion:** staff can add eligible minis to an existing group, edit strand spacing, and set one authoritative group pattern without changing the billed string count.
- **PR #874, suggestion:** append-only internal staff notes shared across a linked quote, job, and invoice. Its additive private schema was applied and verified live with zero note rows created.
- **PR #875, suggestion:** private per-staff quote-build timing from accepted contact or prefilled draft to first real send, including Manual Mark as sent, with average/median/p90 on Insights. Its additive private schema was applied and verified live with zero timing rows created.

## Verification and review

- Every PR received the risk-required adversarial reviews and had its findings dispositioned before opening.
- Seven PR heads have green GitHub `gates`. #859 targets its prerequisite branch, so it has no direct `master` CI run yet.
- Final local gates on #875: TypeScript passed, lint passed, and Vitest passed 6,853 of 6,853 tests. `git diff --check` was clean.
- Browser verification was not run because Naldo prohibited starting a dev server and Vercel produced no previews. Every PR's Vercel status failed on commit-account verification, not a reported code failure.
- The wrap customer lens found no new customer blocker. The integration lens found release blockers between drafts: #874 and #875 both edit `FULL-SCHEMA.sql`; #849 and #875 both edit QuoteBuilder send handling; #866 and #871 overlap portal render surfaces. Each branch must be rebased, resolved keep-both, and re-gated against the actual combined tree before merge.

## Findings and next action

- **Ledger #337:** concurrent fresh Send requests can both reach customer delivery because the final send stamp lacks a `quote_sent_at IS NULL` compare-and-set. It is a separate bug and has a ready next-session prompt.
- The approved **Clear AI-drawn design** suggestion remains unbuilt. Keep its scope narrow: remove AI-owned design artifacts while preserving staff edits and quote values unless new provenance is added.
- PR #875 is current with `master`, mergeable, and green at `35a014ef47fc08d41f142236f8f1d34fa0a2746d`, but it remains draft and unmerged. Required next action: Naldo must send the exact repository-and-PR merge authorization after the SHA summary.
