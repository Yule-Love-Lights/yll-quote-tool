### S91 (Naldo) — 2026-08-28→09-04 — the referral program taken from zero rows ever to every contact holding a link: 8 PRs merged and live, a live-tagged GoHighLevel account, and a double-pay hole caught in review before it shipped. Close PR naldo/s91-close [Claude Code desktop]

> **NUMBER:** it moved three times during this close and every move was a real collision avoided. S72 was pinned early in the conversation and had long gone stale; journal fragments on master run to S89; the unmerged `naldo/s88-postclose4` branch already holds an S89 fragment; and the local self-assessment already had an S90 written by the concurrent advertising session. S91 was free everywhere checked.

**The number that reframed the whole ask.** Naldo asked for a way to let people generate their own referral link. The first thing measured was production: the `referrals` table had **zero rows, all time**, while 37 customers already held codes. The credit logic worked; nobody could see their link. Every decision after that followed from distribution being the bottleneck.

**Shipped and live:** #790 self-serve link page (enumeration-safe uniform response via `after()`) · #804 one-click personalized links from a GoHighLevel contact id · #924 the page upgrade Naldo asked for after calling it "just a box" · #960 the tagging sweep · #1038 the sweep's own logging (its numbers were being computed and discarded every 15 minutes) · #1041 link-preview card, branded 404, honest reward copy, required email · #1158 the quote-builder prefill · #1188 $125 on both sides.

**Live surfaces changed:** a migration applied to production (`consumed_at`, `consumed_by_quote_id`, partial index), verified by querying `information_schema` rather than trusting the tool's success message. `REFERRAL_SWEEP_LIVE=true` (Naldo). The sweep then ran the whole account: **2,253 of 2,259 customers now hold a referral link**, up from 37, zero errors throughout. The six without are the suppressed DO NOT CALL and Declined-for-2026 contacts, which is correct.

**A canary before the blast.** Rather than switch the sweep on for 2,200 contacts and watch, one live run against 10 contacts, then checked those contacts in GoHighLevel afterwards: tag applied, link on the custom field, and no message, campaign or workflow activity of any kind. That turned "nothing should fire" into "nothing did fire" on a population small enough to clean up by hand.

**The double-pay, found by review and introduced by my own PR.** `UNIQUE(referee_quote_id)` guards one referral row per referee QUOTE and nothing across different quotes. A 'link' row's status never changes on its own, so it sat pending forever; with the prefill reading those rows back as suggestions, a repeat customer's second quote would re-surface the same row and pay the same referrer $125 again. Two lenses disagreed about whether it was real; reading `accrueOnBooking` and the constraint settled it. Closed by consuming the link row at mention-creation time, from the save path so it also covers a hand-picked referrer.

**REVIEW at close (full four lenses — #1188 shipped without a pre-merge round, and live GoHighLevel data changed on ~2,250 contacts).** Findings and dispositions recorded with the close.

**A real production case that tested the guards.** The program's first-ever referral row turned out to be a contact using his own link. Both sides resolved to the same customer row and the self-referral exclusion correctly refused to suggest a credit. Worth recording because a review lens had called that guard inert on new quotes: it was load-bearing here.

**Still manual, and the thing most likely to make this fail quietly:** nobody is paid automatically. The builder now prompts when it spots a referred lead, but a staffer still has to press the button before the deposit, and a miss cannot be repaired without a developer. Two follow-ups remain unbuilt: a weekly report of referrals never attached to a quote, and a way to credit a miss after the fact.

**NEXT:** those two follow-ups. Before any segmented newsletter, check whether known past customers actually carry an opportunity in a service pipeline: the `neighbor` tag is decided by pipeline stage, not by tags, so customers recorded only by tag land in the "never booked" copy. And the GoHighLevel Brand Ambassador template is hand-written, does not read the app's constants, and still quotes superseded figures.

Gates at close: tsc 0 · lint 0 errors (23 pre-existing warnings) · vitest **10,528 / 599 files**. Master at close: `fe451628`.
