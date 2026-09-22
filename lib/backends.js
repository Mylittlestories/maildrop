/* MailDrop — storage backends. Every backend is just "put bytes, get an id":
   there is no MailDrop server anywhere. Two no-signup public hosts are wired in
   for small transfers, a bring-your-own bucket backend (any S3-compatible API:
   Backblaze B2, Cloudflare R2, Wasabi, MinIO, Hetzner…) removes the size cap
   without you running a thing, and a local backend makes the whole pipeline
   testable offline. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  var MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  function xhrUpload(url, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(opts.method || 'POST', url, true);
      if (opts.headers) Object.keys(opts.headers).forEach(function (k) {
        if (k.toLowerCase() === 'content-type') { xhr.responseType = ''; }
        try { xhr.setRequestHeader(k, opts.headers[k]); } catch (e) { /* forbidden header */ }
      });
      if (opts.onProgress) {
        xhr.upload.onprogress = function (ev) { opts.onProgress(ev.loaded, ev.total || 1); };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve({ status: xhr.status, text: xhr.responseText, xhr: xhr });
        else {
          var err = new Error('HTTP ' + xhr.status + (xhr.responseText ? ' — ' + U.truncateUtf8(xhr.responseText.replace(/\s+/g, ' ').trim(), 160) : ''));
          err.httpStatus = xhr.status;
          err.retryable = xhr.status >= 500 || xhr.status === 429 || xhr.status === 0;
          reject(err);
        }
      };
      xhr.onerror = function () {
        var err = new Error('Network/CORS failure talking to ' + (opts.label || 'the host') + '. The host may be rate-limiting this IP, blocking browser uploads, or offline.');
        err.retryable = true;
        reject(err);
      };
      xhr.ontimeout = function () { var e = new Error('Upload timed out.'); e.retryable = true; reject(e); };
      if (opts.signal) {
        if (opts.signal.aborted) { reject(abortError()); return; }
        opts.signal.addEventListener('abort', function () { xhr.abort(); });
      }
      xhr.timeout = opts.timeoutMs || 0;
      xhr.send(body);
    });
  }

  function abortError() { var e = new Error('Cancelled.'); e.cancelled = true; return e; }

  function withRetry(fn, tries, onRetry) {
    return (async function () {
      var last;
      for (var attempt = 0; attempt < tries; attempt++) {
        try { return await fn(attempt); }
        catch (e) {
          last = e;
          if (e && (e.cancelled || (e.name === 'AbortError'))) throw e;
          if (e && e.retryable === false) throw e;
          if (attempt < tries - 1) {
            var wait = Math.min(20000, 1500 * Math.pow(2, attempt));
            if (onRetry) onRetry(attempt + 1, wait, e);
            await new Promise(function (r) { setTimeout(r, wait); });
          }
        }
      }
      throw last;
    })();
  }

  // ---------------------------------------------------------------- litterbox
  var litterbox = {
    key: 'litterbox',
    label: 'Litterbox (catbox.moe) — no signup',
    blurb: 'Anonymous temp host, max 1 GB per part, files expire on the schedule you pick. Browser CORS verified.',
    maxPartBytes: 950 * 1024 * 1024,
    expiries: [{ v: '1h', ms: HOUR }, { v: '12h', ms: 12 * HOUR }, { v: '24h', ms: DAY }, { v: '72h', ms: 3 * DAY }],
    defaultExpiry: '72h',
    // Without reqtype the endpoint answers "No request type given?", so these
    // two fields are not optional.
    fieldsFor: function (expiry) { return { reqtype: 'fileupload', time: expiry || this.defaultExpiry }; },
    upload: async function (body, opts) {
      opts = opts || {};
      var res = await xhrUpload('https://litterbox.catbox.moe/resources/internals/api.php', body, {
        method: 'POST', label: 'litterbox.catbox.moe', onProgress: opts.onProgress, signal: opts.signal
      });
      var text = String(res.text || '').trim();
      var m = /^(https?:\/\/[^\s]+)$/i.exec(text);
      if (!m) throw new Error('Litterbox returned something unexpected: ' + U.truncateUtf8(text, 160));
      var t = MD.pack.urlToTemplate(m[1]);
      return { id: t.id, base: t.base };
    },
    buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); }
  };

  // 'direct' uploads nothing: you point MailDrop at a link you already have
  // (x0.at, tmpfile.link, a Drive/OneDrive share, an internal server…) and it
  // composes the email and the receive page. Hosts that block cross-origin
  // reads — most of them — then simply get opened directly.
  var direct = {
    key: 'direct',
    label: 'A link I already have (bring your own)',
    blurb: 'No upload here: paste the download URL of a file you put somewhere yourself. MailDrop writes the email, names the file, and — if the host allows it — rebuilds and verifies it in the page.',
    maxPartBytes: 0,
    noUpload: true,
    expiries: [{ v: 'unknown', ms: 0 }],
    defaultExpiry: 'unknown',
    fieldsFor: function () { return {}; },
    upload: async function () { throw new Error('The “your own link” mode uploads nothing.'); },
    buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); }
  };

  // --------------------------------------------------------- self-host bucket
  // The id is whatever follows the base URL. The base may be given as a
  // template ("…/{id}"), as a bucket prefix, or as a bare endpoint.
  function s3IdFromUrl(url, base, bucket) {
    var s = String(url || '').trim();
    var b = String(base || '').trim();
    if (b.indexOf('{id}') >= 0) {
      var esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{id\\}', '(.+?)');
      var m = new RegExp('^' + esc + '$').exec(s);
      if (m) return m[1];
    }
    var prefixes = [];
    if (b) prefixes.push(b.replace(/\/+$/, '') + '/');
    if (bucket && b) {
      prefixes.push(b.replace(/\/+$/, '') + '/' + bucket + '/');
      if (/^https?:\/\//i.test(b)) prefixes.push(b.replace(/\/+$/, '') + '/');
    }
    for (var i = 0; i < prefixes.length; i++) {
      if (s.indexOf(prefixes[i]) === 0) return s.slice(prefixes[i].length);
    }
    var tail = s.replace(/^https?:\/\/[^/]+\/?/, '');
    if (tail && tail !== s) return tail;
    throw new Error('Could not extract an object id from: ' + s);
  }

  var selfhost = {
    key: 'selfhost',
    label: 'Your own bucket (B2 / R2 / Wasabi / MinIO / any S3 API)',
    blurb: 'Free tiers: Backblaze B2 10 GB, Cloudflare R2 10 GB + unmetered egress. You set it up once in Settings; nothing to install or run.',
    maxPartBytes: 4 * 1024 * 1024 * 1024, // single-PUT ceiling on S3-compatible APIs is 5 GB
    fieldsFor: function () { return {}; },
    expiries: [{ v: '1h', ms: HOUR }, { v: '24h', ms: DAY }, { v: '7d', ms: 7 * DAY }, { v: '30d', ms: 30 * DAY }, { v: 'never', ms: 0 }],
    defaultExpiry: '7d',

    validateCfg: function (cfg) {
      var e = [];
      if (!cfg || !cfg.endpoint) e.push('endpoint URL');
      if (!cfg || !cfg.bucket) e.push('bucket');
      if (!cfg || !cfg.keyId) e.push('access key id');
      if (!cfg || !cfg.secret) e.push('secret access key');
      if (cfg && cfg.allowHttp === false && /^http:\/\//i.test(cfg.endpoint || '')) e.push('endpoint must be https://');
      return e;
    },

    configured: function (cfg) { return !this.validateCfg(cfg).length; },

    objectKey: function (cfg, filename) {
      var prefix = String(cfg.keyPrefix || 'maildrop/').replace(/^\/+|[^A-Za-z0-9._\/-]/g, '');
      if (prefix && prefix.slice(-1) !== '/') prefix += '/';
      var stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
      var rnd = U.toHex(U.randomBytes(6));
      var name = U.cleanName(filename || 'file.bin').replace(/[^A-Za-z0-9._()\- ]/g, '_').slice(0, 120);
      return prefix + stamp + '-' + rnd + '/' + name;
    },

    // Which headers must match the signature. Kept to "query only" on purpose:
    // an x-amz-* header would force a CORS preflight against your bucket.
    upload: async function (body, opts) {
      opts = opts || {};
      var cfg = opts.cfg;
      var signed = await presignPutUrl(cfg, opts.objectKey, body.size, {
        amzDate: opts.amzDate, expiry: opts.expirySeconds
      });
      await xhrUpload(signed.url, body, {
        method: 'PUT', label: (cfg.bucket || 'bucket') + ' (your bucket)',
        onProgress: opts.onProgress, signal: opts.signal
      });
      return { id: opts.objectKey, base: publicBase(cfg) + '/{id}' };
    },


    buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); }
  };

  function publicBase(cfg) {
    var b = (cfg.publicBase || '').trim();
    if (b) return b.replace(/\/+$/, '') + '/';
    var ep = withScheme(cfg.endpoint);
    return ep + '/' + cfg.bucket + '/';
  }

  function stripSlash(s) { return String(s || '').trim().replace(/\/+$/, ''); }

  // People paste "s3.us-west-004.backblazeb2.com" from the dashboard as often as
  // they paste the full URL, so accept both and always emit a valid origin.
  function withScheme(s) {
    var v = stripSlash(String(s || '').trim());
    if (!v) return v;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    return v;
  }

  // AWS SigV4 presigned PUT, built with WebCrypto only. Deliberately signs the
  // `host` header alone and carries x-amz-* in the query, so the browser PUT is
  // a "simple" cross-origin request: no CORS preflight against your bucket.
  async function presignPutUrl(cfg, key, byteLength, opts) {
    opts = opts || {};
    var endpoint = withScheme(cfg.endpoint);
    var region = cfg.region || 'auto';
    var amzDate = opts.amzDate || utcAmzDate();
    var dateStamp = amzDate.slice(0, 8);
    var payloadHash = 'UNSIGNED-PAYLOAD';
    var expires = Math.max(900, Math.min(604800, Number(opts.expiry || cfg.signedUrlExpiry) || 86400));

    var host = endpoint.replace(/^https?:\/\//, '');
    var path = (cfg.virtualHosted ? '/' : '/' + cfg.bucket + '/') +
      String(key).split('/').map(encSeg).join('/');

    var q = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', cfg.keyId + '/' + dateStamp + '/' + region + '/s3/aws4_request'],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', 'host']
    ];
    if (cfg.securityToken) q.push(['X-Amz-Security-Token', cfg.securityToken]);
    q.sort(function (a, b) {
      var x = a[0].toLowerCase(), y = b[0].toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    var canonicalQuery = q.map(function (p) { return encQ(p[0]) + '=' + encQ(p[1]); }).join('&');

    var canonicalRequest = [
      'PUT',
      path,
      canonicalQuery,
      'host:' + host + '\n',
      'host',
      payloadHash
    ].join('\n');

    var scope = dateStamp + '/' + region + '/s3/aws4_request';
    var stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256HexOfText(canonicalRequest)
    ].join('\n');

    var kDate = await hmac(await hmac(U.utf8Encode('AWS4' + cfg.secret), dateStamp), region);
    var kService = await hmac(kDate, 's3');
    var kSigning = await hmac(kService, 'aws4_request');
    var signature = U.toHex(await hmac(kSigning, stringToSign));

    return {
      url: endpoint + path + '?' + canonicalQuery + '&X-Amz-Signature=' + signature,
      canonicalRequest: canonicalRequest,
      stringToSign: stringToSign,
      signature: signature,
      amzDate: amzDate,
      bytes: byteLength
    };
  }

  function encSeg(s) { return encodeURIComponent(s).replace(/%2F/g, '/'); }
  function encQ(s) { return encodeURIComponent(String(s)).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); }); }

  function utcAmzDate(d) {
    var t = (d || new Date());
    var p = function (n, l) { n = String(n); while (n.length < (l || 2)) n = '0' + n; return n; };
    return t.getUTCFullYear() + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) + 'T' +
      p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds()) + 'Z';
  }

  async function sha256HexOfText(s) { return MD.crypto.sha256Hex(U.utf8Encode(s)); }
  async function hmac(keyBytes, msg) {
    var key = await global.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await global.crypto.subtle.sign('HMAC', key, U.utf8Encode(msg)));
  }

  // --------------------------------------------------------------------- local
  // In-browser staging area. Used by "test mode" so a first-time user can watch
  // the whole pipeline (pack → store → fetch → stitch → verify) run offline.
  // Memory store when IndexedDB is unavailable (private mode, file://, tests).
  var memStore = global.__MD_MEM__ = global.__MD_MEM__ || Object.create(null);

  function hasIdb() { return typeof global.indexedDB !== 'undefined' && global.indexedDB; }

  var local = {
    key: 'local',
    label: 'This device only (test mode)',
    blurb: 'Runs the full pack → store → fetch → assemble pipeline against local storage, no network at all.',
    maxPartBytes: 512 * 1024 * 1024,
    expiries: [{ v: 'session', ms: 0 }],
    defaultExpiry: 'session',
    fieldsFor: function () { return {}; },
    upload: async function (body, opts) {
      opts = opts || {};
      var id = 'part-' + U.toHex(U.randomBytes(6));
      if (opts.onProgress) opts.onProgress(body.size, body.size);
      await putBlob(id, body);
      return { id: id, base: 'local://{id}' };
    },
    buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); },
    isLocal: true
  };

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = global.indexedDB.open('maildrop-local', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function putBlob(id, blob) {
    if (!hasIdb()) { memStore[id] = blob; return true; }
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, id);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function getBlob(id) {
    if (!hasIdb()) return memStore[id] || null;
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('blobs', 'readonly');
      var r = tx.objectStore('blobs').get(id);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
  }

  async function deleteBlob(id) {
    if (!hasIdb()) { delete memStore[id]; return true; }
    var db = await openDb();
    return new Promise(function (resolve) {
      var tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(id);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
    });
  }

  // A part URL of the form local://<id> is fetched from the staging area instead
  // of the network, which keeps the receive code path identical for both.
  async function resolvePart(url) {
    var m = /^local:\/\/(.+)$/.exec(String(url || ''));
    if (!m) return null;
    var blob = await getBlob(m[1]);
    if (!blob) throw new Error('Test-mode data for part ' + m[1] + ' is gone (page was reloaded?).');
    return new Uint8Array(await blob.arrayBuffer());
  }

  // --------------------------------------------------------------- mock host
  // Only offered when the page is served from localhost: lets you exercise the
  // real upload/download code path against tools/mock-host.mjs, or against a
  // browser on file:// (via URL ?mock=http://127.0.0.1:8099).
  var mockhost = {
    key: 'mockhost',
    label: 'Local mock host (development)',
    blurb: 'talks to tools/mock-host.mjs on 127.0.0.1 — for testing the pipeline only',
    maxPartBytes: 512 * 1024 * 1024,
    expiries: [{ v: 'session', ms: 0 }],
    defaultExpiry: 'session',
    fieldsFor: function () { return {}; },
    base: 'http://127.0.0.1:8099/',
    upload: async function (body, opts) {
      opts = opts || {};
      var base = mockhost.base;
      if (opts.onProgress) opts.onProgress(0, body.size);
      var res = await xhrUpload(base + 'api/upload', body, {
        method: 'POST', label: 'mock host', onProgress: opts.onProgress, signal: opts.signal
      });
      if (opts.onProgress) opts.onProgress(body.size, body.size);
      var t = MD.pack.urlToTemplate(String(res.text || '').trim());
      return { id: t.id, base: t.base };
    },
    buildUrl: function (id, base) { return MD.pack.templateToUrl(base, id); }
  };

  function isLocalhost() {
    try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(global.location.hostname); } catch (e) { return false; }
  }

  var backends = {
    list: [litterbox, selfhost, direct, local].concat(isLocalhost() || (typeof process !== 'undefined') ? [mockhost] : []),
    byKey: { litterbox: litterbox, selfhost: selfhost, direct: direct, local: local, mockhost: mockhost },
    get: function (key) { return this.byKey[key] || null; },
    xhrUpload: xhrUpload,
    withRetry: withRetry,
    s3: {
      presignPutUrl: presignPutUrl,
      objectKey: selfhost.objectKey,
      publicBase: publicBase,
      idFromUrl: s3IdFromUrl,
      utcAmzDate: utcAmzDate
    },
    local: { getBlob: getBlob, putBlob: putBlob, deleteBlob: deleteBlob, resolvePart: resolvePart },
    resolvePart: resolvePart,
    mock: mockhost,
    litter: litterbox,
    direct: direct,
    selfhost: selfhost,
    // True when the endpoint wants a multipart form rather than raw object bytes.
    wantsForm: function (backend) {
      return !(backend.key === 'selfhost' || backend.key === 'local' || backend.key === 'mockhost');
    },
    // Wraps bytes in the shape the endpoint expects. `fields` comes from the
    // backend itself (litterbox refuses uploads without reqtype).
    partBody: function (backend, source, fields, filename, type) {
      if (!this.wantsForm(backend)) return source;
      return MD.pack.multipartFromBlob(fields || {}, source, filename, type);
    },
    uploadPart: async function (backend, body, opts) {
      opts = opts || {};
      return this.withRetry(function () {
        return backend.upload(body, opts);
      }, opts.tries || 3, opts.onRetry);
    },
    configuredFor: function (key, cfg) {
      var b = this.get(key);
      if (!b) return false;
      if (b.key === 'selfhost') return selfhost.validateCfg(cfg).length === 0;
      return true;
    },
    selfhostConfigured: function (cfg) { return selfhost.validateCfg(cfg).length === 0; }
  };

  MD.backends = backends;
})(typeof window !== 'undefined' ? window : globalThis);
