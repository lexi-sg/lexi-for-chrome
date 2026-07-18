// assets/screenshot-frames/shoot-frames.mjs
//
// Renders the four self-contained Chrome Web Store screenshot frames
// (frame-1.html .. frame-4.html) at their exact pixel dimensions and
// screenshots them to assets/store/screenshot-1.png .. screenshot-4.png
// (1280x800 each), overwriting the flat raw captures with branded
// marketing frames.
//
// Plain Playwright, no test runner — this is a build/asset step, not a
// test. Uses the `playwright` package already installed in this repo's
// node_modules (see package.json devDependencies). Modeled directly on
// scripts/shoot-promos.mjs.
//
// Run:
//   node assets/screenshot-frames/shoot-frames.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRAMES_DIR = __dirname;
const OUT_DIR = path.join(REPO_ROOT, 'assets', 'store');

const TARGETS = [1, 2, 3, 4].map((n) => ({
  html: `frame-${n}.html`,
  out: `screenshot-${n}.png`,
  width: 1280,
  height: 800,
}));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    for (const target of TARGETS) {
      const htmlPath = path.join(FRAMES_DIR, target.html);
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
