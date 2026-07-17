// scripts/shoot-promos.mjs
//
// Renders the two self-contained Chrome Web Store promo tiles
// (assets/promo-small.html, assets/promo-marquee.html) at their exact pixel
// dimensions and screenshots them to assets/store/promo-small.png (440x280)
// and assets/store/promo-marquee.png (1400x560).
//
// Plain Playwright, no test runner — this is a build/asset step, not a test.
// Uses the `playwright` package already installed in this repo's
// node_modules (see package.json devDependencies).
//
// Run:
//   node scripts/shoot-promos.mjs
//
// Each HTML file is a fully self-contained document (inline CSS, base64
// icon, system/serif font stacks only, no network requests) sized exactly
// to its target viewport, so a full-page screenshot at that viewport size
// is pixel-exact to the target dimensions — no cropping or scaling needed.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const OUT_DIR = path.join(REPO_ROOT, 'assets', 'store');

const TARGETS = [
  { html: 'promo-small.html', out: 'promo-small.png', width: 440, height: 280 },
  { html: 'promo-marquee.html', out: 'promo-marquee.png', width: 1400, height: 560 },
];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    for (const target of TARGETS) {
      const htmlPath = path.join(ASSETS_DIR, target.html);
      if (!fs.existsSync(htmlPath)) {
        throw new Error(`Missing source file: ${htmlPath}`);
      }

      const page = await browser.newPage({
        viewport: { width: target.width, height: target.height },
        deviceScaleFactor: 1,
      });
      await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });

      // Sanity: confirm the document's own box matches the target exactly
      // before we screenshot it, so a CSS mistake fails loudly here instead
      // of silently producing a mis-sized PNG.
      const box = await page.evaluate(() => ({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight,
      }));
      if (box.w !== target.width || box.h !== target.height) {
        throw new Error(
          `${target.html}: document size ${box.w}x${box.h} does not match target ${target.width}x${target.height}`,
        );
      }

      const outPath = path.join(OUT_DIR, target.out);
      await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: target.width, height: target.height } });
      await page.close();

      console.log(`wrote ${path.relative(REPO_ROOT, outPath)} (${target.width}x${target.height})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
