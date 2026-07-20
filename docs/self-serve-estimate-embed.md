# Embedding the self-serve estimator on yulelovelights.com

The estimator lives at `https://quote.yulelovelights.com/estimate` and is built to
be **iframed into a WordPress page** on the marketing site. This is the Phase A
launch shape Naldo chose: a dedicated page, embedded, kept separate until we're
happy to make it live.

## Prerequisites (must be true before the embed shows anything)

1. **`SELF_SERVE_ESTIMATE_ENABLED=true`** on the environment the iframe points at.
   Off ⇒ `/estimate` returns 404 and the iframe shows a "not found" page. It is
   currently set on **Preview only** (production is still dark on purpose).
2. The page runs the small resize script below, or the frame will show an inner
   scrollbar / dead space instead of matching the content height.

## What the app already does for you

- **`/estimate?embed=1`** renders the embedded variant: no standalone hero (the
  WordPress page supplies the heading), transparent background, tighter padding.
- **Frame-ancestors:** `/estimate` sends
  `Content-Security-Policy: frame-ancestors 'self' https://yulelovelights.com
  https://www.yulelovelights.com`. Only those origins can embed it; anything else
  is refused (fails closed). The portal and every other route stay
  `X-Frame-Options: SAMEORIGIN` — never embeddable.
- **Auto-height:** the embedded page posts its content height to the parent via
  `postMessage` (`{ type: 'yll-estimate-height', height }`) on every size change,
  so the frame can grow/shrink with the flow (address → measuring → result +
  contact form). The script below listens for it.

## The snippet — paste into an Elementor "HTML" widget

> ⚠️ Elementor gotcha (hit before, S-notes): editing an existing HTML/code
> element sometimes silently reverts. If an edit doesn't stick, DELETE the widget
> and add a fresh one rather than editing in place. Verify the change is live
> logged-out.

```html
<div style="max-width: 640px; margin: 0 auto;">
  <iframe
    id="yll-estimate"
    src="https://quote.yulelovelights.com/estimate?embed=1"
    title="Instant Holiday Lighting Estimate"
    loading="lazy"
    style="width: 100%; height: 520px; border: 0; overflow: hidden;"
    allow="clipboard-write"
  ></iframe>
</div>
<script>
  (function () {
    var frame = document.getElementById('yll-estimate');
    window.addEventListener('message', function (e) {
      // Only trust messages from the estimator origin.
      if (e.origin !== 'https://quote.yulelovelights.com') return;
      var d = e.data;
      if (d && d.type === 'yll-estimate-height' && typeof d.height === 'number') {
        // +2px avoids a 1px scrollbar from sub-pixel rounding.
        frame.style.height = (d.height + 2) + 'px';
      }
    });
  })();
</script>
```

Notes:
- `height: 520px` is just the pre-resize starting height; the script overrides it
  the moment the estimator posts its real height.
- The `e.origin` check is the security half of the handshake — the page only
  accepts height messages from the estimator, nothing else on the internet.
- Put your own heading/subhead in a WordPress heading widget ABOVE this block;
  the embedded estimator deliberately omits its own hero to avoid a double title.

## Rollout order (Naldo's plan)

1. Keep it on a **dedicated, unlinked page** (e.g. `/instant-quote`) — built,
   embedded, not linked from anywhere — until we're happy with it.
2. Flip the prod flag when ready to make it live, then link the page into the
   nav / a CTA.
3. Watch the dashboard's "Self-serve estimates" accuracy tile fill in; use that
   data (not a guess) to decide any pricing buffer and Phase B.

## Cross-domain analytics (follow-up, not required to launch)

The estimator is on the `quote.` subdomain, so a visit that starts on
yulelovelights.com and continues in the iframe splits across two PostHog
"persons" unless cross-domain tracking is configured. Fine for a soft launch;
wire it up before you care about a clean "site → estimate → booking" funnel.
