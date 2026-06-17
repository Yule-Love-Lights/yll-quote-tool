---
name: verify-handoff-before-commit
description: "Before committing a finished task, hand Jason links + test instructions so he can self-verify first."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5f845812-f9ca-46d2-93d8-30a6c551b244
---

When a task's code is done and gates are green, **do NOT commit yet**. First give Jason: the relevant links (dev server URLs / pages affected) and concrete step-by-step instructions — what to click/enter, what the expected values are, and the red flags to watch for — so he can verify it works the way he needs before anything lands. Commit + push only after he confirms.

**Why:** Jason wants to eyeball the actual behavior on the pages himself (he's the product owner for how it should look/work), and the Claude-in-Chrome screenshot path isn't always reliable against his localhost. He'd rather catch "not what I meant" before it's committed.

**How to apply:** at the end of each task, post a short "Verify before commit" block: live links + numbered steps + expected results + what would indicate a bug. Then wait for his go-ahead to commit. Pairs with [[memory-log-cadence]] (update memory/logs around the same checkpoint).

**ALWAYS include the actual clickable links (full URLs), not bare page paths** (2026-06-03, explicit ask). Every page a verification step refers to must appear as a complete `http://localhost:3000/...` URL right there in the steps. When a step needs a specific record (a real quote/portal id), look one up (e.g. `GET /api/quotes`) and put a concrete working URL in the step, not a `<placeholder>`.

**FORMAT: send links as BARE full URLs, each on its own line — NOT Markdown `[text](url)`, NOT inside backticks** (corrected 2026-06-17: Markdown links are NOT clickable in Jason's terminal; he re-asked twice. Backticks also kill clickability). Write the label on one line and the raw `https://…` / `http://localhost:3000/…` URL on the next (or after a colon). The terminal auto-linkifies bare scheme-prefixed URLs; it does not hyperlink Markdown link syntax. Applies to verification links, PR/compare links, and page lists. *(An earlier note here said to use Markdown links — that was wrong for his setup; bare URLs are the reliable form.)*
