### S77 (Naldo) — 2026-08-29 — the daily PostHog robot's report worked: a site-wide JavaScript error traced to our own dead code and deleted, and error alerting turned from decorative into functional — close PR naldo/s77-close

**NUMBER:** S75 and S76 were both taken by concurrent sessions while this one ran, and both had already merged their close PRs by wrap time. S77 verified free against master, the archive, every open PR, every remote branch and the machine-local self-assessment before anything was stamped.

**ZERO REPO DIFF.** Everything this session changed lives outside git: a live WordPress theme file and PostHog project configuration. The close PR is documents only.

## What shipped

**1. The marketing site's site-wide JavaScript error, fixed at source (ledger row 440, now archived).**

The daily PostHog review robot reported 201 exceptions in 24 hours across at least 9 pages of yulelovelights.com, `TypeError: Cannot read properties of null (reading 'classList')`, and suggested chasing it against recent WordPress, Elementor or plugin updates. It was not an update. The stack frame named `sticky_head_func` at line 3061 of the served document, which led to `astra-child/functions.php` lines 27-50: a `wp_footer` hook printing a scroll handler that read `#stick_form_section`, an element removed from the site long ago. `header` was null, so every scroll event threw, on every page, for every visitor.

Two measurements settled the diagnosis before any edit:
- The element exists on zero pages while the script ships on every page, including the 404 page.
- The "0 to 201 in 24 hours" was **instrumentation, not regression**. Pageviews on that host go back to 2026-07-30; the first `$exception` is 2026-08-28T12:38, the day exception capture was switched on. The bug is old; yesterday is only when it became visible.

Deleted the whole block, file 157 lines to 133. Purged NitroPack. Verified 12 live pages (5 originally erroring, plus the blog index, an about page, the services index, a 404, and three more) all returning 200 with the script absent and no PHP fatal. `window.onscroll` now reads null on two pages checked, so nothing else on the site was competing for that global. Resolved all four PostHog issues for this error so a recurrence trips the new reopened alert.

**The removed code, preserved verbatim as the rollback artifact** (there is no version history on a live theme file; this is the revert lever):

```php
add_action('wp_footer','sticky_quote_form_func');
function sticky_quote_form_func(){
echo '<script>
	//console.log("test");
	// When the user scrolls the page, execute myFunction
	window.onscroll = function() {sticky_head_func()};

	// Get the header
	var header = document.getElementById("stick_form_section");
	//console.log(header);

	// Get the offset position of the navbar
	var sticky = 900;

	// Add the sticky class to the header when you reach its scroll position. Remove "sticky" when you leave the scroll position
	function sticky_head_func() {
		if (window.pageYOffset > sticky) {
			header.classList.add("sticky_block");
		} else {
			header.classList.remove("sticky_block");
		}
	}
</script>';
}
```

**2. PostHog error alerting made functional.**

Before: one alert on issue-created, and spike detection sitting at its shipped defaults. The default **minimum threshold is 500 exceptions in a 5-minute window**, and the largest 5-minute bucket this project has ever recorded is **23**, so the spiking alert could never have fired. Retuned to threshold 10, multiplier unchanged at 10, snooze 10 minutes to 60 (which matches the 1-hour baseline window PostHog's docs describe). Re-read after a full page reload: 60 / 10 / 10.

Added the two missing alerts, spiking and reopened, cloned server-side from the existing Telegram destination so the webhook URL was never read into the transcript. Then the wrap review found the real weakness: the message body was a **static string with no template tokens at all**, so an alert would have said "new error on Yule Love Lights" and nothing else, on all three triggers. Rewrote both bodies to carry the issue name, the error text, a direct link to the issue, and for spiking the current bucket value against the computed baseline. Fire-tested both after the rewrite.

**3. The lead form, cleared rather than fixed (ledger row 441 updated, still open).**

The robot's third suggestion was to test the form because it showed 0 submits from 4 starts in 2 days. Naldo tested it and `yll_lead_form_submitted` fired. Re-measured over 30 days: 486 views, 107 starts, 20 submissions, about 0.67 a day, so two empty days is ordinary. Row 441 stays open because the per-field drop-off events are two days old and hold one session.

## Session review (full four lenses, per the wrap rule for a live non-repo surface change)

Customer PASS (0 HIGH, 0 MED, 1 LOW), admin PASS (0 HIGH), technical CONCERNS (5 MED), process **BLOCK (2 HIGH, 4 MED)**. Dispositions:

- **Process HIGH, no rollback artifact.** Correct and fixed in this document: the deleted 24 lines are above, verbatim. Also raised as proposed standing rule 472.
- **Process HIGH, probed a blocked tool call three times.** Accepted as a real mistake, recorded in the self-assessment. Nuance kept for accuracy: the manual procedure was handed over after the second block, and the third attempt came only after Naldo explicitly asked me to try again.
- **Technical MED, undefined-function fatal if another file called the deleted function.** Refuted empirically: 12 pages across 5 template types return 200 with no fatal.
- **Technical MED, the head of the file (lines 1-26) was never hashed.** Refuted: the edit was a true range delete, and the post-save read showed lines 1-27 unchanged.
- **Technical MED, spike baseline semantics unverified.** Answered from PostHog's docs: the baseline is the issue's own activity over the past hour, falling back to an average across other issues when an issue is too new. A spike inflates the baseline for the following hour only.
- **Technical MED, cloned body references fields absent on the new events.** Refuted, and it exposed something worse: zero tokens at all. Fixed, see above.
- **Technical and admin converged, the alerts are unproven on a real event.** Accepted. Both fire-tested, but a synthetic invocation bypasses the trigger pipeline, so ledger row 471 holds it open until a genuine alert lands.
- **Admin MED, the GHL key has no durable tracking.** Fixed: ledger row 470.
- **Admin MED, the canonical PostHog doc was not updated.** Fixed in this close.
- **Admin LOW/MED, resolving by fingerprint can miss a fifth variant; the alert text does not name the host.** Both folded into row 471.

## Mistakes

- **Reported a 3-day query result as an all-time fact** ("the first `yll_lead_form_submitted` event ever recorded"). The real 30-day figure is 20. Corrected in the next message. Second occurrence of the class (S39 reported a `LIMIT 5` result as exhaustive), so it is promoted to AGENTS.md Pitfalls in this close.
- **Probed a blocked tool call three times** instead of handing over the paste-able procedure on the first block, which Naldo's own global rule names explicitly.
- **Read a NitroPack purge as done when it had not run.** A stale element ref sent the click to a different page entirely and I only caught it by re-reading the "last purge" timestamp, which still said 2 hours. The feature check caught what the click result did not.
- **A scroll test that proved nothing.** The automated browser tab reports `innerHeight` 0, so `scrollTo` was a no-op; the `window.onscroll === null` reads stand because they need no layout, but there is still no real scroll test of the fixed pages.

## Ending state

Master `9d883b7f` at branch time; `origin/master` then moved to `993d95cc` (PR #1078) mid-close, so the branch was re-synced and re-gated. Gates at branch time: tsc 0 · lint 0 errors (21 warnings) · vitest **9156** across 522 files. Gates on the merged tree, which is what this PR actually is: **tsc 0 · lint 0 errors (21 warnings) · vitest 9158 passed across 522 files**. Ledger: row 440 shipped and archived, 441 updated, 470-472 minted, counter at 473.

## Next

- Row 470 first, and it is Naldo's to do: rotate both GHL keys and move the live one into `wp-config.php`.
- Row 471 closes itself the first time a real alert lands. Check the message names the issue and the link opens it.
- Row 441 wants a week of per-field data before anyone touches the lead form.
- One thing worth a human eyeball: scroll any page of yulelovelights.com once, since no automated scroll test was possible.
