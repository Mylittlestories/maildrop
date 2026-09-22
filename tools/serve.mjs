/* Tiny static server for local use: node tools/serve.mjs [port]
   No dependencies, and no python in the loop. Bind 0.0.0.0 so a phone on the
   same network can open the page too (HTTPS is required for the optional
   password path — see docs/DEPLOY-GITHUB.md). */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('nope'); return; }
    let s = null;
    try { s = await stat(file); } catch (e) { /* fall through to 404 */ }
    if (!s || !s.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 ' + p + ' — the app is index.html plus lib/*.js');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': s.size,
      'cache-control': 'no-store',
      // so a page served here can still read parts from a second origin in dev
      'access-control-allow-origin': '*'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('MailDrop on http://127.0.0.1:' + PORT + '/   (root: ' + ROOT + ')');
});
