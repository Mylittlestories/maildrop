/* Mock of the public upload hosts, so the upload/download code paths run for
   real (multipart body assembly, XHR, HTTP, Range requests) without a network.
   Also usable by hand: `node tools/mock-host.mjs` then open the page at
   http://localhost:8099/ and pick the "Local mock host" provider. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = new Map(); // id -> { buf, type }
let seen = [];

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Requested-With');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  seen.push(req.method + ' ' + url.pathname + (url.search || ''));
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- the page itself (so you can click through it locally) -------------
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(path.join(ROOT, 'index.html'), (e, b) => {
      if (e) { res.writeHead(500); res.end('no index.html'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(b);
    });
  }
  if (req.method === 'GET' && (url.pathname.startsWith('/lib/') || url.pathname.startsWith('/css/') || url.pathname.startsWith('/tools/'))) {
    const f = path.join(ROOT, path.normalize(url.pathname.slice(1)));
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    return fs.readFile(f, (e, b) => {
      if (e) { res.writeHead(404); res.end('missing'); return; }
      const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/plain';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(b);
    });
  }

  // ---- upload: litterbox-style multipart POST ----------------------------
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      const bm = /boundary=(.+)$/.exec(ct);
      let filename = 'anon.bin', fileBuf = body;
      if (bm) {
        const parts = body.toString('latin1').split('--' + bm[1].trim());
        for (const p of parts) {
          const fm = /filename="([^"]*)"/.exec(p);
          if (!fm) continue;
          filename = fm[1];
          const idx = p.indexOf('\r\n\r\n');
          if (idx < 0) continue;
          let payload = p.slice(idx + 4);
          if (payload.endsWith('\r\n')) payload = payload.slice(0, -2);
          fileBuf = Buffer.from(payload, 'latin1');
        }
      }
      if (fileBuf.length > 2 * 1024 * 1024 && process.env.MOCK_MAX_BYTES && fileBuf.length > Number(process.env.MOCK_MAX_BYTES)) {
        res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('file too large (mock cap)'); return;
      }
      const id = crypto.randomBytes(4).toString('hex') + (path.extname(filename) || '.bin');
      STORE.set(id, { buf: fileBuf, type: 'application/octet-stream', filename });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      // absolute URL built from the request's own Host, so any port works
      res.end('http://' + (req.headers.host || '127.0.0.1:' + PORT) + '/f/' + id);
    });
    return;
  }

  // ---- upload: bucket-style raw PUT -------------------------------------
  if (req.method === 'PUT' && url.pathname.startsWith('/bucket/')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const id = url.pathname.slice('/bucket/'.length);
      STORE.set(id, { buf, type: req.headers['content-type'] || 'application/octet-stream', filename: id.split('/').pop() });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'ETag': '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"' });
      res.end('');
    });
    return;
  }

  // ---- download, with byte ranges + occasional forced range use ----------
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/f/')) {
    const id = url.pathname.slice(3);
    const rec = STORE.get(id);
    if (!rec) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('gone (mock store lost the file)'); return; }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const from = Number(m[1]);
      const to = m[2] ? Math.min(Number(m[2]), rec.buf.length - 1) : rec.buf.length - 1;
      const len = to - from + 1;
      res.writeHead(206, {
        'Content-Range': 'bytes ' + from + '-' + to + '/' + rec.buf.length,
        'Content-Length': len, 'Accept-Ranges': 'bytes'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(rec.buf.subarray(from, to + 1));
    }
    res.writeHead(200, { 'Content-Length': rec.buf.length, 'Accept-Ranges': 'bytes', 'Content-Type': rec.type });
    if (req.method === 'HEAD') return res.end();
    return res.end(rec.buf);
  }

  if (req.method === 'GET' && url.pathname === '/__seen') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ requests: seen, stored: [...STORE.keys()].map((k) => ({ id: k, size: STORE.get(k).buf.length })) }));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('mock-host: nothing at ' + url.pathname);
});

const PORT = Number(process.env.PORT === '0' ? 0 : (process.env.PORT || 8099));
server.listen(PORT, '127.0.0.1', () => {
  const p = server.address().port;
  console.log('MOCKPORT=' + p);
  console.log('mock host on http://127.0.0.1:' + p + '  (page: http://127.0.0.1:' + p + '/)');
});
