---
name: verify-handoff
description: Generate the "verify before commit" handoff block when work is ready for a human check: bare URLs, numbered steps, expected results, red flags, then WAIT for the go. Trigger: work ready for a device-check or human verification, "handoff", before committing customer-facing changes.
---

# Verify Handoff

Give the human everything needed to verify in two minutes, in a form that survives
their terminal. Then stop.

## The block

1. Bare full URLs, each on its own line. No markdown links, no backticks. Reason:
   markdown links are not clickable in Jason's terminal; he had to re-ask twice.
2. Numbered steps in click order, one action per step.
3. Expected result per step, concrete ("price shows $7,797.38", not "price looks
   right"). Reason: a vague expectation turns the check into a shrug.
4. Red flags: what wrong looks like, so a miss gets recognized instead of skimmed past.
5. If test data was staged: list the exact restore steps, and restore it yourself after
   the check. Reason: staged mutations left in SENT quotes become customer-visible.

## Then wait

Do not commit or push until the go arrives. Reason: the human check exists to catch
what green gates cannot (all three S19 device bugs were invisible to tsc and tests);
committing first makes the check theater.
