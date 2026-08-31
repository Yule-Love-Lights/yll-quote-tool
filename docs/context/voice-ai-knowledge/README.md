# Voice AI knowledge base (v0)

Source of truth for the VAPI assistant's grounding. Plain markdown, no vector
DB (per the #168 design — upgrade only if this proves insufficient).

- [services.md](services.md) — what YLL sells, grounded in the actual pricing
  engine types (not guessed from call transcripts yet — that's the v1 upgrade
  once real transcripts are reviewed).
- [pricing-ranges.md](pricing-ranges.md) — the ONLY numbers the AI may speak.
  **Currently placeholder — Naldo must fill in real ranges before any real
  customer call.**
- [disclosure-and-policy.md](disclosure-and-policy.md) — the disclosure
  script, the never-deny rule, and the range-dodge framing.

## Feeding this into VAPI
Paste the combined contents of all three files into the VAPI assistant's
System Prompt (Dashboard → Assistants → [assistant] → Model → System Prompt),
or upload as Knowledge Base documents if using VAPI's file-based knowledge
feature — decide based on prompt length once assembled; test either way in
Chunk 2 Step 6 of the implementation plan.

## Keeping it current
This is a living doc, same convention as the rest of docs/context/. When a
test call or real call reveals the AI got something wrong or missing, add it
here and re-paste into the VAPI assistant. No ML retraining involved.

## Voice provider chosen
TBD — decided by ear in Chunk 2 Step 8 of the implementation plan
(`docs/superpowers/plans/2026-07-20-ai-voice-backup.md`), comparing an
ElevenLabs clone against a Cartesia clone of the same voice sample.

## Transcript-derived content (v1, not yet built)
This v0 is grounded only in code (real service/pricing types) and the
council/design findings. The next real upgrade is distilling patterns from
YLL's actual past-call transcripts (files + what's in GHL) — the language
customers actually use, common objections, what closes a call — per the
design's "Knowledge base (build first)" section. That pass needs the
transcripts themselves; not started yet.
