# Self-serve estimate — sample home style photos

These are the daytime photos behind the **house-style picker + before/after hero**
on the `/estimate` landing screen (see `src/app/estimate/BeforeAfter.tsx` and
`estimateSamples.ts`). One per Long Island style:

```
home-colonial.jpg   home-cape.jpg     home-ranch.jpg
home-hiranch.jpg    home-split.jpg    home-victorian.jpg
```

## ⚠️ These are PLACEHOLDER stock photos

They came from the approved mockup (free-license stock houses). **Swap them for
real Yule Love Lights homes** — authentic homes read as trust/social proof where
stock doesn't. Two ways to do the "with lights" side:

1. **Real before/after photo pairs (preferred).** A daytime "before" and a real
   lit "after" per style. This needs a small change to `BeforeAfter.tsx` to
   crossfade two photos instead of drawing the overlay — say the word and I'll
   switch it.
2. **Keep the drawn-lights overlay.** The lights are drawn from hand-placed
   geometry in `estimateSamples.ts` tuned to THESE photos, so a new photo needs
   its roofline/wreath/garland points re-traced to line up.

Keep them roughly **3:2 landscape**, web-optimized (served as-is from `public/`).
To change the styles/count, edit `SAMPLE_STYLES` in `estimateSamples.ts`.
