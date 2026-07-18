// One-off generator: builds assets/screenshot-frames/frame-1..4.html by
// inlining the existing raw product captures + brand chrome as base64.
// Not a deliverable itself — run once (and re-run after edits to the
// template below) to (re)materialize the checked-in frame-*.html files.
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'assets', 'screenshot-frames');

const iconB64 = fs.readFileSync(path.join(REPO, 'icons', 'icon128.png')).toString('base64');

function shotB64(n) {
  // Read from the preserved raw captures, NOT assets/store — shoot-frames.mjs
  // overwrites assets/store/screenshot-*.png with the framed output, so using
  // that as source would compound frames-within-frames on re-runs.
  return fs.readFileSync(path.join(REPO, 'assets', 'screenshot-frames', 'raw', `screenshot-${n}.png`)).toString('base64');
}

const FRAMES = [
  // cropW = how much of the raw 1280-wide capture's left edge to keep
  // (proportionally re-expanded to fill the mockup width). Screenshots
  // 1/2/4 use the full capture; 3 (options page) has real UI only in
  // the left ~510px with the rest dead white space, so it is cropped
  // to a tighter "settings card" width instead of showing a mostly-empty
  // browser window.
  { n: 1, caption: 'Ask about any page you are reading', cropW: 1280 },
  { n: 2, caption: 'Flag risky terms before you sign', cropW: 1280 },
  { n: 3, caption: 'Private by design — your data stays yours', cropW: 520 },
  { n: 4, caption: 'Agent Mode asks before it acts', cropW: 1280 },
];

function template({ n, caption, cropW }) {
  const shot = shotB64(n);
  const imgWidthPct = (1280 / cropW) * 100;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Lexi — Chrome Web Store screenshot ${n} (1280x800)</title>
<style>
  :root {
    --teal: #24CFA6;
    --bg: #0A0A0A;
    --text: #FFFFFF;
    --muted: #969696;
    --border: rgba(255,255,255,0.10);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 1280px;
    height: 800px;
    overflow: hidden;
    background: var(--bg);
  }
  .stage {
    position: relative;
    width: 1280px;
    height: 800px;
    background: var(--bg);
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* single restrained glow, not a mesh */
  .glow {
    position: absolute;
    left: 50%;
    top: 210px;
    width: 1180px;
    height: 620px;
    transform: translateX(-50%);
    background: radial-gradient(ellipse at center, rgba(36,207,166,0.16) 0%, rgba(36,207,166,0.05) 45%, rgba(36,207,166,0) 72%);
    filter: blur(2px);
    pointer-events: none;
  }
  .vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%);
    pointer-events: none;
  }
  .header {
    position: relative;
    z-index: 2;
    flex: 0 0 auto;
    padding: 30px 90px 0;
    text-align: center;
  }
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    margin-bottom: 16px;
  }
  .brand img {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: block;
  }
  .brand span {
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .eyebrow::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--teal);
    box-shadow: 0 0 10px rgba(36,207,166,0.7);
    display: inline-block;
  }
  h1 {
    margin: 0;
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    font-weight: 700;
    font-size: 42px;
    line-height: 1.18;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .imagewrap {
    position: relative;
    z-index: 2;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 18px 60px 42px;
  }
  .frame {
    position: relative;
    height: 100%;
    aspect-ratio: ${cropW} / 800;
    max-width: 100%;
    border-radius: 14px;
    box-shadow:
      0 1px 0 rgba(255,255,255,0.06) inset,
      0 0 0 1px var(--border),
      0 40px 90px -25px rgba(0,0,0,0.75),
      0 0 60px rgba(36,207,166,0.12);
    overflow: hidden;
    background: #111;
  }
  /* Proportional crop: the raw capture is always 1280x800 natively.
     The frame box represents cropW x 800 of it (left-aligned), scaled
     uniformly to fill the frame — so the image is positioned/sized as
     a percentage of the crop box rather than baked-in pixels. */
  .frame .crop {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .frame .crop img {
    display: block;
    position: absolute;
    top: 0;
    left: 0;
    width: ${imgWidthPct.toFixed(4)}%;
    height: 100%;
  }
  .footer {
    position: absolute;
    z-index: 2;
    left: 0;
    right: 0;
    bottom: 22px;
    text-align: center;
    font-size: 11px;
    letter-spacing: 0.04em;
    color: #55585f;
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="glow"></div>
    <div class="header">
      <div class="brand">
        <img src="data:image/png;base64,${iconB64}" alt="" />
        <span>Lexi</span>
      </div>
      <h1>${caption}</h1>
    </div>
    <div class="imagewrap">
      <div class="frame">
        <div class="crop">
          <img src="data:image/png;base64,${shot}" alt="" />
        </div>
      </div>
    </div>
    <div class="vignette"></div>
    <div class="footer">getlexi.io &middot; Not legal advice</div>
  </div>
</body>
</html>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of FRAMES) {
  const outPath = path.join(OUT_DIR, `frame-${f.n}.html`);
  fs.writeFileSync(outPath, template(f));
  console.log('wrote', outPath);
}
