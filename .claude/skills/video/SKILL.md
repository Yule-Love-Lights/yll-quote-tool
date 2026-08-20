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

If a note already exists, **read it and say so** rather than starting over. Also
skim `INDEX.md`'s reject column: if a *previous* video's idea of the same shape
was already ruled out, say so and reuse the reasoning instead of re-litigating it
from scratch — unless the reason has expired (it usually names a condition, like
"no crew," that may since have changed).

## Step 1 — Get the transcript

```bash
bash .claude/skills/video/scripts/fetch_transcript.sh "<url>" "<scratchpad-outdir>"
```

**If this environment has no shell tool at all** (not blocked — absent), skip
straight to the paste route; don't try to invoke the script.

The script's exit code tells you which rung failed:

| Code | Meaning | What to do |
|---|---|---|
| 0 | transcript written | continue to Step 2 |
| 3 | **network/egress blocked** | STOP the URL route immediately. Go to the paste route. Do NOT try mirror sites or transcript-scraper services — routing around an org egress policy is forbidden (`/root/.ccr/README.md`). |
| 4 | video has no captions | offer the audio route (needs `ffmpeg` + a local `whisper`), else paste route |
| 5 | `yt-dlp` or `python3` missing | `pip3 install yt-dlp` (or `brew install yt-dlp`), retry once |

**Know where you are before you start.** Claude Code *on the web* (a remote
container) has a locked egress policy and cannot reach youtube.com — confirmed
2026-08-19, 403 on CONNECT. Claude Code on the dev's **own machine** can. If the
probe fails, say that in one line and switch routes.

**Paste route** — hand the dev exactly this, on a desktop/laptop browser:

```
1. On the video page, click "..." (more actions, next to Like/Share) OR expand
   "...more" under the title.
2. Click "Show transcript". If it isn't there, the video has no captions — say so.
3. Timestamps are usually already on. If you don't see them, use the transcript
   panel's own menu to turn them on.
4. Click inside the transcript panel, then Ctrl+A (Cmd+A), then Ctrl+C (Cmd+C).
5. Paste it into the chat.
```

On a phone this is slow and error-prone for a long video — say so rather than
insisting. Save the pasted text to the scratchpad before analyzing it.

**File route:** for an mp4/mov/m4a on disk, `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000
out.wav`, then transcribe with whatever local whisper is installed. If none is,
say so plainly — don't pretend to have watched it.

**Never invent content.** With no transcript the answer is "I could not read this
video, here is the 30-second path to get it to me" — not a plausible guess from
the title. A fabricated extract is worse than none, because it gets acted on.

## Step 2 — Capture (faithful, timestamped, auditable)

Write `docs/context/video_notes/YYYY-MM-DD-<slug>.md` from
`reference/note_template.md`.

- **Every idea carries a `[mm:ss]` timestamp and a verbatim quote.** Keep quotes
  short — a sentence or two, enough to prove the point. Never paste long runs of
  transcript into the repo; this is third-party content and the note is permanent.
- **What was SAID stays in a separate field from what it MEANS here.** Merging
  them is how a video's assumption silently becomes our requirement.
- **Flag garbled auto-captions instead of quoting them as fact.** Machine captions
  mis-hear numbers and names — "2 to 4 percent" becomes "24 percent", a product
  name becomes a homophone. If a span is unpunctuated, run-on, or carries a
  number that looks off, mark the quote `[caption uncertain]` and do NOT let a
  cost or money judgement rest on it without the dev confirming what was said.
- **Record the speaker's context** (business size, vertical, what they sell). Most
  advice is load-bearing on context the video never states.
- Keep the raw transcript in the scratchpad, **not** the repo.

## Step 3 — Extract every distinct idea

**Long video first:** if the transcript runs past ~20 minutes, do a fast pass by
timestamp range before extracting. Mark ranges that are clearly filler (intro,
ad read, guest bio, recap) as `[mm:ss–mm:ss] skipped — <why>` and don't extract
from them. Record which range you actually mined; a 90-minute podcast with 4 good
minutes should say so.

Then, inside the ranges that carry content, sweep everything — don't filter while
extracting; filtering early loses ideas that only look good next to the third one.
For each distinct claim, tactic, tool, number, or workflow capture: what it is;
the timestamp + quote; what it would concretely mean **for Yule Love Lights** (a
residential holiday / permanent / event lighting company on Long Island, run by a
solo founder who also works a full-time job); and which surface it touches —
quote tool · portal · pricing engine · dashboard · design editor · GHL ·
WordPress · ops SOP · none.

Record the video's total length against the last extracted timestamp, and state
plainly whether the full transcript was swept.

## Step 4 — Reality filter (three checks, every idea, answers recorded)

**Check 1 — Does it already exist?** *Branch on the surface, and never let a
code grep stand in for a system that isn't in git.*

- **Repo surfaces** (quote tool, portal, pricing, dashboard, editor): grep with
  **at least two different terms** — one for the feature name, one for the
  mechanism — and paste the literal command and its output into the note. A
  single narrow term producing zero hits is not evidence of absence.
  ```bash
  grep -rn "<term>" src/ --include=*.ts --include=*.tsx -il | head -20
  grep -o "<term>" docs/context/task_ledger.md | head
  ```
  Also check the ledger, open PRs (`gh pr list --limit 200`), and unmerged
  branches — this repo has shipped duplicate work by skipping exactly this (S25,
  S26, S35, S36) and has presented five already-shipped rows as open work (S39).
- **GHL / WordPress / any non-repo system:** a repo grep proves *nothing* here.
  Either inspect the live system, or write **"not checked — no read access, ask
  the dev"**. Never write "no — checked src/" for a surface that doesn't live in
  src/.

"Already shipped in X" is a **successful** outcome, not a dead end.

**Check 2 — Is it for THIS business? Cite a real number.** An opinion is not an
answer. Before answering yes, name one concrete figure from our own data — a
`BUSINESS_RULES` constant, a dashboard query, an actual close/approval rate, a
real job total. If no such number is available, the honest answer is "can't
assess without <the number>", which makes it a LATER, not a DO NOW. Context that
matters: solo founder with a full-time job (anything needing ongoing manual
operation costs far more here than in the video's world); seasonal spiky demand;
live customers and real money already flowing; Long Island residential
high-ticket installs — not e-commerce, not B2B SaaS.

**Check 3 — What does it really cost?** Build hours, **recurring maintenance**
(the one people forget), money, and blast radius. Anything touching pricing,
approvals, payments, or customer identity is a money-path change and carries the
repo's heavier review load — say so in the row.

## Step 5 — Decide (derive the verdict, don't re-vote)

The verdict is **arithmetic on Checks 1–3**, not a fresh judgement:

- Already exists (Check 1) → **ALREADY SHIPPED**, cite where. Stop.
- Check 2 fails, or can't be answered with a real number → **NOT FOR US** or
  **LATER** respectively.
- Check 3 exceeds ~one session, **or** touches money / identity / approvals →
  **LATER** (it needs its own scoped build, not a same-day change).
- All three clean → **DO NOW**.

If your gut disagrees with what the checks produce, say so explicitly and give
the reason — don't silently overwrite the derivation.

Present ONE ranked table:

| # | Idea | [mm:ss] | Verdict | Why | Where it lands | Effort |

Then use `AskUserQuestion` for the actual call on the DO NOW set. Don't read
enthusiasm about the video as a green light. If nothing clears the bar, **say
so** — "not worth building anything from this one, here's the single thing worth
remembering" is a legitimate, cheap, useful result.

**These verdicts are recommendations, not gates.** It's Naldo's business. If he
wants something marked LATER or NOT FOR US built anyway, that's his call: flip
the verdict, note `Overridden by Naldo <date> — was NOT FOR US because <reason>`,
and carry it to Step 6 like any DO NOW.

## Step 6 — Land the decisions

1. **Claim a ledger number safely.** The "Next free task #" counter on master is
   necessary and **not sufficient** — also check open PRs and unmerged branches
   for numbers already claimed (AGENTS.md; three near-collisions in one session).
2. **Write to `task_ledger.md` atomically.** That file has been truncated to 0
   bytes twice (S25, S35 — the second time by a script that *followed* the
   script-file rule, because `write_text` opens with `'w'`). Follow the AGENTS.md
   atomic-write rule exactly: build the whole payload in memory, write a temp
   file, verify its size, then `os.replace`. Never write straight onto it.
3. Row content: what, why, the video note as the source link, size (S/M/L), status.
4. Hand off to the normal build pipeline. **This skill does not write the feature.**
5. Non-code outcomes (a GHL automation, WordPress copy, an ops SOP, a pricing
   decision) go in the note's Decisions section — and get a ledger row too if
   they need doing, otherwise they evaporate.

## Step 7 — Update the index

Append a row to `docs/context/video_notes/INDEX.md`: date, title, source, one-line
takeaway, what shipped, **and the reason for anything rejected**. The reject
reason is what lets Step 0 recognise a same-shape idea from a different video
later, instead of re-arguing it from zero.

Per-video notes are **read on demand, not bulk-loaded** — they are not continuity
docs and must not be copied into session memory wholesale. Only `INDEX.md` is
meant to be skimmed routinely.

---

## Pitfalls specific to this skill

- **A video is a hypothesis, not a spec.** Same rule this repo applies to briefs
  and old "fixed" notes (AGENTS.md). A confident presenter is not evidence.
- **Watch for the sales pitch.** Much of this content exists to sell a course, an
  agency, or a tool. Flag when a recommendation is also the presenter's product —
  that doesn't make it wrong, it makes it unverified.
- **Numbers stated on camera are marketing numbers** until reconciled against our
  own data. Never let a video's conversion rate or price point re-anchor a real
  number here without a query against our own rows.
- **Don't ledger the whole video.** Ten new backlog rows from one video is a
  failure of the filter, not a productive session.
- **The extract must survive the dev's terminal.** Bare URLs on their own line,
  concrete expected results, no markdown links (see the `verify-handoff` skill).
