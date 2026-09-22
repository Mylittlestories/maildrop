/* MailDrop — receive side. One pass, part by part: fetch exactly the number of
   bytes the link promised, verify what the host returned, decrypt if needed,
   fold the plaintext into a whole-file fingerprint, and write to disk as we
   go. Nothing about the file is uploaded to us — we only ever talk to the host
   the sender chose. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});

  var CHUNK = 16 * 1024 * 1024;

  // Which host failed is part of the answer: a job can span eight objects on two
  // different hosts, and "HTTP 404" on its own tells you nothing about either.
  function hostOf(url) {
    // no new URL(): a page that is tearing down has a location that throws, and
    // this string is built precisely when something has already gone wrong.
    var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || ''));
    return m ? ' from ' + m[1].replace(/^.*@/, '') : '';
  }

  // Stall detection, not a deadline: reading a 950 MiB part legitimately takes
  // minutes on a home line, so the only honest failure signal is silence. Every
  // await re-arms this; if nothing completes within the window, the attempt is
  // abandoned and reported as retryable instead of hanging the job forever.
  function stallSeconds() {
    var v = Number((MD.config || {}).stallSeconds);
    return isFinite(v) && v >= 0 ? v : 120;
  }

  function fetchRange(url, from, to, onBytes, signal, label) {
    var what = label || 'the file';
    return (async function () {
      if (from >= to) return new Uint8Array(0);
      if (MD.backends && MD.backends.resolvePart && /^local:\/\//.test(url)) {
        var full = await MD.backends.resolvePart(url);
        var view = (from === 0 && to >= full.byteLength) ? full : full.subarray(from, to);
        if (onBytes) onBytes(view.byteLength);
        return view;
      }

      var stallMs = stallSeconds() * 1000;
      var ctl = new AbortController();
      var timer = null, stalled = false, outer = null;
      function onOuterAbort() { try { ctl.abort(); } catch (e) { } }
      if (signal) {
        if (signal.aborted) onOuterAbort();
        else { outer = onOuterAbort; try { signal.addEventListener('abort', outer); } catch (e) { } }
      }
      function stopTimer() { if (timer) { clearTimeout(timer); timer = null; } }
      function cleanup() {
        stopTimer();
        if (signal && outer) { try { signal.removeEventListener('abort', outer); } catch (e) { } outer = null; }
      }
      function guard(promise) {
        stopTimer();
        if (stallMs) timer = setTimeout(function () { stalled = true; try { ctl.abort(); } catch (e) { } }, stallMs);
        return (async function () {
          try { return await promise; }
          catch (e) {
            if (stalled) {
              var se = new Error('Nothing came back for ' + Math.round(stallMs / 1000) + 's while reading ' + what +
                hostOf(url) + ', so this attempt was given up on. The host is being quiet, not necessarily gone.');
              se.retryable = true; se.stalled = true; se.hostUrl = url;
              throw se;
            }
            throw e;
          }
          finally { stopTimer(); }
        })();
      }

      var res;
      var openEnded = !isFinite(to);
      try {
        res = await guard(fetch(url, {
          headers: openEnded ? undefined : { Range: 'bytes=' + from + '-' + (to - 1) },
          signal: ctl.signal
        }));
      } catch (e) {
        cleanup();
        if (e && e.stalled) throw e;
        if (e && e.name === 'AbortError') throw e;
        var net = new Error('Could not reach ' + what + hostOf(url) + ' (' + (e.message || e) + '). Its CORS policy, the network, or the file itself may be the reason.');
        net.retryable = true; net.corsSuspect = true; net.hostUrl = url;
        throw net;
      }
      if (res.status === 403 || res.status === 401) {
        cleanup();
        var blocked = new Error('The host refused the browser (HTTP ' + res.status + ' for ' + what + '). It probably only serves files to a human click.');
        blocked.hostUrl = url;
        throw blocked;
      }
      if (!(res.ok || res.status === 206)) {
        cleanup();
        var err = new Error('The host replied HTTP ' + res.status + ' for ' + what + ', bytes ' + from + '-' + (to - 1) +
          hostOf(url) + (res.status === 404 ? ' — the host says it has no such file; on a free host it may already have been deleted.' : ''));
        err.httpStatus = res.status;
        err.hostUrl = url;
        err.retryable = res.status >= 500 || res.status === 429;
        throw err;
      }
      var u8;
      try {
        u8 = new Uint8Array(await guard(res.arrayBuffer()));
      } catch (e2r) {
        cleanup();
        if (e2r && (e2r.stalled || e2r.name === 'AbortError')) throw e2r;
        var lost = new Error('The read of ' + what + hostOf(url) + ' stopped halfway: ' + (e2r.message || e2r) + '.');
        lost.retryable = true; lost.hostUrl = url;
        throw lost;
      }
      cleanup();
      if (!openEnded && u8.byteLength !== to - from) {
        var e3 = new Error('Short read:' + hostOf(url) + ' gave ' + u8.byteLength + ' bytes for ' + what + ' where ' + (to - from) + ' were promised.');
        e3.retryable = true;
        throw e3;
      }
      if (onBytes) onBytes(u8.byteLength);
      return u8;
    })();
  }

  // Windows are 16 MiB by default. That size is not a guess: it is what the
  // sender hashed with (`m.c`), and a fixed small window is the whole reason a
  // 950 MiB part can be saved on a 1 GB laptop. Concatenating the part first —
  // which an earlier version did — needed the part size *plus* the concat copy in
  // RAM, and that is how a big download kills a tab.
  function windowFor(m) {
    // encrypted: one record per request, because a GCM record cannot be
    // decrypted in pieces. plain: CHUNK, which is also the fold window, so the
    // hasher never buffers more than one window beyond what is in flight.
    if (m.e) return MD.crypto.recordSpan(Number(m.e.bs) || MD.crypto.MAX_PLAIN_BLOCK);
    return CHUNK;
  }

  // Read one part from the host in windows, handing each to `onWindow` as it
  // arrives. The host is asked for the whole part, so a server that ignores
  // Range still works: we detect that from the first reply and stop slicing.
  async function streamPart(url, size, onWindow, signal, label) {
    var win = CHUNK;
    var ranged = true;
    var off = 0;
    while (off < size) {
      var want = ranged ? Math.min(size, off + win) : size;
      var u8 = await fetchRange(url, off, want, null, signal, label);
      if (ranged && u8.byteLength !== want - off) {
        // the host sent something else (usually the whole object): re-read once
        // without ranges and stream from that buffer instead
        ranged = false;
        if (u8.byteLength === size) { await onWindow(u8, 0); return; }
        throw new Error('The host returned ' + u8.byteLength + ' bytes for a ' + (want - off) + ' byte range request for ' + (label || 'the file') + '.');
      }
      await onWindow(u8, off);
      off = want;
    }
    if (off !== size) throw new Error('Short read: stopped at ' + off + ' of ' + size + ' bytes.');
  }

  // The whole part in memory. The page never calls this for big parts — assemble
  // streams instead — but a caller that wants one buffer for a small part (a tool,
  // a test, a 4 MiB demo file) should not have to reimplement the windowing.
  async function fetchPart(url, expectedSize, onBytes, signal, label) {
    var size = Number(expectedSize) || 0;
    if (!size) {
      var only = await fetchRange(url, 0, Infinity, onBytes, signal, label);
      return only;
    }
    var parts = [], total = 0;
    await streamPart(url, size, function (u8) {
      total += u8.byteLength;
      parts.push(u8);
      if (onBytes) onBytes(u8.byteLength);
    }, signal, label);
    return MD.crypto.concat(parts);
  }

  async function keyMaterial(m, password) {
    var salt = MD.crypto.unb64(m.e.salt || '');
    var mat = await MD.crypto.makeEncryptor(password || '', salt, m.e.it);
    if (m.e.fp && mat.verifier !== m.e.fp) throw new Error('WRONG_PASSWORD');
    return mat;
  }

  // opts: { password, writer, signal, onProgress, urls }
  // Returns { bytes, fingerprint, verified, writtenToFile, blob } — `blob` only
  // when there is no writer, because then the whole file has to live in memory.
  async function assemble(m, opts) {
    opts = opts || {};
    var onProgress = opts.onProgress || function () {};
    var writer = opts.writer || null;
    var fold = Number(m.c) || CHUNK;
    var whole = MD.crypto.Folder(fold);                   // folds the plaintext, all parts
    var key = null, iv = null, bs = 0, oh = MD.crypto.OVERHEAD;
    var blockBase = 0, got = 0, plainTotal = 0;
    var chunks = writer ? null : [];
    var partDigests = [];
    var expected = String(m.h || '');

    if (m.e) {
      var mat = await keyMaterial(m, opts.password);
      key = mat.key;
      iv = MD.crypto.unb64(m.e.iv || '');
      bs = Number(m.e.bs) || MD.crypto.MAX_PLAIN_BLOCK;
      oh = Number(m.e.oh) || MD.crypto.OVERHEAD;
    }

    for (var i = 0; i < m.parts.length; i++) {
      var part = m.parts[i];
      if (!part.i) throw new Error('Part ' + (i + 1) + ' of ' + m.parts.length + ' is missing — the sender still has to upload it.');
      var url = MD.util.safeUrl((opts.urls && opts.urls[i]) || MD.manifest.partUrl(m, i), true);
      if (!url) throw new Error('Part ' + (i + 1) + ' points somewhere this page will not fetch. A link only works if it names an http(s) address.');
      var win = windowFor(m, part);
      var hasher = part.h ? MD.crypto.Folder(fold) : null;
      var recIndex = 0, plainLeft = MD.crypto.partPayloadSize(part.s, part.b || 0);

      onProgress({ phase: 'fetch', part: i, parts: m.parts.length, done: got, total: m.z, writer: !!writer });

      await streamPart(url, part.s, async function (u8, off) {
        got += u8.byteLength;
        if (hasher) await hasher.push(u8);
        var plain = u8;
        if (m.e) {
          // one window is exactly one record: fetchRange never splits one
          var thisPlain = Math.min(bs, plainLeft - recIndex * bs);
          if (u8.byteLength !== thisPlain + oh) {
            throw new Error('Encrypted data is truncated — part ' + (i + 1) + ' ended inside a record.');
          }
          plain = await MD.crypto.decryptRecord(u8, key, iv, blockBase + recIndex, bs);
          recIndex++;
        }
        plainTotal += plain.byteLength;
        await whole.push(plain);
        if (writer) await writer.write(new Blob([plain]));
        else chunks.push(plain);
        onProgress({ phase: 'write', part: i, parts: m.parts.length, done: got, total: m.z, plain: plainTotal });
      }, opts.signal, m.parts.length > 1 ? 'part ' + (i + 1) + ' of ' + m.parts.length : 'the file');

      if (m.e) blockBase += recIndex;
      plainLeft = 0;

      if (hasher) {
        var hex = await hasher.finish();
        partDigests.push(hex.slice(0, 16));
        if (hex.slice(0, 16) !== String(part.h).slice(0, 16)) {
          throw new Error('Part ' + (i + 1) + ' does not match the fingerprint the sender recorded — the host returned different bytes than were stored.');
        }
      } else {
        partDigests.push('');
      }
    }

    if (writer) await writer.close();

    var fingerprint = await whole.finish();
    // `hm: 'parts'` means the sender could not fold the whole file cheaply, so
    // the link's fingerprint is the digest of the part digests instead.
    var chain = m.hm === 'parts' ? await MD.crypto.chainDigest(partDigests) : '';
    var mode = m.hm === 'parts' ? 'chain' : 'file';
    var computed = mode === 'chain' ? chain : fingerprint;
    var checked = !!expected && !!computed;
    var verified = checked && computed.slice(0, 16) === expected.slice(0, 16);

    return {
      bytes: plainTotal,
      writtenToFile: !!writer,
      verified: verified,
      checkable: checked,
      checkMode: mode,
      fingerprint: computed,
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

  // Whole file in memory: only for small transfers, and the reason the page warns
  // before trying it on a big one. (An earlier `materialise` helper here fetched
  // everything twice — one pass for the blob, one for a falsy `.blob` check.)
  async function collect(m, opts) {
    opts = opts || {};
    var res = await assemble(m, Object.assign({}, opts, { writer: null }));
    return res.blob;
  }

  MD.receive = {
    CHUNK: CHUNK,
    fetchRange: fetchRange,
    fetchPart: fetchPart,
    assemble: assemble,
    collect: collect,
    streamPart: streamPart,
    windowFor: windowFor,
    needsPassword: needsPassword,
    canStreamSave: canStreamSave,
    pickWriter: pickWriter,
    saveBlob: saveBlob,
    keyMaterial: keyMaterial
  };
})(typeof window !== 'undefined' ? window : globalThis);
