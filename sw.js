/* MailDrop service worker — offline shell for GitHub Pages.
   Static, no build step: precaches the 11 scripts + shell assets so
   “Install app” and airplane mode both work. Nothing about your file
   ever touches this cache — only the UI shell.
   Bump the CACHE name when you ship new bytes. */
const CACHE = 'maildrop-v1.3.2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-16.png',
  './assets/icon-32.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
  './lib/util.js',
  './lib/config.js',
  './lib/manifest.js',
  './lib/crypto.js',
  './lib/pack.js',
  './lib/backends.js',
  './lib/receive.js',
  './lib/email.js',
  './lib/qrcode.js',
  './lib/p2p.js',
  './lib/ui.js',
  './lib/app.js'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function(){}));
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  // Only handle same-origin; leave catbox / bucket fetches to the network.
  if (url.origin !== location.origin) return;
  // For the shell, serve cache-first, refresh in background.
  e.respondWith(caches.match(e.request).then(function (hit) {
    if (hit) return hit;
    return fetch(e.request).then(function (res) {
      // cache successful shell responses for next offline open
      if (res.ok && SHELL.some(function (p) { return e.request.url.endsWith(p.replace('./','/')); })){
        var clone = res.clone();
        caches.open(CACHE).then(function (c){ c.put(e.request, clone); });
      }
      return res;
    });
  }));
});
