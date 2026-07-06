---
description: Adversarial review of a billing endpoint before commit (idempotency, double-charge, money math, retries)
---

Before this billing endpoint is committed, run an adversarial review focused on:
idempotency keys, double-charge prevention, integer-cents money math, and failure/retry
handling. List concrete defects with line-level evidence (file:line). Distinguish real
defects from parity-with-existing-prod-code, and say which is which; do not "fix" a
pattern that matches deliberate existing behavior without flagging it as a choice.
