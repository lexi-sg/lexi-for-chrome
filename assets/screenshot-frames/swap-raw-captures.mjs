// One-off helper: swaps the embedded product-capture base64 inside each
// checked-in frame-1..4.html for the corresponding NEW raw capture in
// assets/raw-captures/, leaving everything else (caption, icon, styling,
// markup) byte-for-byte untouched. Targets only the <div class="crop"><img
// src="data:image/png;base64,...">  payload — the exact markup gen-frames.mjs
// emits for the product screenshot (as opposed to the small brand <img> for
// icon128.png, which is left alone).
//
// Run:
//   node assets/screenshot-frames/swap-raw-captures.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const FRAMES_DIR = __dirname;
const RAW_DIR = path.join(REPO, 'assets', 'raw-captures');

for (const n of [1, 2, 3, 4]) {
  const framePath = path.join(FRAMES_DIR, `frame-${n}.html`);
  const rawPath = path.join(RAW_DIR, `screenshot-${n}.png`);

  const html = fs.readFileSync(framePath, 'utf8');
  const newB64 = fs.readFileSync(rawPath).toString('base64');

  const cropOpen = '<div class="crop">';
  const cropStart = html.indexOf(cropOpen);
  if (cropStart === -1) throw new Error(`${framePath}: could not find <div class="crop">`);

  const imgMarker = 'data:image/png;base64,';
  const b64Start = html.indexOf(imgMarker, cropStart) + imgMarker.length;
  if (b64Start === -1 + imgMarker.length) throw new Error(`${framePath}: could not find crop <img> data URI`);
  const b64End = html.indexOf('"', b64Start);
  if (b64End === -1) throw new Error(`${framePath}: could not find end of crop <img> data URI`);

  const oldB64 = html.slice(b64Start, b64End);
  if (!oldB64) throw new Error(`${framePath}: empty existing base64 payload — refusing to swap`);

  const updated = html.slice(0, b64Start) + newB64 + html.slice(b64End);
  fs.writeFileSync(framePath, updated);
  console.log(`swapped ${path.relative(REPO, framePath)} crop image (${oldB64.length} -> ${newB64.length} base64 chars)`);
}
