# ops/

Self-verifying work queue for unattended runs (overnight SEO, WordPress,
app maintenance). Full steps live in `.claude/skills/run-queue/SKILL.md`.

## Writing a queue

One task per line in a `.jsonl` file, matching `ops/queue.schema.json`.
Every task needs a `verify` block: a `shell` command that must exit 0, or
a `manual` check for a human. No verify, no task.
`ops/queue.sample.jsonl` has 3 real, read-only examples to copy from.

Check your file before running it:

    python ops/validate_queue.py path/to/queue.jsonl

## blast_radius

- `READ`: looks at things, changes nothing. Safe any time.
- `WRITE`: changes files or dev/staging data. Not production.
- `PROD_WRITE`: touches production data or live customer records. Needs a
  3-record dry run with a printed before/after diff first. See the skill.

## Blockers

A task that fails verify `max_attempts` times gets quarantined instead of
forced green. Its writeup lands in `ops/blockers/<id>.md`: what was
tried, the exact failing output, a minimal repro, and what it needs.
Triage means giving it the missing access, fixing the thing by hand, or
rewriting the task. Never close a blocker without rerunning verify.
