---
name: merge-safe
description: Never-stale merge checklist for landing any PR or PR batch: fetch first, full PR-list scan, base-branch map, re-merge master + re-gate, combined-tree gate for batches, plain-English summary before the human go, exact-name branch deletes. Trigger: "merge this PR", "land the batch", any merge or branch-cleanup work.
---

# Merge Safe

Landing changes on master is the highest-risk moment in this repo: master auto-deploys
to prod, two devs push all day, and every historical merge accident traces to skipping
one of these steps. Run them in order.

## 1. Fetch and scan first

- `git fetch origin` before any merge reasoning. Reason: master moves mid-session
  constantly; #378 went 23 commits stale between review-green and merge.
- `gh pr list --limit 200` and scan the whole list. Reason: the silent 30-PR default
  cap hides pileups; docs PRs once stacked six deep, each "master + one entry", and
  merging only the newest would have lost the rest.

## 2. Map dependencies before touching anything

- For every PR in scope: `gh pr view <n> --json baseRefName`. Stacked PRs merge
  bottom-up. Reason: merging stacked #229 out of order forced an abort and re-plan,
  and deleting a merged parent branch once auto-closed child PR #184.

## 3. Never merge stale

- Merge current origin/master INTO the PR branch, re-run the project gates
  (`npx tsc --noEmit`, `npm run lint`, `npx vitest run src`), and check the LOGICAL
  interaction with what landed meanwhile, not just text conflicts. Reason: a
  serviceType prop collision between #378 and a same-day flag-removal PR merged clean
  textually and only surfaced on the logical pass.

## 4. Batches gate as a set

- For parallel fix PRs: integration branch off fresh master, merge all candidates in,
  gate the combined tree, then land PR-by-PR with a final gate on real master. Reason:
  per-PR green misses composition breaks; the S20 audit waves caught several this way.

## 5. Human go, with a real summary

- Present a plain-English summary derived from the actual diff (not from intent), then
  wait for the dev's merge-go. The one standing exception is the wrap skill's own
  docs-only notes PR. Reason: an assistant merging on its own removes the last human
  check before prod.

## 6. Cleanup without collateral

- Delete branches by exact name only, never a glob. Reason: a `naldo/inventory-*` glob
  once deleted 10 remote branches instead of 1.
- Never delete the branch a worktree has checked out. Switch the worktree off it first,
  then confirm the commit is in master (`git merge-base --is-ancestor <sha>
  origin/master`) before `-D`. Reason: deleting from inside the worktree fails halfway,
  and the failure modes have included auto-closing a stacked child PR.
- A branch restarted after a merge pushes with `--force-with-lease`. Reason: plain push
  rejects non-fast-forward; force without lease can stomp the other dev's work.
- Verify every checkout landed (`git branch --show-current` as its own command, never
  chained with `&&` into a merge). Reason: when a chained checkout fails because
  another worktree holds the branch, the merge half runs on the CURRENT branch.
