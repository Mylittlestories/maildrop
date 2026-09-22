/* MailDrop — the manifest: the whole transfer described in ~200-500 bytes,
   packed into an email-safe base32 token that lives in the URL *hash*
   (hashes never reach the web server, never appear in Referer headers,
   and survive email line-wrapping because the alphabet has no '-' or '='). */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  var VERSION = 1;
  var HASH_PREFIX = '#';
  var TOKEN_RE = /#([A-Z2-7]{40,})/i;

  function canonical(m) {
    if (!m || typeof m !== 'object') throw new Error('manifest: not an object');
    if (m.v !== VERSION) throw new Error('manifest: unsupported version ' + m.v);
    var parts = Array.isArray(m.parts) ? m.parts : [];
    if (!parts.length) throw new Error('manifest: no parts');
    var total = 0;
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || typeof p !== 'object') throw new Error('manifest: bad part ' + i);
      var size = Number(p.s) || 0;
      var pb = Number(p.b) || 0;
      total += size;
      out.push({ x: 0, i: p.i || '', s: size, h: p.h || '', b: pb });
    }
    // `x` is the part's index in the whole set, which for a partial manifest is
    // not its position in this array.
    for (var j = 0; j < out.length; j++) {
      var px = Number(parts[j] && parts[j].x);
      out[j].x = isFinite(px) && px > 0 ? px : j;
    }
    out.sort(function (a, b) { return a.x - b.x; });
    var c = {
      v: VERSION,
      n: U.cleanName(m.n),
      t: typeof m.t === 'string' ? m.t : '',
      z: Number(m.z) || total,
      p: String(m.p || 'litterbox'),
      b: typeof m.b === 'string' ? m.b : '',
      d: m.d == null ? null : String(m.d),
      o: m.o ? String(m.o) : '',
      c: Number(m.c) || 0,
      k: Number(m.k) || 0,
      // hm: 'file' (h is the file digest) | 'parts' (h binds the part digests)
      hm: m.hm === 'parts' ? 'parts' : 'file',
      // x: absolute deadline, so the receive page can say "expired" plainly
      x: Number(m.x) || 0,
      // f: 'page' (this app rebuilds the file) | 'direct' (host link only)
      f: m.f === 'direct' ? 'direct' : 'page',
      // u: when there is one part, the host URL itself, so the receive page can
      // offer "open it on the host" whenever its own fetch is blocked
      u: m.u ? String(m.u) : '',
      e: m.e || null,
      h: m.h ? String(m.h) : '',
      parts: out
    };
    // z is the size of the *original file*. In plaintext mode the parts carry
    // exactly those bytes so they must sum to it; with encryption they sum to
    // file size + GCM tags, which is legitimate, so no check there.
    var isPartial = Number(c.k) > c.parts.length;
    if (!c.e && !isPartial && c.z !== total) {
      throw new Error('manifest: parts sum to ' + total + ' bytes but the declared file size is ' + c.z);
    }
    if (isPartial) {
      var seen = {};
      c.parts.forEach(function (p) {
        if (p.x >= c.k) throw new Error('manifest: part index ' + p.x + ' is beyond the declared ' + c.k + ' parts');
        if (seen[p.x]) throw new Error('manifest: duplicate part ' + p.x);
        seen[p.x] = 1;
      });
    }
    if (c.e && !isPartial && c.parts.every(function (p) { return p.b > 0; })) {
      var plain = 0, oh = (c.e && c.e.oh) || 16;
      c.parts.forEach(function (p) { plain += Math.max(0, p.s - p.b * oh); });
      if (plain !== c.z) throw new Error('manifest: parts decode to ' + plain + ' bytes but the declared file size is ' + c.z);
    }
    guardUrls(c);
    return c;
  }

  // One link per part, for the case where a mail client or a filter refuses a
  // long link: each of these stands on its own, and the receive page merges
  // them back into one job.
  function splitPerPart(m) {
    var c = canonical(m);
    var out = [];
    for (var i = 0; i < c.parts.length; i++) {
      if (!c.parts[i].i) continue;
      out.push(canonical({
        v: VERSION, n: c.n, t: c.t, z: c.z, p: c.p, b: c.b, d: c.d, o: c.o,
        f: c.f, u: c.u, c: c.c, hm: c.hm, x: c.x, e: c.e, h: c.h, k: c.parts.length,
        parts: [{ x: i, i: c.parts[i].i, s: c.parts[i].s, h: c.parts[i].h, b: c.parts[i].b }]
      }));
    }
    return out;
  }

  // A manifest can arrive from an email that someone else wrote, so nothing in it
  // may name a scheme this page should touch, and no part id may climb out of the
  // path the sender's bucket prefix put it in. Checked here, once, at the only
  // door: encode() and decode() both run canonical(), so the receive page, the
  // history re-open and the "open it on the host" link are all covered.
  function guardUrls(c) {
    if (c.b) {
      var probe = c.b.replace(/\{id\}/g, 'id');
      if (!U.safeUrl(probe, true)) {
        throw new Error('manifest: the stored-file address is not an http(s) address: ' + U.truncateUtf8(c.b, 80));
      }
    }
    if (c.u && !U.safeUrl(c.u, true)) {
      throw new Error('manifest: the direct link is not an http(s) address: ' + U.truncateUtf8(c.u, 80));
    }
    var templ = c.b && c.b.indexOf('{id}') >= 0;
    for (var i = 0; i < c.parts.length; i++) {
      var id = c.parts[i].i;
      if (!id) continue;
      if (templ) {
        if (/[\u0000-\u0020\u007f"'<>`\\?#]|\.\./.test(id)) {
          throw new Error('manifest: part ' + (i + 1) + ' has an id that does not look like a file name: ' + U.truncateUtf8(id, 60));
        }
      } else if (!U.safeUrl((c.b || '') + id, true)) {
        throw new Error('manifest: part ' + (i + 1) + ' points somewhere this page will not fetch.');
      }
    }
  }

  function encode(m) {
    var c = canonical(m);
    // every byte here costs 1.6 characters of link, so defaults are omitted
    var o = { v: c.v, n: c.n, z: c.z, p: c.p, p2: c.parts };
    if (c.hm !== 'file') o.hm = c.hm;
    if (c.x) o.x = c.x;
    if (c.t) o.t = c.t;
    if (c.b) o.b = c.b;
    if (c.d) o.d = c.d;
    if (c.o) o.o = c.o;
    if (c.f !== 'page') o.f = c.f;
    if (c.u) o.u = c.u;
    if (c.e) o.e = c.e;
    if (c.h) o.h = c.h;
    if (c.c) o.c = c.c;
    var partial = c.k > c.parts.length;
    if (partial) {
      o.k = c.k;
      o.p2 = c.parts.map(function (p) { return { x: p.x, i: p.i, s: p.s, h: p.h, b: p.b }; });
    } else if (c.parts.some(function (p) { return p.x !== 0; })) {
      o.p2 = c.parts.map(function (p, i) { return { x: i, i: p.i, s: p.s, h: p.h, b: p.b }; });
    }
    return U.bytesToBase32(U.utf8Encode(JSON.stringify(o)));
  }

  function decode(token) {
    var bytes = U.base32ToBytes(token);
    if (!bytes.length) throw new Error('manifest: empty token');
    var json = U.utf8Decode(bytes);
    var raw;
    try { raw = JSON.parse(json); } catch (e) { throw new Error('manifest: corrupt token (bad checksum region)'); }
    raw.parts = raw.p2 || raw.parts;
    delete raw.p2;
    return canonical(raw);
  }

  function buildUrl(baseUrl, m) {
    var b = String(baseUrl || '').replace(/[#?].*$/, '');
    return b + HASH_PREFIX + encode(m);
  }

  // Extract a manifest from *anything*: a full link, a bare token, or the whole
  // body of an email. Mail clients soft-wrap long URLs and quote-printable
  // encoders sprinkle "=\r\n" and stray hyphens into them, so we do not try to
  // match the token with a regex. Instead: cut at each '#', keep only characters
  // from the base32 alphabet, and see whether a valid manifest falls out.
  function findManifest(text) {
    var s = String(text == null ? '' : text);
    var tried = {};
    function attempt(blob) {
      var clean = blob.toUpperCase().replace(/[^A-Z2-7]/g, '');
      if (clean.length < 40 || tried[clean]) return null;
      tried[clean] = 1;
      try { return decode(clean); } catch (e) { return null; }
    }
    var cut, idx = -1, hit;
    while ((idx = s.indexOf('#', idx + 1)) >= 0) {
      // up to the next blank line, which is where a URL ends in practice
      cut = s.slice(idx + 1);
      var stop = cut.search(/\r?\n\r?\n/);
      if (stop >= 0) cut = cut.slice(0, stop);
      if ((hit = attempt(cut))) return hit;
    }
    if ((hit = attempt(s))) return hit;
    throw new Error('No download token found in that text — paste the whole message, or just the part after the # sign.');
  }

  function partUrl(m, idx) {
    var p = m.parts[idx];
    if (!p || !p.i) return '';
    var b = b64uSafe(m.b);
    if (b.indexOf('{id}') >= 0) return b.replace('{id}', p.i);
    return b + p.i;
  }

  function b64uSafe(s) {
    // base64 of the base URL is stashed in m.o as fallback when there's no template
    return String(s || '');
  }

  function merge(a, b) {
    var A = canonical(a), B = canonical(b);
    if (A.h && B.h && A.h !== B.h) throw new Error('Those two links are not parts of the same transfer.');
    if (A.z !== B.z) throw new Error('Those two links describe different file sizes — cannot merge.');
    if (A.n !== B.n) throw new Error('Those two links have different file names — cannot merge.');
    var parts = A.parts.slice();
    for (var i = 0; i < B.parts.length; i++) {
      if (!parts[i]) parts[i] = B.parts[i];
      else if (!parts[i].i && B.parts[i].i) parts[i] = B.parts[i];
    }
    var byIndex = {};
    A.parts.concat(B.parts).forEach(function (p) { if (p.i && !byIndex[p.x]) byIndex[p.x] = p; });
    var k = Math.max(Number(A.k) || A.parts.length, Number(B.k) || B.parts.length);
    var filled = Object.keys(byIndex).map(function (x) { return byIndex[x]; }).sort(function (a, b) { return a.x - b.x; });
    var complete = filled.length >= k;
    var out = {
      v: VERSION, n: A.n || B.n, t: A.t || B.t, z: A.z, p: A.p || B.p,
      b: A.b || B.b, d: A.d || B.d, o: A.o || B.o, f: A.f || B.f, u: A.u || B.u,
      hm: A.hm === 'parts' || B.hm === 'parts' ? 'parts' : 'file', x: A.x || B.x,
      c: A.c || B.c, e: A.e || B.e, h: A.h || B.h,
      k: complete ? 0 : k, parts: filled
    };
    return canonical(out);
  }

  // Which part indexes are still absent. A complete manifest lists every part,
  // a partial one (one email per part) declares the total in `k`.
  function missingParts(m) {
    var total = Math.max(Number(m.k) || 0, m.parts.length);
    var have = {};
    m.parts.forEach(function (p) { if (p.i) have[p.x == null ? m.parts.indexOf(p) : p.x] = 1; });
    var out = [];
    for (var i = 0; i < total; i++) if (!have[i]) out.push(i);
    return out;
  }

  function partCount(m) { return Math.max(Number(m.k) || 0, m.parts.length); }

  MD.manifest = {
    VERSION: VERSION,
    HASH_PREFIX: HASH_PREFIX,
    encode: encode,
    decode: decode,
    buildUrl: buildUrl,
    findManifest: findManifest,
    splitPerPart: splitPerPart,
    partUrl: partUrl,
    merge: merge,
    missingParts: missingParts,
    partCount: partCount,
    canonical: canonical
  };
})(typeof window !== 'undefined' ? window : globalThis);
