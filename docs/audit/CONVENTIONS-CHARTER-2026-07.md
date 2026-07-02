# Conventions charter (#110)

> One page. Every #110 fix-PR follows these — they are the codebase's OWN dominant patterns
> (surveyed 2026-07-02 at `c04447c`, 40+ routes / 159 test files sampled). Wave 6 audits
> *adherence* to this charter; it does not invent new patterns mid-epic. A fix that wants to
> deviate says so in its PR description.

## 1. Auth gating
- The perimeter is `src/middleware.ts` + the **single allowlist** `isPublicPath()` in
  `src/lib/auth/operatorGate.ts`. A new public route = an allowlist entry, never a bypass.
- Operator API routes call `requireOperator()` (dormancy-aware); admin-only routes call
  `requireAdmin()` (strict, never dormancy-bypassed) — both from `lib/auth/supabaseServer.ts`.
- Customer/portal routes are capability-gated by the quote UUID (`UUID_RE` check → 400).
- Webhooks/crons authenticate per kind: `Authorization: Bearer ${CRON_SECRET}` compared with
  `safeEqual()` (constant-time) · HMAC signature verify · shared-secret header. Never an
  operator session.

## 2. Input validation
- **No zod** — the house pattern is `try { body = await req.json() } catch → 400 'Invalid
  JSON body'`, then `typeof` guards with trims/defaults, enums via fixed sets, `UUID_RE` for
  ids.
- Anything beyond trivial → a **pure, unit-testable validator** returning
  `{ ok: true } | { ok: false; error }` (`lib/auth/accountGuards.ts` is the template), or a
  type-guard fn for nested shapes (`isSceneShape`).

## 3. Error responses
- Failure: `{ error: string, code?: string }` with the right status — 400 bad input · 401
  unauthenticated · 403 forbidden · 404 not found · 409 idempotency conflict · 428
  precondition · 429 rate-limited · 502 upstream · 503 unconfigured. Success: `{ ok: true, … }`.
- Log with `console.error('[api/route/context] …', err)` — raw error to the log, never to a
  customer.
- Portal surfaces NEVER render raw server text — `friendlyPortalError('<action>')`
  (`components/portal/friendlyError.ts`).

## 4. Client/server import boundary
- `'use client'` sits on leaf components/pages.
- Server-only chains (sharp, service-role supabase, fs) must never be importable from a
  client module — extract a **client-safe pure module** instead (template:
  `lib/design/sceneCorrections.ts`, which imports only sceneTypes). Type-only imports are
  always safe.
- The S18 lesson: tsc will NOT catch this; check the import chain when a client file imports
  from `lib/`.

## 5. Data access
- Prefer the `lib/` data module when one exists (`quotes.ts`, `designs.ts`, …); simple
  one-off queries inline in a route are acceptable house style.
- Client acquisition: `getSupabaseServiceClient() ?? getSupabaseClient()` (service-first
  fallback); admin-only operations REQUIRE the service client and 503 when unconfigured.
- Money routes read-before-write for idempotency (already-paid → 409, never a re-charge).

## 6. Tests
- Colocated `*.test.ts` next to the code; `vi.hoisted()` + `vi.mock()` whole-module mocks
  shaped like the real API; pure validators tested mock-free; per-file `makeReq()`/`makeSb()`
  builders (no central fixture lib).
- Money / auth / pricing fixes land **failing-then-passing** (TDD) — no exceptions.

## 7. Epic-wide rules (from AGENTS.md / the plan)
- `editor-core/**` + `sceneTypes.ts`: bugfixes relay **byte-identical** to the design tool;
  structural changes are out of scope (→ #29).
- PR-not-master · gates green (`tsc · lint · vitest`) · never-stale re-gates · merges only on
  Jason's explicit go · SHARED files + Naldo's lane per the plan's protocols.
- Surgical fixes only (Karpathy): no drive-by refactors inside a bug-fix PR; a refactor
  without a concrete payoff is `accept`, not a PR.
