---
name: winback-campaign
description: "STOPPED GHL win-back SMS campaign (\"database reactivation\") — final results, why it stopped (GHL 6% opt-out compliance trip), where the state lives, revival checklist. Historical record + the guardrails if anyone ever revives it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 34ff624b-7267-480d-8fe6-eabc52f0d184
  modified: 2026-08-18T19:35:40.138Z
---

# Winback-2026 SMS campaign — ⛔ STOPPED (final record, closed S31 2026-08-18)

**What it was:** Naldo's "database reactivation" — a 3-texts-over-3-months win-back to 381 old PROSPECTS (not past customers) tagged `winback-2026` in GHL (location zHpH8HA5xfa7magbxtvU). 10% off booking before Nov 1. Segment A = previously quoted (`bid sent` tag, 175) · Segment B = never quoted (203). Naldo sent 110 (July, soft "Christmas in July" copy); Jason + assistant picked it up in S31 (2026-07-27) and sent 79 more over 2 days via a purpose-built engine before stopping.

**Why it stopped (2026-07-28→29, permanent by ~Aug):** the S31 messages ran a ~6% STOP rate (vs Naldo's 0.9%) and tripped GHL's 6% opt-out compliance threshold — account-wide SMS restriction (rolling ~24h, email 2026-07-28 14:31 UTC). Jason + Naldo decided the account (email+SMS) is worth more than the campaign. **No further sends, including the planned August "text 2." 189 Segment-B contacts were never texted; pool frozen.**

**Final scoreboard (verified live 2026-08-18):** 189 texted of 380 (110 Naldo + 79 engine; melissa north removed on Jason's order — past customer, `perm-installed`). 6 STOPs, every one GHL auto-DND'd `permanent` (verified per contact). **5 conversions, ~$9.6k quoted, 1 BOOKED:**
- michael vahling (B arm) — $2,175 Bistro **BOOKED**, installed ~Aug 12. The campaign's realized revenue.
- stephen siena (Y) — $2,909.06 sent 8/18 (Naldo personally handling; replied "Yes." 8/17 + address 8/18).
- diana lopez-smith (Naldo's copy) — $1,848.75 **viewed**, quiet since July. Follow-up candidate.
- matthew keller (Y) — $1,145.14 sent 7/28, quiet since. Follow-up candidate.
- thomas volberg (X) — $1,489.88 quoted 8/3, declined 8/4.
- **A/B verdict: Y ("Reply YES" explicit ask) won** — 2 conversions vs X's 1-then-declined; STOPs even across arms.
- All silent-period replies were human-answered via the GHL team inbox (verified in threads at close — none dropped).
- **⚠️ OPEN (S31 close-review HIGH, needs Jason/Naldo):** the texts promised "10% off the whole job," but only matthew keller's quote carries it (`discountAmount` $177 = 10%). vahling **booked at full price $2,175** (~$217.50 owed if honored), siena's $2,909.06 + diana's $1,848.75 are pre-approval (easy re-issue), volberg declined (possibly because full price). Decide: honor retroactively / apply on the open ones / let it lie. Also decide the post-Nov-1 policy for late "YES" replies before staff improvise it.

**Where everything lives:** engine + recon scripts tracked in-repo (`scripts/winback-send.ts`, `scripts/winback-recon.ts` — ledger row 253, S37). Pool/state: `C:\Users\Jason\Documents\YLL-Winback\state.json` (189 B still `pending` — the engine will NOT send without an explicit `--live` run). Send log: `send-log.jsonl` same folder. Recon artifact + previews local-only (PII, never committed).

**If anyone ever revives it (Naldo sign-off required):** (1) copy tone must match Naldo's proven 0.9%-STOP skeleton, canary 20 first, measure before scaling — sharper sales copy is what tripped compliance; (2) the opt-out budget is ACCOUNT-WIDE — his permanent-lighting drip spends from the same 6% pool; (3) confirm A2P registration first (GHL's own recommendation, account-level); (4) engine pre-send verify already excludes DND/replied/tag-removed/active-deal contacts and opp-activity must threshold at 2026-07-21 (Naldo's 7/20 status backfill bulk-stamped ~880 cards `abandoned`); (5) sends NEVER auto-retry (5xx parks as `send-ambiguous`, resolve via `--check`).

**Hard-won GHL API facts (still true for ANY GHL work):** contact-SEARCH payload omits `dndSettings` (STOP opt-out = `dndSettings.SMS.status:"permanent"`, `contact.dnd` stays false — full GET needed) · gateway randomly flakes `401 "Command timed out"` (transient; retry-safe on reads only) · `TYPE_EMAIL` messages carry `direction: undefined` · GHL restriction emails claim a fixed resume time but the real block is rolling ~24h from trip · manual conversational replies in existing threads are exempt from the bulk-send restriction · weekly Monday newsletters account for email touches on texted contacts.
