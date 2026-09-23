#!/usr/bin/env node
/* MailDrop icon: one geometry, every size.

   Why a generator: an icon set that is typed out by hand always drifts — the
   favicon says one thing, the PNG another, the manifest a third. Here the shapes
   are declared once, and the SVG, the PNGs and the web app manifest are all
   written from the same numbers, so what the browser tab shows is provably what
   the manifest promises and what the repo ships.

   No dependencies on purpose (this repo has a build step for nothing): the PNG
   encoder is a hand-written IHDR/IDAT/IEND with zlib, and anti-aliasing comes
   from supersampling the analytic shapes, so there is no rasteriser to install
   and no font to hope for.

     node tools/make-icons.mjs            regenerate assets/
     node tools/make-icons.mjs --check    fail if assets/ is stale (CI-friendly)
*/
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');   // where the rasters go
const CHECK = process.argv.includes('--check');

// ---------------------------------------------------------------- the geometry
// A flat, bold field with one white glyph: an arrow dropping into a tray. That is
// the WeTransfer move — a single solid colour, one shape, nothing that needs a
// manual to read — and it survives being drawn 16 pixels wide, which an envelope
// with a seal does not.
const S = 512;                    // design canvas
const FIELD_R = 112;             // corner radius of the field (22%)
const TOP = '#38BDF8';           // the same two stops as the app's own primary button
const BOTTOM = '#0284C7';
const STROKE = 52;               // one weight everywhere, round caps and joins
const HALF = STROKE / 2;

const ARROW_TOP = 100;
const ARROW_X = S / 2;
const CHEVRON_TIP = 312;
const CHEVRON_ARM_Y = 236;
const CHEVRON_HALF = 62;

const TRAY_L = 108;               // tray walls, floor and corner radius
const TRAY_R = S - 108;
const TRAY_TOP = 316;
const TRAY_FLOOR = 412;
const CORNER = 44;
// The flare is the whole personality of the mark, so it has to be out of the
// chevron's way: a 40 px band of clear air between the two, or at 16 px they
// fuse into one smudge. These numbers were picked by rendering, not by eye-balling
// the SVG at full size, which is where this kind of detail lies to you.
const FLARE = 30;                 // how far the walls kick out at the top
const FLARE_H = 40;               // and over how much height

// Optical balance: every stroke's outer edge lands 86 px from a canvas edge, so
// the mark sits centred rather than geometrically centred inside an off-centre box.
const num = (n) => String(Math.round(n * 100) / 100);

// Primitives, shared by the SVG writer and the rasteriser. Segments are the
// thick white strokes; a corner arc is a segment endpoint too, so joins and caps
// come for free from the same coverage test.
function glyphPrims(scale = 1, dx = 0, dy = 0) {
  const P = (x, y) => [x * scale + dx, y * scale + dy];
  const segs = [];
  // the arrow: shaft, then two arms of the head
  segs.push([P(ARROW_X, ARROW_TOP), P(ARROW_X, CHEVRON_TIP - HALF)]);
  segs.push([P(ARROW_X - CHEVRON_HALF, CHEVRON_ARM_Y), P(ARROW_X, CHEVRON_TIP)]);
  segs.push([P(ARROW_X + CHEVRON_HALF, CHEVRON_ARM_Y), P(ARROW_X, CHEVRON_TIP)]);
  // the tray: a floor, two walls, and each wall flared outwards at the top so it
  // reads as something open that catches the drop rather than a "download" slot
  segs.push([P(TRAY_L - FLARE, TRAY_TOP - FLARE_H), P(TRAY_L, TRAY_TOP)]);
  segs.push([P(TRAY_R + FLARE, TRAY_TOP - FLARE_H), P(TRAY_R, TRAY_TOP)]);
  segs.push([P(TRAY_L, TRAY_TOP), P(TRAY_L, TRAY_FLOOR - CORNER)]);
  segs.push([P(TRAY_R, TRAY_TOP), P(TRAY_R, TRAY_FLOOR - CORNER)]);
  segs.push([P(TRAY_L + CORNER, TRAY_FLOOR), P(TRAY_R - CORNER, TRAY_FLOOR)]);
  for (const [cx, cy, from] of [[TRAY_L + CORNER, TRAY_FLOOR - CORNER, 180], [TRAY_R - CORNER, TRAY_FLOOR - CORNER, 0]]) {
    let prev = null;
    for (let i = 0; i <= 12; i++) {
      const ang = ((from + (from === 180 ? -90 : 90) * (i / 12)) * Math.PI) / 180;
      const pt = P(cx + CORNER * Math.cos(ang), cy + CORNER * Math.sin(ang));
      if (prev) segs.push([prev, pt]);
      prev = pt;
    }
  }
  return { segs, w: STROKE * scale / 2 };
}

// The same numbers as a path the browser can antialias for free. Quadratics are
// exact circular arcs here because each corner is a quarter turn.
function svgPaths() {
  const g = [];
  g.push(`M${num(ARROW_X)} ${num(ARROW_TOP)}V${num(CHEVRON_TIP - HALF)}`);
  g.push(`M${num(ARROW_X - CHEVRON_HALF)} ${num(CHEVRON_ARM_Y)}L${num(ARROW_X)} ${num(CHEVRON_TIP)}L${num(ARROW_X + CHEVRON_HALF)} ${num(CHEVRON_ARM_Y)}`);
  g.push([
    `M${num(TRAY_L - FLARE)} ${num(TRAY_TOP - FLARE_H)}L${num(TRAY_L)} ${num(TRAY_TOP)}`,
    `M${num(TRAY_R + FLARE)} ${num(TRAY_TOP - FLARE_H)}L${num(TRAY_R)} ${num(TRAY_TOP)}`,
    `M${num(TRAY_L)} ${num(TRAY_TOP)}`,
    `V${num(TRAY_FLOOR - CORNER)}`,
    `Q${num(TRAY_L)} ${num(TRAY_FLOOR)} ${num(TRAY_L + CORNER)} ${num(TRAY_FLOOR)}`,
    `H${num(TRAY_R - CORNER)}`,
    `Q${num(TRAY_R)} ${num(TRAY_FLOOR)} ${num(TRAY_R)} ${num(TRAY_FLOOR - CORNER)}`,
    `V${num(TRAY_TOP)}`
  ].join(''));
  return g;
}

function iconSvg(opts) {
  const o = opts || {};
  const field = o.fullBleed
    ? `<rect width="${S}" height="${S}" fill="url(#md-g)"/>`
    : `<rect width="${S}" height="${S}" rx="${FIELD_R}" fill="url(#md-g)"/>`;
  const paths = svgPaths().map((d) => `<path d="${d}"/>`).join('\n      ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-labelledby="md-t md-d">
  <title id="md-t">MailDrop</title>
  <desc id="md-d">A white arrow dropping into an open tray, on a sky-blue rounded square. Generated from tools/make-icons.mjs — do not hand-edit.</desc>
  <defs>
    <linearGradient id="md-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TOP}"/>
      <stop offset="1" stop-color="${BOTTOM}"/>
    </linearGradient>
  </defs>
  ${field}
  <g fill="none" stroke="#FFFFFF" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">
      ${paths}
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- rasterising
// Each sample point answers one question — is it in the field, is it on a stroke —
// and the 4x4 grid per pixel becomes the coverage. Nothing here is an
// approximation of a renderer; it is the same geometry as the SVG, tested with
// signed distances.
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
const RGB_TOP = hex(TOP), RGB_BOT = hex(BOTTOM);

function distToSeg(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const len = vx * vx + vy * vy;
  let t = len ? (wx * vx + wy * vy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dy = wy - vy * t;
  return Math.hypot(dx, dy);
}

function render(size, opts) {
  const o = opts || {};
  const scale = size / S;
  // maskable icons get the glyph pulled into Android's safe zone (~66% of the
  // canvas) and a field that fills the tile, since the launcher crops it anyway
  const gscale = o.maskable ? 0.72 : 1;
  const off = (S * (1 - gscale)) / 2;
  const prim = glyphPrims(gscale, o.maskable ? off : 0, o.maskable ? off : 0);
  const segs = prim.segs.map((s) => [[s[0][0] * scale, s[0][1] * scale], [s[1][0] * scale, s[1][1] * scale]]);
  const w = prim.w * scale;
  const rr = (o.fullBleed ? 0 : FIELD_R) * scale;
  const cx0 = rr, cy0 = rr, cx1 = size - rr, cy1 = size - rr;
  const SS = 4, inv = 1 / SS;
  const data = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, bl = 0, al = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) * inv;
          const py = y + (sy + 0.5) * inv;
          const qxx = px < cx0 ? px - cx0 : px > cx1 ? px - cx1 : 0;
          const qyy = py < cy0 ? py - cy0 : py > cy1 ? py - cy1 : 0;
          if (rr > 0 && Math.hypot(qxx, qyy) > rr) continue;
          const tc = py / size;
          let cr = RGB_TOP[0] + (RGB_BOT[0] - RGB_TOP[0]) * tc;
          let cg = RGB_TOP[1] + (RGB_BOT[1] - RGB_TOP[1]) * tc;
          let cb = RGB_TOP[2] + (RGB_BOT[2] - RGB_TOP[2]) * tc;
          for (let i = 0; i < segs.length; i++) {
            const A = segs[i][0], B = segs[i][1];
            const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
            const ex = Math.abs(A[0] - B[0]) / 2 + w, ey = Math.abs(A[1] - B[1]) / 2 + w;
            if (Math.abs(px - mx) > ex || Math.abs(py - my) > ey) continue;
            if (distToSeg(px, py, A, B) <= w) { cr = 255; cg = 255; cb = 255; break; }
          }
          r += cr; g += cg; bl += cb; al += 255;
        }
      }
      const n = SS * SS, i0 = (y * size + x) * 4;
      if (al === 0) { data[i0] = data[i0 + 1] = data[i0 + 2] = data[i0 + 3] = 0; }
      else {
        // unpremultiply so the average is over colour, not over colour x alpha
        // al is 255 per covered sample, so 255 * sum / al is the mean colour
        data[i0] = Math.round(255 * r / al);
        data[i0 + 1] = Math.round(255 * g / al); data[i0 + 2] = Math.round(255 * bl / al);
        data[i0 + 3] = Math.round(al / n);
      }
    }
  }
  return { size, data };
}

// area-average a big render down to the target size — box filters beat point
// sampling for a 16 px favicon by a wide margin
function downsample(src, size) {
  const n = src.size, ratio = n / size, out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * ratio), x1 = Math.min(n, Math.ceil((x + 1) * ratio));
      const y0 = Math.floor(y * ratio), y1 = Math.min(n, Math.ceil((y + 1) * ratio));
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i0 = (sy * n + sx) * 4, al = src.data[i0 + 3];
          r += src.data[i0] * al; g += src.data[i0 + 1] * al; b += src.data[i0 + 2] * al; a += al; cnt++;
        }
      }
      const i1 = (y * size + x) * 4;
      if (a === 0) { out[i1] = out[i1 + 1] = out[i1 + 2] = out[i1 + 3] = 0; }
      else {
        out[i1] = Math.round(r / a); out[i1 + 1] = Math.round(g / a);
        out[i1 + 2] = Math.round(b / a); out[i1 + 3] = Math.round(a / cnt);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- a tiny PNG
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- emit
// The manifest goes at the site root, next to index.html, so its './' start_url
// and its assets/icon-*.png paths both mean what they say.
const manifest = {
  name: 'MailDrop — big files by email link',
  short_name: 'MailDrop',
  description: 'Pack any file into an email-safe download link. Static page, no backend, nothing to install.',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: '#070b14',
  theme_color: BOTTOM,
  icons: [
    { src: 'assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};

function manifestText() { return JSON.stringify(manifest, null, 2) + '\n'; }

// Everything the repo ships, derived from the numbers above. The three renders are
// the expensive part, so they happen here rather than at import time: the test
// suite only wants the text files and must not pay 7 seconds for a raster.
function jobs() {
  const master = render(1024, {});                    // one big render, then box-downsample
  const flat = render(768, { fullBleed: true });       // iOS wants an opaque tile, not a cutout
  const mask = render(768, { fullBleed: true, maskable: true });
  return [
    ['assets/icon.svg', Buffer.from(iconSvg(), 'utf8')],
    ['assets/icon-16.png', png(16, downsample(master, 16))],
    ['assets/icon-32.png', png(32, downsample(master, 32))],
    ['assets/icon-192.png', png(192, downsample(master, 192))],
    ['assets/icon-512.png', png(512, downsample(master, 512))],
    ['assets/icon-maskable-512.png', png(512, downsample(mask, 512))],
    ['assets/apple-touch-icon.png', png(180, downsample(flat, 180))],
    ['manifest.webmanifest', Buffer.from(manifestText(), 'utf8')]
  ];
}

function run() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  let stale = 0;
  for (const [rel, buf] of jobs()) {
    const p = path.join(ROOT, rel);
    const before = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (before && before.equals(buf)) { console.log('  ok      ' + rel + '  (' + buf.length + ' bytes)'); continue; }
    stale++;
    if (CHECK) { console.log('  STALE   ' + rel); continue; }
    fs.writeFileSync(p, buf);
    console.log('  wrote   ' + rel + '  (' + buf.length + ' bytes)');
  }
  if (CHECK && stale) {
    console.log('');
    console.error(stale + ' shipped file(s) do not match the geometry in tools/make-icons.mjs.');
    console.error('Regenerate them with:  node tools/make-icons.mjs');
    process.exit(1);
  }
  if (!CHECK) console.log('\nevery size regenerated from one set of numbers.');
}

// Exported so a test can compare the checked-in files against the geometry without
// rasterising anything. run() only when this file is the program being executed.
export { iconSvg, manifestText, svgPaths, glyphPrims, GEOMETRY };

const GEOMETRY = { S, FIELD_R, TOP, BOTTOM, STROKE, ARROW_TOP, CHEVRON_TIP, CHEVRON_ARM_Y,
  CHEVRON_HALF, TRAY_L, TRAY_R, TRAY_TOP, TRAY_FLOOR, CORNER, FLARE, FLARE_H };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
