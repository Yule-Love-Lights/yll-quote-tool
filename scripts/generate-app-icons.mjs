// Generates the home-screen app icons for the two installable surfaces
// (the quote tool at / and the advertising capture at /advertising/capture).
//
// The only brand asset in the repo is a WIDE wordmark (598x385, roughly 3.2:1
// once the banner and bow are cropped away), and a wide mark squeezed into a
// square icon ends up about 20 pixels tall on a phone home screen. So the icon
// is composed rather than cropped: the wreath-and-houses mark on top, a bold
// "YLL" underneath, on a flat brand background. The two apps share the mark and
// differ only by background colour, which is what makes them tellable apart at
// a glance on the same home screen.
//
// Output is COMMITTED as static PNGs under public/icons/. This script exists to
// record how they were made and to regenerate them if the logo changes. It
// renders the "YLL" text through librsvg, so it depends on a heavy sans font
// being installed on the machine that runs it (Arial Black on Windows). If the
// regenerated text looks wrong on another machine, that is why: check the font
// before assuming the script is broken.
//
// Run: node scripts/generate-app-icons.mjs

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SRC = 'public/yule-site-logo-2.png';
const OUT_DIR = 'public/icons';

// The wreath arch plus the two house roofs, stopping just above the red
// "YULE LOVE LIGHTS" banner. Measured off the source PNG: the banner's first
// solid-red row is y=194, and the green ground line under the houses runs at
// y=170, so 2..185 keeps the whole mark and none of the wordmark.
const MARK = { left: 4, top: 2, width: 592, height: 184 };

const APPS = [
  {
    slug: 'quote',
    // Matches the app's own themeColor in src/app/layout.tsx.
    background: '#0B140F',
    textColor: '#FFFFFF',
  },
  {
    slug: 'advertising',
    // Warm off-white. The logo was drawn for a light background, so the green
    // wreath and red bulbs stay bright, and it is unmistakable next to the
    // near-black quote tool icon.
    background: '#FAF7F0',
    textColor: '#C8102E',
  },
];

// A maskable icon is cropped by the launcher to whatever shape it likes, and
// only the middle 80% is guaranteed to survive. Shrinking the artwork to 70%
// keeps the mark and the wordmark inside that safe circle.
const MASKABLE_CONTENT_SCALE = 0.7;

async function renderIcon({ size, background, textColor, contentScale = 1 }) {
  const inner = Math.round(size * contentScale);

  const markWidth = Math.round(inner * 0.92);
  const markHeight = Math.round((markWidth * MARK.height) / MARK.width);
  const mark = await sharp(SRC)
    .extract(MARK)
    .resize(markWidth, markHeight)
    .png()
    .toBuffer();

  const textBlockHeight = Math.round(inner * 0.38);
  const fontSize = Math.round(inner * 0.325);
  const text = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${textBlockHeight}">` +
      `<text x="${inner / 2}" y="${Math.round(textBlockHeight * 0.8)}" ` +
      `font-family="Arial Black, Arial, sans-serif" font-weight="900" ` +
      `font-size="${fontSize}" letter-spacing="${Math.round(inner * 0.006)}" ` +
      `fill="${textColor}" text-anchor="middle">YLL</text></svg>`,
  );

  // Vertical rhythm inside the content box: mark sits at 17% from its top,
  // wordmark baseline block starts at 55%. Tuned by eye at 320px and scaled.
  const offset = Math.round((size - inner) / 2);

  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([
      {
        input: mark,
        left: offset + Math.round((inner - markWidth) / 2),
        top: offset + Math.round(inner * 0.17),
      },
      { input: text, left: offset, top: offset + Math.round(inner * 0.55) },
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
    const { slug, background, textColor } = app;

    for (const size of [192, 512]) {
      await write(
        `yll-${slug}-${size}.png`,
        await renderIcon({ size, background, textColor }),
      );
    }

    await write(
      `yll-${slug}-maskable-512.png`,
      await renderIcon({
        size: 512,
        background,
        textColor,
        contentScale: MASKABLE_CONTENT_SCALE,
      }),
    );

    // iOS ignores the manifest icons and uses this one, at 180x180.
    await write(
      `yll-${slug}-apple-touch.png`,
      await renderIcon({ size: 180, background, textColor }),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
