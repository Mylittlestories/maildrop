/* Test harness: loads the browser scripts (they are plain IIFEs with no deps)
   into a Node vm context that provides the handful of web APIs they use. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const LIB = path.join(__dirname, '..', 'lib');
const FILES = ['util.js', 'manifest.js', 'crypto.js', 'pack.js', 'backends.js', 'receive.js', 'email.js'];
// ui.js is intentionally not loaded: the tests drive the logic with a stub view.

function makeSandbox(extraGlobals) {
  const sandbox = {
    crypto: global.crypto,
    TextEncoder, TextDecoder,
    Blob: global.Blob, File: global.File,
    URL: global.URL, fetch: global.fetch, AbortController, ReadableStream,
    setTimeout, clearTimeout, Promise, console,
    Buffer,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    navigator: { userAgent: 'node-test' },
    isSecureContext: true,
    location: { href: 'https://pages.example/maildrop/index.html', hash: '', pathname: '/maildrop/index.html' },
    localStorage: memStorage(),
    document: { readyState: 'complete', getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, click() {} }), addEventListener() {}, querySelectorAll: () => [], body: { appendChild() {}, removeChild() {} } },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  Object.assign(sandbox, extraGlobals || {});
  return vm.createContext(sandbox);
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const APP = ['app.js'];

function loadLib(context, withApp) {
  const list = FILES.concat(withApp ? APP : []);
  for (const f of list) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    new vm.Script(src, { filename: path.join(LIB, f) }).runInContext(context);
  }
  return context.MD;
}

// ---- tiny assert framework -------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; process.stdout.write('  \x1b[32m✓\x1b[0m ' + name + '\n'); })
    .catch((e) => { failed++; failures.push([name, e]); process.stdout.write('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e) + '\n'); });
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' !== ' + JSON.stringify(b));
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + v); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error((msg || 'not near') + ': ' + a + ' vs ' + b); }
function section(t) { process.stdout.write('\n\x1b[1m' + t + '\x1b[0m\n'); }
async function throwsAsync(fn, re, msg) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error(msg || 'expected a throw, got none');
  if (re && !re.test(String(err.message))) throw new Error(msg || 'wrong error: ' + err.message);
  return err;
}

function report(label) {
  process.stdout.write('\n' + label + ': ' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) {
    for (const [n, e] of failures) process.stdout.write(' - ' + n + ': ' + (e && e.message) + '\n');
    process.exitCode = 1;
  }
}

// ---- mock host lifecycle: PORT=0, learn the real port from stdout ----------
function startMock(root) {
  const { spawn } = require('child_process');
  const http = require('http');
  const srv = spawn(process.execPath, [path.join(root, 'tools', 'mock-host.mjs')], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0' }
  });
  let out = '';
  const portReady = new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('mock host did not report a port')), 8000);
    srv.stdout.on('data', (d) => {
      out += d.toString();
      const m = /MOCKPORT=(\d+)/.exec(out);
      if (m) { clearTimeout(to); res(Number(m[1])); }
    });
    srv.on('exit', (c) => rej(new Error('mock host exited early: ' + c + ' ' + out)));
  });
  return portReady.then(async (port) => {
    const base = 'http://127.0.0.1:' + port + '/';
    await new Promise((res, rej) => {
      const t0 = Date.now();
      (function tick() {
        const q = http.get(base, () => { q.destroy(); res(); });
        q.on('error', () => (Date.now() - t0 > 5000 ? rej(new Error('mock host unreachable')) : setTimeout(tick, 60)));
      })();
    });
    return { port, base, kill: () => srv.kill('SIGTERM'), stderr: out };
  });
}

module.exports = { makeSandbox, loadLib, loadAll: (c) => loadLib(c, true), startMock, test, eq, ok, near, throwsAsync, section, report, FILES, LIB, path, fs };
