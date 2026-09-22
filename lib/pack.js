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

  function buildMultipartBody(fields, file, start, size, filename, type) {
    return multipartFromBlob(fields, file.slice(start, start + size), filename, type);
  }

  // Same envelope, but around an already-prepared Blob (the encrypted part).
  function multipartFromBlob(fields, blob, filename, type) {
    var blobParts = [];
    fields = fields || {};
    Object.keys(fields).forEach(function (k) { blobParts.push(multipartField(k, fields[k])); });
    blobParts.push(multipartFilePart('file', filename || 'file.bin', type));
    blobParts.push(blob);
    blobParts.push(multipartEnd());
    return new Blob(blobParts, { type: 'multipart/form-data; boundary=' + BOUNDARY });
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
    var maxPart = opts.maxPartBytes;
    var enc = opts.enc || null; // {key, ivPrefix(Uint8Array), blockSize?}
    var onPartHash = opts.onPartHash || function () {};

    if (!files.length) throw new Error('No file selected.');
    if (files.length > 1) throw new Error('One file per transfer in this version.');
    var total = 0;
    files.forEach(function (f) { total += f.size; });
    if (!total) throw new Error('All selected files are empty.');

    var blockSize = enc ? (enc.blockSize || MD.crypto.MAX_PLAIN_BLOCK) : 0;
    var parts = planParts(total, maxPart, blockSize || 1);

    var out = [];
    var blockIdx = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var plain = await readSlice(files[0], p.start, p.size);
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
    urlToTemplate: urlToTemplate,
    templateToUrl: templateToUrl,
    buildTransfer: buildTransfer
  };
})(typeof window !== 'undefined' ? window : globalThis);
