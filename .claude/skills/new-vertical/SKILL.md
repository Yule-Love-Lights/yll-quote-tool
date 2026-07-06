---
name: new-vertical
description: Checklist for adding or altering a service type / vertical (holiday, permanent, event, next one). Prevents the seam bugs that shipped with the 3rd vertical: inherited behavior, wrong-shape producers, missed fan-out sites. Trigger: new service type, package variant, or any change fanned across a vertical's seams.
---

# New Vertical

The 3rd vertical (event) silently inherited holiday behavior across 5 seams and needed
3 input-model refactors. All of it was preventable with the checks below.

## Before writing code

1. Read the sibling vertical's MERGED seam code, not the plan and not your memory of
   it. Reason: `derivePackagesEvent` was built against an imagined return shape and had
   to be reworked to match the real `PortalPackage[]` consumer.
2. Pin the consumer type before building the producer: name the exact type the
   portal/adapter expects and build to it.
3. Enumerate every seam the service type touches: portal render, confirmation page,
   add-ons, emails, settings, invoices, scheduling windows. Reason: event showed the
   holiday confirmation page and wrong takedown windows because no one listed the
   seams first.

## Gates and fan-out

4. Positive-match gates only: `=== 'holiday'`, never `!== 'permanent'`. Reason:
   negative gates silently hand every future vertical the old behavior; that is
   exactly how event got holiday's rush and early-takedown add-ons.
5. For any stamp or behavior applied across N similar sites: `grep -c` the pattern and
   reconcile the count against the edit list before gating. Reason: the photoId stamp
   covered 13 of 14 sites; the missed one (the garland TRACE commit path) shipped a
   real bug.
6. When a shared structure gains members (link expansion, id threading), grep its
   readers the same hour. Reason: the sceneLinks twin-expansion leaked twin ids into
   the photo-tag chip lookup and mis-tagged canonical rows.
7. Before widening a shared type: list every consumer and hunt stale narrow duplicates
   hidden behind `as` casts, which tsc will not flag. Reason: the railing type had two
   parallel narrow copies that only an adversarial review caught.

A 4th copy-paste vertical is a smell. If you are copying the seam pattern again, raise
extracting a shared vertical abstraction first instead of pasting (council
recommendation, S23).
