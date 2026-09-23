#!/usr/bin/env node
/* Deployment check: is the *published* page the page we wrote, and does it work?

   The suites prove the source. A static host can still ship something else: a
   build step that mangled the markup, a lib file left out, a wrong MIME type, a
   Content-Security-Policy tight enough to block the page's own scripts. This
   fetches the URL you actually point recipients at and checks the bytes, then
   runs that live page in jsdom and sends and receives a file through it.

     node tools/deployed-check.mjs [https://you.github.io/maildrop/] [--no-send]

   Exits non-zero on any mismatch, which is what a CI job or a pre-announce
   sanity pass wants.
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(ROOT, 'package.json'));

const args = process.argv.slice(2);
const doSend = !args.includes('--no-send');
const URL_ = args.find((a) => /^https?:/.test(a)) || 'https://mylittlestories.github.io/maildrop/';

let JSDOM, ResourceLoader;
try {
  ({ JSDOM } = req('jsdom'));
} catch (e) {
  console.log('jsdom not installed — run `npm i` first (dev-only dependency).');
  process.exit(2);
}

function abs(href) { try { return new URL(href, URL_); } catch (e) { return null; } }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
const say = (...a) => console.log(...a);

(async () => {
  const base = abs('');
  if (!base) throw new Error('not a URL I can use: ' + URL_);
  const index = base.origin + base.pathname;

  say('=== the published page at ' + index + '\n');
  const res = await fetch(index, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error('the live page answered HTTP ' + res.status);
  const html = await res.text();

  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .filter((m) => m[1].trim().length);
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  if (srcs.length !== 10) throw new Error('expected ten scripts on the live page, found ' + srcs.length);
  if (inline.length) throw new Error('the live page carries executable inline script, which its own CSP forbids');
  if (!csp || !/script-src 'self'/.test(csp[1])) throw new Error("no script-src 'self' policy on the live page");
  say('markup: ten scripts, no inline script, CSP present ✓');

  // Every file the page names must be there, be a script, and be the bytes we
  // shipped. Byte identity is the point: a stale deploy is the failure mode a
  // static host has that no source-level test can see.
  const localIndex = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlDrift = sha(html) !== sha(localIndex);
  if (htmlDrift) {
    say('note: the live index.html differs from the working copy (' + html.length + ' vs ' +
      localIndex.length + ' bytes) — the host changed or added markup');
  }
  for (const s of srcs) {
    const u = abs(s);
    const r = await fetch(u.href, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(s + ' → HTTP ' + r.status + ' on the live host');
    const ct = r.headers.get('content-type') || '';
    if (!/javascript|ecmascript/.test(ct)) throw new Error(s + ' is served as "' + ct + '" — a browser will not run it');
    const body = await r.text();
    const mine = path.join(ROOT, s.replace(/^\.\//, ''));
    if (!fs.existsSync(mine)) throw new Error(s + ' is on the live host but not in the repo');
    if (sha(body) !== sha(fs.readFileSync(mine, 'utf8'))) {
      throw new Error(s + ' is NOT the file we shipped (live ' + sha(body) + ' vs local ' + sha(fs.readFileSync(mine, 'utf8')) + ')');
    }
  }
  say('files: all ten reachable, served as javascript, byte-identical to the repo ✓');

  // Now run it. The shims are the same ones the browser suite uses (jsdom has no
  // fetch-backed XHR and no WebCrypto on its window), so what executes here is the
  // live scripts against a real-ish browser surface. Errors the page reports are
  // collected, and a red console is a failed check.
  const { makeXhr } = req('./tests/xhr-shim.js');
  const problems = [];
  const dom = await JSDOM.fromURL(index, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (...a) => fetch(...a);
      win.XMLHttpRequest = makeXhr(win);
      try { Object.defineProperty(win, 'crypto', { value: crypto.webcrypto, configurable: true }); } catch (e) { }
      win.Blob = Blob; win.File = File; win.AbortController = AbortController;
      win.URL.createObjectURL = function () { return 'blob:fake'; };
      win.URL.revokeObjectURL = function () { };
      win.confirm = function () { return true; };
      win.prompt = function () { return null; };
      try { Object.defineProperty(win, 'isSecureContext', { value: true, configurable: true }); } catch (e) { }
      win.addEventListener('error', (ev) => problems.push('window error: ' + (ev.message || ev.error)));
      const orig = win.console.error;
      win.console.error = (...a) => { problems.push('console.error: ' + a.join(' ').slice(0, 200)); orig.apply(win.console, a); };
    }
  });
  await new Promise((r) => (dom.window.document.readyState === 'complete' ? r() : dom.window.addEventListener('load', r)));
  await new Promise((r) => setTimeout(r, 600));
  const win = dom.window;
  const MD = win.MD;

  if (!MD) throw new Error('window.MD never appeared — the scripts did not execute on the live host');
  for (const k of ['util', 'manifest', 'crypto', 'pack', 'backends', 'receive', 'email', 'app']) {
    if (!MD[k]) throw new Error('MD.' + k + ' missing on the live page');
  }
  if (!win.UI || typeof win.UI.init !== 'function') throw new Error('the view layer did not load');
  say('boot: eight modules plus the view layer built from the live URLs ✓');
  say('      providers offered to a visitor: ' + MD.backends.list.map((b) => b.key).join(', '));

  for (const id of ['drop', 'fileInput', 'btnStart', 'backendSel', 'pasteBox', 'panel-receive']) {
    if (!win.document.getElementById(id)) throw new Error('the live page has no #' + id);
  }
  if (!win.document.getElementById('drop').querySelector('label, button, input')) {
    throw new Error('the drop zone is not clickable');
  }
  say('wiring: both entry points present and interactive ✓');

  if (doSend) {
    // A real job through the shipped bytes: the file goes out as two parts, the
    // manifest comes back off the URL fragment, and the reassembled bytes are
    // compared against the source. Uses the test host for storage, so it proves
    // the page, not somebody else's uptime.
    const { startMock } = req('./tests/harness.js');
    const mock = await startMock(ROOT);
    try {
      const buf = Buffer.alloc(3 * 1024 * 1024, 7);
      const backend = MD.backends.get('mockhost');
      if (!backend) throw new Error('the live page does not expose the test backend');
      backend.base = mock.base;
      win.document.getElementById('backendSel').value = 'mockhost';
      MD.app.state.files = [new win.File([buf], 'deployed-check.bin', { type: 'application/octet-stream' })];
      MD.app.state.cfg.backend = 'mockhost';
      MD.app.state.cfg.partCapBytes = '2MB';
      MD.app.state.cfg.receiveBase = index;
      win.UI.renderFiles();
      await MD.app.runSend();
      const m = MD.app.state.lastManifest;
      if (!m || !m.parts || m.parts.length < 2) throw new Error('the live page did not split the job into parts');
      // read the link out of the card the recipient would copy, not out of memory
      const card = win.document.getElementById('linkCard');
      if (card.hidden) throw new Error('the live page finished an upload and never showed the link card');
      const link = win.document.getElementById('linkText').value;
      if (!link || link.length < 40) throw new Error('#linkText is empty on the live page');
      const urls = m.parts.map((p) => mock.base + 'f/' + p.i);
      const fresh = MD.manifest.findManifest(link);   // as a recipient's paste would be
      const res2 = await MD.receive.assemble(fresh, { urls });
      const got = res2.blob ? Buffer.from(await res2.blob.arrayBuffer()) : Buffer.from(res2.bytes);
      if (!got.equals(buf)) throw new Error('the live page round-tripped different bytes');
      say('round trip: ' + m.parts.length + ' parts, link ' + link.length + ' chars, ' +
        got.length + ' bytes back identical ✓');
    } finally {
      mock.kill();
    }
  } else {
    say('round trip: skipped (--no-send)');
  }

  win.close();
  const blocking = problems.filter((p) => !/favicon|Failed to load resource/i.test(p));
  if (blocking.length) throw new Error('the live page reported errors:\n  ' + blocking.join('\n  '));
  say('\n✓ ' + index + ' is the shipped page, and it works.\n');
})().catch((e) => { say('\n✗ ' + (e && e.message ? e.message : e) + '\n'); process.exit(1); });
