# Operator-surface authentication — proposal (closes the 2 CRITICALs)

**Status: PROPOSAL / DRAFT — needs a decision + a runtime verification pass before it is enabled. Do not merge as-is.**

## Why
The audit's two CRITICAL findings and most of the HIGH cluster share one root cause: **the operator surface has no server-side authentication.** The `/customers` pages are server components that render every customer's PII to anyone; most operator write APIs (`/api/settings`, `/api/training`, `/api/designs`, `/api/save-correction`, `/api/integrations/highlevel/*`, `GET /api/quotes`, …) accept anonymous requests. Operator *pages* only gate their data *calls* (a static `x-admin-secret` kept in `sessionStorage`), not their *render*.

The fix is a single default-deny gate in front of the whole app, with an explicit allowlist for the customer surface.

## What's in this PR (a working starting point — not finished)
- `src/lib/auth/operatorGate.ts` — pure, **unit-tested** (`operatorGate.test.ts`, 8 tests):
  - `isPublicPath(pathname)` — the customer/public allowlist (default-deny).
  - `hasValidOperatorAuth(cred, secret)` — accepts the session cookie **or** the existing `x-admin-secret` header; fails closed when the secret is unset.
  - `safeEqual` — edge-safe constant-time-ish compare.
- `src/middleware.ts` — thin wrapper: public → pass; authorized → pass; else 401 (APIs) or redirect to `/login` (pages).
- `src/app/login/page.tsx` + `src/app/api/login/route.ts` — minimal staff password gate that sets an **httpOnly** session cookie (already better than today's JS-readable `sessionStorage` secret).

The public allowlist (verify this list against every customer route before enabling):
`/portal/**`, `/photos/**`, `/login`, `/api/login`, `/api/quotes/<id>/{approve,pay,view}`, `/api/integrations/valor/webhook`, `/api/integrations/homeworks/signed`. **Everything else is operator-only**, including `/`, `/customers`, `/admin`, `/settings`, `/quote`, `/training`, `/insights`, `/inventory`, and all other `/api/*`.

## The decision this needs (Naldo + Jason)
1. **Mechanism.** This interim version reuses `ADMIN_SECRET` as a single shared staff password. Options to weigh:
   - **A. Shared password (this PR)** — fastest; closes the CRITICALs today; no per-user identity, so no real audit trail (ties into the "no `created_by`" finding).
   - **B. Supabase Auth** — real per-user accounts + identity for the audit trail; more setup; the natural long-term answer.
   A is a reasonable bridge to B for peak season; B is the real fix. Pick one.
2. **Operator-flow review (Jason).** Enabling this changes how staff reach the tool: they log in once (sets the cookie), then the builder/settings/training/designs pages work via the cookie automatically. The existing `/admin/quotes` header path keeps working. Confirm no operator flow breaks.

## Safe to merge — dormant by default
The middleware **does nothing unless `AUTH_GATE_ENABLED=true`** is set in the environment. So this PR can be reviewed and merged without changing any behavior; enabling the gate is a single env-var flip *after* the runtime verification below. (This removes the "merge accidentally locks everyone out" risk.)

## Required before enabling (`AUTH_GATE_ENABLED=true`)
- [ ] Runtime pass: log in, then walk the **whole** customer flow (open a portal link, pick a package, approve, pay) and confirm nothing 401s/redirects — i.e. the allowlist is complete.
- [ ] Confirm the Valor webhook + home.works signed webhook reach their routes (they're allowlisted, but verify in prod).
- [ ] Decide cookie lifetime (currently 12h) and whether to rotate `ADMIN_SECRET`.
- [ ] If choosing mechanism B, replace the password gate with Supabase Auth and drop the shared-secret cookie.

## Follow-ups this unblocks
Once the gate is on, the per-route hardening for the unauthenticated write APIs becomes defense-in-depth rather than the only line, and a real `created_by` audit trail becomes possible (mechanism B).
