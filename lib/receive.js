/* MailDrop — receive side. One pass, part by part: fetch exactly the number of
   bytes the link promised, verify what the host returned, decrypt if needed,
   fold the plaintext into a whole-file fingerprint, and write to disk as we
   go. Nothing about the file is uploaded to us — we only ever talk to the host
   the sender chose. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});

  var CHUNK = 16 * 1024 * 1024;

  function fetchRange(url, from, to, onBytes, signal) {
    return (async function () {
      if (from >= to) return new Uint8Array(0);
      if (MD.backends && MD.backends.resolvePart && /^local:\/\//.test(url)) {
        var full = await MD.backends.resolvePart(url);
        var view = (from === 0 && to >= full.byteLength) ? full : full.subarray(from, to);
        if (onBytes) onBytes(view.byteLength);
        return view;
      }
      var res;
      try {
        res = await fetch(url, { headers: { Range: 'bytes=' + from + '-' + (to - 1) }, signal: signal || undefined });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        var net = new Error('Could not reach the host (' + (e.message || e) + '). Its CORS policy, the network, or the file itself may be the reason.');
        net.retryable = true; net.corsSuspect = true;
        throw net;
      }
      if (res.status === 403 || res.status === 401) {
        var blocked = new Error('The host refused the browser (HTTP ' + res.status + '). It probably only serves files to a human click.');
        blocked.hostUrl = url;
        throw blocked;
      }
      if (!(res.ok || res.status === 206)) {
        var err = new Error('The host replied HTTP ' + res.status + ' for part ' + (to > from ? '' : '') + '.');
        err.httpStatus = res.status;
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      var u8 = new Uint8Array(await res.arrayBuffer());
      if (u8.byteLength !== to - from) {
        var e2 = new Error('Short read: the host gave ' + u8.byteLength + ' bytes where ' + (to - from) + ' were promised.');
        e2.retryable = true;
        throw e2;
      }
      if (onBytes) onBytes(u8.byteLength);
      return u8;
    })();
  }

  // Ranges are used when the host supports them (both wired-in hosts do); a
  // host that ignores Range simply returns the whole object each time, so we
  // detect that on the first slice and stop asking.
  async function fetchPart(url, expectedSize, onBytes, signal) {
    if (expectedSize <= CHUNK) return fetchRange(url, 0, expectedSize, onBytes, signal);
    var first = await fetchRange(url, 0, CHUNK, onBytes, signal);
    if (first.byteLength !== CHUNK) {
      // host ignored Range and returned something unexpected; treat as error
      throw new Error('The host returned ' + first.byteLength + ' bytes for a 16 MiB range request.');
    }
    var out = [first];
    for (var off = CHUNK; off < expectedSize; off += CHUNK) {
      var to = Math.min(expectedSize, off + CHUNK);
      out.push(await fetchRange(url, off, to, onBytes, signal));
    }
    return MD.crypto.concat(out);
  }

  async function keyMaterial(m, password) {
    var salt = MD.crypto.unb64(m.e.salt || '');
    var mat = await MD.crypto.makeEncryptor(password || '', salt, m.e.it);
    if (m.e.fp && mat.verifier !== m.e.fp) throw new Error('WRONG_PASSWORD');
    return mat;
  }

  // opts: { password, writer, signal, onProgress, urls }
  // Returns { bytes, fingerprint } when writing to a stream, or { blob, … }.
  async function assemble(m, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var writer = opts.writer || null;
    var folder = MD.crypto.Folder(m.c || 0);
    var key = null, iv = null, bs = 0, oh = MD.crypto.OVERHEAD;
    var blockBase = 0, got = 0, plainTotal = 0;
    var chunks = writer ? null : [];

    if (m.e) {
      var mat = await keyMaterial(m, opts.password);
      key = mat.key;
      iv = MD.crypto.unb64(m.e.iv || '');
      bs = Number(m.e.bs) || MD.crypto.MAX_PLAIN_BLOCK;
    }

    for (var i = 0; i < m.parts.length; i++) {
      var part = m.parts[i];
      if (!part.i) throw new Error('Part ' + (i + 1) + ' of ' + m.parts.length + ' is missing — the sender still has to upload it.');
      var url = (opts.urls && opts.urls[i]) || MD.manifest.partUrl(m, i);
      if (!url) throw new Error('Cannot rebuild the download URL for part ' + (i + 1) + '.');
      onProgress({ phase: 'fetch', part: i, parts: m.parts.length, done: got, total: m.z, writer: !!writer });
      var stored = await fetchPart(url, part.s, function (n) {
        got += n;
        onProgress({ phase: 'fetch', part: i, parts: m.parts.length, done: got, total: m.z, writer: !!writer });
      }, opts.signal);

      if (part.h) {
        var hex = await MD.crypto.sha256Hex(stored);
        if (hex.slice(0, 16) !== String(part.h).slice(0, 16)) {
          throw new Error('Part ' + (i + 1) + ' does not match the fingerprint the sender recorded — the host returned different bytes than were stored.');
        }
      }

      var plain = stored;
      if (m.e) {
        var plainLen = MD.crypto.partPayloadSize(part.s, part.b);
        plain = await MD.crypto.decryptPayload(stored, key, iv, blockBase, plainLen, part.b || undefined, bs);
        blockBase += part.b || MD.crypto.blockCount(plainLen, bs);
      }
      plainTotal += plain.byteLength;
      await folder.push(plain);
      if (writer) await writer.write(new Blob([plain]));
      else chunks.push(plain);
      onProgress({ phase: 'write', part: i, parts: m.parts.length, done: got, total: m.z, plain: plainTotal });
    }

    if (writer) await writer.close();

    var fingerprint = await folder.finish();
    var expected = String(m.h || '');
    var verified = !expected || fingerprint.slice(0, 16) === expected.slice(0, 16);
    return {
      bytes: plainTotal,
      writtenToFile: !!writer,
      verified: verified,
      fingerprint: fingerprint,
      blob: writer ? null : new Blob(chunks),
      truncated: !m.e && plainTotal !== m.z ? 'file is ' + plainTotal + ' bytes, link says ' + m.z : ''
    };
  }

  function needsPassword(m) { return !!(m.e && m.e.fp); }

  // --- saving ---------------------------------------------------------------
  function canStreamSave() {
    return typeof global.showSaveFilePicker === 'function' &&
      typeof global.Blob.prototype.stream === 'function' &&
      typeof global.Blob.prototype.pipeTo === 'function';
  }

  async function pickWriter(filename) {
    var name = MD.util.cleanName(filename || 'download.bin');
    var ext = '.' + ((name.split('.').pop() || 'bin').toLowerCase());
    var handle = await global.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: name, accept: { 'application/octet-stream': [ext] } }],
      excludeAcceptAllOption: false
    });
    return { writable: await handle.createWritable(), name: name, handle: handle };
  }

  async function saveBlob(blob, filename) {
    var name = MD.util.cleanName(filename || 'download.bin');
    var url = URL.createObjectURL(blob);
    return new Promise(function (resolve) {
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        resolve({ method: 'anchor', filename: name });
      }, 1500);
    });
  }

  // Legacy entry point kept for callers that want "give me the whole blob".
  async function collect(m, opts) {
    opts = opts || {};
    var res = await assemble(m, Object.assign({}, opts, { writer: null }));
    return res.blob;
  }

  async function materialise(m, opts) {
    return (await collect(m, opts)).blob || (await collect(m, opts));
  }

  MD.receive = {
    CHUNK: CHUNK,
    fetchRange: fetchRange,
    fetchPart: fetchPart,
    assemble: assemble,
    collect: collect,
    materialise: materialise,
    needsPassword: needsPassword,
    canStreamSave: canStreamSave,
    pickWriter: pickWriter,
    saveBlob: saveBlob,
    keyMaterial: keyMaterial
  };
})(typeof window !== 'undefined' ? window : globalThis);
