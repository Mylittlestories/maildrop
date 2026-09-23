/* Live check: does the real public host still work, from this network, with the
   exact code the page uses?

     node tools/live-check.mjs [sizeMB] [--cors-only] [--backend litterbox]

   Four things have to be true for a browser page to move a big file, and hosts
   fail them in different ways, so this reports each one separately:

     1. the upload endpoint answers a cross-origin request  (ACAO on POST)
     2. the stored object is served back to a cross-origin reader (ACAO on GET)
     3. it honours Range requests            (accept-ranges / a 206 reply)
     4. the bytes that come back are the bytes that went in (SHA-256)

   Nothing sensitive leaves the machine: the payload is random bytes that expire
   on their own, and --cors-only does not upload anything at all. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const corsOnly = argv.includes('--cors-only');
const sizeMB = Number(argv.find((a) => /^[0-9.]+$/.test(a)) || 3);
const backendKey = flag('--backend') || 'litterbox';
const baseOverride = flag('--base');          // point a host with a mutable base (mockhost) somewhere else
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const ORIGIN = 'https://pages.example.invalid';

const FILES = ['util.js', 'config.js', 'manifest.js', 'crypto.js', 'pack.js', 'backends.js', 'receive.js', 'email.js'];

/* XMLHttpRequest does not exist in Node; give the shipping code a fetch-backed
   one, which is what tests/xhr-shim.js does for the offline suites. */
function makeXhr() {
  return function XMLHttpRequest() {
    const self = this;
    self.upload = {};
    self.status = 0; self.responseText = '';
    let method = 'GET', url = '', headers = {};
    self.open = (m, u) => { method = m; url = u; };
    self.setRequestHeader = (k, v) => { headers[k] = v; };
    self.abort = () => { self._aborted = true; };
    self.send = async (b) => {
      let buf = Buffer.alloc(0);
      if (b && typeof b.arrayBuffer === 'function') buf = Buffer.from(await b.arrayBuffer());
      else if (b) buf = Buffer.from(String(b));
      if (b && b.type) headers['Content-Type'] = b.type;
      try {
        const res = await fetch(url, { method, headers, body: buf.length ? buf : undefined });
        self.status = res.status;
        self.responseText = await res.text();
        if (!res.ok && res.status < 500) { const e = new Error('HTTP ' + res.status); e.httpStatus = res.status; throw e; }
        self.onload && self.onload();
      } catch (e) {
        if (e && e.httpStatus) { self.status = e.httpStatus; self.onload && self.onload(); return; }
        self.status = 0; self._error = e;
        self.onerror && self.onerror();
      }
    };
  };
}

const sb = {
  crypto: globalThis.crypto, TextEncoder, TextDecoder, Blob, File, URL, fetch, AbortController,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  XMLHttpRequest: makeXhr(), setTimeout, clearTimeout, console, process,
  location: { href: ORIGIN + '/maildrop/index.html', hash: '', hostname: 'pages.example.invalid' }
};
sb.globalThis = sb; sb.window = sb;
const ctx = vm.createContext(sb);
for (const f of FILES) new vm.Script(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), { filename: f }).runInContext(ctx);
const MD = sb.MD;

const t0 = Date.now();
const step = (m) => console.log('  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's  ' + m);
const hdr = (res, k) => res.headers.get(k) || '(absent)';
let ok = true;
const bad = (m) => { ok = false; step('\u2717 ' + m); };
const good = (m) => step('\u2713 ' + m);

async function probeDownloadCors(url, size) {
  step('2/3  reading it back with an Origin of ' + ORIGIN);
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': UA }, duplex: 'half' });
    step('     HTTP ' + res.status + ' · content-length ' + hdr(res, 'content-length') +
      ' · accept-ranges ' + hdr(res, 'accept-ranges') + ' · ACAO ' + hdr(res, 'access-control-allow-origin'));
    if (res.status !== 200 && res.status !== 206) { res.body && res.body.cancel && res.body.cancel(); bad('the host answered ' + res.status + ' to a plain GET'); return; }
    const acao = res.headers.get('access-control-allow-origin');
    if (!acao) bad('no Access-Control-Allow-Origin — a page on another origin cannot read this');
    else good('cross-origin read allowed (' + acao + ')');
    const text0 = acao ? null : await res.text().catch(() => '');
    if (text0 && /<html|<!doctype/i.test(text0.slice(0, 400))) {
      bad('the URL serves an HTML page, not the file. This host only gives files to a human click — use “A link I already have”, not an upload backend.');
      return;
    }
    res.body && res.body.cancel && res.body.cancel();
  } catch (e) { bad('GET failed: ' + e.message); return; }
  try {
    const r2 = await fetch(url, { headers: { Range: 'bytes=0-1023', Origin: ORIGIN, 'User-Agent': UA } });
    if (r2.status === 206 && (await r2.arrayBuffer()).byteLength === 1024) good('Range requests work (206, 1024 bytes) — parts can resume');
    else bad('Range request returned ' + r2.status + ' — resuming a dropped part will re-upload the whole thing');
  } catch (e) { bad('Range request failed: ' + e.message); }
}

console.log('\nMailDrop live check · ' + sizeMB + ' MiB of random bytes · provider: ' + backendKey + (corsOnly ? ' · CORS only, nothing uploaded' : '') + '\n');

const backend = MD.backends.get(backendKey);
if (!backend) { console.log('no such provider: ' + backendKey); process.exit(2); }

if (baseOverride) {
  if (backend.base === undefined) { console.log(backend.key + ' has no adjustable base URL'); process.exit(2); }
  backend.base = /\/$/.test(baseOverride) ? baseOverride : baseOverride + '/';
  step('target   ' + backend.base + '  (offline mock host, no internet involved)');
}

if (backend.key === 'litterbox') {
  step('1    OPTIONS on the upload endpoint');
  try {
    const o = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
      method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'User-Agent': UA }
    });
    step('     HTTP ' + o.status + ' · ACAO ' + hdr(o, 'access-control-allow-origin') + ' · allow-methods ' + hdr(o, 'access-control-allow-methods'));
    // A refused preflight is not a verdict on this page: a multipart POST with no
    // custom headers is a *simple* request and is never preflighted, so the only
    // thing that answers the question is the upload two lines below. Note it; do not
    // fail on it, or the tool cries wolf on every host that does not implement OPTIONS
    // (405 here, and the transfer works).
    if (o.status >= 400) step('     ! preflight answered ' + o.status + ' — irrelevant to us: a plain multipart POST is not preflighted');
  } catch (e) { bad('OPTIONS failed: ' + e.message); }
}

const tmp = path.join(ROOT, '.live-check-' + Date.now() + '.bin');
const buf = crypto.randomBytes(Math.round(sizeMB * 1024 * 1024));
fs.writeFileSync(tmp, buf);
const digest = crypto.createHash('sha256').update(buf).digest('hex');
const file = new File([fs.readFileSync(tmp)], 'live-check.bin', { type: 'application/octet-stream' });

let stored = null;
let storedBodySize = 0;
if (!corsOnly) {
  try {
    const fields = backend.fieldsFor ? backend.fieldsFor(backend.defaultExpiry) : {};
    const body = MD.backends.partBody(backend, file, fields, file.name, file.type);
    storedBodySize = body.size;
    if (MD.backends.wantsForm(backend)) {
      const b = /boundary=([^;]+)/.exec(body.type || '');
      if (!b) throw new Error('body has no boundary in its Content-Type');
      if (!b[1].replace(/^"|"$/g, '').toLowerCase().includes(MD.pack.BOUNDARY)) {
        throw new Error('the Blob type was rewritten by this Node build (' + body.type + ') — the boundary in the header must match the body');
      }
    }
    step('uploading ' + (body.size / 1048576).toFixed(1) + ' MiB to ' + backendKey + ' …');
    const res = await MD.backends.uploadPart(backend, body, { tries: 1 });
    stored = backend.buildUrl(res.id, res.base);
    good('1  stored → ' + stored);
  } catch (e) {
    bad('upload: ' + (e.message || e));
    step('   (403: the host is refusing this IP or user agent, and the same request from a home');
    step('    connection may pass. 412 with a body like "No file!" is different: the bytes');
    step('    arrived and the field carrying them was not named what the endpoint looks for.)');
  }
} else {
  step('1    skipped the upload (--cors-only)');
}

if (stored) {
  await probeDownloadCors(stored, file.size);
  step('4    fetching through MD.receive.fetchPart, exactly as the page does');
  try {
    const expect = MD.backends.wantsForm(backend) ? file.size : storedBodySize;
    const got = await MD.receive.fetchPart(stored, expect, () => { });
    const gotSha = crypto.createHash('sha256').update(got).digest('hex');
    if (got.byteLength === expect && gotSha === digest) good('bytes identical, ' + got.byteLength + ' bytes, sha256 ' + gotSha.slice(0, 16) + '\u2026');
    else bad('MISMATCH: ' + got.byteLength + ' bytes back with sha ' + gotSha.slice(0, 16) + '\u2026 where ' + expect + ' bytes with sha ' + digest.slice(0, 16) + '\u2026 went in' +
      (got.byteLength === expect ? ' — same length, so the host kept something else' : ' — the host kept a different amount'));
  } catch (e) { bad('re-download: ' + (e.message || e)); }
}

// What the manifest costs at the sizes people actually ask about, using the real
// part ceiling of the chosen provider — this is what decides whether a mail
// client or a spam filter chokes on the link.
const per = backend.maxPartBytes || 950 * 1024 * 1024;
console.log('\nlink length with this provider (' + ((per / 1048576) | 0) + ' MiB parts)');
for (const total of [1, 2, 5, 20]) {
  const z = total * 1024 * 1024 * 1024;
  const parts = MD.pack.planParts(z, per, 1024 * 1024);
  const m = {
    v: 1, n: 'film.mov', t: 'video/quicktime', z: z, p: backend.key,
    b: backend.key === 'litterbox' ? 'https://litter.catbox.moe/{id}' : 'https://bucket.example/{id}',
    d: 259200000, o: '', e: null, h: 'a'.repeat(64),
    parts: parts.map((p) => ({ i: 'abcd12ef.bin', s: p.size, h: '0123456789abcdef' }))
  };
  const len = ORIGIN.length + '/maildrop/index.html'.length + 1 + MD.manifest.encode(m).length;
  const verdict = len < 2000 ? '✓ fine for email' : len < 6200 ? '· long but allowed' : '\u2717 over the 6200-char budget';
  console.log('  ' + String(total).padStart(2) + ' GB → ' + String(parts.length).padStart(2) + ' part(s), ' + String(len).padStart(5) + ' chars  ' + verdict);
}

try { fs.unlinkSync(tmp); } catch (e) { }
console.log('\n' + (ok ? 'live check passed' : 'live check reported problems') + '\n');
process.exit(ok ? 0 : 2);
