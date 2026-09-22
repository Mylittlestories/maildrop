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

  report('page');
})();
