---
description: Continuous defect auditor for payment and auth surfaces (property-based + adversarial tests, CI script)
---

Build a continuous defect auditor for our payment and auth surfaces. First, map every
code path touching money math, quote/order status transitions, Valor token charging, and
Supabase RLS/service-role usage. Then generate property-based and adversarial tests
asserting: amounts never drift from rounding, charges are idempotent under retries,
status transitions follow the allowed state machine, and no table is reachable
anonymously without service-role routing. Run them, report every violation with
file:line evidence, propose fixes, and produce a CI script that fails the build if any
invariant breaks. Distinguish real defects from false positives explicitly.
