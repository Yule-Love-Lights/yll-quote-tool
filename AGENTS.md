<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Codebase navigation — prefer the graphify graph for big-picture questions

A `graphify-out/` knowledge graph of `src/` may exist locally. It's **gitignored — per-machine, never committed**, so a fresh clone / another machine won't have one until it's built: `/graphify src` (free for code, ~seconds). The optional post-commit auto-rebuild hook (`graphify hook install`, also per-machine) then keeps it fresh on every commit.

- **When a graph exists** — for **architecture / cross-cutting** questions ("how does X flow", "what touches Y", "trace A → B") query it first with `graphify query "..."` instead of reading lots of files; it's cheaper and faster.
- **For targeted lookups** (one specific function / prop / line) — just grep/read; that's already the cheapest route and the graph isn't worth the overhead.
- **If no graph exists** (fresh clone / another machine) — grep/read, or build one first with `/graphify src`.

Staleness guards (the graph is a point-in-time snapshot and drifts):

- Treat it as a **map for orientation, not ground truth** — verify any file / function / line it cites against the live code before acting on it.
- If it seems unaware of recent work, fall back to grep/read.
