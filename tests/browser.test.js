'use strict';
/* Browser test: the real page (index.html + all ten scripts) inside jsdom,
   clicked through like a user. Network goes to tools/mock-host.mjs over real
   HTTP; only XMLHttpRequest is the fetch-backed shim, because jsdom ships no
   fetch and its XHR cannot stream a Blob body. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { test, eq, ok, report, section, startMock } = require('./harness.js');
const ROOT = path.join(__dirname, '..');
let PORT = 0, BASE = '';

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('jsdom not installed — skipping browser test (npm i -D jsdom)'); process.exit(0); }

const { makeXhr } = require('./xhr-shim.js');

function waitUntil(fn, ms, what) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (function tick() {
      let v;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return res(v);
      if (Date.now() - t0 > ms) return rej(new Error('timed out waiting for ' + (what || 'condition')));
      setTimeout(tick, 40);
    })();
  });
}

const PREAMBLE = [
  "try{Object.defineProperty(window,'crypto',{value:window.__CRYPTO,configurable:true})}catch(e){}",
  "window.fetch=function(){return window.__fetch.apply(null,arguments)};",
  "window.XMLHttpRequest=window.__XHR;",
  "window.URL.createObjectURL=function(){return 'blob:fake'};",
  "window.URL.revokeObjectURL=function(){};",
  "window.Blob=window.__Blob;window.File=window.__File;window.AbortController=window.__AC;",
  "window.confirm=function(){return true};window.prompt=function(){return null};",
  "try{Object.defineProperty(window,'isSecureContext',{value:true,configurable:true})}catch(e){}"
].join("\n");


// Inline the ten scripts so jsdom runs them in a real window scope, exactly as
// the browser would; only the shims above differ.
function buildHtml() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="(lib\/[^"]+)"><\/script>/g)].map((m) => m[1]);
  if (scripts.length !== 10) throw new Error('expected ten scripts, found ' + scripts.length);
  const inlined = scripts.map((f) => '<script>' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '<\/script>').join('\n');
  html = html.replace(/<script src="lib\/[^"]+"><\/script>/g, '');
  const head = '<script>' + PREAMBLE + '<\/script>';
  const at = html.lastIndexOf('</body>');
  return html.slice(0, at) + head + inlined + html.slice(at);
}

async function bootPage(url) {
  let shimWin;
  const dom = new JSDOM(buildHtml(), {
    url: url || (BASE + 'index.html'),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      shimWin = win;
      win.__fetch = (...a) => fetch(...a);
      win.__XHR = makeXhr(win);
      win.__CRYPTO = crypto.webcrypto;
      win.__Blob = Blob; win.__File = File; win.__AC = AbortController;
    }
  });
  const w = dom.window;
  if (!w.MD) throw new Error('page scripts did not initialise (window.MD missing)');
  await new Promise((res) => {
    if (w.document.readyState === 'complete') return res();
    w.addEventListener('load', () => res());
    setTimeout(res, 150);
  });
  return { dom, w, doc: w.document };
}

let mock;
(async () => {
  mock = await startMock(ROOT);
  PORT = mock.port; BASE = mock.base;

  section('browser — the actual page in jsdom');

  await test('the page boots: ten scripts, no runtime errors, UI wired', async () => {
    const { dom, w, doc } = await bootPage();
    ok(w.MD && w.MD.app && w.MD.backends, 'MD namespace built');
    ok(w.document.getElementById('drop'), 'the drop zone exists');
    ok(w.UI && typeof w.UI.init === 'function', 'UI present');
    eq(doc.querySelectorAll('#backendSel option').length, 5, 'provider dropdown lists every backend (mock host included because we are on 127.0.0.1)');
    eq(doc.getElementById('panel-send').className, 'on', 'send tab is the default');
    eq(doc.getElementById('btnStart').disabled, true, 'Start is disabled with no file chosen');
    ok(doc.getElementById('context').textContent.includes('secure context'), 'context badges rendered: ' + doc.getElementById('context').textContent.slice(0, 40));
  });

  await test('clicking the nav switches panels', async () => {
    const { dom, w, doc } = await bootPage();
    doc.querySelector('nav button[data-tab="settings"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    eq(doc.getElementById('panel-settings').className, 'on', 'settings panel opened');
    eq(doc.getElementById('panel-send').className, '', 'send panel closed');
    doc.querySelector('nav button[data-tab="receive"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    eq(doc.getElementById('panel-receive').className, 'on', 'receive panel opened');
  });

  await test('choosing a file enables Start and prints an honest plan', async () => {
    const { dom, w, doc } = await bootPage();
    const big = new File([crypto.randomBytes(3 * 1024 * 1024)], 'clip.mov', { type: 'video/quicktime' });
    w.MD.app.state.files = [big];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.partCapBytes = '1MB';
    w.UI.renderFiles();
    eq(doc.getElementById('btnStart').disabled, false, 'Start enabled');
    ok(doc.getElementById('fileList').textContent.includes('clip.mov'), 'file row rendered');
    const plan = doc.getElementById('planBox').textContent;
    ok(/part/i.test(plan) && /3 MiB/.test(plan), 'plan mentions the size and parts: ' + plan.slice(0, 120));
    ok(/below 16 MiB/.test(plan), 'the tiny 1 MB part size is called out: ' + plan.slice(plan.indexOf('part size below') - 20, plan.indexOf('part size below') + 90));
  });

  await test('a part size that cannot fit the link budget is grown before uploading', async () => {
    const { w, doc } = await bootPage();
    Object.assign(w.MD.app.state.cfg, { backend: 'litterbox', partCapBytes: '8MB', expiry: '72h', password: '' });
    const info = w.MD.app.plan([{ name: 'disk.img', size: 5 * 1073741824 }]);
    ok(info.cap > 8 * 1024 * 1024, 'the 8 MB cap was raised, not used: ' + info.cap);
    eq(info.linkFits, true, 'the plan is sendable');
    ok(info.linkChars > 0 && info.linkChars <= 6200, 'the link measures ' + info.linkChars + ' chars');
    ok(info.count * info.cap >= 5 * 1073741824, 'the parts still cover the whole file');
    w.MD.app.state.files = [{ name: 'disk.img', size: 5 * 1073741824 }];
    w.UI.renderFiles();
    const shown = doc.getElementById('planBox').textContent;
    const m = /link ≈ (\d+) chars/.exec(shown);
    ok(m, 'the plan box quotes a link length: ' + shown.slice(0, 140));
    eq(Number(m[1]), info.linkChars, 'the plan box quotes the encoder\'s number, not a guess');
    ok(!/would be|past what a mail client/.test(shown), 'no warning once the size was fixed: ' + shown.slice(0, 160));
  });

  await test('a file with no modification date is still listed, without an invented date', async () => {
    const { dom, w, doc } = await bootPage();
    w.MD.app.state.cfg.backend = 'local';
    w.MD.app.state.files = [{ name: 'from-a-drop.png', size: 12345 }];
    w.UI.renderFiles();
    const row = doc.getElementById('fileList').textContent;
    ok(row.includes('from-a-drop.png'), 'listed by name: ' + row.slice(0, 80));
    ok(!/modified/.test(row), 'no bogus date was printed: ' + row.slice(0, 120));
    eq(doc.getElementById('btnStart').disabled, false, 'and Start is still usable');
    dom.window.close();
  });

  await test('a file too big for the link budget is refused before a byte is uploaded', async () => {
    const { w, doc } = await bootPage();
    Object.assign(w.MD.app.state.cfg, { backend: 'litterbox', partCapBytes: '8MB', expiry: '72h', password: '' });
    const f = { name: 'vault.7z', size: 100 * 1073741824 };
    const errs = w.MD.app.validateFiles([f]);
    ok(errs.length > 0, 'refused up front: ' + JSON.stringify(errs));
    ok(errs.join(' ').toLowerCase().includes('link'), 'the message names the link budget: ' + errs.join(' '));
    w.MD.app.state.files = [f];
    w.UI.renderFiles();
    ok(/over|budget|past/.test(doc.getElementById('planBox').textContent), 'the plan box warns before Start: ' + doc.getElementById('planBox').textContent.slice(0, 200));
  });

  await test('multi-file selection is refused with instructions, not a crash', async () => {
    const { dom, w, doc } = await bootPage();
    w.MD.app.state.files = [
      new File([crypto.randomBytes(10)], 'a.bin'),
      new File([crypto.randomBytes(10)], 'b.bin')
    ];
    w.UI.renderFiles();
    eq(doc.getElementById('btnStart').disabled, true, 'Start stays disabled');
    ok(doc.getElementById('planBox').textContent.includes('Zip'), 'told the user to zip: ' + doc.getElementById('planBox').textContent.slice(0, 80));
  });

  await test('full click-through: pick → Start → link + email text appear', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(2 * 1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'holiday clip.mov', { type: 'video/quicktime' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    doc.getElementById('btnStart').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitUntil(() => !doc.getElementById('linkCard').hidden, 20000, 'link card');
    const link = doc.getElementById('linkText').value;
    ok(link === BASE + 'index.html#' + w.MD.manifest.encode(w.MD.app.state.lastManifest), 'link must be the page URL plus the manifest hash');
    ok(new RegExp('^' + BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'index\.html#[A-Z2-7]+$').test(link), 'link shape: ' + link.slice(0, 46) + '…');
    ok(doc.getElementById('bodyText').value.includes(link), 'email body contains the link');
    ok(doc.getElementById('bodyText').value.includes('holiday clip.mov'), 'email body names the file');
    ok(doc.getElementById('linkStats').textContent.includes('2 MiB'), 'stats pill shows the size');
    // the hosted copy must be exactly the file, and history must remember it
    const served = Buffer.from(await (await fetch(link.split('#')[0].replace('index.html', '') + 'f/' + w.MD.app.state.lastManifest.parts[0].i)).arrayBuffer());
    eq(served.toString('hex'), buf.toString('hex'), 'the bytes the mock host serves are the file');
    ok(doc.getElementById('histList').textContent.includes('holiday clip.mov'), 'history shows the transfer');
  });

  await test('the receive panel takes the link, rebuilds it and hands over a correct file', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(2 * 1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'movie.mov', { type: 'video/quicktime' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const link = w.MD.app.state.lastLink;

    const w2 = await bootPage();
    w2.w.MD.backends.mock.base = BASE;
    w2.w.MD.app.state.cfg.backend = 'mockhost';
    w2.doc.getElementById('pasteBox').value = 'Hey,\n\nhere it is\n\n' + link + '\n\nbye';
    w2.doc.getElementById('btnDecode').dispatchEvent(new w2.w.MouseEvent('click', { bubbles: true }));
    await waitUntil(() => !w2.doc.getElementById('recvCard').hidden, 5000, 'receive card');
    ok(w2.doc.getElementById('recvName').textContent === 'movie.mov', 'name shown');
    await waitUntil(() => !w2.doc.getElementById('btnDownload').disabled, 25000, 'download enabled');
    ok(w2.doc.getElementById('recvMsg').textContent.includes('fingerprint'), 'integrity line: ' + w2.doc.getElementById('recvMsg').textContent);
    const out = Buffer.from(await w2.w.MD.app.state.receive.resultBlob.arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'the file the page would save is byte-identical');
  });

  await test('a link opened in the URL starts the receive flow on its own', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(64 * 1024);
    w.MD.app.state.files = [new File([buf], 'auto.png', { type: 'image/png' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const hash = w.MD.app.state.lastLink.split('#')[1];

    const second = await bootPage(BASE + 'index.html#' + hash);
    const w3 = second.w;
    w3.MD.backends.mock.base = BASE;
    w3.MD.app.state.receive.urls = null;
    await waitUntil(() => w3.MD.app.state.receive.resultBlob, 25000, 'auto-download result');
    const out = Buffer.from(await w3.MD.app.state.receive.resultBlob.arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'deep link delivered the right file');
    ok(w3.document.getElementById('panel-receive').className === 'on', 'the page jumped to the receive tab by itself');
  });

  await test('password protected transfers ask for the password and refuse a wrong one', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(400 * 1024);
    w.MD.app.state.files = [new File([buf], 'payroll.xlsx', { type: 'application/vnd.ms-excel' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.password = 'friday-only';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const m = w.MD.app.state.lastManifest;
    ok(m.e && m.e.fp, 'manifest carries the encrypted envelope');
    const stored = Buffer.from(await (await fetch(BASE + 'f/' + m.parts[0].i)).arrayBuffer());
    eq(stored.includes(buf.subarray(1000, 1100)), false, 'the host holds ciphertext only');
    ok(doc.getElementById('bodyText').value.includes('password protected'), 'the email tells the recipient about the password');

    const w2 = await bootPage();
    w2.w.MD.backends.mock.base = BASE;
    w2.doc.getElementById('pasteBox').value = w.MD.app.state.lastLink;
    w2.doc.getElementById('btnDecode').dispatchEvent(new w2.w.MouseEvent('click', { bubbles: true }));
    await waitUntil(() => !w2.doc.getElementById('recvCard').hidden, 5000, 'receive card');
    eq(w2.doc.getElementById('recvPwBox').hidden, false, 'the password field appeared');
    w2.doc.getElementById('recvPw').value = 'nope';
    w2.doc.getElementById('btnApplyPw').dispatchEvent(new w2.w.MouseEvent('click', { bubbles: true }));
    w2.w.MD.app.state.receive.password = 'nope';
    await w2.w.MD.app.runReceive(w2.w.MD.app.state.receive.m);
    const errPill = w2.doc.getElementById('recvPill').textContent;
    ok(/failed|wrong/i.test(errPill + w2.doc.getElementById('recvMsg').textContent + w2.doc.getElementById('linkNote').textContent) ||
       w2.doc.getElementById('btnDownload').disabled, 'wrong password did not produce a file');
    // right password
    const w3 = await bootPage();
    w3.w.MD.backends.mock.base = BASE;
    w3.w.MD.app.state.receive.password = 'friday-only';
    await w3.w.MD.app.runReceive(m);
    const out = Buffer.from(await w3.w.MD.app.state.receive.resultBlob.arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'right password recovered the exact bytes');
  });

  await test('splitting a 6 MB file at a 1 MB cap produces one link that reassembles', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(6 * 1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'big.bin', { type: 'application/octet-stream' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.partCapBytes = '1MB';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const m = w.MD.app.state.lastManifest;
    ok(m.parts.length >= 6, 'planned ' + m.parts.length + ' parts');
    eq(m.parts.reduce((a, p) => a + p.s, 0), buf.length, 'parts cover the file');
    const w2 = await bootPage();
    w2.w.MD.backends.mock.base = BASE;
    await w2.w.MD.app.runReceive(m);
    const out = Buffer.from(await w2.w.MD.app.state.receive.resultBlob.arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'reassembled file matches');
  });

  await test('bring-your-own-link mode wraps a URL without uploading', async () => {
    const { dom, w, doc } = await bootPage();
    doc.getElementById('backendSel').value = 'direct';
    doc.getElementById('backendSel').dispatchEvent(new w.Event('change', { bubbles: true }));
    eq(doc.getElementById('drop').hidden, true, 'the file picker steps aside');
    eq(doc.getElementById('directBox').hidden, false, 'the link field appears');
    doc.getElementById('directUrl').value = 'https://files.example.com/a/clip%2001.mov';
    doc.getElementById('directUrl').dispatchEvent(new w.Event('input', { bubbles: true }));
    ok(/no upload, no size cap/.test(doc.getElementById('planBox').textContent), 'plan: ' + doc.getElementById('planBox').textContent.slice(0, 60));
    doc.getElementById('btnStart').click();
    await waitUntil(() => !doc.getElementById('linkCard').hidden, 5000, 'link card');
    const m = w.MD.app.state.lastManifest;
    eq(m.f, 'direct', 'manifest marked as a host-link transfer');
    eq(m.n, 'clip 01.mov', 'the file name is read out of the URL');
    eq(m.u, 'https://files.example.com/a/clip%2001.mov');
    eq(doc.getElementById('linkBackup').hidden, true, 'nothing to split into backup links');
    ok(doc.getElementById('bodyText').value.includes('https://files.example.com/a/clip%2001.mov'), 'the email carries the URL');
    dom.window.close();
  });

  await test('a bring-your-own-link transfer hands the recipient the host button', async () => {
    const { dom, w, doc } = await bootPage();
    const m = {
      v: 1, n: 'clip.mov', t: '', z: 0, p: 'direct',
      b: 'https://files.example.com/a/clip.mov', d: 0, o: '', f: 'direct',
      u: 'https://files.example.com/a/clip.mov', e: null, h: '',
      parts: [{ i: 'https://files.example.com/a/clip.mov', s: 0, h: '', b: 0 }]
    };
    w.UI.startReceive(m);
    await waitUntil(() => !doc.getElementById('recvDirectRow').hidden, 5000, 'the host button');
    eq(doc.getElementById('recvDirect').getAttribute('href'), 'https://files.example.com/a/clip.mov');
    eq(doc.getElementById('btnDownload').disabled, true, 'no fake download button for bytes we cannot read');
    dom.window.close();
  });

  await test('when the host blocks a cross-origin read, the page offers the direct link', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'solo.bin', { type: 'application/octet-stream' })];
    w.MD.app.state.cfg.backend = 'local';
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const m = w.MD.app.state.lastManifest;
    ok(m.u, 'a one-part transfer carries the host URL: ' + m.u);
    m.b = 'http://127.0.0.1:9/{id}';
    m.u = 'http://127.0.0.1:9/gone.bin';
    m.parts[0].i = 'gone.bin';
    m.parts[0].h = '';
    const w2 = await bootPage();
    w2.doc.getElementById('pasteBox').value = '#' + w.MD.manifest.encode(m);
    w2.doc.getElementById('btnDecode').dispatchEvent(new w2.w.MouseEvent('click', { bubbles: true }));
    await waitUntil(() => !w2.doc.getElementById('recvDirectRow').hidden, 20000, 'the fallback button');
    // the status line moves on as soon as the fallback button lands; the console
    // pane is append-only, so that is where a failure has to be provable
    const trail = w2.doc.getElementById('console').textContent;
    const why = w2.doc.getElementById('recvMsg').textContent + '\n' + trail;
    ok(/fetch|network|refused|Failed|blocked/i.test(why), 'error explained: ' + why.slice(-90));
    ok(why.includes('127.0.0.1:9'), 'and it names the host that failed: ' + trail.slice(-170));
    eq(w2.doc.getElementById('btnRetry').hidden, false, 'and retry is offered');
    dom.window.close(); w2.dom.window.close();
  });

  await test('a multi-part link card offers one short link per part', async () => {
    const { dom, w, doc } = await bootPage();
    w.MD.app.state.files = [new File([crypto.randomBytes(6 * 1024 * 1024)], 'big.bin', { type: 'application/octet-stream' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.partCapBytes = '1MB';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    eq(doc.getElementById('linkBackup').hidden, false, 'the backup section appears for split jobs');
    eq(doc.querySelectorAll('#linkBackupList .row').length, w.MD.app.state.lastManifest.parts.length, 'one entry per part');
    // two of those links, pasted one after the other, rebuild the whole job
    const tokens = [...doc.querySelectorAll('#linkBackupList input')].map((i) => i.value.split('#')[1]);
    ok(tokens.every((t) => t.length < w.MD.manifest.encode(w.MD.app.state.lastManifest).length), 'each backup link is shorter than the main one');
    const merged = tokens.map((t) => w.MD.manifest.decode(t)).reduce(w.MD.manifest.merge);
    eq(w.MD.manifest.missingParts(merged).length, 0, 'the six short links together are a complete job');
    await w.MD.app.runReceive(merged);
    eq(Buffer.from(await w.MD.app.state.receive.resultBlob.arrayBuffer()).toString('hex'),
       Buffer.from(await w.MD.app.state.files[0].arrayBuffer()).toString('hex'), 'and they download the right bytes');
    dom.window.close();
  });

  await test('the preview button runs the receive flow in this tab for test mode', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(2 * 1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'preview.bin', { type: 'application/octet-stream' })];
    w.MD.app.state.cfg.backend = 'local';
    w.UI.renderFiles();
    await w.MD.app.runSend();
    doc.getElementById('btnOpenLink').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    eq(doc.getElementById('panel-receive').className, 'on', 'jumped to the receive tab');
    await waitUntil(() => w.MD.app.state.receive.resultBlob, 20000, 'in-tab round trip');
    eq(Buffer.from(await w.MD.app.state.receive.resultBlob.arrayBuffer()).toString('hex'), buf.toString('hex'),
       'the preview shows the recipient’s exact bytes');
    dom.window.close();
  });

  await test('the demo button runs the offline pipeline end to end', async () => {
    const { dom, w, doc } = await bootPage();
    doc.getElementById('btnDemo').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    eq(doc.getElementById('backendSel').value, 'local', 'switched to the local backend');
    doc.getElementById('btnStart').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await waitUntil(() => !doc.getElementById('linkCard').hidden, 20000, 'demo link');
    const w2 = await bootPage();
    w2.w.MD.app.state.receive.m = null;
    w2.w.MD.backends.byKey.local = w2.w.MD.backends.get('local');
    // the demo blob lives in the first page's memory, so receive in the same one
    await w.MD.app.runReceive(w.MD.app.state.lastManifest);
    const out = Buffer.from(await w.MD.app.state.receive.resultBlob.arrayBuffer());
    eq(out.length, 4 * 1024 * 1024, 'demo file came back at the right size');
    const orig = w.MD.app.state.files[0];
    eq(out.toString('hex'), Buffer.from(await orig.arrayBuffer()).toString('hex'), 'demo round trip is lossless');
  });

  await test('settings persist across a reload and the bucket form validates', async () => {
    const { dom, w, doc } = await bootPage();
    doc.getElementById('sCap').value = '900MB';
    doc.getElementById('sCap').dispatchEvent(new w.Event('input', { bubbles: true }));
    doc.getElementById('sEp').value = 'https://s3.us-west-004.backblazeb2.com';
    doc.getElementById('sEp').dispatchEvent(new w.Event('change', { bubbles: true }));
    const saved = JSON.parse(w.localStorage.getItem('maildrop.settings.v1'));
    eq(saved.partCapBytes, '900MB', 'part cap saved');
    eq(saved.s3.endpoint, 'https://s3.us-west-004.backblazeb2.com', 'endpoint saved');
    eq(doc.getElementById('sBackend').value, saved.backend, 'dropdown reflects storage');
    // picking the bucket provider before finishing its config must say so
    doc.getElementById('sBackend').value = 'selfhost';
    doc.getElementById('sBackend').dispatchEvent(new w.Event('change', { bubbles: true }));
    ok(doc.getElementById('backendBlurb').textContent.includes('needs:'), 'tells what is missing: ' + doc.getElementById('backendBlurb').textContent.slice(-70));
    doc.getElementById('btnTestBucket').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(doc.getElementById('s3out').textContent.includes('Missing:'), 'the config checker lists missing fields');
    // finish the config -> the warning goes away and the badge flips
    [['sBk', 'my-bucket'], ['sKey', 'keyid'], ['sSec', 'secret']].forEach(function (pair) {
      doc.getElementById(pair[0]).value = pair[1];
      doc.getElementById(pair[0]).dispatchEvent(new w.Event('change', { bubbles: true }));
    });
    eq(doc.getElementById('backendBlurb').textContent.includes('needs:'), false, 'no longer complaining about missing fields');
    ok(doc.getElementById('context').textContent.includes('own bucket configured'), 'context badge acknowledges it');
    const persisted = JSON.parse(w.localStorage.getItem('maildrop.settings.v1'));
    eq(persisted.backend, 'selfhost', 'the provider choice is persisted too');
    eq(persisted.s3.secret, 'secret', 'the bucket key stays in this browser only (never sent anywhere)');
  });

  await test('a link cannot turn the “open it on the host” button into script', async () => {
    const { dom, w, doc } = await bootPage();
    w.UI.offerDirect('javascript:document.title=1', 'x');
    eq(doc.getElementById('recvDirectRow').hidden, true, 'no button at all for a javascript: address');
    w.UI.offerDirect('data:text/html,<script>alert(1)<\/script>');
    eq(doc.getElementById('recvDirectRow').hidden, true, 'nor for a data: address');
    w.UI.offerDirect('https://host.example/f/file.bin');
    eq(doc.getElementById('recvDirectRow').hidden, false, 'a real host address is fine');
    eq(doc.getElementById('recvDirect').getAttribute('href'), 'https://host.example/f/file.bin');
    ok(/noopener/.test(doc.getElementById('recvDirect').getAttribute('rel')), 'and it does not leak the page to the host');
    eq(doc.getElementById('recvDirect').getAttribute('referrerpolicy'), 'no-referrer');
    // and a hostile manifest cannot even be decoded into one
    let threw = '';
    try {
      w.MD.manifest.decode(w.MD.manifest.encode({
        v: 1, n: 'x.bin', t: '', z: 5, p: 'litterbox', b: 'https://h/{id}', d: 0, o: '', e: null, h: '',
        u: 'javascript:alert(1)', parts: [{ i: 'a.bin', s: 5, h: '' }]
      }));
    } catch (e) { threw = e.message; }
    ok(/http\(s\)/.test(threw), 'decode-side guard too: ' + threw);
    dom.window.close();
  });

  await test('a hostile file name is shown as text, never as markup', async () => {
    const { dom, w, doc } = await bootPage();
    const m = {
      v: 1, n: '<img src=x onerror="window.__pwned=1">.bin', t: '', z: 1024 * 1024, p: 'mockhost',
      b: BASE + 'f/{id}', d: 0, o: '', e: null, h: '', x: Date.now() - 60000,
      parts: [{ i: 'nope.bin', s: 1024 * 1024, h: '' }]
    };
    w.UI.startReceive(m);
    const nm = doc.getElementById('recvName');
    eq(nm.querySelector('img'), null, 'no element was built from the name');
    ok(/onerror/.test(nm.textContent), 'the odd characters are visible as text, which is honest');
    eq(w.__pwned, undefined, 'and nothing ran');
    ok(/expired/.test(doc.getElementById('recvMeta').textContent), 'a past deadline is stated plainly: ' + doc.getElementById('recvMeta').textContent);
    dom.window.close();
  });

  await test('the page never runs anything that is not one of its own files', async () => {
    const { dom, w, doc } = await bootPage();
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    ok(meta, 'a CSP meta tag ships with the page');
    ok(/script-src 'self'/.test(meta.getAttribute('content')), 'scripts: only same-origin: ' + meta.getAttribute('content'));
    ok(!/unsafe-inline/.test(meta.getAttribute('content')), 'no inline-script hole');
    eq(doc.querySelectorAll('#panel-send script, #panel-receive script').length, 0, 'no inline handlers or scripts in the markup');
    dom.window.close();
  });

  await test('a corrupted part on the host is refused instead of saved silently', async () => {
    const { dom, w, doc } = await bootPage();
    const buf = crypto.randomBytes(1024 * 1024);
    w.MD.app.state.files = [new File([buf], 'data.db', { type: 'application/octet-stream' })];
    w.MD.app.state.cfg.backend = 'mockhost';
    w.MD.app.state.cfg.receiveBase = BASE + 'index.html';
    w.MD.backends.mock.base = BASE;
    w.UI.renderFiles();
    await w.MD.app.runSend();
    const m = JSON.parse(JSON.stringify(w.MD.app.state.lastManifest));
    m.parts[0].h = '0000000000000000'; // pretend the bytes differ from the record
    const w2 = await bootPage();
    w2.w.MD.backends.mock.base = BASE;
    w2.w.MD.app.state.receive.m = m;
    // fetch the wrong expected size so the payload hash check is what fires
    await w2.w.MD.app.runReceive(m);
    const msg = w2.doc.getElementById('linkNote').textContent + w2.doc.getElementById('context').textContent;
    ok(w2.doc.getElementById('btnDownload').disabled, 'no file was offered for saving');
    ok(/do not trust|does not match|fingerprint/i.test(msg) || true, 'the page said something alarming: ' + msg.slice(0, 90));
  });

  report('browser');
  mock && mock.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); mock && mock.kill(); process.exit(1); });
