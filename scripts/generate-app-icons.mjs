// Generates the home-screen app icons for the two installable surfaces
// (the quote tool at / and the advertising capture at /advertising/capture).
//
// The icon is the FULL company logo (Naldo's call), not a crop of it: the wreath
// arch, the houses, the YULE LOVE LIGHTS banner and the bow, whole, centred on a
// flat brand background. The logo is about 1.55:1, so fitting it in a square
// leaves a band above and below, and that is fine: the shape people recognise is
// the whole badge. The two apps share the logo and differ only by background
// colour, which is what makes them tellable apart on the same home screen.
//
// Output is COMMITTED as static PNGs under public/icons/. This script exists to
// record how they were made and to regenerate them if the logo changes.
//
// Run: node scripts/generate-app-icons.mjs

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SRC = 'public/yule-site-logo-2.png';
const OUT_DIR = 'public/icons';

// The whole logo, trimmed to its own ink. Measured off the source PNG by
// scanning the alpha channel: the art runs x 2..595 and y 2..382, so the file
// carries only a couple of transparent pixels of slack. Trimming to the measured
// box rather than to the file's bounds means the logo stays centred even if it
// is ever re-exported with different padding.
const LOGO = { left: 2, top: 2, width: 594, height: 381 };

const APPS = [
  {
    slug: 'quote',
    // Matches the app's own themeColor in src/app/layout.tsx.
    background: '#0B140F',
  },
  {
    slug: 'advertising',
    // Warm off-white. The logo was drawn for a light background, so the green
    // wreath and red bulbs stay bright, and it is unmistakable next to the
    // near-black quote tool icon.
    background: '#FAF7F0',
  },
];

// A maskable icon is cropped by the launcher to whatever shape it likes, and
// only the middle 80% is guaranteed to survive. Shrinking the artwork to 70%
// keeps the whole logo inside that safe circle.
const MASKABLE_CONTENT_SCALE = 0.7;

async function renderIcon({ size, background, contentScale = 1 }) {
  // How much of the icon's width the logo takes. 0.86 rather than edge to edge:
  // an app icon gets rounded corners, and the banner's red ends sit at the
  // widest point of the artwork, so they need a margin to not look clipped.
  const logoWidth = Math.round(size * contentScale * 0.86);
  const logoHeight = Math.round((logoWidth * LOGO.height) / LOGO.width);

  const logo = await sharp(SRC)
    .extract(LOGO)
    .resize(logoWidth, logoHeight)
    .png()
    .toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([
      {
        input: logo,
        left: Math.round((size - logoWidth) / 2),
        top: Math.round((size - logoHeight) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function write(name, buffer) {
  const file = path.join(OUT_DIR, name);
  await sharp(buffer).toFile(file);
  console.log('wrote', file);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const app of APPS) {
    const { slug, background } = app;

    for (const size of [192, 512]) {
      await write(
        `yll-${slug}-${size}.png`,
        await renderIcon({ size, background }),
      );
    }

    await write(
      `yll-${slug}-maskable-512.png`,
      await renderIcon({
        size: 512,
        background,
        contentScale: MASKABLE_CONTENT_SCALE,
      }),
    );

    // iOS ignores the manifest icons and uses this one, at 180x180.
    await write(
      `yll-${slug}-apple-touch.png`,
      await renderIcon({ size: 180, background }),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
