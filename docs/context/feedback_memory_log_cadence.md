---
name: memory-log-cadence
description: "When to pause and refresh memory/logs — Jason wants it done around task completion, before moving on."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5f845812-f9ca-46d2-93d8-30a6c551b244
---

After finishing a task (or a batch of tasks) — at the natural checkpoint right before/around committing — pause and update all memory files and logs before moving on. Local memory: [[session-log]] + [[project-quote-tool]]. Repo canonical (shared, needs a commit): `docs/context/*.md` + the `docs/CURRENT_STATE.md` QA backlog.

**Why:** keeps the continuity thread and the shared `docs/context/` copies (which Naldo also reads on a different machine) from drifting behind the real state of `master`. Jason called this out after several merged tasks had piled up undocumented in one session.

**How to apply:** when a task's PR merges (or just before committing it), refresh the session-log entry (what shipped + the single NEXT step), `project-quote-tool` (mark done, update QA backlog + Next up), and sync the repo `docs/context/` copies. Don't let multiple merged tasks accumulate undocumented.
