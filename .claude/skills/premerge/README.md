# premerge

Runnable form of the AGENTS.md "Review gates" policy. Trigger: `/premerge`
or "premerge review".

Classifies a diff into a risk tier (FULL, CODE, PROCESS), spawns that
tier's lens agents from `.claude/agents/lens-*.md` in parallel on Sonnet 5,
collects findings through a report-contract file per lens, respawns any
stalled lens once, dispositions every finding, and stops for the dev's
explicit merge-go. It never merges.

AGENTS.md stays the policy source. This skill is only the mechanism that
runs it. If they disagree, AGENTS.md wins.

See `SKILL.md` for the full step-by-step.
