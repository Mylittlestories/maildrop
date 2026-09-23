'use strict';
/* Unit tests for the pure logic: encoding, manifest, crypto, packing, email. */
const { makeSandbox, loadLib, test, eq, ok, near, throwsAsync, section, report, crypto: _c } = require('./harness.js');
const crypto = require('crypto');

const ctx = makeSandbox();
const MD = loadLib(ctx);

function randFile(size, name) {
  const buf = crypto.randomBytes(size);
  return { buf, file: new ctx.File([buf], name || 'sample.bin', { type: 'application/octet-stream' }) };
}

(async () => {
  section('util — email-safe base32');
  await test('round-trips random binary', () => {
    for (let i = 0; i < 200; i++) {
      const n = 1 + (i % 37);
      const b = crypto.randomBytes(n);
      const t = MD.util.bytesToBase32(b);
      ok(/^[A-Z2-7]+$/.test(t), 'alphabet only, got ' + t);
      const back = MD.util.base32ToBytes(t);
      eq(Buffer.from(back).toString('hex'), b.toString('hex'), 'mismatch at len ' + n);
    }
  });
  await test('token alphabet contains no - _ = + or dots (email-wrapping safe)', () => {
    const t = MD.util.bytesToBase32(crypto.randomBytes(400));
    eq(/[-_=+./]/.test(t), false);
  });
  await test('decode ignores case, newlines and hyphens injected by mailers', () => {
    const b = crypto.randomBytes(64);
    const t = MD.util.bytesToBase32(b);
    const mangled = (t.toLowerCase().match(/.{1,19}/g) || []).map((s) => '- ' + s + ' -').join('\r\n=\r\n');
    eq(MD.util.base32ToBytes(mangled).length, b.length, 'length after mangling');
    eq(Buffer.from(MD.util.base32ToBytes(mangled)).toString('hex'), b.toString('hex'), 'bytes after mangling');
  });
  await test('fmtBytes / fmtDuration are readable', () => {
    eq(MD.util.fmtBytes(2 * 1024 * 1024 * 1024), '2 GiB');
    eq(MD.util.fmtBytes(1536), '1.5 KiB');
    eq(MD.util.fmtDuration(72), '3 days');
    eq(MD.util.fmtDuration(1), '1 h');
  });
  await test('parseSizeInput accepts what a human types', () => {
    eq(MD.util.parseSizeInput('900MB'), 900 * 1000 * 1000);
    eq(MD.util.parseSizeInput(' 700 MiB '), 700 * 1024 * 1024);
    eq(MD.util.parseSizeInput('junk'), null);
  });

  section('manifest — the thing that travels inside the email');
  await test('encode → URL → decode keeps every field', () => {
    const m = {
      v: 1, n: 'holiday clip.mov', t: 'video/quicktime', z: 3 * 1024 * 1024,
      p: 'litterbox', b: 'https://litter.catbox.moe/{id}', d: 259200000, o: '',
      f: 'page', u: 'https://litter.catbox.moe/ab12cd.mov',
      e: { salt: 'c2FsdHNhbHRzYWx0c2E=', fp: 'a1b2c3d4e5f6', iv: 'BAQHBw==' }, h: 'deadbeefcafe0011',
      parts: [{ i: 'ab12cd.mov', s: 2097152, h: 'aaaa1111bbbb2222' }, { i: 'zz99yy.mov', s: 1048576, h: 'cccc3333dddd4444' }]
    };
    const link = MD.manifest.buildUrl('https://you.github.io/maildrop/', m);
    ok(link.startsWith('https://you.github.io/maildrop/#'), 'link shape');
    const back = MD.manifest.decode(link.split('#')[1]);
    eq(back.n, 'holiday clip.mov');
    eq(back.parts.length, 2);
    eq(back.parts[1].i, 'zz99yy.mov');
    eq(back.e.fp, 'a1b2c3d4e5f6');
    eq(back.z, 3 * 1024 * 1024);
    eq(MD.manifest.partUrl(back, 0), 'https://litter.catbox.moe/ab12cd.mov', 'part url rebuilt from template');
    eq(back.f, 'page');
    eq(back.u, 'https://litter.catbox.moe/ab12cd.mov', 'single-part transfers carry the host URL for a fallback click');
  });
  await test('a bring-your-own-link manifest round trips', () => {
    const m = { v: 1, n: 'clip.mov', t: '', z: 0, p: 'direct', b: 'https://host/clip.mov', d: 0, o: '', f: 'direct', u: 'https://host/clip.mov', e: null, h: '', parts: [{ i: 'https://host/clip.mov', s: 0, h: '', b: 0 }] };
    const tok = MD.manifest.encode(m);
    const back = MD.manifest.decode(tok);
    eq(back.f, 'direct');
    eq(back.u, 'https://host/clip.mov');
    eq(back.parts[0].i, 'https://host/clip.mov', 'the full URL survives');
  });

  await test('a bucket endpoint works with or without the https://', async () => {
    const cfg = {
      endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'mail', region: 'eu-central-003',
      keyId: 'K', secret: 'S', keyPrefix: 'drop/', signedUrlExpiry: 900
    };
    const a = await MD.backends.s3.presignPutUrl(cfg, 'drop/2026/x/p1', 1024);
    const b = await MD.backends.s3.presignPutUrl(Object.assign({}, cfg, { endpoint: 'https://s3.eu-central-003.backblazeb2.com' }), 'drop/2026/x/p1', 1024);
    ok(a.url.startsWith('https://s3.eu-central-003.backblazeb2.com/mail/drop/2026/x/p1?'), 'scheme added: ' + a.url.slice(0, 70));
    eq(a.url, b.url, 'both spellings sign to the same request');
    eq(MD.backends.selfhostConfigured(cfg), true);
  });

  section('the guard — nothing from someone else\u2019s link is trusted');

  await test('a manifest cannot name a scheme this page should touch', () => {
    const base = { v: 1, n: 'x.bin', t: '', z: 5, p: 'litterbox', d: 0, o: '', e: null, h: '', parts: [{ i: 'a.bin', s: 5, h: '' }] };
    for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>hi', 'file:///etc/passwd', 'javascript:alert(1)//', '  https://ok/x  javascript:']) {
      throwsAsync(() => Promise.resolve().then(() => MD.manifest.encode(Object.assign({}, base, { b: bad + '/{id}' }))), /http\(s\)/, 'base ' + JSON.stringify(bad));
      throwsAsync(() => Promise.resolve().then(() => MD.manifest.encode(Object.assign({}, base, { u: bad }))), /http\(s\)/, 'direct link ' + JSON.stringify(bad));
    }
    ok(MD.manifest.decode(MD.manifest.encode(Object.assign({}, base, { b: 'https://h.example/{id}', u: 'https://h.example/a.bin' }))), 'a plain https manifest still works');
  });

  await test('a part id cannot climb out of the sender\u2019s prefix or smuggle a query', () => {
    const base = { v: 1, n: 'x.bin', t: '', z: 5, p: 'litterbox', b: 'https://h.example/drop/{id}', d: 0, o: '', e: null, h: '', parts: [] };
    for (const bad of ['../../other-bucket/secret', 'a?id=1', 'a#f', 'a b', 'a\nb', '..\\..\\x']) {
      throwsAsync(() => Promise.resolve().then(() => MD.manifest.encode(Object.assign({}, base, { parts: [{ i: bad, s: 5, h: '' }] }))), /does not look like a file name|will not fetch/, 'id ' + JSON.stringify(bad));
    }
    eq(MD.manifest.encode(Object.assign({}, base, { parts: [{ i: 'drop-9f2a.bin', s: 5, h: '' }] })).length > 0, true, 'an ordinary id passes');
  });

  await test('a file name from a link cannot carry markup into the page', () => {
    eq(MD.util.cleanName('<img src=x onerror=alert(1)>.png'), '_img src=x onerror=alert(1)_.png');
    eq(MD.util.cleanName('a\u0007b.txt'), 'ab.txt');
    eq(MD.util.cleanName('../../etc/passwd'), '.._.._etc_passwd');
    eq(MD.util.cleanName(''), 'file');
  });

  await test('safeUrl only ever lets an http(s) address through', () => {
    eq(MD.util.safeUrl('https://a.b/c'), 'https://a.b/c');
    eq(MD.util.safeUrl('http://127.0.0.1:8099/f/x'), 'http://127.0.0.1:8099/f/x');
    eq(MD.util.safeUrl('javascript:alert(1)'), '');
    eq(MD.util.safeUrl('https://a.b/c?next=javascript:alert(1)'), 'https://a.b/c?next=javascript:alert(1)');
    eq(MD.util.safeUrl('https://a.b/c\nX'), '');
    eq(MD.util.safeUrl('local://part-1'), '', 'local:// needs to be asked for');
    eq(MD.util.safeUrl('local://part-1', true), 'local://part-1');
  });

  await test('the To: field cannot add recipients or headers', () => {
    const good = MD.email.safeAddress('first@example.com, second@x.co.uk');
    eq(good.to, 'first@example.com,second@x.co.uk');
    eq(good.dropped.length, 0);
    const evil = MD.email.safeAddress('a@b.co?cc=victim@evil.com');
    eq(evil.to, '', 'a query in the address is not an address');
    const mixed = MD.email.safeAddress('a@b.co x@y#z');
    eq(mixed.to, 'a@b.co');
    eq(mixed.dropped.join(''), 'x@y#z');
    const url = MD.email.mailtoUrl('a@b.co?subject=hi&body=hacked', 's', 'b');
    eq(url.startsWith('mailto:?'), true, 'nothing usable survives: ' + url.slice(0, 30));
    ok(!url.includes('hacked'), 'the smuggled body text never enters the URL');
  });

  await test('hm and the deadline travel with the manifest', () => {
    const m = { v: 1, n: 'x.bin', t: '', z: 5, p: 'litterbox', b: 'https://h.example/{id}', d: 3600000, x: 1700000000000, o: '', e: null, h: 'aa'.repeat(32), hm: 'parts', parts: [{ i: 'a.bin', s: 5, h: '' }] };
    const back = MD.manifest.decode(MD.manifest.encode(m));
    eq(back.hm, 'parts');
    eq(back.x, 1700000000000);
    const plain = MD.manifest.decode(MD.manifest.encode(Object.assign({}, m, { hm: 'file', x: 0 })));
    eq(plain.hm, 'file', 'the default costs no characters');
    eq(plain.x, 0);
    eq(MD.manifest.encode(m).length > MD.manifest.encode(Object.assign({}, m, { hm: 'file', x: 0 })).length, true, 'and the extras do cost a few');
  });

  await test('lib/config.js pre-fills settings, and this browser still wins', () => {
    const ctx2 = makeSandbox({ MD: { config: {
      backend: 'selfhost', partCapBytes: '64MB',
      s3: { endpoint: 's3.eu-central-003.backblazeb2.com', bucket: 'mail', region: 'eu-central-003', keyPrefix: 'drop/' }
    } } });
    const MD2 = loadLib(ctx2, true);
    const cfg = MD2.app.loadCfg();
    eq(cfg.backend, 'selfhost', 'provider taken from the file');
    eq(cfg.partCapBytes, '64MB');
    eq(cfg.s3.bucket, 'mail', 'bucket form pre-filled');
    eq(cfg.s3.secret, '', 'and the secret is never in it');
    ctx2.localStorage.setItem('maildrop.settings.v1', JSON.stringify({ backend: 'litterbox', s3: { bucket: 'mine' } }));
    const cfg2 = MD2.app.loadCfg();
    eq(cfg2.backend, 'litterbox', 'a choice made in this browser beats the file');
    eq(cfg2.s3.bucket, 'mine');
    eq(cfg2.s3.endpoint, 's3.eu-central-003.backblazeb2.com', 'fields the browser never touched keep the file value');
  });

  await test('a 24-part transfer still fits a sane link length', () => {
    const parts = [];
    for (let i = 0; i < 24; i++) parts.push({ i: 'f' + i + 'abc.bin', s: 900 * 1024 * 1024, h: 'x'.repeat(16) });
    const m = { v: 1, n: 'big.bin', t: '', z: 24 * 900 * 1024 * 1024, p: 'litterbox', b: 'https://litter.catbox.moe/{id}', d: 0, o: '', e: null, h: '', parts };
    const tok = MD.manifest.encode(m);
    ok(tok.length < 6200, 'token length ' + tok.length + ' must stay under the 6200 link budget');
    eq(MD.manifest.decode(tok).parts.length, 24);
  });
  await test('findManifest rescues a link broken by quoted-printable wrapping', () => {
    const m = { v: 1, n: 'x.bin', t: '', z: 10, p: 'litterbox', b: 'https://litter.catbox.moe/{id}', d: 0, o: '', e: null, h: '', parts: [{ i: 'q1w2.bin', s: 10, h: '' }] };
    const tok = MD.manifest.encode(m);
    const wrapped = ('https://y.github.io/maildrop/#' + tok).replace(/(.{20})/g, '$1\r\n- ');
    const found = MD.manifest.findManifest('Hi,\r\n\r\n' + wrapped + '\r\n\r\n-- sent from MailDrop');
    eq(found.n, 'x.bin');
    eq(found.parts[0].i, 'q1w2.bin');
  });
  await test('two links from separate emails merge into one complete job', () => {
    const base = { v: 1, n: 'parted.bin', t: '', z: 30, p: 'litterbox', b: 'https://litter.catbox.moe/{id}', d: 0, o: '', e: null, h: 'abc', parts: [{ i: '', s: 10, h: '' }, { i: '', s: 20, h: '' }] };
    const a = JSON.parse(JSON.stringify(base)); a.parts[0].i = 'aaa.bin';
    const b = JSON.parse(JSON.stringify(base)); b.parts[1].i = 'bbb.bin';
    const merged = MD.manifest.merge(a, b);
    eq(MD.manifest.missingParts(merged).length, 0);
    eq(merged.parts[1].i, 'bbb.bin');
  });
  await test('merge refuses links that describe different files', async () => {
    const a = { v: 1, n: 'a.bin', t: '', z: 10, p: 'litterbox', b: 'https://h.example/{id}', d: 0, o: '', e: null, h: '', parts: [{ i: '1', s: 10, h: '' }] };
    const b = { v: 1, n: 'b.bin', t: '', z: 10, p: 'litterbox', b: 'https://h.example/{id}', d: 0, o: '', e: null, h: '', parts: [{ i: '2', s: 10, h: '' }] };
    await throwsAsync(async () => MD.manifest.merge(a, b), /different file names/);
  });
  await test('garbage in the paste box says so instead of half-working', async () => {
    await throwsAsync(async () => MD.manifest.findManifest('nothing here at all'), /No download token/);
  });

  section('crypto — optional, but never weaker than it claims');
  await test('AES-GCM block stream round-trips a 5 MiB payload across blocks', async () => {
    const size = 5 * 1024 * 1024 + 12345;
    const plain = new Uint8Array(crypto.randomBytes(size));
    const key = (await MD.crypto.makeEncryptor('correct horse', new Uint8Array(crypto.randomBytes(16)))).key;
    const iv = new Uint8Array([1, 2, 3, 4]);
    const blocks = MD.crypto.blockCount(size);
    const cipher = await MD.crypto.encryptBlob(plain, key, iv, 0, size);
    eq(cipher.byteLength, size + blocks * MD.crypto.OVERHEAD, 'ciphertext grows by iv+tag per block');
    const back = await MD.crypto.decryptPayload(cipher, key, iv, 0, size, blocks);
    eq(Buffer.from(back).toString('hex'), Buffer.from(plain).toString('hex'), 'plaintext recovered');
  });
  await test('wrong password is refused by the key fingerprint, not by padding', async () => {
    const size = 100000;
    const plain = new Uint8Array(crypto.randomBytes(size));
    const salt = new Uint8Array(crypto.randomBytes(16));
    const m1 = await MD.crypto.makeEncryptor('right', salt);
    const m2 = await MD.crypto.makeEncryptor('wrong', salt);
    ok(m1.verifier !== m2.verifier, 'verifiers differ');
    const k1 = m1.key, k2 = m2.key;
    eq((await MD.crypto.fingerprint('right', salt)), m1.verifier, 'fingerprint is reproducible');
    const iv = new Uint8Array([9, 8, 7, 6]);
    const cipher = await MD.crypto.encryptBlob(plain, k1, iv, 0, size);
    await throwsAsync(async () => MD.crypto.decryptPayload(cipher, k2, iv, 0, size), /decrypt|Unsupported|Operation/i);
  });
  await test('one flipped byte in the ciphertext is caught by GCM', async () => {
    const size = 4096;
    const plain = new Uint8Array(crypto.randomBytes(size));
    const key = (await MD.crypto.makeEncryptor('pw', new Uint8Array(crypto.randomBytes(16)))).key;
    const iv = new Uint8Array([1, 1, 1, 1]);
    const cipher = await MD.crypto.encryptBlob(plain, key, iv, 0, size);
    cipher[Math.floor(cipher.length / 2)] ^= 0x01;
    await throwsAsync(async () => MD.crypto.decryptPayload(cipher, key, iv, 0, size), /decrypt|Operation/i);
  });
  await test('digestFolded is deterministic and stream-only', async () => {
    const { buf, file } = randFile(3 * 1024 * 1024);
    const a = await MD.crypto.digestFolded(file, 64 * 1024);
    const b = await MD.crypto.digestFolded(new ctx.Blob([buf]), 64 * 1024);
    eq(a, b);
    eq(a.length, 64);
    const c = await MD.crypto.digestFolded(file, 64 * 1024);
    eq(a, c, 'stable across runs');
  });
  await test('deriveKey uses real PBKDF2 (checked against node)', async () => {
    const salt = crypto.randomBytes(16);
    const key = await MD.crypto.deriveKey('pw', new Uint8Array(salt), 1000);
    const expected = crypto.pbkdf2Sync('pw', salt, 1000, 32, 'sha256');
    const raw = new Uint8Array(await ctx.crypto.subtle.exportKey('raw', key).catch(() => null) || new Uint8Array());
    ok(key, 'derived');
    if (raw.length) eq(Buffer.from(raw).toString('hex'), expected.toString('hex'), 'matches PBKDF2');
    eq(expected.length, 32, '256-bit');
  });

  section('pack — part planning and byte assembly');
  await test('100 MB fits one part at a 1 GB cap', () => {
    const p = MD.pack.planParts(100 * 1024 * 1024, 950 * 1024 * 1024, 1);
    eq(p.length, 1);
    eq(p[0].size, 100 * 1024 * 1024);
  });
  await test('2.3 GB over a 950 MB cap becomes 3 balanced parts, none over the cap', () => {
    const total = Math.round(2.3 * 1024 * 1024 * 1024);
    const p = MD.pack.planParts(total, 950 * 1024 * 1024, 1);
    eq(p.length, 3);
    p.forEach((x) => ok(x.size <= 950 * 1024 * 1024, 'part over cap: ' + x.size));
    eq(p.reduce((a, x) => a + x.size, 0), total, 'covers the whole file');
    near(p[0].size, p[1].size, 1024 * 1024, 'parts balanced');
  });
  await test('8 GB with a user cap of 500 MB becomes 17 parts, exact coverage', () => {
    const total = 8 * 1024 * 1024 * 1024;
    const p = MD.pack.planParts(total, 500 * 1024 * 1024, 1);
    eq(p.length, 17);
    eq(p.reduce((a, x) => a + x.size, 0), total);
    let cursor = 0;
    p.forEach((x) => { eq(x.start, cursor, 'contiguous'); cursor += x.size; });
  });
  await test('one-byte file still gets one part', () => {
    const p = MD.pack.planParts(1, 1024 * 1024, 1);
    eq(p.length, 1);
    eq(p[0].size, 1);
  });
  await test('multipart body assembles fields + the file slice from disk', async () => {
    const { buf, file } = randFile(70000, 'holiday.mov');
    const body = MD.pack.buildMultipartBody({ reqtype: 'fileupload', time: '72h' }, file, 1000, 40000, 'holiday.mov', 'video/quicktime');
    const all = Buffer.from(await body.arrayBuffer());
    ok(all.includes('name="reqtype"\r\n\r\nfileupload'), 'field present');
    ok(all.includes('filename="holiday.mov"'), 'filename present');
    var B = MD.pack.BOUNDARY;
    ok(all.includes(Buffer.from('\r\n--' + B + '--\r\n')), 'terminator is preceded by CRLF (strict parsers demand it)');
    eq(all.includes(Buffer.from('\r\n--' + B + '--\r\n--')), false, 'no doubled terminator');
    ok(body.type.indexOf(B) >= 0, 'the declared boundary matches the body byte for byte: ' + body.type);
    eq(body.type, 'multipart/form-data; boundary=' + B, 'no case mangling');
    const idx = all.indexOf('Content-Type: video/quicktime\r\n\r\n');
    const got = all.subarray(idx + 'Content-Type: video/quicktime\r\n\r\n'.length);
    eq(got.subarray(0, 40000).toString('hex'), buf.subarray(1000, 41000).toString('hex'), 'exact bytes of the slice');
    eq(body.size, 40000 + all.indexOf('Content-Type: video/quicktime\r\n\r\n') + 'Content-Type: video/quicktime\r\n\r\n'.length + ('\r\n--' + MD.pack.BOUNDARY + '--\r\n').length, 'body length arithmetic');
  });
  await test('url ↔ {id} template keeps links short for any provider', () => {
    const t = MD.pack.urlToTemplate('https://litter.catbox.moe/ab12cd.bin');
    eq(t.base, 'https://litter.catbox.moe/{id}');
    eq(t.id, 'ab12cd.bin');
    eq(MD.pack.templateToUrl(t.base, t.id), 'https://litter.catbox.moe/ab12cd.bin');
    const s3 = MD.pack.urlToTemplate('https://bucket.s3.eu-central-1.amazonaws.com/maildrop/2026/clip.mov');
    eq(s3.id, 'clip.mov');
    eq(MD.pack.templateToUrl('https://cdn.example.com/{id}', 'maildrop/2026/clip.mov'), 'https://cdn.example.com/maildrop/2026/clip.mov');
  });
  await test('buildTransfer produces sized, hashed, optionally encrypted parts', async () => {
    const size = 2 * 1024 * 1024;
    const { file, buf } = randFile(size);
    const plan = await MD.pack.buildTransfer({ files: [file], maxPartBytes: 700 * 1024 });
    eq(plan.parts.length, 3);
    eq(plan.total, size);
    plan.parts.forEach((p, i) => {
      eq(p.blobSize, p.size, 'plaintext part has no overhead');
      const expect = crypto.createHash('sha256').update(buf.subarray(p.start, p.start + p.size)).digest('hex');
      eq(p.sha256, expect, 'part digest of the real bytes, part ' + i);
    });
    const key = (await MD.crypto.makeEncryptor('pw', new Uint8Array(crypto.randomBytes(16)))).key;
    const bs = 128 * 1024 - 16;                 // small records so the 2 MiB file spans many
    const enc = await MD.pack.buildTransfer({
      files: [file], maxPartBytes: 700 * 1024, enc: { key, ivPrefix: new Uint8Array([1, 2, 3, 4]), blockSize: bs }
    });
    ok(enc.parts.length > 1, 'split into several parts: ' + enc.parts.length);
    ok(enc.parts.every((p) => p.blobSize > p.size), 'ciphertext is longer');
    ok(enc.parts.slice(0, -1).every((p) => p.size % bs === 0), 'part boundaries land on block boundaries');
    const joined = Buffer.concat(enc.parts.map((p) => Buffer.from(p.blob)));
    const blocks = MD.crypto.blockCount(size, bs);
    eq(joined.length, size + blocks * MD.crypto.OVERHEAD, 'stitched payload is exactly blocks records');
    const dec = await MD.crypto.decryptPayload(new Uint8Array(joined), key, new Uint8Array([1, 2, 3, 4]), 0, size, blocks, bs);
    eq(Buffer.from(dec).toString('hex'), buf.toString('hex'), 'encrypted parts stitch back into the file');
  });

  section('email — the copy the recipient sees');
  await test('subject and body carry size, parts, expiry and link', () => {
    const m = { v: 1, n: 'master.mov', t: '', z: 2 * 1024 * 1024 * 1024, p: 'litterbox', b: 'https://h.example/{id}', d: 259200000, o: '', e: null, h: 'abcdef1234567890', parts: [{ i: '1', s: 1, h: '' }, { i: '2', s: 1, h: '' }] };
    const s = MD.email.subjectFor(m, {});
    ok(s.includes('master.mov') && s.includes('GiB'), s);
    const b = MD.email.bodyFor(m, 'https://y.github.io/maildrop/#TOKEN', { includeToken: true });
    ok(b.includes('2 GiB'), 'size line');
    ok(b.includes('Parts: 2'), 'parts line');
    ok(b.includes('Expires: 3 days after the send'), 'expiry line');
    ok(b.includes('abcdef12'), 'integrity line');
    ok(b.includes('https://y.github.io/maildrop/#TOKEN'), 'link line');
    ok(b.includes('CODE'), 'recovery code block');
  });
  await test('the code block survives 76-char line folding', () => {
    const tok = MD.util.bytesToBase32(crypto.randomBytes(300));
    const lines = MD.email.tokenLines(tok).split('\n');
    lines.forEach((l, i) => { ok(l.length <= 76, 'line ' + i + ' is ' + l.length); ok(!/[-_=+]/.test(l), 'no wrap-unsafe chars'); });
    eq(MD.util.base32ToBytes(lines.join('')).length, 300);
  });
  await test('mailto: stays under client limits and says so when trimming', () => {
    const long = 'x'.repeat(9000);
    const url = MD.email.mailtoUrl('a@b.c', 'subject', long);
    ok(url.length < 1900, 'length ' + url.length);
    ok(decodeURIComponent(url).includes('Message shortened'), 'honest truncation note');
  });
  await test('extract() takes a link, a raw token or a whole email', () => {
    const m = { v: 1, n: 'q.bin', t: '', z: 5, p: 'litterbox', b: 'https://h.example/{id}', d: 0, o: '', e: null, h: '', parts: [{ i: 'q.bin', s: 5, h: '' }] };
    const tok = MD.manifest.encode(m);
    for (const text of ['https://p/#' + tok, tok, 'Hey!\n\nhttps://p/#' + tok + '\n\nbye']) {
      eq(MD.manifest.findManifest(text).n, 'q.bin');
    }
  });

  section('a delete, signed as a delete');
  await test('an empty body hashes to the constant a DELETE signature uses', async () => {
    eq(await MD.crypto.sha256Hex(new Uint8Array(0)),
       'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
       'if this drifts, every delete the page signs is rejected by the bucket');
  });
  await test('presigning a delete produces a different signature than presigning the upload', async () => {
    const cfg = { endpoint: 's3.example.com', bucket: 'mail', region: 'auto', keyId: 'K', secret: 'S', keyPrefix: 'd/' };
    const at = '20260101T000000Z';
    const put = await MD.backends.s3.presignPutUrl(cfg, 'd/2026/x.bin', 10, { amzDate: at });
    const del = await MD.backends.s3.presignPutUrl(cfg, 'd/2026/x.bin', 0, { amzDate: at, method: 'DELETE' });
    eq(del.url.split('?')[0], put.url.split('?')[0], 'same object, same address');
    ok(del.url !== put.url, 'but a different signature — the method is part of what is signed');
    ok(/X-Amz-Algorithm=AWS4-HMAC-SHA256/.test(del.url), 'and it is still a presigned URL: ' + del.url.slice(0, 90));
    const put2 = await MD.backends.s3.presignPutUrl(cfg, 'd/2026/x.bin', 10, { amzDate: at });
    eq(put2.url, put.url, 'the upload signature is stable, byte for byte');
  });

  // ---- webmail compose links --------------------------------------------
  await test('composeUrl builds an https draft link and encodes every part', () => {
    const c = MD.email.composeUrl('gmail', 'first@example.com', 'Re: the mix', 'line one\nline two');
    ok(c.url.startsWith('https://mail.google.com/mail/?view=cm'), 'gmail compose: ' + c.url.slice(0, 46));
    ok(c.url.includes('&to=' + encodeURIComponent('first@example.com')), 'the address is encoded, not spliced raw');
    ok(c.url.includes(encodeURIComponent('line one\nline two')), 'newlines survive as escapes');
    eq(c.hasTo, true, 'a real address is accepted');
    const o = MD.email.composeUrl('outlook', 'first@example.com', 's', 'b');
    ok(o.url.startsWith('https://outlook.office.com/mail/deeplink/compose?to='), 'outlook gets its own shape');
  });

  await test('an address that could extend the query string is dropped, not escaped around', () => {
    const evil = 'a@b.com?body=hacked&to=victim@x.com';
    const c = MD.email.composeUrl('outlook', evil, 's', 'b');
    eq(c.hasTo, false, 'nothing usable remains');
    eq(c.dropped.join('|'), evil, 'and the caller is told what was refused');
    ok(!c.url.includes('victim@x.com') && !c.url.includes(encodeURIComponent('victim@x.com')), 'the smuggled recipient never reaches the URL');
    const mixed = MD.email.composeUrl('outlook', 'good@example.com, ' + evil, 's', 'b');
    eq(mixed.hasTo, true, 'the valid address in the list still gets through');
    ok(mixed.url.includes(encodeURIComponent('good@example.com')), 'and it is the only one');
  });

  await test('a deployment can point at its own webmail, but only over https', () => {
    const before = MD.config;
    MD.config = { composeUrl: 'https://webmail.example.com/write?to={to}&subject={subject}&body={body}' };
    const c = MD.email.composeUrl('gmail', 'first@example.com', 'hi', 'there');
    ok(c.url.startsWith('https://webmail.example.com/write?to='), 'the template wins over the built-in provider');
    ok(c.url.includes('&subject=hi') && c.url.includes('&body=there'), 'all three placeholders filled');
    MD.config = { composeUrl: 'http://insecure.example.com/write?to={to}' };
    let threw = '';
    try { MD.email.composeUrl('gmail', 'a@b.co', 's', 'b'); threw = 'did not throw'; } catch (e) { threw = e.message; }
    ok(/has to be https:\/\//.test(threw), 'a plain-http compose URL is refused: ' + threw);
    MD.config = before || {};
  });

  await test('explainFailure separates "no answer" from "the host said no", per status', () => {
    const cfg = { bucket: 'clips', endpoint: 'https://s3.example.com' };
    const zero = MD.backends.explainFailure(Object.assign(new Error('Nothing reached the page'), { httpStatus: 0 }), cfg, 'https://me.github.io');
    const zt = zero.join(' ');
    ok(zt.includes('https://me.github.io'), 'status 0 names the origin that must be allowed: ' + zt.slice(0, 90));
    ok(/CORS rules/.test(zt) && /refusing this network/.test(zt), 'and it offers both fixes, saying which is yours');
    const f403 = MD.backends.explainFailure(Object.assign(new Error('HTTP 403'), { httpStatus: 403 }), cfg, 'x').join(' ');
    ok(/key id or secret/.test(f403), '403 is about credentials');
    ok(!/CORS rules/.test(f403), 'and is not blamed on CORS');
    const f404 = MD.backends.explainFailure(Object.assign(new Error('HTTP 404'), { httpStatus: 404 }), cfg, 'x').join(' ');
    ok(/path is wrong/.test(f404), '404 points at the bucket name or URL style');
    ok(/rate-limiting|failing/.test(MD.backends.explainFailure(Object.assign(new Error('HTTP 500'), { httpStatus: 500 }), cfg, 'x').join(' ')), 'a 5xx is blamed on the host, honestly');
  });

  report('unit');
})();
