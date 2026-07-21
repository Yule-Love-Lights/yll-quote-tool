# Self-serve estimate — sample homes

Drop the **5 Long Island style sample homes** here as:

```
home-1.jpg
home-2.jpg
home-3.jpg
home-4.jpg
home-5.jpg
```

These render in the "Homes we've lit up on Long Island" carousel on the
`/estimate` **address screen** (and stay up while the customer's own house is
looked up). See `src/app/estimate/SampleHomes.tsx`.

Notes:
- Any of the 5 that isn't present just drops out of the carousel — the gallery
  renders nothing at all until at least one loads, so there's no broken-image
  placeholder before the assets land. Add all 5 (or fewer) and they appear
  automatically; no code change needed.
- Use finished (lit) photos, roughly **4:3** landscape, web-optimized (they're
  served as-is from `public/`). To change the filenames or count, edit the
  `SAMPLE_HOMES` list in `SampleHomes.tsx`.
