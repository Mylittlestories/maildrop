/* MailDrop — file packing: decide how many chunks a transfer needs, slice the
   file straight from disk (Blob.slice never loads the whole file into RAM),
   build the multipart/form-data body a browser would otherwise refuse to send
   with progress, and turn provider URLs into {id} templates so links stay tiny. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  // ---- part planning -------------------------------------------------------
  // Returns [{start, size}, ...] covering [0,total) with each part <= maxPartBytes.
  function planParts(total, maxPartBytes, align) {
    if (!(total > 0)) throw new Error('empty file');
    total = Math.floor(total);
    var cap = Math.max(1, Math.floor(maxPartBytes));
    var a = Math.max(1, align || 1);
    var count = Math.ceil(total / cap);
    // Even-ish split so no part is much smaller than the others, rounded to `align`.
    var per = Math.ceil(total / count / a) * a;
    if (per > cap) { per = Math.floor(cap / a) * a; count = Math.ceil(total / per); }
    var parts = [], off = 0;
    while (off < total) {
      var size = Math.min(per, total - off);
      parts.push({ start: off, size: size });
      off += size;
    }
    return parts;
  }

  // ---- reading -------------------------------------------------------------
  function readSlice(file, start, size) {
    return file.slice(start, start + size).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function hashSlice(file, start, size, onProgress) {
    return readSlice(file, start, size).then(function (u8) {
      if (onProgress) onProgress(size, size);
      return MD.crypto.sha256Hex(u8);
    });
  }

  // ---- multipart body ------------------------------------------------------
  // Lowercase and hyphen-only on purpose: a Blob's `type` can be case-normalised
  // by the implementation, and a header saying boundary=----MailDropBoundary while
  // the body says ----maildropboundary means the server finds no file at all.
  var BOUNDARY = '----maildropboundary';
  // We hand-assemble the multipart payload so the *entire* body can be a Blob
  // (prefix + file slice + suffix): the browser reads the bytes from disk at
  // send time and xhr.upload.progress still reports every byte.
  function multipartField(name, value) {
    return new TextEncoder().encode('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n');
  }

  function multipartFilePart(name, filename, type) {
    return new TextEncoder().encode(
      '--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="' +
      String(filename).replace(/"/g, '') + '"\r\nContent-Type: ' + (type || 'application/octet-stream') +
      '\r\n\r\n'
    );
  }

  // The CRLF before the closing boundary is mandatory: it terminates the file
  // part's body. Without it, strict parsers (PHP/tmpfiles) report "no file".
  function multipartEnd() { return new TextEncoder().encode('\r\n--' + BOUNDARY + '--\r\n'); }

  function buildMultipartBody(fields, file, start, size, filename, type, fileField) {
    return multipartFromBlob(fields, file.slice(start, start + size), filename, type, fileField);
  }

  // Same envelope, but around an already-prepared Blob (the encrypted part).
  // fileField is the name the endpoint looks for its file under, and it is not a
  // detail to guess at: catbox's API answers "412 No file!" for a body that carries
  // the whole payload under any other name, having read every byte of it.
  function multipartFromBlob(fields, blob, filename, type, fileField) {
    var blobParts = [];
    fields = fields || {};
    Object.keys(fields).forEach(function (k) { blobParts.push(multipartField(k, fields[k])); });
    blobParts.push(multipartFilePart(fileField || 'file', filename || 'file.bin', type));
    blobParts.push(blob);
    blobParts.push(multipartEnd());
    return new Blob(blobParts, { type: 'multipart/form-data; boundary=' + BOUNDARY });
  }

  // ---- several files, one link: a stored-method ZIP ---------------------------
  // A recipient clicks one link and gets one object, so "several files" has to
  // become one file. Compressing them would mean holding and re-writing every byte,
  // which is exactly what this design refuses to do at 2 GB, and phone video is
  // already compressed — the deflate pass would buy nothing. So the container here
  // is *stored*: the bytes inside are the bytes on disk, unchanged, and the result
  // is a view rather than a copy. slice(a, b) on the archive reaches back into the
  // originals, so the part plan, the hashing, the encryption and the uploads keep
  // streaming exactly as they did with one file, and peak memory stays at one part.
  // Nothing downstream has to know an archive exists: it is an object with a name,
  // a size and a slice, which is the only thing the rest of this file asks of a
  // file.
  // CRC-32 is the one field that cannot be lazy — a local header sits *in front* of
  // the bytes it describes — so making an archive costs one streaming read over the
  // inputs, and the progress line says so rather than looking like a hang.
  // Past 4 GiB (sizes or offsets) the ZIP64 extra records appear on their own,
  // because a multi-file pick from a camera roll crosses 4 GiB far more often than a
  // single download does.
  var ZIP_MAX32 = 0xffffffff;
  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Uint32Array(256), n, k, c;
    for (n = 0; n < 256; n++) {
      c = n;
      for (k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return (CRC_TABLE = t);
  }
  function crcStep(crc, u8) {
    var t = crcTable(), i;
    for (i = 0; i < u8.length; i++) crc = t[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }
  function crc32Bytes(u8) { return (crcStep(0xffffffff, u8) ^ 0xffffffff) >>> 0; }

  // One streaming pass over a file, 4 MiB at a time: never more than a window in
  // memory, cancellable, and it reports progress because on a phone this is the
  // step that takes seconds and would otherwise look like nothing is happening.
  async function crc32File(file, onProgress, signal) {
    var crc = 0xffffffff, CHUNK = 4 * 1024 * 1024, pos = 0, size = Number(file.size) || 0;
    while (pos < size) {
      if (signal && signal.aborted) { var e = new Error('Cancelled.'); e.cancelled = true; throw e; }
      var u8 = await readSlice(file, pos, Math.min(CHUNK, size - pos));
      crc = crcStep(crc, u8);
      pos += u8.byteLength;
      if (onProgress) onProgress(pos, size);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function putU64(dv, at, n) {
    n = Number(n) || 0;
    dv.setUint32(at, n % 0x100000000, true);
    dv.setUint32(at + 4, Math.floor(n / 0x100000000), true);
  }

  function dosWhen(ms) {
    var d = ms && ms > 0 ? new Date(ms) : new Date();
    var y = d.getFullYear();
    if (y < 1980) return { t: 0, d: 33 };            // the format's epoch is 1980-01-01
    return {
      t: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
      d: (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
    };
  }

  function zipSafeName(name, i) {
    var s = String(name == null ? '' : name).replace(/\\/g, '/');
    // for files from a folder drop, keep the relative path inside the zip
    s = s.replace(/^\/+/, '');
    s = s.replace(/[\x00-\x1c]/g, '');
    var parts = s.split('/');
    parts = parts.map(function(p,i2){ var last = i2===parts.length-1; var v=last ? p.replace(/[<>:"|?*]/g,'_').replace(/^\.+$/,'_') : p.replace(/[<>:"|?*]/g,'_').replace(/^\.+$/,'_'); return v||('part'+(i+1)); });
    var out = parts.join('/');
    // basename duplicate handling is done outside; keep full path here
    return out || ('file' + (i + 1) + '.bin');
  }

  // Two "IMG_0001.jpg" from different folders are one name inside an archive, and
  // silently dropping a file is the worst possible thing a container could do.
  function zipUnique(used, base) {
    // base may contain a path — dedupe on full path, and suffix before extension
    if (!used[base]) { used[base] = 1; return base; }
    var slash = base.lastIndexOf('/');
    var dir = slash>=0? base.slice(0,slash+1):'';
    var file = slash>=0? base.slice(slash+1):base;
    var dot = file.lastIndexOf('.'), stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : '';
    var k = 2;
    while (used[dir+stem + ' (' + k + ')' + ext]) k++;
    var n = dir+stem + ' (' + k + ')' + ext;
    used[n] = 1;
    return n;
  }

  function zipArchiveName(files) {
    var base = String((files[0] && (files[0].relativePath||files[0].webkitRelativePath||files[0].name)) || 'files');
    base = base.split('/')[0] || base;
    var stem = base.replace(/\.[^.\\/]*$/, '') || base;
    if (stem.length > 80) stem = stem.slice(0, 80);
    return stem + '.zip';
  }

  // The container's own bytes, per file: local header + name, then the central
  // directory record + name, then the end record. No compression, no padding, so
  // this is everything an archive adds to a transfer.
  function zipEntryOverhead(nameLen, zip64) {
    return (30 + nameLen + (zip64 ? 20 : 0)) + (46 + nameLen + (zip64 ? 28 : 0));
  }

  function zipBuild(files, crcs, zip64) {
    var used = {}, enc = new TextEncoder(), list = [], off = 0, cdLen = 0, i;
    for (i = 0; i < files.length; i++) {
      var f = files[i];
      var size = Number(f.size) || 0;
      var nm = zipUnique(used, zipSafeName(f.relativePath || f.webkitRelativePath || f.name, i));
      var nb = enc.encode(nm);
      var when = dosWhen(f.lastModified);
      var local = new Uint8Array(30 + nb.length + (zip64 ? 20 : 0));
      var v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, zip64 ? 45 : 20, true);            // version needed to extract
      v.setUint16(6, 0x0800, true);                     // names are UTF-8
      v.setUint16(8, 0, true);                          // method: stored
      v.setUint16(10, when.t, true);
      v.setUint16(12, when.d, true);
      v.setUint32(14, crcs[i] >>> 0, true);
      v.setUint32(18, zip64 ? ZIP_MAX32 : (size % 0x100000000), true);
      v.setUint32(22, zip64 ? ZIP_MAX32 : (size % 0x100000000), true);
      v.setUint16(26, nb.length, true);
      v.setUint16(28, zip64 ? 20 : 0, true);
      local.set(nb, 30);
      if (zip64) {
        var p = 30 + nb.length;
        v.setUint16(p, 0x0001, true); v.setUint16(p + 2, 16, true);
        putU64(v, p + 4, size); putU64(v, p + 12, size);
      }
      list.push({ name: nm, nb: nb, size: size, crc: crcs[i] >>> 0, t: when.t, d: when.d,
        offset: off, local: local, file: f, cd: null });
      off += local.length + size;
    }
    var cdStart = off;
    for (i = 0; i < list.length; i++) {
      var en = list[i];
      var cd = new Uint8Array(46 + en.nb.length + (zip64 ? 28 : 0));
      var w = new DataView(cd.buffer);
      w.setUint32(0, 0x02014b50, true);
      w.setUint16(4, 20, true);                         // made by: DOS, no extras
      w.setUint16(8, zip64 ? 45 : 20, true);            // needed
      w.setUint16(10, 0x0800, true);
      w.setUint16(12, 0, true);                         // stored
      w.setUint16(14, en.t, true);
      w.setUint16(16, en.d, true);
      w.setUint32(18, en.crc, true);
      w.setUint32(22, zip64 ? ZIP_MAX32 : (en.size % 0x100000000), true);
      w.setUint32(26, zip64 ? ZIP_MAX32 : (en.size % 0x100000000), true);
      w.setUint16(30, en.nb.length, true);
      w.setUint16(32, zip64 ? 28 : 0, true);
      w.setUint32(38, 0, true);                         // internal attrs
      w.setUint32(40, 0x81a40000, true);                // -rw-r--r-- on a unix-ish reader
      w.setUint32(42, zip64 ? ZIP_MAX32 : (en.offset % 0x100000000), true);
      cd.set(en.nb, 46);
      if (zip64) {
        var q = 46 + en.nb.length;
        w.setUint16(q, 0x0001, true); w.setUint16(q + 2, 24, true);
        putU64(w, q + 4, en.size); putU64(w, q + 12, en.size); putU64(w, q + 20, en.offset);
      }
      en.cd = cd;
      cdLen += cd.length;
    }
    var afterCd = cdStart + cdLen, total;
    var tail;
    if (zip64) {
      tail = new Uint8Array(56 + 20 + 22);
      var z = new DataView(tail.buffer);
      z.setUint32(0, 0x06064b50, true);
      putU64(z, 4, 44);                                 // this record, minus its first 12 bytes
      z.setUint16(12, 45, true); z.setUint16(14, 45, true);
      z.setUint32(16, 0, true); z.setUint32(20, 0, true);
      putU64(z, 24, list.length); putU64(z, 32, list.length);
      putU64(z, 40, cdLen); putU64(z, 48, cdStart);
      z.setUint32(56, 0x07064b50, true);                // the locator that points at it
      z.setUint32(60, 0, true);
      putU64(z, 64, afterCd);
      z.setUint32(72, 1, true);
      z.setUint32(76, 0x06054b50, true);                // and the legacy record, maxed out
      z.setUint16(84, 0xffff, true);                       // entries on this disk
      z.setUint16(86, 0xffff, true);                        // entries in total
      z.setUint32(88, ZIP_MAX32, true);                  // size of central directory
      z.setUint32(92, ZIP_MAX32, true);                  // its offset
      z.setUint16(96, 0, true);                           // comment length
      total = afterCd + tail.length;
    } else {
      tail = new Uint8Array(22);
      var y = new DataView(tail.buffer);
      y.setUint32(0, 0x06054b50, true);
      y.setUint16(8, list.length, true);
      y.setUint16(10, list.length, true);
      y.setUint32(12, cdLen, true);
      y.setUint32(16, cdStart, true);
      total = afterCd + tail.length;
    }
    // cd entries are stored on the records so the region list can be built without
    // re-encoding anything
    return { list: list, zip64: zip64, cdStart: cdStart, total: total, tail: tail };
  }

  function zipNeeds64(files) {
    if (files.length > 0xffff) return true;
    var off = 0;
    for (var i = 0; i < files.length; i++) {
      var size = Number(files[i].size) || 0;
      if (size >= ZIP_MAX32) return true;
      off += size + 30 + String(files[i].name || '').length + 46 + String(files[i].name || '').length;
      if (off >= ZIP_MAX32) return true;
    }
    return false;
  }

  function zipLayout(files, crcs) {
    var zip64 = zipNeeds64(files);
    var lay = zipBuild(files, crcs, zip64);
    // The extra fields push the central directory past 4 GiB on their own, so the
    // decision has to be re-checked against the layout that would actually be
    // written — otherwise a 4 GiB minus one byte archive is one header too small.
    if (!zip64 && lay.total >= ZIP_MAX32) lay = zipBuild(files, crcs, true);
    return lay;
  }

  function zipRegions(lay) {
    var R = [], off = 0, i;
    for (i = 0; i < lay.list.length; i++) {
      var en = lay.list[i];
      R.push({ s: off, e: off + en.local.length, bytes: en.local });
      off += en.local.length;
      R.push({ s: off, e: off + en.size, file: en.file });
      off += en.size;
    }
    // the central directory sits right after the last file: concatenate the records
    var parts = [];
    for (i = 0; i < lay.list.length; i++) parts.push(lay.list[i].cd);
    var len = 0;
    for (i = 0; i < parts.length; i++) len += parts[i].length;
    var cd = new Uint8Array(len);
    var at = 0;
    for (i = 0; i < parts.length; i++) { cd.set(parts[i], at); at += parts[i].length; }
    R.push({ s: off, e: off + cd.length, bytes: cd });
    off += cd.length;
    R.push({ s: off, e: off + lay.tail.length, bytes: lay.tail });
    return R;
  }

  function zipSlice(regions, total, from, to) {
    from = Math.max(0, Math.floor(Number(from) || 0));
    to = to === undefined ? total : Math.min(total, Math.floor(Number(to) || 0));
    if (to <= from) return new Blob([], { type: 'application/zip' });
    var out = [];
    for (var i = 0; i < regions.length; i++) {
      var r = regions[i];
      if (r.e <= from || r.s >= to) continue;
      var a = Math.max(from, r.s) - r.s, b = Math.min(to, r.e) - r.s;
      out.push(r.bytes ? new Blob([r.bytes.subarray(a, b)]) : r.file.slice(a, b));
    }
    return new Blob(out, { type: 'application/zip' });
  }

  // What an archive adds to N files, without reading a byte: the plan preview needs
  // this to be honest about the part count before the upload starts.
  function archiveOverhead(files) {
    var fs = Array.prototype.slice.call(files || []);
    if (!fs.length) return 0;
    var crcs = fs.map(function () { return 0; });
    var lay = zipLayout(fs.map(function (f) { return { name: (f.relativePath||f.webkitRelativePath||f.name), size: Number(f.size) || 0, lastModified: f.lastModified }; }), crcs);
    var bodies = 0;
    for (var i = 0; i < fs.length; i++) bodies += Number(fs[i].size) || 0;
    return lay.total - bodies;
  }

  // The transfer object for a multi-file pick: looks like a file, is a container.
  async function makeArchive(files, opts) {
    opts = opts || {};
    var fs = Array.prototype.slice.call(files || []);
    if (!fs.length) throw new Error('Nothing to put in the archive.');
    if (fs.length < 2) return fs[0];
    var view = fs.map(function (f) { return { name: (f.relativePath||f.webkitRelativePath||f.name), size: Number(f.size) || 0, lastModified: f.lastModified }; });
    var crcs = [];
    for (var i = 0; i < fs.length; i++) {
      if (opts.onFile) opts.onFile(i, fs.length, fs[i].name);
      var crc = await crc32File(fs[i], opts.onProgress ? function (d, t) { opts.onProgress(i, fs.length, d, t); } : null, opts.signal);
      crcs.push(crc);
    }
    var lay = zipLayout(view, crcs);
    // zipBuild was given view objects for sizing, but the slice needs the real
    // Blobs to read from — replace the placeholder file refs with the originals.
    for (var k = 0; k < lay.list.length; k++) lay.list[k].file = fs[k];
    var regions = zipRegions(lay);
    var total = lay.total;
    var name = zipArchiveName(fs);
    var arch = {
      name: name,
      type: 'application/zip',
      size: total,
      lastModified: Date.now(),
      isArchive: true,
      archiveName: name,
      entries: lay.list.map(function (e) { return { name: e.name, size: e.size, crc: e.crc, offset: e.offset }; }),
      zip64: lay.zip64,
      slice: function (from, to) { return zipSlice(regions, total, from, to); }
    };
    arch.arrayBuffer = function () { return arch.slice(0, arch.size).arrayBuffer(); };
    arch.stream = function () { return arch.slice(0, arch.size).stream(); };
    // some callers check instanceof Blob/File; providing a minimal Blob-like interface
    // plus these two methods is enough for digestFolded and readSlice.
    return arch;
  }

  // ---- provider URL <-> id -------------------------------------------------
  // 'https://litter.catbox.moe/ab12cd.bin' -> { base: 'https://litter.catbox.moe/{id}', id: 'ab12cd.bin' }
  function urlToTemplate(url) {
    var s = String(url || '');
    var m = /^(https?:\/\/[^\s]+?)\/([^\/?#]+)(?:[?#].*)?$/.exec(s);
    if (!m) throw new Error('Unexpected provider URL: ' + s);
    return { base: m[1] + '/{id}', id: m[2] };
  }

  function templateToUrl(base, id) {
    var b = String(base || '');
    return b.indexOf('{id}') >= 0 ? b.replace('{id}', id) : b + id;
  }

  // ---- transfer plan -------------------------------------------------------
  // Builds the part list + per-part digests, encrypting each part in place when
  // a key is given (so what the host stores is never your original bytes).
  // Records are numbered continuously across parts, and each part reports how
  // many it holds, so parts can be any size at all.
  async function buildTransfer(opts) {
    var files = opts.files || [];
    // One object per transfer is the format's rule, not the picker's: several picked
    // files arrive here already wrapped by MD.pack.makeArchive, which is a *view*
    // over them, so the part loop never holds more than a part.
    var file = opts.file || (files.length === 1 ? files[0] : null);
    var maxPart = opts.maxPartBytes;
    var enc = opts.enc || null; // {key, ivPrefix(Uint8Array), blockSize?}
    var onPartHash = opts.onPartHash || function () {};

    if (!file) {
      if (files.length > 1) throw new Error('Several files have to be wrapped first: pass MD.pack.makeArchive(files) as opts.file.');
      throw new Error('No file selected.');
    }
    var total = Number(file.size) || 0;
    if (!total) throw new Error(files.length > 1 ? 'Every one of those files is empty.' : 'The file is empty.');

    var blockSize = enc ? (enc.blockSize || MD.crypto.MAX_PLAIN_BLOCK) : 0;
    var parts = planParts(total, maxPart, blockSize || 1);

    var out = [];
    var blockIdx = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var plain = await readSlice(file, p.start, p.size);
      var blob;
      if (enc) {
        blob = await MD.crypto.encryptBlob(plain, enc.key, enc.ivPrefix, blockIdx, p.size, blockSize);
        blockIdx += MD.crypto.blockCount(p.size, blockSize);
      } else {
        blob = plain;
      }
      var hex = await MD.crypto.sha256Hex(blob);
      out.push({ start: p.start, size: p.size, blobSize: blob.byteLength, sha256: hex, blob: blob });
      onPartHash(i, out.length, hex);
    }
    return { parts: out, total: total, blocks: blockIdx, blockSize: blockSize };
  }

  MD.pack = {
    BOUNDARY: BOUNDARY,
    planParts: planParts,
    readSlice: readSlice,
    hashSlice: hashSlice,
    buildMultipartBody: buildMultipartBody,
    multipartFromBlob: multipartFromBlob,
    makeArchive: makeArchive,
    archiveOverhead: archiveOverhead,
    archiveName: zipArchiveName,
    crc32Bytes: crc32Bytes,
    crc32File: crc32File,
    urlToTemplate: urlToTemplate,
    templateToUrl: templateToUrl,
    buildTransfer: buildTransfer
  };
})(typeof window !== 'undefined' ? window : globalThis);
