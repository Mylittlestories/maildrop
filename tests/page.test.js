'use strict';
/* Static consistency checks. These catch the boring-but-fatal mistakes a
   build-less app can ship with: a UI handler calling into an element that does
   not exist, a <script> that points at a missing file, or a sneaky CDN
   dependency that breaks "works offline, no third-party requests". */
const fs = require('fs');
const path = require('path');
const { test, eq, ok, report, section, LIB } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function idsInHtml() {
  const set = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) set.add(m[1]);
  return set;
}
function idRefs(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = new Set();
  const re = /\bid\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

(async () => {
  section('page — markup, wiring and self-containment');

  const present = idsInHtml();

  await test('every id() the UI touches exists in the page', () => {
    const missing = [];
    for (const f of ['lib/ui.js', 'lib/app.js']) {
      for (const ref of idRefs(f)) if (!present.has(ref)) missing.push(f + ' → #' + ref);
    }
    eq(missing.join(', '), '', missing.length + ' dangling element reference(s)');
  });

  await test('every data-tab control has a matching panel', () => {
    const tabs = [...html.matchAll(/<button data-tab="([^"]+)"/g)].map((m) => m[1]);
    tabs.forEach((t) => ok(present.has('panel-' + t), 'panel-' + t + ' missing for tab ' + t));
    const panels = [...html.matchAll(/id="panel-([^"]+)"/g)].map((m) => m[1]);
    eq(panels.sort().join(','), tabs.sort().join(','), 'tabs and panels must match 1:1');
  });

  await test('every script and stylesheet referenced by the page exists', () => {
    const refs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const local = refs.filter((r) => !/^(https?:|data:|mailto:)/.test(r));
    local.forEach((r) => {
      if (r.endsWith('.md')) { ok(fs.existsSync(path.join(ROOT, r)), 'doc missing: ' + r); return; }
      ok(fs.existsSync(path.join(ROOT, r)), 'missing asset: ' + r);
    });
    ok(local.length >= 10, 'expected the lib files to be linked, found ' + local.length);
  });

  await test('the page loads all ten lib files in dependency order', () => {
    const order = [...html.matchAll(/<script src="lib\/([^"]+)"><\/script>/g)].map((m) => m[1]);
    const want = ['util.js', 'config.js', 'manifest.js', 'crypto.js', 'pack.js', 'backends.js', 'receive.js', 'email.js', 'ui.js', 'app.js'];
    eq(order.join(','), want.join(','), 'script order');
    const onDisk = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();
    eq(onDisk.sort().join(','), want.slice().sort().join(','), 'lib/*.js on disk must match the page: ' + onDisk.join(','));
  });

  await test('no external scripts, styles or fonts — the app must run offline', () => {
    const bad = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !/docs\/|README/.test(u));
    eq(bad.join(' '), '', 'external references found: ' + bad.join(' '));
    const code = ['util.js', 'config.js', 'manifest.js', 'crypto.js', 'pack.js', 'backends.js', 'receive.js', 'email.js', 'ui.js', 'app.js']
      .map((f) => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n');
    eq(/<(script|link)\b|document\.write|importScripts|new Worker|createElement\("script"\)/i.test(code), false, 'no dynamic script loading');
    ok(code.includes('litterbox.catbox.moe'), 'the only remote hosts are the storage endpoints you choose');
    eq((code.match(/https?:\/\/(?!127\.0\.0\.1|localhost|s3\.|files\.catbox|litter\.catbox|litterbox|tmpfiles)[a-z0-9.-]+\//gi) || [])
      .filter((u) => !/schema|w3\.org|example|amazonaws|backblazeb2|cloudflare|wasabi|catbox|tmpfiles/.test(u)).join(' '), '', 'stray third-party URLs');
  });

  await test('nothing in the shipped page leaks a secret to the host', () => {
    const code = ['app.js', 'ui.js', 'backends.js', 'email.js'].map((f) => fs.readFileSync(path.join(LIB, f), 'utf8')).join('\n');
    // the password must never be sent anywhere, and the hash must not be
    // included in the mail body's visible text beyond the file name
    eq(/body\s*[:=][^;\n]*password/i.test(code), false, 'no password in the outgoing email body');
    ok(!/fetch\([^)]*\b(cfg\.secret|state\.cfg\.password)/.test(code), 'credentials are only used for signing');
    ok(/localStorage/.test(code), 'settings stay local');
    eq(/localStorage\.setItem\([^,]+,\s*JSON\.stringify\(\s*\{\s*secret/.test(code), false, 'the bucket secret is written with the whole settings object only (documented risk), never on its own');
  });

  await test('CORS-relevant claim is honest: the receive page needs no CORS for a plain host link', () => {
    const recv = fs.readFileSync(path.join(LIB, 'receive.js'), 'utf8');
    ok(/Range/.test(recv), 'range requests used for slicing');
    ok(/fetch\(/.test(recv) && !/mode:\s*['"]no-cors/.test(recv), 'never pretends to read a no-cors response');
  });

  await test('the manifest is carried in the hash, never in the query string', () => {
    const man = fs.readFileSync(path.join(LIB, 'manifest.js'), 'utf8');
    ok(/HASH_PREFIX = '#'/.test(man), 'hash prefix constant');
    eq(/'\?'/.test(man), false, 'no query-string embedding');
  });

  await test('what a static host must serve is really there: scripts, docs, and no dotfiles', async () => {
    const { startServe } = require('./harness.js');
    const srv = await startServe(ROOT);
    try {
      const page = await fetch(srv.base);
      eq(page.status, 200, 'the page itself');
      ok(/^text\/html/.test(page.headers.get('content-type') || ''), 'served as HTML');
      const body = await page.text();
      const scripts = [...body.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      eq(scripts.length, 10, 'ten local scripts referenced');
      for (const src of scripts) {
        const r = await fetch(srv.base + src);
        eq(r.status, 200, src + ' resolves relative to the page');
        ok(/javascript/.test(r.headers.get('content-type') || ''), src + ' is served as JavaScript');
      }
      const links = [...html.matchAll(/href="((?:docs|README)[^"]*)"/g)].map((m) => m[1]);
      ok(links.length >= 4, 'the page links its docs: ' + links.join(' '));
      for (const href of links) eq((await fetch(srv.base + href)).status, 200, 'doc link is real: ' + href);
      eq((await fetch(srv.base + '.git/config')).status, 404, 'no dotfiles out of a preview server');
      eq((await fetch(srv.base + 'nowhere.js')).status, 404, 'a 404 says what is missing');
    } finally {
      srv.kill();
    }
  });

  await test('the icon set the page promises is really there, and really an image', async () => {
    const { startServe } = require('./harness.js');
    const srv = await startServe(ROOT);
    try {
      const refs = [...html.matchAll(/<(?:link|img)[^>]*(?:href|src)="((?:assets\/[^"]+|manifest\.webmanifest))"/g)].map((m) => m[1]);
      ok(refs.length >= 6, 'the page references its whole icon set, found ' + refs.length);
      for (const ref of new Set(refs)) {
        const r = await fetch(srv.base + ref);
        eq(r.status, 200, ref + ' is served next to the page');
        const ct = r.headers.get('content-type') || '';
        ok(/image\/|manifest\+json|application\/json/.test(ct), ref + ' arrives as an image or manifest, not "' + ct + '"');
      }
      // a favicon declared at the wrong size is served but ignored by the browser,
      // so the size attribute is checked against the PNG header rather than trusted
      const declared = [...html.matchAll(/<link rel="icon"[^>]*sizes="(\d+)x(\d+)"[^>]*href="([^"]+)"/g)];
      ok(declared.length >= 2, 'the raster favicons declare their sizes');
      for (const [, w, h, href] of declared) {
        const buf = fs.readFileSync(path.join(ROOT, href));
        eq(buf.readUInt32BE(16), Number(w), href + ' really is ' + w + ' px wide');
        eq(buf.readUInt32BE(20), Number(h), href + ' really is ' + h + ' px tall');
      }
    } finally {
      srv.kill();
    }
  });

  await test('the shipped icons are the generated ones, not a hand edit', async () => {
    const mod = await import('../tools/make-icons.mjs');     // imported, not run: no rasterising here
    eq(fs.readFileSync(path.join(ROOT, 'assets/icon.svg'), 'utf8'), mod.iconSvg(),
      'assets/icon.svg is byte-for-byte what tools/make-icons.mjs writes');
    eq(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'), mod.manifestText(),
      'manifest.webmanifest is byte-for-byte what tools/make-icons.mjs writes');
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    ok(man.icons.length === 3, 'the manifest offers 192, 512 and a maskable 512');
    for (const ic of man.icons) {
      const buf = fs.readFileSync(path.join(ROOT, ic.src));
      eq(buf.readUInt32BE(16), Number(ic.sizes.split('x')[0]), ic.src + ' is the width the manifest claims');
      eq(buf.readUInt32BE(20), Number(ic.sizes.split('x')[1]), ic.src + ' is the height the manifest claims');
      ok(buf.length > 400, ic.src + ' carries actual pixels (' + buf.length + ' bytes)');
    }
    ok(man.start_url === './' && man.scope === './', 'installed, it starts and stays on this site');
    const G = mod.GEOMETRY;
    ok(G.CHEVRON_TIP <= G.TRAY_TOP, 'the arrow head stops at the rim: caught, not punched through the tray');
    ok(G.TRAY_TOP - G.FLARE_H >= G.CHEVRON_ARM_Y + 30, 'the flared wall tops clear the arrow arms — at 16 px, anything closer fuses into one smudge');
  });

  report('page');
})();
