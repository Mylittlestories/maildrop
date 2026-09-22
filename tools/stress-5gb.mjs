/* Five gigabytes, end to end, on a 1 GB machine.
   ===========================================================================
     node tools/stress-5gb.mjs [--gb 5] [--part 96] [--password phrase] [--keep]

   This is not a simulation: the real page (index.html + the ten scripts) is
   booted in jsdom, the real provider code uploads to tools/mock-host.mjs over
   real HTTP with real multipart framing, the real receive path streams back in
   16 MiB windows and writes to a real file, and the digests are compared
   afterwards with an independent hasher. The only substitution is the File
   object: a 5 GiB `new File([buffer])` would need 5 GiB of RAM, so the file the
   "user" picks is a disk-backed object exposing exactly the members the app
   uses (size, name, type, lastModified, slice(), stream()).

   It exists because RAM, not the network, is what kills a big transfer in a
   browser, and that is invisible to every test that uses a 4 MiB sample.

     --send-only      stop after the upload and write .stress/link.txt
     --receive-only   only download, using .stress/link.txt (needs the same
                      host still running; --host <port> points at it)
     --host <port>    reuse a mock host that is already up
     --expose-gc is honoured if you launch with it: the sender's page is closed
     and collected before the receiver starts, so the two halves never share a
     peak — which is also how a real transfer behaves, on two different machines.
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const GB = Number(arg('--gb', 5));
const PART_MB = Number(arg('--part', 96));
const PW = arg('--password', '') || '';
const KEEP = process.argv.includes('--keep');
const SEND_ONLY = process.argv.includes('--send-only');
const RECV_ONLY = process.argv.includes('--receive-only');
const HOST_PORT = Number(arg('--host', 0));
const MB = 1024 * 1024;
const SIZE = Math.round(GB * 1024 * MB);
const WORK = path.join(ROOT, '.stress');
const SRC = path.join(WORK, `dummy-${GB}gb.bin`);
const DST = path.join(WORK, `received-${GB}gb.bin`);
const LINK_FILE = path.join(WORK, 'link.txt');
fs.mkdirSync(WORK, { recursive: true });

const req = createRequire(path.join(ROOT, 'package.json'));
let JSDOM, makeXhr;
try {
  ({ JSDOM } = req('jsdom'));
  ({ makeXhr } = req(path.join(ROOT, 'tests/xhr-shim.js')));
} catch (e) {
  console.error('needs jsdom: npm install   (' + e.message.split('\n')[0] + ')');
  process.exit(2);
}

const log = (m) => console.log('  ' + ((Date.now() - T0) / 1000).toFixed(1) + 's  ' + m);
const rss = () => (process.memoryUsage().rss / MB).toFixed(0) + ' MB';
let T0 = Date.now();
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 120);

// ---- 1. the dummy file -----------------------------------------------------
function makeDummy() {
  const st = fs.existsSync(SRC) ? fs.statSync(SRC) : null;
  if (st && st.size === SIZE) { log('reusing ' + path.basename(SRC) + ' (already ' + GB + ' GiB)'); return; }
  log('writing a ' + GB + ' GiB dummy file (a repeating random block, so it is not all zeros) …');
  const block = crypto.randomBytes(MB);
  const fd = fs.openSync(SRC, 'w');
  let n = 0;
  while (n < SIZE) n += fs.writeSync(fd, block, 0, Math.min(block.length, SIZE - n));
  fs.closeSync(fd);
}
makeDummy();

// the hash the app's own digests are judged against, computed independently
async function sha256OfFile(p) {
  const h = crypto.createHash('sha256');
  await new Promise((res, rej) => {
    fs.createReadStream(p, { highWaterMark: 8 * MB })
      .on('data', (d) => h.update(d)).on('end', res).on('error', rej);
  });
  return h.digest('hex');
}
log('hashing the source …');
const SRC_SHA = await sha256OfFile(SRC);

// ---- 2. a file that lives on disk but looks like a browser File ------------
class DiskFile {
  constructor(p, name, type) { this.path = p; this.name = name; this.type = type; this.size = fs.statSync(p).size; this.lastModified = Date.now(); }
  slice(start, end) {
    const len = Math.min(this.size, end) - start;
    const buf = Buffer.allocUnsafe(len);
    const fd = fs.openSync(this.path, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    return new Blob([buf], { type: this.type });
  }
  stream() { return Readable.toWeb(fs.createReadStream(this.path, { highWaterMark: 8 * MB })); }
  arrayBuffer() { throw new Error('the stress file refuses to be loaded whole — that is the point of this test'); }
}

// ---- 3. the mock host, storing on disk so it can hold 5 GiB too ------------
let host = null, PORT = HOST_PORT;
if (!PORT) {
  fs.rmSync(path.join(WORK, 'host'), { recursive: true, force: true });
  host = spawn(process.execPath, [path.join(ROOT, 'tools/mock-host.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', MOCK_DIR: path.join(WORK, 'host') }
  });
  let out = '';
  PORT = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('mock host did not start: ' + out)), 8000);
    host.stdout.on('data', (d) => { out += d; const m = /MOCKPORT=(\d+)/.exec(out); if (m) { clearTimeout(to); res(Number(m[1])); } });
    host.on('exit', (c) => rej(new Error('mock host exited: ' + c + ' ' + out)));
  });
}
const BASE = 'http://127.0.0.1:' + PORT + '/';

// ---- 4/5. the sender: the real page, driven like a user clicks it ----------
// the real index.html with its ten scripts inlined, so jsdom executes exactly the
// code a browser would fetch (a replacer function, not a string: the libraries
// contain $' and $& and String.replace would splice text in where a literal was
// meant)
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="(lib\/[^"]+)"><\/script>/g)].map((m) => m[1]);
if (scripts.length !== 10) throw new Error('expected ten scripts, found ' + scripts.length);
html = html.replace(/<script src="lib\/[^"]+"><\/script>/g, () => '');
html = html.replace('</body>', () => scripts.map((f) =>
  '<script>' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '<\/script>').join('\n') + '</body>');


async function bootPage(url, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    url: url, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = (...a) => fetch(...a);
      win.XMLHttpRequest = makeXhr(win);
      Object.defineProperty(win, 'crypto', { value: crypto.webcrypto, configurable: true });
      win.Blob = Blob; win.File = File; win.AbortController = AbortController;
      // Node has Blob.stream() but not the pipeTo() the feature test looks for
      if (!Blob.prototype.pipeTo) {
        Blob.prototype.pipeTo = async function (w) { for await (const c of this.stream()) await w.write(c); };
      }
      win.URL.createObjectURL = () => 'blob:stress'; win.URL.revokeObjectURL = () => {};
      win.confirm = () => true; win.prompt = () => null;
      Object.defineProperty(win, 'isSecureContext', { value: true, configurable: true });
      if (opts.save) {
        win.showSaveFilePicker = async (o) => {
          fs.rmSync(DST, { force: true });
          const fd = fs.openSync(DST, 'w');
          let written = 0;
          log('the recipient chose: ' + o.suggestedName + ' → ' + path.basename(DST));
          return {
            name: o.suggestedName,
            createWritable: async () => ({
              write: async (blob) => { const b = Buffer.from(await blob.arrayBuffer()); written += fs.writeSync(fd, b); },
              close: async () => { fs.fsyncSync(fd); fs.closeSync(fd); log('closed the file at ' + (written / MB).toFixed(1) + ' MB'); },
              seek: async () => {}, truncate: async () => {}
            })
          };
        };
      }
    }
  });
  const win = dom.window, doc = win.document;
  await new Promise((r) => (doc.readyState === 'complete' ? r() : win.addEventListener('load', r, { once: true })));
  if (!win.MD || !win.MD.app) throw new Error('the page did not boot');
  win.MD.backends.get('mockhost').base = BASE;
  return { dom, win, doc };
}

let sender = null;
if (!RECV_ONLY) {
  sender = await bootPage(BASE);
  const win = sender.win, doc = sender.doc, MD = win.MD;
  MD.app.state.files = [new DiskFile(SRC, 'field-recording.mkv', 'video/x-matroska')];
  MD.app.state.cfg.backend = 'mockhost';
  MD.app.state.cfg.partCapBytes = PART_MB + 'MB';
  MD.app.state.cfg.receiveBase = BASE;
  MD.app.state.cfg.password = PW;
  win.UI.renderFiles();
  console.log('\nplan: ' + doc.getElementById('planBox').textContent.replace(/\s+/g, ' ').slice(0, 200));
  doc.getElementById('btnStart').click();
  log('start pressed; part size ' + PART_MB + ' MB' + (PW ? ', encrypted with a password' : ', plaintext'));

  // the memory curve: a flat line is the whole point of the design, and a rising
  // one is a leak — either way it should be visible, not inferred from an OOM
  const curve = setInterval(() => log('   sending… ' + rss() + ' rss · ' +
    doc.getElementById('progMsg').textContent.slice(0, 76)), 15000);

  const linkT0 = Date.now();
  while (doc.getElementById('linkCard').hidden) {
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - linkT0 > 1500000) throw new Error('send did not finish in 25 min: ' + doc.getElementById('progMsg').textContent);
  }
  clearInterval(curve);
  const m = MD.app.state.lastManifest;
  const link = doc.getElementById('linkText').value;
  const upSecs = (Date.now() - linkT0) / 1000;
  log('SENT. ' + m.parts.length + ' parts, link ' + link.length + ' chars, token ' + MD.manifest.encode(m).length +
    ' chars, ' + rss() + ' rss → ' + ((SIZE / MB / 1024) / upSecs).toFixed(2) + ' GiB/s');
  if (link.length > 6200) throw new Error('the link is ' + link.length + ' chars — too long for an email');
  fs.writeFileSync(LINK_FILE, link);

  if (SEND_ONLY) {
    console.log('\n  uploaded; the link is in ' + path.relative(ROOT, LINK_FILE));
    console.log('  download it in its own process with:  node tools/stress-5gb.mjs --gb ' + GB + ' --receive-only --host ' + PORT);
    clearInterval(sample);
    sender.dom.window.close();
    if (host) host.kill('SIGTERM');
    process.exit(0);
  }

  // hand the receive half the memory the sender had, the way two machines would
  sender.dom.window.close();
  sender = null;
  if (global.gc) { global.gc(); log('collected the sender page'); }
  else log('tip: run `node --expose-gc tools/stress-5gb.mjs` to release the sender page first');
}

// ---- 6. receive, from the link alone, in a fresh page ----------------------
const link = fs.readFileSync(LINK_FILE, 'utf8').trim();
log('recipient opens the link (' + link.length + ' chars)');
const recv = await bootPage(link, { save: true });
const { win: w2, doc: d2 } = recv;
const dlT0 = Date.now();
const done = () => /(saved|verified|matched|failed|Do not trust|not checked)/i.test((d2.getElementById('recvMsg').textContent || ''));
while (!done()) {
  await new Promise((r) => setTimeout(r, 1000));
  if (Date.now() - dlT0 > 1500000) throw new Error('receive stalled at ' + d2.getElementById('recvBar').style.width + ' — ' + d2.getElementById('recvMsg').textContent);
  if ((Date.now() - dlT0) % 15000 < 1100) log('   receiving… ' + rss() + ' rss · ' + d2.getElementById('progMsg').textContent.slice(0, 70));
}
const dlSecs = (Date.now() - dlT0) / 1000;
log('RECEIVED in ' + dlSecs.toFixed(1) + ' s · ' + ((SIZE / MB / 1024) / dlSecs).toFixed(2) + ' GiB/s · peak rss ' + (peak / MB).toFixed(0) + ' MB');
console.log('  the page says: ' + d2.getElementById('recvPill').textContent + ' — ' +
  d2.getElementById('recvMsg').textContent.replace(/\s+/g, ' ').slice(0, 200));

// ---- 7. independent verdict, from the file system rather than from the page --
const want = fs.statSync(SRC).size;
const got = fs.statSync(DST).size;
if (got !== want) { console.error('\n✗ the saved file is ' + got + ' bytes, the source is ' + want); }
log('sizes ' + (got === want ? 'match' : 'DIFFER') + '; hashing the saved file …');
const DST_SHA = await sha256OfFile(DST);
const same = got === want && DST_SHA === SRC_SHA;
console.log('\n  source  sha256 ' + SRC_SHA);
console.log('  saved   sha256 ' + DST_SHA);
console.log('  ' + (same ? '✓ byte-for-byte identical over ' + (want / 1048576).toFixed(0) + ' MiB through the real page' : '✗ THE FILE CHANGED'));
try {
  const hostInfo = await (await fetch(BASE + '__seen')).json();
  console.log('  host held ' + hostInfo.stored.length + ' objects, ' + (hostInfo.bytes / 1024 / MB).toFixed(2) + ' GiB, mode ' + hostInfo.mode +
    ', and this process peaked at ' + (peak / MB).toFixed(0) + ' MB rss');
} catch (e) { }

clearInterval(sample);
if (!KEEP) { fs.rmSync(WORK, { recursive: true, force: true }); console.log('  (cleaned up .stress; --keep to inspect)'); }
if (host) host.kill('SIGTERM');
try { w2.close(); } catch (e) { }
process.exit(same ? 0 : 1);
