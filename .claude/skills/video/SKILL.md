---
name: video
description: Turn a video into shipped work — pull the transcript (YouTube link, pasted text, or a local file), extract every distinct idea with a timestamped verbatim quote, reality-check each one against this codebase and this business, then hand back a ranked DO / LATER / NOT-FOR-US decision table and ledger rows. Trigger — "/video", a pasted YouTube / Loom / Vimeo link, "take everything from this video", "what's in this video", "implement this video", "here's a video", "summarize this video". NEVER implements without an explicit go.
license: MIT
---

# Video → decisions → shipped work

A video is a stack of **claims made for someone else's business**. This skill turns
one into a short list of things actually worth building here, with the evidence
attached and the rejects recorded so the same idea never gets re-proposed.

**This is not a summarizer.** A summary is the cheap 10%. The value is the three
gates between "the video said X" and "we shipped X": faithful capture, reality
filter, and a decision the dev actually makes.

**Never write feature code from this skill.** It ends at ledger rows + a build
plan. Implementation goes through the normal pipeline (branch → PR → four-lens
review → the dev's explicit merge-go, per AGENTS.md).

---

## Step 0 — Pin the source, and don't re-mine

Record the URL / file path verbatim. Then:

```bash
ls docs/context/video_notes/ && grep -rl "<video-id-or-title-fragment>" docs/context/video_notes/ 2>/dev/null
```

If a note already exists, **read it and say so** rather than starting over. Ask
whether the dev wants a re-mine (new angle / new goals) or a status check on the
decisions that note already recorded. Re-mining a video and re-proposing an idea
that was already rejected is the failure mode this index exists to prevent.

## Step 1 — Get the transcript

Run the ladder in order. Stop at the first one that yields text.

```bash
bash .claude/skills/video/scripts/fetch_transcript.sh "<url>" "<outdir>"
```

The script's exit code tells you which rung failed:

| Code | Meaning | What to do |
|---|---|---|
| 0 | transcript written | continue to Step 2 |
| 3 | **network/egress blocked** | STOP the URL route immediately. Go to the paste route below. Do NOT try mirror sites or transcript-scraper services — routing around an org egress policy is forbidden (`/root/.ccr/README.md`). |
| 4 | video has no captions | offer the audio route (needs `ffmpeg` + a local `whisper`), else paste route |
| 5 | `yt-dlp` missing | `pip3 install yt-dlp` (or `brew install yt-dlp`), retry once |

**Know where you are before you start.** Claude Code *on the web* (a remote
container) has a locked egress policy and cannot reach youtube.com — confirmed
2026-08-19, 403 on CONNECT. Claude Code on the dev's **own machine** can. If the
probe fails, say that in one line and switch routes; don't spend the session
rediscovering it.

**Paste route (works everywhere, ~30 seconds):** on the YouTube page, `...more`
under the video → **Show transcript** → toggle timestamps ON → select all → paste
into chat. Save it to the outdir yourself before analyzing.

**File route:** for an mp4/mov/m4a on disk, extract audio with `ffmpeg -i in.mp4
-vn -ac 1 -ar 16000 out.wav` then transcribe with whatever local whisper is
installed. If none is, say so plainly — don't pretend to have watched it.

**Never invent content.** If no transcript was obtained, the answer is "I could
not read this video, here is the 30-second path to get it to me" — not a plausible
guess from the title. A fabricated extract is worse than no extract, because it
gets acted on.

## Step 2 — Capture (faithful, timestamped, auditable)

Write `docs/context/video_notes/YYYY-MM-DD-<slug>.md` using the template in
`reference/note_template.md`.

Rules that make the note trustworthy:

- **Every idea carries a `[mm:ss]` timestamp and a verbatim quote.** Paraphrase
  drifts; quotes don't. Any idea that later becomes a ledger row must be traceable
  back to the speaker's own words.
- **Separate what was SAID from what it MEANS here.** Two distinct fields, always.
  Merging them is how a video's assumption silently becomes our requirement.
- **Record the speaker's context** (their business size, their vertical, what they
  are selling). Most advice is load-bearing on context the video never states.
- Keep the raw transcript in the scratchpad, not the repo — unless the dev asks
  for it. Quote enough in the note that it stands on its own.

## Step 3 — Extract every distinct idea

Sweep the whole transcript, not just the parts that sound relevant. For each
distinct claim, tactic, tool, number, or workflow, capture:

- what it is, in one line
- the timestamp + quote
- what it would concretely mean **for Yule Love Lights** (a residential holiday /
  permanent / event lighting company on Long Island, run by a solo founder who
  also works a full-time job)
- which surface it would touch: quote tool · customer portal · pricing engine ·
  dashboard · design editor · GHL · WordPress site · ops/SOP · nothing (pure idea)

Do not filter yet. Filtering while extracting loses the ideas that only look good
after the third one lands next to them.

## Step 4 — Reality filter (three checks, every idea, no exceptions)

This is the step that earns the skill. Run all three; record the answers.

**Check 1 — Does it already exist?** Grep before believing anything is new.
A graph may exist (`graphify query "..."`); otherwise grep/read.

```bash
grep -rn "<feature-ish term>" src/ --include=*.ts --include=*.tsx -il | head -20
grep -o "<term>" docs/context/task_ledger.md | head
```

Check `docs/context/task_ledger.md` **and** open PRs (`gh pr list --limit 200`)
and unmerged branches. This repo has shipped duplicate work more than once by
skipping this (S25, S26, S35, S36) and has presented five already-shipped rows as
open work by trusting a table instead of reading each row's status (S39). If it
already exists, the finding is "already shipped in X" — that is a **successful**
outcome for the idea, not a dead end.

**Check 2 — Is it for THIS business?** State the answer, don't assume it.
- Solo founder, no dev team, limited hours — anything needing ongoing manual
  operation is much more expensive here than in the video's world.
- Seasonal, spiky demand — a tactic that assumes year-round even volume may not
  transfer.
- Real customers and real money already flow through this system. Advice aimed at
  a pre-revenue product does not apply to a live money path.
- Long Island residential homeowners, high-ticket installs — not e-commerce, not
  B2B SaaS, not a content business, unless the video is actually about those.

**Check 3 — What does it really cost?** Build hours, *recurring* maintenance
(the one people forget), money, and blast radius. An idea that touches pricing,
approvals, payments, or customer identity is a money-path change and carries the
repo's heavier review load — say so in the row.

## Step 5 — Decide (a table, then ask)

Present ONE table. Ranked, not exhaustive-alphabetical.

| # | Idea | Timestamp | Verdict | Why | Where it lands | Effort |
|---|---|---|---|---|---|---|

Verdicts are exactly three: **DO NOW** (clear payoff, ≤1 session, low blast
radius) · **LATER** (real, but not now — becomes a backlog ledger row) · **NOT FOR
US** (with the reason written down, permanently).

Then use `AskUserQuestion` to get the actual call on the DO NOW set. Do not
assume a green light from enthusiasm about the video. If nothing in the video
clears the bar, **say that** — "this one is not worth building anything from,
here is the one thing worth remembering" is a legitimate and useful result, and
much cheaper than a session spent on it.

## Step 6 — Land the decisions

For each greenlit item:

1. **Claim a ledger number safely.** The "Next free task #" counter on master is
   necessary and **not sufficient** — also check open PRs and unmerged branches
   for numbers already claimed (AGENTS.md; three near-collisions in one session).
2. Write the ledger row: what, why, the video note as the source link, size
   (S/M/L), and status.
3. Hand off to the normal build pipeline. This skill does not write the feature.
4. Non-code outcomes (a GHL automation, WordPress copy, an ops SOP, a pricing
   decision) get written into the video note's Decisions section and, if they need
   doing, a ledger row too — otherwise they evaporate.

## Step 7 — Update the index

Append a row to `docs/context/video_notes/INDEX.md`: date, title, source, one-line
takeaway, and what shipped from it. This is what makes the corpus compound: after
ten videos it answers "have we already looked at this?" and "which channels
actually produce things we build?" in one read.

---

## Pitfalls specific to this skill

- **A video is a hypothesis, not a spec.** Same rule this repo applies to briefs,
  handoffs, and old "fixed" notes (AGENTS.md). Verify against the live system
  before acting; a confident presenter is not evidence.
- **Watch for the sales pitch.** Much of this content exists to sell a course, an
  agency, or a tool. Flag when a recommendation is also the presenter's product —
  that does not make it wrong, it makes it unverified.
- **Numbers stated on camera are marketing numbers** until reconciled against our
  own data. Never let a video's conversion rate, price point, or close rate
  re-anchor a real number here without a query against our own rows.
- **Don't ledger the whole video.** Ten new backlog rows from one video is a
  failure of the filter, not a productive session. If everything cleared, the
  filter did not run.
- **The extract must survive the dev's terminal.** Bare URLs on their own line,
  concrete expected results, no markdown links (see the `verify-handoff` skill).
