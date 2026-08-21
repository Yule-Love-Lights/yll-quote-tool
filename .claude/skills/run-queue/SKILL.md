---
name: run-queue
description: Execute an unattended work queue (overnight SEO, WordPress, or app maintenance tasks) with real verification, retries, and quarantine blockers instead of narrated "done" claims. Trigger "/run-queue <path to queue.jsonl>".
---

# Run Queue

This skill runs a list of tasks with nobody watching. The only thing that
proves a task is done is its verify command exiting 0. Nothing else counts:
not a confident summary, not "this should work now", not a partial log that
looks right. If it did not print exit 0, it is not done.

No Stop hook enforces this. You enforce it by following these steps in
order, every time.

## 1. Validate the queue file before anything runs

Run the validator:

    python ops/validate_queue.py <path to queue.jsonl>

If it prints `QUEUE INVALID` and exits non-zero, stop. Do not run any task.
Report the schema errors and ask for a fixed queue file. A queue file that
does not match `ops/queue.schema.json` does not get a partial run.

## 2. Build the execution order

Read every task. Order them so a task never starts before every id in its
`depends_on` is `verified`. If two tasks have no dependency relationship,
either order is fine, but do not parallelize tasks that touch the same
files or the same external system.

If `depends_on` points at an id that never reaches `verified` (it gets
quarantined instead), skip the dependent task and quarantine it too, with
a blocker that says which dependency failed. Do not attempt a task whose
dependency did not verify.

## 3. Before any PROD_WRITE task: dry run first

This is a standing machine rule, not optional. A task with
`blast_radius: PROD_WRITE` never runs for real on the first attempt.
Before touching production:

1. Pick 3 sample records (or the smallest real sample the task allows).
2. Run the change against only those 3, in a mode that does not commit it
   (a transaction you roll back, a `--dry-run` flag, a staging copy).
3. Print a before/after diff for all 3 records.
4. Only after that diff is printed and looks right, run the task for real.

`READ` and `WRITE` tasks skip this step and go straight to execution.
`WRITE` still means real changes, so read the task's `execute_notes`
carefully, but it is not production data, so no dry run is required.

## 4. Execute one task

Do the work described in `description`, using `execute_notes` as a guide,
not a script to follow blindly. Keep the change scoped to what the task
asks for.

## 5. Verify. Only verify output counts as done.

Run the exact command in `verify.command` (for a `shell` verify) and paste
its real output, including the exit code. A task is `verified` only when
that command exits 0.

For a `manual` verify, the task cannot self-certify. Print the `check`
text as an instruction for a human and leave the task `pending` with a
note that it needs manual sign-off. Do not mark a manual task `verified`
yourself.

Never write "done", "verified", or "should work" based on what the work
looked like while you were doing it. The narration of the work and the
proof of the work are two different things. Only the second one changes
`status`.

## 6. On verify failure, retry with a genuinely different approach

If the verify command exits non-zero:

1. Write down what you think went wrong (the hypothesis) in the task's log
   section before touching anything else.
2. Try a different approach, not a small tweak to the same one. Same
   command with a typo fixed is not a different approach. A different
   file, a different method, a different assumption checked, is.
3. Run verify again.
4. Repeat until verify exits 0, or until you have used `max_attempts`
   attempts (default 2 if the task did not set one). Each attempt gets its
   own hypothesis logged, even the ones that fail.

## 7. Quarantine when max_attempts is exhausted

Write `ops/blockers/<id>.md` with these sections:

- **Tried**: every hypothesis from step 6, in order, and why each one did
  not work.
- **Exact failing output**: the real, unedited output of the last verify
  attempt. Do not summarize it or clean it up.
- **Minimal repro**: the shortest command that reproduces the failure.
- **What it needs**: what would unblock this. Human UI access, a
  credential the automation does not have, a host-level change, a product
  decision, or anything else outside what an unattended run can do.

Set the task's `status` to `quarantined` and move to the next task whose
dependencies are satisfied. A quarantined task does not block unrelated
tasks, only tasks that depend on it.

## 8. End of run: print the scorecard

When every task is either `verified` or `quarantined` (or skipped because
a dependency never verified), print a table:

    | id | status | attempts | note |
    |----|--------|----------|------|
    | <id> | VERIFIED or QUARANTINED | <n> | one line, what happened |

Then state the honest totals in plain English: how many verified, how many
quarantined, how many skipped for a failed dependency. The run is complete
only when every task has a final status and a reason. If anything is still
`pending` with no blocker file, the run is not complete. Say so plainly
instead of rounding it up to "done".
