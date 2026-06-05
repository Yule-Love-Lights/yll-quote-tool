---
name: feedback-context-warning
description: Jason wants a heads-up when the conversation context window hits ~90% full
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f1094160-a945-4c44-9963-e22a7e3a9905
---

When the chat's context window approaches ~90% full, give Jason an explicit heads-up so he can decide whether to wrap the current chunk and start a fresh session.

**Why:** Long sessions on this project ([[project-design-tool]]) routinely hit the limit. The last session ended at ~95% with work still in flight; better to flag early and land a clean stopping point than to get auto-compressed mid-task.

**How to apply:** I don't have a precise token counter, so estimate from conversation length, cumulative tool-output volume, and how many turns deep we are. When it feels close to 90%, surface a one-line warning ("Heads up — we're roughly at 90% context, want me to commit current work and we pick up in a new session?") rather than silently continuing. Better to warn slightly early than to miss it.

**Important calibration:** Jason's setup is **Opus 4.7 1M context window** (NOT 200K). 38% used ≈ 380k tokens — there's far more headroom than gut-feel "this conversation is getting long" suggests. Don't trigger the warning prematurely; a session can comfortably run many turns before hitting 90% of 1M.
