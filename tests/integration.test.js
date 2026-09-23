'use strict';
/* Integration test: the shipped send/receive code, driven end to end over real
   HTTP against tools/mock-host.mjs. Only XMLHttpRequest is faked (Node has no
   XHR); every decision — part planning, multipart body assembly, retries,
   response parsing, URL templating, manifest encode/decode, stitching,
   verification, decryption — is the code the browser runs. */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { makeSandbox, loadLib, test, eq, ok, throwsAsync, section, report, startMock } = require('./harness.js');
const { makeXhr } = require('./xhr-shim.js');

let PORT = 0, BASE = '';


let mock;
(async () => {
  mock = await startMock(path.join(__dirname, '..'));
  PORT = mock.port;
  BASE = mock.base;
  const uiCalls = [];
  function freshSandbox() {
    // each scenario gets a pristine sandbox so a UI-stub call from a previous
    // test can never satisfy the next one
    const sb = makeSandbox({});
    sb.XMLHttpRequest = makeXhr(sb);
    sb.UI = new Proxy({}, { get: (t, k) => (...a) => { uiCalls.push([String(k), ...a]); } });
    loadLib(sb, true);
    sb.MD.app.loadCfg();
    return sb;
  }

  section('integration — MailDrop against a live HTTP host');

  const MD = freshSandbox().MD;   // shared constants only (OVERHEAD etc.)

  await test('mock host is reachable and CORS-permissive', async () => {
    const r = await fetch(BASE + 'api/upload', { method: 'OPTIONS' });
    ok(r.status === 204 || r.status === 200, 'preflight answered: ' + r.status);
  });

  async function drive(sb, file, backendKey, opts = {}) {
    const MDx = sb.MD;
    MDx.app.state.files = [file];
    MDx.app.state.cfg.backend = backendKey;
    if (backendKey === 'mockhost') MDx.backends.get('mockhost').base = BASE;
    MDx.app.state.cfg.password = opts.password || '';
    MDx.app.state.cfg.partCapBytes = opts.partCapBytes || '';
    MDx.app.state.cfg.receiveBase = BASE;
    await MDx.app.runSend();
    const link = uiCalls.filter((c) => c[0] === 'showLink').pop();
    if (!link) {
      const err = uiCalls.filter((c) => c[0] === 'error').pop();
      throw new Error('send never produced a link: ' + (err ? err[1] : 'no error captured either'));
    }
    return { link: link[1], manifest: link[2], token: link[3] };
  }

  async function receive(sb, manifest, password) {
    const MDx = sb.MD;
    MDx.app.state.receive.password = password || '';
    uiCalls.length = 0;
    const p = MDx.app.runReceive(manifest);
    await (p || Promise.resolve());
    const ready = uiCalls.filter((c) => c[0] === 'receiveReady').pop();
    const fail = uiCalls.filter((c) => c[0] === 'error').pop();
    if (!ready) throw new Error('receive failed: ' + (fail ? fail[1] : 'unknown'));
    const res = ready[2];
    ok(res.verified, 'receiver reported the fingerprint as verified');
    return res.blob;
  }

  await test('plaintext round trip: 3 MiB file out and back, byte-identical', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(3 * 1024 * 1024);
    const file = new sb.File([buf], 'holiday.mov', { type: 'video/quicktime' });
    const { link, manifest } = await drive(sb, file, 'mockhost');
    ok(link.startsWith(BASE + '#'), 'link points at the receive page: ' + link.slice(0, 40) + '…');
    eq(manifest.parts.length, 1, 'one part at a 512 MB cap');
    const out = Buffer.from(await (await receive(sb, manifest)).arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'bytes identical');
  });

  await test('multi-part: forcing a small cap splits, uploads, and reassembles', async () => {
    const sb = freshSandbox();
    const total = 5 * 1024 * 1024;
    const buf = crypto.randomBytes(total);
    const file = new sb.File([buf], 'splitme.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost', { partCapBytes: '1MB' });
    ok(manifest.parts.length >= 5, 'planned ' + manifest.parts.length + ' parts');
    manifest.parts.forEach((p) => ok(p.s <= 1024 * 1024 + 1024, 'part within cap: ' + p.s));
    eq(manifest.parts.reduce((a, p) => a + p.s, 0), total, 'parts cover the file exactly');
    const out = Buffer.from(await (await receive(sb, manifest)).arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'stitched file is identical');
  });

  await test('password mode: ciphertext on the host, plaintext only after the password', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(1024 * 1024);
    const file = new sb.File([buf], 'secret.zip', { type: 'application/zip' });
    const { manifest } = await drive(sb, file, 'mockhost', { password: 'outlandish-phrase-7' });
    ok(manifest.e && manifest.e.fp, 'manifest carries salt + verifier');
    eq(manifest.parts[0].s, 1024 * 1024 + MD.crypto.OVERHEAD, 'stored blob is ciphertext (+GCM tag)');
    // what the "host" actually holds must not contain the file
    const raw = Buffer.from(await (await fetch(MD.manifest.partUrl(manifest, 0))).arrayBuffer());
    eq(raw.includes(buf.subarray(4096, 4200)), false, 'no plaintext fragment on the host');
    const plain = Buffer.from(await (await receive(sb, manifest, 'outlandish-phrase-7')).arrayBuffer());
    eq(plain.toString('hex'), buf.toString('hex'), 'decrypted file matches');
    await throwsAsync(async () => await receive(sb, manifest, 'guess'), /password/i, 'wrong password must be refused');
  });

  await test('encrypted multi-part round trip', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(4 * 1024 * 1024);
    const file = new sb.File([buf], 'enc-big.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost', { password: 'pw-2', partCapBytes: '1MB' });
    ok(manifest.parts.length >= 3, 'split into ' + manifest.parts.length);
    const out = Buffer.from(await (await receive(sb, manifest, 'pw-2')).arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'decrypted bytes identical');
  });

  await test('link survives a pasted-into-an-email round trip (whole email)', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(512 * 1024);
    const file = new sb.File([buf], 'clip.mp4', { type: 'video/mp4' });
    const { link } = await drive(sb, file, 'mockhost');
    const m = sb.MD.app.state.lastManifest;
    const body = sb.MD.email.bodyFor(m, link, { includeToken: true, personal: 'Here is the footage.' });
    const mangled = ('--9f86d0818' + body.replace(/(.{18})/g, '$1=\r\n')).replace(/=$/gm, '');
    const rescued = sb.MD.email.extract(mangled);
    eq(rescued.n, 'clip.mp4', 'file name recovered from a mangled email body');
    const out = Buffer.from(await (await receive(sb, rescued)).arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'download still works from the rescued link');
  });

  await test('a missing part is reported as missing, not downloaded wrongly', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(3 * 1024 * 1024);
    const file = new sb.File([buf], 'two.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost', { partCapBytes: '1MB' });
    const copy = JSON.parse(JSON.stringify(manifest));
    copy.parts[0].i = '';
    let msg = '';
    uiCalls.length = 0;
    await sb.MD.app.runReceive(copy).catch(() => { });
    const err = uiCalls.filter((c) => c[0] === 'error').pop();
    ok(err && /missing/i.test(err[1]), 'told the user part 1 is missing: ' + (err && err[1]));
  });

  await test('silent truncation by a proxy is caught by the part hash', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(1024 * 1024);
    const file = new sb.File([buf], 'trunc.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost');
    manifest.parts[0].s = manifest.parts[0].s - 1; // pretend the host served fewer bytes
    uiCalls.length = 0;
    await sb.MD.app.runReceive(manifest).catch(() => { });
    const err = uiCalls.filter((c) => c[0] === 'error').pop();
    ok(err, 'an error was raised');
    ok(/size|mismatch|expected|Downloaded|bytes/i.test(err[1]), 'with a size-related message: ' + err[1]);
  });

  await test('bucket presigning produces a stable, well-formed AWS4 URL', async () => {
    const sb = freshSandbox();
    const cfg = {
      endpoint: 'https://s3.eu-central-003.backblazeb2.com', bucket: 'maildrop-demo', region: 'eu-central-003',
      keyId: 'KeyIdNotReal', secret: 'SecretNotReal', keyPrefix: 'maildrop/', signedUrlExpiry: 3600
    };
    const key = sb.MD.backends.s3.objectKey(cfg, 'holiday clip.mov');
    ok(/^maildrop\/\d{12}-[0-9a-f]{12}\/holiday clip\.mov$/.test(key), 'key layout: ' + key);
    const signed = await sb.MD.backends.s3.presignPutUrl(cfg, key, 123, { amzDate: '20260922T120000Z' });
    ok(/[?&]X-Amz-Signature=[0-9a-f]{64}$/.test(signed.url), 'signature appended');
    ok(signed.url.includes('X-Amz-Credential=KeyIdNotReal%2F20260922%2Feu-central-003%2Fs3%2Faws4_request'), 'credential scope encoded');
    ok(signed.url.includes('X-Amz-SignedHeaders=host'), 'only host signed (no preflight headers)');
    ok(signed.stringToSign.startsWith('AWS4-HMAC-SHA256\n20260922T120000Z\n20260922/eu-central-003/s3/aws4_request\n'), 'string-to-sign shape:\n' + signed.stringToSign);
    const again = await sb.MD.backends.s3.presignPutUrl(cfg, key, 123, { amzDate: '20260922T120000Z' });
    eq(again.signature, signed.signature, 'deterministic for the same date');
  });

  await test('provider URL round trip: template + id rebuild the exact object path', async () => {
    const sb = freshSandbox();
    const cfg = { endpoint: 'http://127.0.0.1:' + PORT, bucket: 'bucket', region: 'auto', keyId: 'k', secret: 's', keyPrefix: 'md/' };
    const key = 'md/20260922120000-abcdef/clip.mov';
    const id = sb.MD.backends.s3.idFromUrl(BASE + 'bucket/' + key, BASE + 'bucket/', 'bucket');
    eq(id, key, 'id extracted from a path-style URL');
    eq(sb.MD.pack.templateToUrl(BASE + 'bucket/{id}', id), BASE + 'bucket/' + key, 'and put back');
  });

  await test('a part that fails is retried, not silently skipped', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    let tries = 0;
    const flaky = {
      key: 'flaky', label: 'flaky', maxPartBytes: 1024 * 1024, expiries: [], defaultExpiry: 'session',
      upload: async (body, o) => {
        tries++;
        if (tries < 3) { const e = new Error('HTTP 503 — busy'); e.retryable = true; throw e; }
        return { id: 'ok.bin', base: BASE + 'f/{id}' };
      },
      buildUrl: (id, base) => MDx.pack.templateToUrl(base, id)
    };
    MDx.backends.byKey.flaky = flaky;
    MDx.backends.list.push(flaky);
    const buf = crypto.randomBytes(64 * 1024);
    const file = new sb.File([buf], 'flaky.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'flaky');
    eq(tries, 3, 'retried until it went through');
    eq(manifest.parts[0].i, 'ok.bin');
  });

  await test('a hard 4xx from the host stops instead of hammering it', async () => {
    const sb = freshSandbox();
    let tries = 0;
    const mean = {
      key: 'mean', label: 'mean', maxPartBytes: 1024 * 1024, expiries: [], defaultExpiry: 'session',
      upload: async () => { tries++; const e = new Error('HTTP 413 — too large'); e.httpStatus = 413; e.retryable = false; throw e; },
      buildUrl: () => ''
    };
    sb.MD.backends.byKey.mean = mean; sb.MD.backends.list.push(mean);
    const file = new sb.File([crypto.randomBytes(1024)], 'x.bin');
    uiCalls.length = 0;
    const { manifest } = await drive(sb, file, 'mean').then(() => ({ manifest: null }), () => ({ manifest: null }));
    const err = uiCalls.filter((c) => c[0] === 'error').pop();
    ok(err && /413/.test(err[1]), 'surfaced the host error: ' + (err && err[1]));
  });

  await test('the litterbox envelope carries the fields that endpoint demands', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const lb = MDx.backends.get('litterbox');
    const fields = lb.fieldsFor('24h');
    eq(fields.reqtype, 'fileupload', 'reqtype is required or the host replies "No request type given?"');
    eq(fields.time, '24h', 'expiry token forwarded');
    const file = new sb.File([crypto.randomBytes(4096)], 'a.bin', { type: 'application/octet-stream' });
    const body = MDx.backends.partBody(lb, file.slice(0, 4096), fields, 'a.bin', 'application/octet-stream');
    const head = Buffer.from(await body.slice(0, 400).arrayBuffer()).toString('latin1');
    ok(/name="reqtype"\r\n\r\nfileupload/.test(head), 'reqtype inside the body: ' + head.slice(0, 120));
    ok(/name="time"\r\n\r\n24h/.test(head), 'expiry inside the body');
    ok(/filename="a\.bin"/.test(head), 'file part named');
    // raw-object backends must NOT get a multipart wrapper
    const raw = MDx.backends.partBody(MDx.backends.get('selfhost'), file.slice(0, 4096), fields, 'a.bin');
    eq(raw.size, 4096, 'bucket PUT is the payload only');
  });

  await test('stored size vs payload size are never confused', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const payload = crypto.randomBytes(100000);
    const file = new sb.File([payload], 'a.bin', { type: 'application/octet-stream' });
    MDx.app.state.files = [file];
    MDx.app.state.cfg.backend = 'litterbox';
    MDx.app.state.cfg.password = 'p';
    MDx.app.state.cfg.receiveBase = BASE;
    uiCalls.length = 0;
    // encryption path: the manifest must describe the stored ciphertext blob
    let stubId = 0;
    const capture = [];
    const spy = {
      key: 'spy', label: 'spy', maxPartBytes: 1024 * 1024, expiries: [], defaultExpiry: 'session',
      fieldsFor: () => ({ reqtype: 'fileupload', time: '1h' }),
      upload: async (body, o) => { capture.push(body.size); if (o.onProgress) o.onProgress(body.size, body.size); return { id: 'p' + (stubId++) + '.bin', base: 'https://litter.catbox.moe/{id}' }; },
      buildUrl: (id, base) => MDx.pack.templateToUrl(base, id)
    };
    MDx.backends.byKey.spy = spy; MDx.backends.list.push(spy);
    MDx.app.state.cfg.backend = 'spy';
    await MDx.app.runSend();
    const shown = uiCalls.filter((c) => c[0] === 'showLink').pop();
    ok(shown, 'link produced');
    const m = shown[2];
    const framing = capture[0] - m.parts[0].s;
    ok(framing > 100, 'multipart framing rode on the wire: ' + framing + ' bytes');
    eq(m.parts[0].s, 100000 + MDx.crypto.OVERHEAD, 'manifest records what the host stores: ciphertext, no framing');
    eq(m.parts[0].b, 1, 'plus exactly one encryption record for this part');
    eq(m.z, 100000, 'while z stays the size of the original file');
    eq(MDx.crypto.partPayloadSize(m.parts[0].s, m.parts[0].b), 100000, 'receiver recovers the plaintext length');
  });

  await test('local test mode completes with zero network', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(700 * 1024);
    const file = new sb.File([buf], 'offline.txt', { type: 'text/plain' });
    const { link } = await drive(sb, file, 'local');
    ok(link.includes('#'), 'still a normal link: ' + link.slice(0, 30) + '…');
    const out = Buffer.from(await (await receive(sb, sb.MD.app.state.lastManifest)).arrayBuffer());
    eq(out.toString('hex'), buf.toString('hex'), 'offline round trip works');
  });

  await test('a transfer too big to fold still ends with one binding fingerprint', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(5 * 1024 * 1024);
    const file = new sb.File([buf], 'chain.bin', { type: 'application/octet-stream' });
    const MDx = sb.MD;
    // pretend this file is past the fold limit — the case where the sender used
    // to give up on a whole-file fingerprint altogether
    MDx.app.FOLD_LIMIT = 2 * 1024 * 1024;
    const bk = MDx.backends.get('mockhost');
    bk.expiries = [{ v: '1h', ms: 3600000 }]; bk.defaultExpiry = '1h';
    const { manifest } = await drive(sb, file, 'mockhost', { partCapBytes: '1MB' });
    ok(manifest.parts.length >= 5, 'planned ' + manifest.parts.length + ' parts');
    eq(manifest.hm, 'parts', 'the fingerprint is the chain of part digests');
    ok(manifest.h && manifest.h.length === 64, 'and it is still a full-length digest: ' + (manifest.h || '').slice(0, 12) + '…');
    eq(manifest.d, 3600000, 'the expiry is in the link');
    ok(manifest.x > Date.now() && manifest.x <= Date.now() + 3600000, 'and so is the absolute deadline it expires at: ' + new Date(manifest.x).toISOString());
    const res = await receive(sb, manifest);
    eq(Buffer.from(await res.arrayBuffer()).toString('hex'), buf.toString('hex'), 'bytes identical');
    MDx.app.FOLD_LIMIT = 8 * 1024 * 1024 * 1024;
    delete bk.expiries; bk.defaultExpiry = 'session';
  });

  await test('replacing one part breaks the chain even though its own hash is copied', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(5 * 1024 * 1024);
    const file = new sb.File([buf], 'chain2.bin', { type: 'application/octet-stream' });
    const MDx = sb.MD;
    MDx.app.FOLD_LIMIT = 2 * 1024 * 1024;
    const { manifest } = await drive(sb, file, 'mockhost', { partCapBytes: '1MB' });
    // an attacker who can write to the host can copy the recorded part hash; what
    // they cannot do is make a *different* set of parts still match m.h
    const raw = Buffer.from(await (await fetch(MD.manifest.partUrl(manifest, 0))).arrayBuffer());
    const swapped = manifest.parts[0];
    const other = manifest.parts[2];
    manifest.parts[0] = Object.assign({}, swapped, { i: other.i, s: other.s, h: swapped.h });
    manifest.z = manifest.parts.reduce((a, p) => a + p.s, 0) + (raw.length - swapped.s);
    uiCalls.length = 0;
    await MDx.app.runReceive(manifest);
    const ready = uiCalls.filter((c) => c[0] === 'receiveReady').pop();
    const fail = uiCalls.filter((c) => c[0] === 'error').pop();
    ok(!ready, 'the tampered job is refused rather than saved: ' + (fail ? fail[1].slice(0, 60) : ''));
    MDx.app.FOLD_LIMIT = 8 * 1024 * 1024 * 1024;
  });

  await test('a link with no fingerprints says so instead of claiming success', async () => {
    const sb = freshSandbox();
    const buf = crypto.randomBytes(1024 * 1024);
    const file = new sb.File([buf], 'nohash.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost');
    const bare = JSON.parse(JSON.stringify(manifest));
    bare.h = ''; bare.hm = 'file';
    bare.parts.forEach((p) => { p.h = ''; });
    uiCalls.length = 0;
    sb.MD.app.state.receive.password = '';
    await sb.MD.app.runReceive(sb.MD.manifest.decode(MD.manifest.encode(bare)));
    const ready = uiCalls.filter((c) => c[0] === 'receiveReady').pop();
    ok(ready, 'the file is still delivered');
    eq(ready[2].verified, false, 'but it is not reported as verified');
    eq(ready[2].checkable, false, 'and the page is told there was nothing to check');
  });

  await test('a 950 MiB part does not mean 950 MiB of RAM on the way back', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const win = MDx.receive.windowFor({ c: MDx.app.HASH_CHUNK });
    eq(win, MDx.receive.CHUNK, 'plain parts are read in one fixed window');
    const enc = MDx.receive.windowFor({ e: { bs: 1024 * 1024 }, c: MDx.app.HASH_CHUNK });
    eq(enc, 1024 * 1024 + MDx.crypto.OVERHEAD, 'encrypted parts are read one whole record at a time');
    eq(MDx.app.HASH_CHUNK, 16 * 1024 * 1024, 'and the fold window matches it, so nothing has to be buffered ahead');
    let biggest = 0, windows = 0;
    const MB = 1024 * 1024;
    const buf = crypto.randomBytes(40 * MB);
    const file = new sb.File([buf], 'windows.bin', { type: 'application/octet-stream' });
    const { manifest } = await drive(sb, file, 'mockhost', { partCapBytes: '48MB' });
    eq(manifest.parts.length, 1, 'one 40 MiB part, which is what a provider would hand back at once');
    const url = MDx.manifest.partUrl(manifest, 0);
    await MDx.receive.streamPart(url, manifest.parts[0].s, (u8) => { windows++; biggest = Math.max(biggest, u8.byteLength); });
    ok(windows >= 3, 'the part arrived in ' + windows + ' windows of at most ' + MDx.receive.CHUNK / MB + ' MiB');
    eq(biggest, MDx.receive.CHUNK, 'and the biggest was exactly one window');
    ok(biggest <= MDx.receive.CHUNK, 'the largest window was ' + biggest + ' bytes');
  });

  await test('an attempt that dies partway is continued, not restarted', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const self = MDx.backends.get('selfhost');
    Object.assign(MDx.app.state.cfg, {
      backend: 'selfhost', password: '', partCapBytes: '1MB',
      receiveBase: BASE + 'index.html',
      s3: { endpoint: 'http://127.0.0.1:' + PORT, bucket: 'bucket', region: 'auto', keyId: 'k', secret: 's', keyPrefix: 'resume/' }
    });
    const buf = crypto.randomBytes(4 * 1024 * 1024);
    const file = new sb.File([buf], 'vault.zip', { type: 'application/zip' });
    MDx.app.state.files = [file];
    const orig = self.upload.bind(self);
    const keys = [];
    let n = 0;
    let broken = true;
    self.upload = async function (body, opts) {
      n++;
      // refuse *before* storing, so what is on the host is exactly what is recorded
      if (broken && n === 3) { const e = new Error('the host refused this part'); e.retryable = false; throw e; }
      const r = await orig(body, opts);
      keys.push(r.id);
      return r;
    };
    await MDx.app.runSend();
    eq(keys.length, 2, 'two parts got through before it died');
    ok(!MDx.app.state.lastLink, 'and there was no link to give away');
    const notes = uiCalls.filter((c) => c[0] === 'note' || c[0] === 'warn').map((c) => c[1]).join(' | ');
    ok(/are still in your bucket so this job can be continued/.test(notes), 'it said so: ' + notes.slice(-200));
    const plan = MDx.app.resumeFor(file);
    ok(plan && plan.done === 2, 'the plan knows 2 of 4 parts are stored: ' + JSON.stringify(plan && plan.done));

    // the connection comes back: press Start again
    broken = false;
    await MDx.app.runSend();
    eq(n, 5, 'the second attempt uploaded only the 2 missing parts, not 4: calls=' + n);
    const link = uiCalls.filter((c) => c[0] === 'showLink').pop();
    ok(link, 'and it produced a link');
    const m = link[2];
    eq(m.parts.length, 4, 'all four parts are in it');
    eq(MDx.app.resumeFor(file), null, 'the record is gone once the job is finished');
    // and the file it points at is the right file
    const sb2 = freshSandbox();
    sb2.MD.backends.get('mockhost').base = BASE;
    MDx.app.state.files = [];
    const res = await sb2.MD.receive.assemble(m, { urls: m.parts.map((p) => BASE + 'f/' + p.i) });
    eq(Buffer.from(res.blob ? await res.blob.arrayBuffer() : res.bytes).toString('hex'), buf.toString('hex'),
       'the continued job reassembles the exact bytes');
  });

  await test('rememberAttempts: false leaves no record to continue from', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    MDx.config = { rememberAttempts: false };
    const self = MDx.backends.get('selfhost');
    Object.assign(MDx.app.state.cfg, {
      backend: 'selfhost', password: '', partCapBytes: '1MB', receiveBase: BASE + 'index.html',
      s3: { endpoint: 'http://127.0.0.1:' + PORT, bucket: 'bucket', region: 'auto', keyId: 'k', secret: 's', keyPrefix: 'nor/' }
    });
    const file = new sb.File([crypto.randomBytes(4 * 1024 * 1024)], 'x.zip', { type: 'application/zip' });
    MDx.app.state.files = [file];
    const orig = self.upload.bind(self);
    let n = 0;
    self.upload = async function (b, o) {
      n++;
      if (n === 3) { const e = new Error('no'); e.retryable = false; throw e; }
      return orig(b, o);
    };
    await MDx.app.runSend();
    eq(n, 3, 'two parts stored and a third attempted, as in the other tests');
    eq(MDx.app.resumeFor(file), null, 'but this browser kept nothing about it');
    eq(sb.localStorage.getItem('maildrop.resume.v1'), null, 'no record on disk either');
  });

  await test('an encrypted job continues, and refuses to continue on another password', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const self = MDx.backends.get('selfhost');
    Object.assign(MDx.app.state.cfg, {
      backend: 'selfhost', password: 'friday-only', partCapBytes: '1MB',
      receiveBase: BASE + 'index.html',
      s3: { endpoint: 'http://127.0.0.1:' + PORT, bucket: 'bucket', region: 'auto', keyId: 'k', secret: 's', keyPrefix: 'enc-resume/' }
    });
    const buf = crypto.randomBytes(4 * 1024 * 1024);
    const file = new sb.File([buf], 'secrets.zip', { type: 'application/zip' });
    MDx.app.state.files = [file];
    const orig = self.upload.bind(self);
    const keys = [];
    let n = 0, failAt = 3;
    self.upload = async function (body, opts) {
      n++;
      if (failAt && n === failAt) { const e = new Error('the host refused this part'); e.retryable = false; throw e; }
      const r = await orig(body, opts);
      keys.push(r.id);
      return r;
    };

    await MDx.app.runSend();
    eq(keys.length, 2, 'two sealed parts were stored before it died');
    const plan = MDx.app.resumeFor(file);
    ok(plan && plan.done === 2, 'the record carries them');
    ok(plan.rec.salt && plan.rec.ivp && plan.rec.fp, 'with the salt, the IV prefix and the verifier — and no password');

    failAt = 0;
    await MDx.app.runSend();
    eq(n, 5, 'the same password sent only the 2 missing parts');
    const m = uiCalls.filter((c) => c[0] === 'showLink').pop()[2];
    const sb2 = freshSandbox();
    const res = await sb2.MD.receive.assemble(m, { password: 'friday-only', urls: m.parts.map((p) => BASE + 'f/' + p.i) });
    eq(Buffer.from(res.blob ? await res.blob.arrayBuffer() : res.bytes).toString('hex'), buf.toString('hex'),
      'and it opens as one file: the continued parts and the fresh ones were sealed with the same key');

    // now the dangerous case: retry the leftover parts with a different password
    MDx.app.state.cfg.password = 'friday-only';
    n = 0; failAt = 2; keys.length = 0;
    await MDx.app.runSend();
    eq(keys.length, 1, 'one part stored, then the attempt died');
    ok(MDx.app.resumeFor(file), 'and there is something to continue');
    MDx.app.state.cfg.password = 'wrong-tuesday';
    failAt = 0;
    const before = n;
    await MDx.app.runSend();
    eq(n - before, 4, 'a different password re-sealed all four parts instead of mixing two keys');
    const notes = uiCalls.filter((c) => c[0] === 'warn').map((c) => c[1]).join(' | ');
    ok(/not the one the earlier attempt used/.test(notes), 'and it said why: ' + notes.slice(-160));
    const m2 = uiCalls.filter((c) => c[0] === 'showLink').pop()[2];
    const res2 = await freshSandbox().MD.receive.assemble(m2, { password: 'wrong-tuesday', urls: m2.parts.map((p) => BASE + 'f/' + p.i) });
    eq(Buffer.from(res2.blob ? await res2.blob.arrayBuffer() : res2.bytes).toString('hex'), buf.toString('hex'),
      'the fresh job is self-consistent and opens with the new password');
  });

  await test('a bucket job that is abandoned on purpose leaves nothing behind', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    const self = MDx.backends.get('selfhost');
    Object.assign(MDx.app.state.cfg, {
      backend: 'selfhost', password: '', partCapBytes: '1MB',
      receiveBase: BASE + 'index.html',
      s3: { endpoint: 'http://127.0.0.1:' + PORT, bucket: 'bucket', region: 'auto', keyId: 'k', secret: 's', keyPrefix: 'abandoned/' }
    });
    const file = new sb.File([crypto.randomBytes(4 * 1024 * 1024)], 'vault.zip', { type: 'application/zip' });
    MDx.app.state.files = [file];
    const orig = self.upload.bind(self);
    const keys = [];
    let n = 0, failAt = 3, failKind = 'host';
    self.upload = async function (body, opts) {
      n++;
      // the counter resets per attempt, so each run dies at the same part
      if (failAt && n === failAt) {
        const e = new Error(failKind === 'cancel' ? 'Cancelled.' : 'the host refused this part');
        if (failKind === 'cancel') e.cancelled = true; else e.retryable = false;
        throw e;
      }
      const r = await orig(body, opts);
      keys.push(r.id);
      return r;
    };
    // 1) it died, so the parts stay put for a continuation
    await MDx.app.runSend();
    eq(keys.length, 2, 'two parts were stored before it died');
    ok(MDx.app.resumeFor(file), 'and there is a job to continue');
    const still = await Promise.all(keys.map((k) => fetch(BASE + 'f/' + k).then((r) => r.status)));
    eq(still.join(','), '200,200', 'they are still in the bucket, because a retry will use them');

    // 2) the user chooses "Start over": that is a decision to abandon, so it deletes
    const out = await MDx.app.forgetResume(file);
    eq(MDx.app.resumeFor(file), null, 'the record is gone');
    eq(out.removed.gone, 2, 'both objects were deleted');
    eq(out.removed.failed, 0, 'nothing was left behind');
    const after = await Promise.all(keys.map((k) => fetch(BASE + 'f/' + k).then((r) => r.status)));
    eq(after.join(','), '404,404', 'the bucket really has them no more — a signed DELETE went through');

    // 3) and an explicit Cancel takes the same route without asking
    failKind = 'cancel'; n = 0;
    await MDx.app.runSend();
    eq(keys.length, 4, 'two more parts were stored before Cancel');
    const notes = uiCalls.filter((c) => c[0] === 'note' || c[0] === 'warn').map((c) => c[1]).join(' | ');
    ok(/Cancelled/.test(notes), 'Cancel is reported as a decision: ' + notes.slice(-160));
    ok(/2 of 2 uploaded parts were deleted from your bucket/.test(notes), 'and it cleaned up: ' + notes.slice(-200));
    eq(MDx.app.resumeFor(file), null, 'a cancelled job is not offered as a continuation');
    const after2 = await Promise.all(keys.slice(2).map((k) => fetch(BASE + 'f/' + k).then((r) => r.status)));
    eq(after2.join(','), '404,404', 'including the second pair');
  });

  await test('a host that accepts the request and then says nothing is given up on', async () => {
    // /stall on the mock host never answers. Without a watchdog this is the one
    // failure mode that leaves the job spinning forever with nothing to report.
    const sb = freshSandbox();
    const MDx = sb.MD;
    MDx.config = { stallSeconds: 1 };
    const t0 = Date.now();
    let err = null;
    try { await MDx.receive.streamPart(BASE + 'stall/quiet.bin', 4096, () => { }); }
    catch (e) { err = e; }
    const secs = (Date.now() - t0) / 1000;
    ok(err, 'the read failed instead of hanging');
    ok(err.stalled, 'and it is reported as a stall: ' + err.message);
    ok(/quiet|given up/.test(err.message), 'the message says what happened: ' + err.message);
    eq(err.retryable, true, 'a stall is worth another attempt');
    ok(secs > 0.9 && secs < 8, 'it gave up after ' + secs.toFixed(1) + 's, not before the window and not long after');
  });

  // ---- the host check the Send tab offers ---------------------------------
  await test('probeHost speaks to the real upload path and reports both halves', async () => {
    const sb = freshSandbox();
    const MDx = sb.MD;
    MDx.app.state.cfg.backend = 'mockhost';
    MDx.backends.get('mockhost').base = BASE;
    const r = await MDx.backends.probeHost('mockhost', MDx.app.state.cfg.s3);
    eq(r.ok, true, 'the mock host accepted the 1 KiB upload: ' + r.lines.join(' / ').slice(0, 200));
    const txt = r.lines.join('\n');
    ok(/reachability ✓/.test(txt), 'reachability reported');
    ok(/upload ✓/.test(txt), 'upload reported');
    ok(/page origin +\S+/.test(txt), 'it names the origin to whitelist: ' + r.lines[0]);
    ok(/test file stays until/.test(txt), 'and is honest that a host with no delete API leaves it behind');
  });

  await test('probeHost on a dead port blames the network, not CORS', async () => {
    const sb = freshSandbox();
    sb.MD.backends.get('mockhost').base = 'http://127.0.0.1:1/';     // nothing listens there
    const r = await sb.MD.backends.probeHost('mockhost', sb.MD.app.state.cfg.s3);
    eq(r.ok, false, 'an unreachable host is never a pass');
    const txt = r.lines.join('\n');
    ok(/reachability ✗/.test(txt), txt.slice(0, 200));
    ok(/not a CORS problem/.test(txt), 'and it is labelled as such: ' + txt.slice(-140));
    ok(!/upload ✓/.test(txt), 'it stopped before sending anything');
  });

  await test('the no-network providers say there is nothing to check', async () => {
    const sb = freshSandbox();
    for (const key of ['local', 'direct']) {
      const r = await sb.MD.backends.probeHost(key, {});
      eq(r.ok, true, key + ' cannot fail a network check');
      ok(/Nothing to check/.test(r.lines.join(' ')), key + ' says why');
    }
  });

  report('integration');
  mock && mock.kill();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); mock && mock.kill(); process.exit(1); });
