/* MailDrop — optional crypto. Everything is WebCrypto, all in the browser,
   no key ever leaves the machine. The key travels inside the URL hash, which
   browsers do not send to servers and which never lands in a Referer header. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  var PBKDF2_ITERATIONS = 210000;
  var DEFAULT_BLOCK_LEN = 32 * 1024 * 1024; // one AES-GCM record per 32 MiB of plaintext
  var OVERHEAD = 16;                     // GCM tag only: the 12-byte IV is derived from
                                         // (random prefix, block index), never transmitted
  var MAX_PLAIN_BLOCK = DEFAULT_BLOCK_LEN - OVERHEAD;

  // Small RAM budgets (phones, 4 GB laptops) can shrink the record size; the
  // value travels in the manifest so the receiver reads it the same way.
  function setBlockSize(n) {
    n = Math.floor(Number(n) || 0);
    if (n <= OVERHEAD * 4) throw new Error('block size too small');
    MAX_PLAIN_BLOCK = n;
    return MAX_PLAIN_BLOCK;
  }

  function subtle() {
    var s = global.crypto && global.crypto.subtle;
    if (!s) throw new Error('WebCrypto unavailable in this context — open the page over https:// (file:// cannot encrypt).');
    return s;
  }

  function available() { return !!(global.crypto && global.crypto.subtle); }

  function sha256Hex(data) {
    return subtle().digest('SHA-256', data).then(function (buf) { return U.toHex(buf); });
  }

  // --- memory-frugal streaming over a File/Blob (no full-file RAM load) -----
  async function* blobChunks(blob, size) {
    if (typeof blob.stream === 'function') {
      var reader = blob.stream().getReader();
      var buf = new Uint8Array(size), filled = 0;
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        var v = r.value;
        var i = 0;
        while (i < v.byteLength) {
          var take = Math.min(v.byteLength - i, size - filled);
          buf.set(v.subarray(i, i + take), filled);
          filled += take; i += take;
          if (filled === size) { yield buf; buf = new Uint8Array(size); filled = 0; }
        }
      }
      if (filled) yield buf.subarray(0, filled);
      return;
    }
    var all = new Uint8Array(await blob.arrayBuffer());
    for (var o = 0; o < all.byteLength; o += size) yield all.subarray(o, Math.min(all.byteLength, o + size));
  }

  // WebCrypto has no streaming SHA-256, so we fold fixed-size window digests:
  // H = SHA256(h1 || h2 || …). Not the raw file digest, but both ends can
  // reproduce it with only one window in RAM at a time.
  // Incremental folded hasher: feed it any number of byte windows and it
  // returns the same hex for the same byte stream, regardless of how that
  // stream was chunked into pushes. Used by both ends, and while streaming to
  // disk so verification costs no extra pass over the file.
  function Folder(chunk) {
    if (!(this instanceof Folder)) return new Folder(chunk);
    this.chunk = chunk || 67108864;
    this.digests = [];
    this.pending = new Uint8Array(0);
    this.bytes = 0;
  }
  Folder.prototype.push = async function (u8) {
    this.bytes += u8.byteLength;
    if (this.pending.length) {
      var joined = new Uint8Array(this.pending.length + u8.byteLength);
      joined.set(this.pending, 0); joined.set(u8, this.pending.length);
      u8 = joined;
      this.pending = new Uint8Array(0);
    }
    var o = 0;
    while (u8.byteLength - o >= this.chunk) {
      this.digests.push(new Uint8Array(await subtle().digest('SHA-256', u8.subarray(o, o + this.chunk))));
      o += this.chunk;
    }
    if (o < u8.byteLength) this.pending = u8.slice(o);
    return this.bytes;
  };
  Folder.prototype.finish = async function () {
    if (this.pending.length) {
      this.digests.push(new Uint8Array(await subtle().digest('SHA-256', this.pending)));
      this.pending = new Uint8Array(0);
    }
    if (!this.digests.length) this.digests.push(new Uint8Array(await subtle().digest('SHA-256', new Uint8Array(0))));
    if (this.digests.length === 1 && this.bytes === 0) this.digests = [this.digests[0]];
    var single = this.digests.length === 1 && this.bytes <= this.chunk ? this.digests[0] : null;
    var final = single || new Uint8Array(await subtle().digest('SHA-256', concat(this.digests)));
    return U.toHex(final);
  };

  async function digestFolded(blob, chunk, onProgress, signal) {
    var f = Folder(chunk);
    var it = blobChunks(blob, f.chunk)[Symbol.asyncIterator]();
    while (true) {
      if (signal && signal.aborted) { var e = new Error('Cancelled.'); e.cancelled = true; throw e; }
      var step = await it.next();
      if (step.done) break;
      await f.push(step.value.byteLength === f.chunk ? step.value : step.value.slice());
      if (onProgress) onProgress(f.bytes, blob.size);
    }
    return f.finish();
  }

  // plain SHA-256 of a Blob (one window, used for per-part digests)
  function sha256HexOfBlob(blob) {
    return blob.arrayBuffer().then(function (b) { return sha256Hex(new Uint8Array(b)); });
  }

  function partPayloadSize(storedBytes, blocks) {
    return storedBytes - (blocks || 0) * OVERHEAD;
  }

  // One PBKDF2 pull yields 512 bits: the low half becomes the AES key, the high
  // half becomes the "password is right" verifier. The AES key stays
  // non-extractable, and no cipher call is wasted on a password check.
  function deriveMaterial(password, saltBytes, iterations) {
    var it = iterations || PBKDF2_ITERATIONS;
    return subtle().importKey('raw', U.utf8Encode(String(password)), 'PBKDF2', false, ['deriveBits'])
      .then(function (base) {
        return subtle().deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: it, hash: 'SHA-256' }, base, 512);
      })
      .then(function (bits) {
        var half = new Uint8Array(bits);
        return { key: null, verifier: U.toHex(half.subarray(32, 64)).slice(0, 12), keyBytes: half.subarray(0, 32) };
      })
      .then(function (mat) {
        return subtle().importKey('raw', mat.keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
          .then(function (key) { return { key: key, verifier: mat.verifier }; });
      });
  }

  function deriveKey(password, saltBytes, iterations) {
    return deriveMaterial(password, saltBytes, iterations).then(function (m) { return m.key; });
  }

  function fingerprint(password, saltBytes, iterations) {
    return deriveMaterial(password, saltBytes, iterations).then(function (m) { return m.verifier; });
  }

  function makeEncryptor(password, saltBytes, iterations) { return deriveMaterial(password, saltBytes, iterations); }

  function makeIv(prefixBytes, blockIdx) {
    var iv = new Uint8Array(12);
    iv.set(prefixBytes.subarray(0, 4), 0);
    var view = new DataView(iv.buffer);
    view.setUint32(4, Math.floor(blockIdx / 0x100000000) >>> 0, false);
    view.setUint32(8, blockIdx >>> 0, false);
    return iv;
  }

  function blockCount(plainLen, blockSize) {
    var bs = blockSize || MAX_PLAIN_BLOCK;
    if (plainLen <= 0) return 0;
    return Math.ceil(plainLen / bs);
  }

  // `plainLen` is the length of the byte stream in this blob; `blockBase` is the
  // index of the first block within the whole transfer (blocks run continuously
  // across blobs so one shared IV prefix is safe).
  function encryptBlob(plainBytes, key, ivPrefix, blockBase, plainLen, blockSize) {
    var bs = blockSize || MAX_PLAIN_BLOCK;
    return (async function () {
      var total = blockCount(plainLen, bs);
      var out = [];
      for (var i = 0; i < total; i++) {
        var start = i * bs;
        var end = Math.min(plainLen, start + bs);
        var chunk = plainBytes.subarray(start, end);
        var cipher = await subtle().encrypt({ name: 'AES-GCM', iv: makeIv(ivPrefix, blockBase + i), tagLength: 128 }, key, chunk);
        out.push(new Uint8Array(cipher));
      }
      return concat(out);
    })();
  }

  // Decrypts a payload made of `blocks` AES-GCM records, given the total
  // plaintext length so the final (short) record can be sized correctly.
  function decryptPayload(cipherBytes, key, ivPrefix, blockBase, plainLen, blocks, blockSize) {
    var bs = blockSize || MAX_PLAIN_BLOCK;
    return (async function () {
      var n = blocks || blockCount(plainLen, bs);
      var off = 0;
      var out = [];
      for (var i = 0; i < n; i++) {
        var thisPlain = Math.min(bs, plainLen - i * bs);
        var len = thisPlain + OVERHEAD;
        var slice = cipherBytes.subarray(off, off + len);
        if (slice.byteLength !== len) throw new Error('Encrypted data is truncated — a part did not download completely.');
        var plain = await subtle().decrypt({ name: 'AES-GCM', iv: makeIv(ivPrefix, blockBase + i), tagLength: 128 }, key, slice);
        out.push(new Uint8Array(plain));
        off += len;
      }
      if (off !== cipherBytes.byteLength) throw new Error('Encrypted data has trailing bytes — the blob is not the one described by the link.');
      return concat(out);
    })();
  }

  function concat(u8s) {
    var total = 0, i;
    for (i = 0; i < u8s.length; i++) total += u8s[i].byteLength;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < u8s.length; i++) { out.set(u8s[i], o); o += u8s[i].byteLength; }
    return out;
  }

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa ? global.btoa(s) : Buffer.from(bytes).toString('base64');
  }

  function unb64(str) {
    var bin = global.atob ? global.atob(str) : Buffer.from(str, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // One AES-GCM record on its own. This is what makes streaming possible: the
  // reader asks the host for exactly recordSpan() bytes, decrypts one record,
  // writes it and forgets it — so a 950 MiB part never needs 950 MiB of RAM.
  function decryptRecord(cipherBytes, key, ivPrefix, blockIdx, blockSize) {
    return subtle().decrypt({ name: 'AES-GCM', iv: makeIv(ivPrefix, blockIdx), tagLength: 128 }, key, cipherBytes)
      .then(function (b) { return new Uint8Array(b); });
  }

  function recordSpan(blockSize) { return (blockSize || MAX_PLAIN_BLOCK) + OVERHEAD; }

  // Fingerprint of the per-part digests: used when the file was too big to fold
  // in one pass, so that even a six-part transfer ends with one value that binds
  // every part together and proves none of them was swapped.
  function chainDigest(partHexes) {
    return (async function () {
      var bytes = U.utf8Encode(partHexes.map(function (h) { return String(h || '').slice(0, 16); }).join(''));
      return U.toHex(await subtle().digest('SHA-256', bytes));
    })();
  }

  MD.crypto = {
    DEFAULT_BLOCK_LEN: DEFAULT_BLOCK_LEN,
    setBlockSize: setBlockSize,
    OVERHEAD: OVERHEAD,
    MAX_PLAIN_BLOCK: MAX_PLAIN_BLOCK,
    PBKDF2_ITERATIONS: PBKDF2_ITERATIONS,
    available: available,
    sha256Hex: sha256Hex,
    digestFolded: digestFolded,
    Folder: Folder,
    sha256HexOfBlob: sha256HexOfBlob,
    partPayloadSize: partPayloadSize,
    blobChunks: blobChunks,
    deriveKey: deriveKey,
    deriveMaterial: deriveMaterial,
    makeEncryptor: makeEncryptor,
    fingerprint: fingerprint,
    encryptBlob: encryptBlob,
    decryptPayload: decryptPayload,
    decryptRecord: decryptRecord,
    recordSpan: recordSpan,
    chainDigest: chainDigest,
    blockCount: blockCount,
    makeIv: makeIv,
    b64: b64,
    unb64: unb64,
    concat: concat
  };
})(typeof window !== 'undefined' ? window : globalThis);
