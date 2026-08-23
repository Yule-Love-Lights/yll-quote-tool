-- =====================================================================
-- designs.version — compare-and-swap guard for the scene autosave (ledger
-- row 260).
--
-- THE PROBLEM: updateDesignScene was a bare last-write-wins full-scene PUT
-- (designs.ts's own W2-016 comment names it as an accepted risk). #741
-- narrowed the money path but its own review confirmed the underlying race
-- stayed open: the editor's saveSeq only decides which callback updates the
-- UI ("Saved" vs a stale response getting ignored) — it never decided which
-- PUT the database actually keeps. Two overlapping full-scene writes (two
-- browser tabs, two operators, or a slow autosave racing a server-side
-- reseed) can still silently drop whichever one lands second at Postgres.
--
-- THE FIX: version is a per-design monotonic counter. Every scene write goes
-- `UPDATE designs SET version = version + 1, scene = $1 WHERE id = $2 AND
-- version = $3` (the version the writer last read) — computed client-side as
-- `expected + 1` (see updateDesignSceneGuarded in src/lib/designs.ts), not a
-- raw SQL increment, so the same guard is trivially mockable in tests. Zero
-- rows updated means somebody else's write landed first; the caller gets a
-- distinguishable conflict instead of silently losing data.
--
-- NOT NULL DEFAULT 1 (rather than a bare nullable add-column): per AGENTS.md's
-- migration-application allowlist, a NOT NULL DEFAULT add-column backfills
-- every existing row — so after this applies, no design in Postgres actually
-- carries a null version. The application code still treats a MISSING/null
-- version on the WIRE (a request body from a browser tab whose bundle predates
-- this migration) as "unknown" and adopts rather than bricking the save — see
-- updateDesignSceneGuarded's `expectedVersion == null` branch — but that is a
-- defensive client-compat path, not a real legacy-row state.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (NOT NULL DEFAULT add-column on the existing, populated `designs` table —
-- explicitly named safe in the allowlist). NOT applied by this commit — the
-- seat reviews and applies it (before the code in this branch that reads/
-- writes the column ships, per the migration-ships-before-code convention).
-- =====================================================================

alter table public.designs
  add column if not exists version integer not null default 1;

comment on column public.designs.version is
  'Compare-and-swap counter for the scene autosave (ledger row 260). Every scene write is UPDATE ... WHERE version = <last-read value> SET version = version + 1 — zero rows updated means a concurrent writer won the race. NOT the same guard as extra_photos'' updated_at-based optimistic concurrency (updateExtraPhotosAtomic) — that column is untouched.';
