/* MailDrop — utilities: email-safe base32, formatting, misc. No deps, no build step. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});

  var A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC4648, unpadded (length is derivable from char count)

  function bytesToBase32(bytes) {
    var out = '', i, acc = 0, bits = 0;
    for (i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += A32.charAt((acc >>> (bits - 5)) & 31); bits -= 5; }
    }
    if (bits > 0) out += A32.charAt((acc << (5 - bits)) & 31);
    return out;
  }

  function base32ToBytes(str) {
    var clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    var out = [], acc = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var v = A32.indexOf(clean.charAt(i));
      if (v < 0) continue;
      acc = (acc << 5) | v;
      bits += 5;
      if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  function utf8Encode(s) { return new TextEncoder().encode(s); }
  function utf8Decode(b) { return new TextDecoder('utf-8', { fatal: false }).decode(b); }

  function toHex(buf) {
    var v = new Uint8Array(buf), s = '';
    for (var i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
    return s;
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (var i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
    return b;
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    var u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    var t = (v >= 100 || i === 0) ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2);
    if (t.indexOf('.') >= 0) t = t.replace(/0+$/, '').replace(/\.$/, '');
    return t + ' ' + u[i];
  }

  function fmtRate(bps) {
    if (!isFinite(bps) || bps <= 0) return '—';
    return fmtBytes(bps) + '/s';
  }

  function fmtEta(remainingBytes, bps) {
    if (!bps || bps <= 0) return '—';
    var s = Math.max(0, Math.round(remainingBytes / bps));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + ' min';
    return (s / 3600).toFixed(1) + ' h';
  }

  function fmtDuration(hours) {
    if (hours % 24 === 0) {
      var d = hours / 24;
      return d + (d === 1 ? ' day' : ' days');
    }
    return hours + ' h';
  }

  function byteLen(s) { return new TextEncoder().encode(String(s)).length; }

  function truncateUtf8(s, maxBytes) {
    s = String(s == null ? '' : s);
    if (byteLen(s) <= maxBytes) return s;
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (byteLen(out + s[i]) > maxBytes - 1) break;
      out += s[i];
    }
    return out + '…';
  }

  function cleanName(name) {
    var n = String(name == null ? 'file' : name)
      .replace(/[\\/]/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    if (!n || /^\.+$/.test(n)) n = 'file';
    return n.slice(0, 200);
  }

  function extOf(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? '.' + m[1] : '.bin';
  }

  // 100 MiB in bytes, etc. — tiny expression evaluator for the size input box
  function parseSizeInput(s) {
    var m = /^\s*([0-9]*\.?[0-9]+)\s*(kb|kib|mb|mib|gb|gib|b)?\s*$/i.exec(String(s || ''));
    if (!m) return null;
    var n = parseFloat(m[1]);
    var unit = (m[2] || 'b').toLowerCase();
    var mult = { b: 1, kb: 1000, kib: 1024, mb: 1000 * 1000, mib: 1024 * 1024, gb: 1000 * 1000 * 1000, gib: 1024 * 1024 * 1024 }[unit];
    if (!isFinite(n) || n <= 0 || !mult) return null;
    return Math.round(n * mult);
  }

  MD.util = {
    bytesToBase32: bytesToBase32,
    base32ToBytes: base32ToBytes,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    toHex: toHex,
    randomBytes: randomBytes,
    fmtBytes: fmtBytes,
    fmtRate: fmtRate,
    fmtEta: fmtEta,
    fmtDuration: fmtDuration,
    byteLen: byteLen,
    truncateUtf8: truncateUtf8,
    cleanName: cleanName,
    extOf: extOf,
    parseSizeInput: parseSizeInput
  };
})(typeof window !== 'undefined' ? window : globalThis);
