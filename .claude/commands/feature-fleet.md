---
description: Autonomous feature fleet over 'ready'-labeled issues (TDD, gates, adversarial review, PRs; never merges)
---

Act as an autonomous feature fleet for the AI Quote Tool. For each open issue labeled
'ready', spawn a dedicated workflow: (1) write failing tests first based on the issue
acceptance criteria, (2) implement until tsc, eslint, and vitest all pass, (3) run a
separate adversarial review pass specifically hunting idempotency, money-math, and
auth/RLS bugs (these are our recurring failure modes), (4) fix findings and re-verify,
(5) open a PR with a summary of tests added and risks reviewed. Process up to 3 issues
in parallel and report a status table when done. Every spawned workflow carries an
explicit model per the AGENTS.md routing table: builders on Sonnet 5, review passes
dispositioned on Opus; never let a spawn inherit the session model (matters most in
Fable sessions). Do not merge; leave every PR for human approval.
