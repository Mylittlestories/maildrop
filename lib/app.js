/* MailDrop — UI glue: the Send flow (pack → parts → link → email) and the
   Receive flow (link → parts → verify → file). Everything below is vanilla JS
   with no build step, so the repo can be published as plain static files. */
(function (global) {
  'use strict';
  var MD = (global.MD = global.MD || {});
  var U = MD.util;

  var LS_KEY = 'maildrop.settings.v1';
  var RESUME_KEY = 'maildrop.resume.v1';
  var HIST_KEY = 'maildrop.history.v1';
  var MAX_TOKEN_CHARS = 6200;

  var defaults = {
    backend: 'litterbox',
    expiry: null,           // provider token, e.g. '72h'
    partCapBytes: null,     // user override of the per-part size
    receiveBase: '',        // where the receive page lives (defaults to this page)
    password: '',
    includeTokenInMail: true,
    s3: {
      endpoint: '', bucket: '', region: 'auto', keyId: '', secret: '',
      keyPrefix: 'maildrop/', publicBase: '', signedUrlExpiry: 86400
    }
  };

  var state = {
    cfg: null,
    files: [],
    busy: false,
    abort: null,
    lastManifest: null,
    lastLink: '',
    receive: { m: null, extra: {}, password: '', busy: false, abort: null, resultBlob: null }
  };

  function loadCfg() {
    var raw = null;
    try { raw = JSON.parse(global.localStorage.getItem(LS_KEY) || 'null'); } catch (e) { raw = null; }
    var c = JSON.parse(JSON.stringify(defaults));
    // lib/config.js, if it carries anything, is the starting point for a shared
    // deployment. Whatever this browser already chose wins over it, so a
    // site-wide file can never stomp on a personal setting.
    var K = (global.MD && global.MD.config) || null;
    if (K && typeof K === 'object') {
      ['backend', 'receiveBase', 'partCapBytes', 'expiry'].forEach(function (k) {
        if (K[k]) c[k] = K[k];
      });
      if (K.s3) Object.keys(K.s3).forEach(function (k) {
        if (K.s3[k] && (c.s3[k] === '' || c.s3[k] == null)) c.s3[k] = K.s3[k];
      });
    }
    if (raw && typeof raw === 'object') {
      Object.keys(c).forEach(function (k) {
        if (raw[k] === undefined) return;
        if (k === 's3') { c.s3 = Object.assign(c.s3, raw.s3 || {}); }
        else c[k] = raw[k];
      });
    }
    state.cfg = c;
    return c;
  }

  function saveCfg() {
    try { global.localStorage.setItem(LS_KEY, JSON.stringify(state.cfg)); } catch (e) { /* private mode */ }
  }

  function history() {
    try { return JSON.parse(global.localStorage.getItem(HIST_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function pushHistory(entry) {
    var h = history();
    h.unshift(entry);
    h = h.slice(0, 25);
    try { global.localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { }
    // the view redraws the list; app.js only knows about the record
    UI.renderHistory();
  }

  function currentBackend() {
    var b = MD.backends.get(state.cfg.backend) || MD.backends.get('litterbox');
    if (b.key === 'selfhost' && !MD.backends.selfhostConfigured(state.cfg.s3)) {
      b = MD.backends.get('litterbox');
      UI.warn('Your bucket is not configured yet — falling back to ' + b.label + '.');
    }
    return b;
  }

  // Part size policy: never above what the host accepts, never below 1 MiB
  // (a link with thousands of parts is useless), and a manual override always
  // wins over the recommended 16 MiB floor — the tester who types 1MB means it.
  var MIN_PART = 1 * 1024 * 1024;
  var SOFT_MIN_PART = 16 * 1024 * 1024;
  var MAX_PARTS_KEEN = 40;
  function partCap(backend) {
    var cap = Math.max(SOFT_MIN_PART, backend.maxPartBytes);
    var override = U.parseSizeInput(state.cfg.partCapBytes == null ? '' : String(state.cfg.partCapBytes));
    if (override) cap = Math.min(cap, override);
    return Math.max(MIN_PART, cap);
  }
  function encBlockSize() { return MD.crypto.MAX_PLAIN_BLOCK; }

  function receiveBaseUrl() {
    var base = (state.cfg.receiveBase || '').trim();
    if (!base) base = global.location.href.split('#')[0];
    return base.replace(/[#?].*$/, '');
  }

  // ------------------------------------------------------------- send: plan ---
  function plan(files) {
    var backend = currentBackend();
    if (backend.noUpload) {
      return { backend: backend, cap: 0, total: 0, parts: [], count: 0, direct: true };
    }
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    var info = files.length === 1 ? planInfoFor(backend, { size: total })
                                  : { parts: [], cap: partCap(backend), linkChars: 0, linkFits: true, capRaised: false };
    return { backend: backend, cap: info.cap, total: total, parts: info.parts, count: info.parts.length,
             linkChars: info.linkChars, linkFits: info.linkFits, capRaised: info.capRaised };
  }

  function validateFiles(files) {
    var errs = [];
    var b = currentBackend();
    if (b.noUpload) {
      var url = (state.directUrl || '').trim();
      if (!/^https?:\/\/.+/i.test(url)) errs.push('“Your own link” mode needs a full http(s):// download URL.');
      return errs;
    }
    if (!files.length) errs.push('Pick at least one file.');
    if (files.length > 1) errs.push('Version 1 sends one file per link. Zip the others together (right-click → Send to → Compressed folder / Compress) or send a second link.');
    if (files.length === 1) {
      var pi = planInfoFor(b, files[0]);
      if (!pi.linkFits) {
        errs.push(files[0].name + ' would need a ' + pi.linkChars + '-character link at ' + U.fmtBytes(pi.cap) +
          ' parts, past the ' + MAX_TOKEN_CHARS + '-character budget. ' + shortName(b) +
          ' will not take larger parts — raise “parts at most” in Settings only if the host allows it, or send this one from your own bucket.');
      }
    }
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    if (total === 0) errs.push('The file is empty.');
    if (b.key !== 'selfhost' && total > 20 * 1024 * 1024 * 1024) errs.push('That is over 20 GB — set up your own bucket in Settings for files that big.');
    return errs;
  }

  // ------------------------------------------------------------ send: hash ---
  // Both ends reproduce the same fingerprint from MD.crypto.digestFolded, so it
  // costs one 64 MiB window of RAM regardless of how big the file is.
  function hashWholeFile(blob, onProgress, signal) {
    return MD.crypto.digestFolded(blob, MD.app.HASH_CHUNK, onProgress, signal);
  }

  function abortErr() { var e = new Error('Cancelled.'); e.cancelled = true; return e; }

  // ----------------------------------------------------------- send: upload ---
  // One part at a time: read the slice, encrypt it if a password was given,
  // wrap it in whatever envelope the host expects, upload with retries, and
  // remember {id, stored size, record count, digest of stored bytes}.
  async function runSend() {
    var app = MD.app, A = MD.app.state;
    var files = A.files;
    var errs = validateFiles(files);
    if (errs.length) { UI.error(errs.join(' ')); return; }
    var file = files[0];
    var backend = currentBackend();

    if (backend.noUpload) {
      A.busy = true; UI.setBusy(true);
      try {
        var url = (state.directUrl || '').trim();
        var guess = decodeURIComponent((url.split('?')[0].split('/').pop() || 'file')).replace(/[^A-Za-z0-9 ._()-]/g, '_').slice(0, 120);
        var dm = {
          v: MD.manifest.VERSION, n: guess || 'file', t: '', z: 0, p: 'direct',
          b: url, d: 0, o: '', f: 'direct', u: url, e: null, h: '',
          parts: [{ i: url, s: 0, h: '', b: 0 }]
        };
        var dtok = MD.manifest.encode(dm);
        var dlink = MD.manifest.buildUrl(receiveBaseUrl(), dm);
        A.lastManifest = dm; A.lastLink = dlink;
        UI.showLink(dlink, dm, dtok);
        pushHistory({ n: dm.n, z: 0, u: dlink, at: Date.now() });
      } catch (e) {
        UI.error(e.message || String(e));
      } finally {
        A.busy = false; UI.setBusy(false);
      }
      return;
    }

    var info = plan(files);
    var encPlan = planInfoFor(backend, file);
    var parts = encPlan.parts;

    var sig = resumeSig(file, backend, encPlan.cap, !!(A.cfg.password || '').trim(), A.cfg.expiry);
    var resume = A.dropResume ? null : resumeRecord(sig);
    A.dropResume = false;
    if (resume && (resume.count !== parts.length || resume.total !== file.size)) resume = null;
    var rec = resume || null;
    var reused = 0;

    A.busy = true;
    A.abort = new AbortController();
    UI.setBusy(true);
    UI.show('progress');
    UI.progress(0, 1, 'Staging ' + U.fmtBytes(file.size) + ' into ' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + ' …');

    try {
      var pw = (A.cfg.password || '').trim();
      var enc = null;
      if (pw) {
        if (!MD.crypto.available()) throw new Error('Password protection needs the https:// deployment (WebCrypto is unavailable here).');
        UI.progress(0, 1, 'Stretching the password into a key (PBKDF2, ' + MD.crypto.PBKDF2_ITERATIONS.toLocaleString() + ' rounds) …');
        var salt = rec && rec.salt ? MD.crypto.unb64(rec.salt) : U.randomBytes(16);
        var mat = await MD.crypto.makeEncryptor(pw, salt);
        enc = { key: mat.key, verifier: mat.verifier, salt: salt, blockSize: encPlan.blockSize,
          ivPrefix: rec && rec.ivp ? MD.crypto.unb64(rec.ivp) : U.randomBytes(4) };
        // The parts already on the host were sealed with the password from that
        // attempt. A different one derives a different key, and mixing the two
        // makes a file that cannot be opened at all — so it is refused, not tried.
        if (rec && rec.fp && rec.fp !== enc.verifier) {
          UI.warn('That password is not the one the earlier attempt used, so its parts are left alone and this job starts fresh.');
          clearResume(sig);
          rec = null;
        }
      }

      // Folding the whole file is one extra streaming read, so it is the default
      // and only skipped when the wait would be rude. A skipped fold is not a
      // silent downgrade: the fingerprint becomes the digest of the part digests,
      // which still binds every part together, and the link records which it is.
      var fingerprint = '';
      var chainMode = file.size > app.FOLD_LIMIT;
      if (!chainMode) {
        UI.progress(0, 1, 'Fingerprinting the file so the recipient can prove nothing changed …');
        fingerprint = await MD.crypto.digestFolded(file, app.HASH_CHUNK, function (d, t) {
          UI.progress(d, t, 'Fingerprinting ' + U.fmtBytes(file.size) + ' … ' + Math.round(d / t * 100) + '%');
        }, A.abort.signal);
      } else {
        UI.note('Over ' + U.fmtBytes(app.FOLD_LIMIT) + ': the link carries a fingerprint built from the part digests rather than one pass over the whole file, and every part is still checked on its own.');
      }

      var expMs = expiryMs(backend);
      var fields = backend.fieldsFor ? backend.fieldsFor(A.cfg.expiry || backend.defaultExpiry) : {};
      var sent = [];
      var stranded = [];   // what really reached the host, for the cleanup below
      if (!rec) {
        rec = { at: Date.now(), until: Date.now() + (expMs || 6 * 3600000), count: parts.length,
                cap: encPlan.cap, total: file.size, enc: !!enc, backend: backend.key,
                salt: enc ? MD.crypto.b64(enc.salt) : '', ivp: enc ? MD.crypto.b64(enc.ivPrefix) : '',
                fp: enc ? enc.verifier : '', parts: [] };
      }
      var base = '';
      var blocksTotal = 0;
      var uploaded = 0;
      var rate = { t0: Date.now(), b0: 0, bps: 0 };

      for (var i = 0; i < parts.length; i++) {
        if (A.abort.signal.aborted) throw abortErr();
        var p = parts[i];
        var body, partSha = '', blocks = 0, payloadSize = p.size;

        var keep = rec.parts[i];
        if (keep && keep.i && keep.l === p.size) {
          sent.push({ i: keep.i, s: keep.s, h: keep.h, b: keep.b });
          blocksTotal += keep.b || 0;
          uploaded += p.size;
          reused++;
          UI.progress(uploaded, file.size, 'Part ' + (i + 1) + '/' + parts.length +
            ' was already on ' + shortName(backend) + ' — kept, nothing to re-send');
          continue;
        }

        if (enc) {
          UI.progress(uploaded, file.size, 'Reading + encrypting part ' + (i + 1) + '/' + parts.length + ' …');
          var plain = await MD.pack.readSlice(file, p.start, p.size);
          blocks = MD.crypto.blockCount(p.size, enc.blockSize);
          var cipher = await MD.crypto.encryptBlob(plain, enc.key, enc.ivPrefix, blocksTotal, p.size, enc.blockSize);
          blocksTotal += blocks;
          plain = null;
          // folded, not raw SHA-256: the receiver streams the same bytes in
          // windows and has no way to hash a 950 MiB part in one WebCrypto call
          partSha = await MD.crypto.digestFolded(new Blob([cipher]), app.HASH_CHUNK);
          payloadSize = cipher.byteLength;
          body = MD.backends.partBody(backend, new Blob([cipher], { type: 'application/octet-stream' }), fields, file.name, 'application/octet-stream');
          cipher = null;
        } else {
          var slice = file.slice(p.start, p.start + p.size);
          partSha = await MD.crypto.digestFolded(slice, app.HASH_CHUNK);
          body = MD.backends.partBody(backend, slice, fields, file.name, file.type || 'application/octet-stream');
        }

        // What the host stores and later serves back is the payload, not the
      // form framing that carried it — so the manifest records the payload size.
        var storedBytes = payloadSize;
        UI.progress(uploaded, file.size, 'Uploading part ' + (i + 1) + '/' + parts.length + ' (' + U.fmtBytes(storedBytes) + ') to ' + shortName(backend) + ' …');

        var res = await MD.backends.uploadPart(backend, body, {
          cfg: A.cfg.s3,
          objectKey: backend.key === 'selfhost' ? MD.backends.s3.objectKey(A.cfg.s3, file.name) : undefined,
          signal: A.abort.signal,
          onProgress: function (loaded, totalBytes) {
            var done = uploaded + loaded;
            var now = Date.now();
            if (now - rate.t0 > 400) {
              rate.bps = rate.bps * 0.6 + ((done - rate.b0) / ((now - rate.t0) / 1000)) * 0.4;
              rate.t0 = now; rate.b0 = done;
            }
            UI.progress(done, file.size,
              'Part ' + (i + 1) + '/' + parts.length + ' — ' + U.fmtBytes(done) + ' / ' + U.fmtBytes(file.size) +
              ' · ' + U.fmtRate(rate.bps) + ' · ' + U.fmtEta(file.size - done, rate.bps) + ' left');
          },
          onRetry: function (n, wait, e) {
            UI.warn('Part ' + (i + 1) + ' failed (' + e.message + '). Retrying in ' + Math.round(wait / 1000) + ' s …');
          }
        });

        uploaded += p.size;
        base = res.base || base;
        var entry = { i: res.id, s: payloadSize, h: partSha.slice(0, 16), b: blocks, l: p.size };
        sent.push(entry);
        stranded.push(res.id);
        // written per part, not per byte: this is what makes a resume possible
        // after the tab is closed, and it costs one small localStorage write.
        rec.parts[i] = entry;
        saveResume(sig, rec);
        UI.progress(uploaded, file.size, 'Part ' + (i + 1) + '/' + parts.length + ' stored ✓');
        body = null;
      }

      if (chainMode) {
        // The file was too big to fold while the user waited, so the link's
        // fingerprint becomes the digest of the part digests: still one value
        // that only matches when every part is present and untouched.
        fingerprint = await MD.crypto.chainDigest(sent.map(function (x) { return x.h; }));
      }
      var m = {
        v: MD.manifest.VERSION,
        n: U.cleanName(file.name),
        t: file.type || '',
        z: file.size,
        p: backend.key,
        b: base || (backend.key === 'local' ? 'local://{id}' : backend.key === 'mockhost' ? MD.backends.mock.base + 'f/{id}' : ''),
        d: expMs,
        o: '',
        c: app.HASH_CHUNK,
        e: enc ? {
          salt: MD.crypto.b64(enc.salt), fp: enc.verifier, iv: MD.crypto.b64(enc.ivPrefix),
          it: MD.crypto.PBKDF2_ITERATIONS, bs: enc.blockSize, oh: MD.crypto.OVERHEAD
        } : null,
        h: fingerprint,
        hm: chainMode ? 'parts' : 'file',
        x: expMs ? Date.now() + expMs : 0,
        u: sent.length === 1 ? MD.pack.templateToUrl(base || '', sent[0].i) : '',
        parts: sent
      };
      var token;
      try { token = MD.manifest.encode(m); }
      catch (e) { throw new Error('The link could not be built: ' + e.message); }
      if (token.length > MAX_TOKEN_CHARS) {
        throw new Error('The link would be ' + token.length + ' characters, over the ' + MAX_TOKEN_CHARS + ' budget. Raise the per-part size in Settings so fewer parts are needed.');
      }

      var link = MD.manifest.buildUrl(receiveBaseUrl(), m);
      A.lastManifest = m;
      A.lastLink = link;
      UI.progress(file.size, file.size, 'Done.');
      clearResume(sig);
      if (reused) UI.note(reused + ' of ' + parts.length + ' parts came from the earlier attempt; the rest were sent now.');
      UI.showLink(link, m, token);
      pushHistory({ n: m.n, z: m.z, u: link, at: Date.now() });
    } catch (e) {
      await afterFailure(backend, e, stranded, expMs, { sig: sig, rec: rec, reused: reused });
      UI.hideProgress && UI.hideProgress();
    } finally {
      A.busy = false;
      A.abort = null;
      UI.setBusy(false);
      // the plan is what the user reads after a failure, so it has to reflect the
      // record that was just written — otherwise "start again" looks like "start over"
      UI.renderPlan && UI.renderPlan();
    }
  }

  function shortName(backend) { return String(backend.label || backend.key).split(' —')[0]; }

  // ---- continuing an attempt that did not finish ---------------------------
  /* A 5 GiB job that dies on part 20 has already put 19 parts on a host that was
     going to keep them for hours regardless. Starting over from part 1 throws that
     work away and strands the old parts twice as long, so the plan is matched
     against what is left and the next Start sends only what is missing. The record
     is enough to rebuild the *same* bytes: the part sizes, the digests, and for an
     encrypted job the salt and IV prefix, which is what makes the already-sealed
     parts still readable. */
  function resumeSig(file, backend, cap, pwOn, expiry) {
    return [file.name, file.size, file.lastModified || 0, backend.key, cap,
      pwOn ? 'enc' : 'plain', expiry || ''].join('|');
  }
  // A deployment that would rather nothing about a job outlive the tab can switch
  // this off in lib/config.js; the transfer still works, it just starts over.
  function resumeAllowed() {
    var K = (MD.config || {});
    return K.rememberAttempts !== false && K.rememberAttempts !== 'false' && K.rememberAttempts !== 0;
  }

  function resumeMap() {
    try { var v = JSON.parse(global.localStorage.getItem(RESUME_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; }
    catch (e) { return {}; }
  }
  function resumeRecord(sig) {
    if (!resumeAllowed()) return null;
    var r = resumeMap()[sig];
    if (!r || !r.count) return null;
    // the host's clock is the only honest expiry: past it the parts are gone and a
    // "continue" would quietly produce a corrupt file
    if (!(r.until > Date.now())) return null;
    return r;
  }
  function saveResume(sig, rec) {
    if (!resumeAllowed()) return;
    try {
      var all = resumeMap();
      all[sig] = rec;
      // two files' worth is plenty; the oldest goes first
      var keys = Object.keys(all);
      while (keys.length > 3) { delete all[keys.shift()]; }
      global.localStorage.setItem(RESUME_KEY, JSON.stringify(all));
    } catch (e) { /* private mode: nothing to resume from, which is fine */ }
  }
  function clearResume(sig) {
    try {
      var all = resumeMap();
      if (all[sig]) { delete all[sig]; global.localStorage.setItem(RESUME_KEY, JSON.stringify(all)); }
    } catch (e) { }
  }
  function resumeFor(file) {
    if (!file) return null;
    var backend = currentBackend();
    if (!backend || backend.noUpload) return null;
    var info = planInfoFor(backend, file);
    var sig = resumeSig(file, backend, info.cap, !!(state.cfg.password || '').trim(), state.cfg.expiry);
    var r = resumeRecord(sig);
    if (!r || r.count !== info.parts.length || r.total !== file.size) return null;
    var done = 0, ids = [];
    for (var i = 0; i < r.parts.length; i++) if (r.parts[i]) { done++; ids.push(r.parts[i].i); }
    if (!done) return null;
    return { sig: sig, rec: r, done: done, count: r.count, ids: ids, backend: backend, until: r.until };
  }
  async function deleteParts(backend, ids) {
    var gone = 0, failed = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await backend.remove(ids[i], state.cfg.s3, {}); gone++; }
      catch (e) { failed++; }
    }
    return { gone: gone, failed: failed, ids: ids };
  }

  /* A send that stops partway leaves objects on the host with no link pointing at
     them. That is not the same as nothing having happened: the bytes sit there
     until the host's clock deletes them, and on a free host there is no way to
     hurry that along — so the honest thing is to say exactly what is left and for
     how long. A bucket you hold credentials for can be cleaned up properly, so it
     is: an abandoned upload should not outlive the decision that made it. */
  async function afterFailure(backend, e, ids, expMs, ctx) {
    ctx = ctx || {};
    if (e && e.cancelled) UI.note('Cancelled.');
    else UI.error(e && e.message ? e.message : String(e));
    if (!ids || !ids.length) { if (ctx.sig) clearResume(ctx.sig); return; }
    var held = expMs ? ' for up to ' + U.fmtDuration(expMs / 3600000) : ' until the host clears them';
    var canResume = !!(ctx.rec && !(e && e.cancelled) && ctx.rec.parts.some(function (x) { return x; }));
    if (canResume) saveResume(ctx.sig, ctx.rec); else if (ctx.sig) clearResume(ctx.sig);
    if (backend && backend.key === 'selfhost' && typeof backend.remove === 'function') {
      // Deliberate abandonment (Cancel) cleans up; a failure keeps the parts only
      // while there is a job to continue, and says so instead of deleting quietly.
      if (canResume) {
        UI.warn(ids.length + ' of ' + ctx.rec.count + ' part' + (ctx.rec.count === 1 ? '' : 's') +
          ' are still in your bucket so this job can be continued — press Start again to send only what is missing,' +
          ' or “Start over” in the plan to remove them now.');
        return;
      }
      var out = await deleteParts(backend, ids);
      if (!out.failed) {
        UI.note(out.gone + ' of ' + ids.length + ' uploaded part' + (ids.length === 1 ? '' : 's') +
          (out.gone === 1 ? ' was' : ' were') + ' deleted from your bucket, so nothing is left behind.');
      } else {
        UI.warn(out.gone + ' of ' + ids.length + ' part' + (ids.length === 1 ? '' : 's') +
          ' were deleted; ' + out.failed + ' stayed in the bucket. If the bucket does not allow the DELETE' +
          ' method in its CORS settings, remove the objects there — the keys are the part ids in the failed link.');
      }
      return;
    }
    UI.warn(ids.length + ' part' + (ids.length === 1 ? '' : 's') + ' had already reached ' + shortName(backend) +
      ' and will stay there' + held + (canResume ? ', so starting again continues from where it stopped' : '') +
      '. Nothing can be rebuilt from them without the link, and ' + shortName(backend) + ' gives no way to delete them early.');
  }


  // The multipart wrapper is framing, not payload; subtract it so the progress
  // maths talk about file bytes the user cares about.


  /* A link has to survive being pasted into an email, so the part size is not only
     a RAM question: 84 parts of 64 MB encode to almost 10 KB, past the budget. The
     plan therefore grows the parts until a trial manifest of this exact shape fits,
     instead of uploading for two minutes and then failing at the link. */
  // A stand-in manifest with the same shape and the same kind of values the real
  // send() builds, so encode() measures the link rather than a guess of it.
  function trialLinkChars(total, parts, backend, exp, pw) {
    var app = MD.app;
    var m = {
      v: MD.manifest.VERSION,
      n: 'a-realistically-long-file-name.pdf',
      t: 'application/pdf',
      z: total,
      p: backend.key,
      b: 'https://host.example.com/d/abcdefghijkl/{id}',
      d: exp || 0,
      o: '',
      c: app.HASH_CHUNK,
      e: pw ? {
        salt: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY', fp: '0123456789abcdef',
        iv: 'MDEyMzQ1Njc4OWFiY2RlZg', it: MD.crypto.PBKDF2_ITERATIONS,
        bs: pw === true ? 32 * 1024 * 1024 - 16 : pw, oh: MD.crypto.OVERHEAD
      } : null,
      h: '0123456789abcdef0123456789abcdef',
      hm: total > app.FOLD_LIMIT ? 'parts' : 'file',
      x: exp ? Date.now() + exp : 0,
      u: '',
      parts: parts.map(function (q) {
        return { i: 'abcdefghijkl', s: q.size, h: '0123456789abcdef', b: 0 };
      })
    };
    return MD.manifest.encode(m).length;
  }

  function fitLink(total, cap, backend) {
    var pw = !!(state.cfg.password || '').trim();
    var c = cap, best = null, chars = 0;
    var max = backend.maxPartBytes || 0;
    for (var i = 0; i < 14; i++) {
      var parts = MD.pack.planParts(total, c, 1);
      chars = trialLinkChars(total, parts, backend, expiryMs(backend), pw);
      best = { cap: c, parts: parts, chars: chars, fits: chars <= MAX_TOKEN_CHARS };
      if (best.fits || !max || c >= max) return best;
      c = Math.min(max, Math.floor(c * 2));
    }
    return best;
  }

  // Part plan. No alignment constraint: every part carries its own record
  // count, so parts may end mid-record without the receiver guessing anything.
  function planInfoFor(backend, file) {
    var pw = (state.cfg.password || '').trim();
    var want = partCap(backend);
    var fit = fitLink(file.size, want, backend);
    return {
      parts: fit.parts,
      cap: fit.cap,
      blockSize: pw ? encBlockSize() : 0,
      linkChars: fit.chars,
      linkFits: fit.fits,
      capRaised: fit.cap > want
    };
  }

  function memoryCeiling() {
    var v = (MD.config || {}).maxMemoryBlob;
    if (v) {
      var n = U.parseSizeInput(String(v));
      if (n > 0) return n;
    }
    // deviceMemory (GiB of RAM) is a Chrome-only hint; where it is missing, assume
    // an ordinary laptop and keep well inside what a single tab can hold.
    var dev = global.navigator && global.navigator.deviceMemory ? Number(global.navigator.deviceMemory) : 0;
    if (dev > 0) return Math.round(dev * 0.3 * 1024 * 1024 * 1024);
    return Math.round(1.5 * 1024 * 1024 * 1024);
  }

  function expiryMs(backend) {
    var list = backend.expiries || [];
    var want = state.cfg.expiry || backend.defaultExpiry;
    for (var i = 0; i < list.length; i++) if (list[i].v === want) return list[i].ms;
    return list.length ? list[list.length - 1].ms : null;
  }

  // ---------------------------------------------------------- receive: flow ---
  function applyIncomingLink() {
    var hash = (global.location.hash || '').replace(/^#/, '');
    if (!hash) return false;
    try {
      var m = MD.manifest.decode(hash);
      UI.startReceive(m);
      return true;
    } catch (e) { return false; }
  }

  async function runReceive(m) {
    var app = MD.app, r = state.receive;
    if (r.busy) return;
    r.busy = true;
    r.resultBlob = null;
    r.resultBytes = 0;
    state.abort = new AbortController();
    UI.setBusy(true);
    UI.show('progress');
    var writer = null;
    try {
      var mm = MD.manifest.canonical(m || r.m);
      var missing = MD.manifest.missingParts(mm);
      if (missing.length) {
        throw new Error('Still missing part' + (missing.length > 1 ? 's ' : ' ') +
          missing.map(function (i) { return i + 1; }).join(', ') + '. Paste the link from the other email with “Add another link”.');
      }
      if (MD.receive.needsPassword(mm) && !(r.password || '').length) {
        var ask = global.prompt('This transfer is encrypted. Type the password the sender gave you:');
        if (ask == null) throw abortErr();
        r.password = ask;
      }

      // Prefer writing each part to disk as it arrives: a 12 GB file then never
      // has to fit in RAM. Falls back to building a Blob on browsers without it.
      if (MD.receive.canStreamSave() && !global.__MD_NO_STREAM__) {
        try {
          var pick = await MD.receive.pickWriter(mm.n);
          writer = pick.writable;
          UI.note('Saving to ' + pick.name + ' as it downloads.');
        } catch (e) {
          if (e && (e.name === 'AbortError')) throw abortErr();
          UI.warn('Could not open the save dialog (' + e.message + ') — falling back to in-memory assembly.');
          writer = null;
        }
      }

      /* Chrome and Edge write each window straight to the file the user chose, so
         the transfer never has to fit in memory. Without that API the whole file has
         to be held here, and being hopeful about that is how a tab dies with a
         spinner on it — so the ceiling is stated and refused instead. */
      var ceiling = memoryCeiling();
      if (!writer && mm.z > ceiling) {
        var em = new Error('This browser cannot stream a download to disk from a page, and ' + U.fmtBytes(mm.z) +
          ' is more than a tab should hold in memory (' + U.fmtBytes(ceiling) + ' is the limit here). Open this link' +
          ' in Chrome or Edge and press Download again — or take the file from the host, and MailDrop will still' +
          ' check the fingerprint afterwards if you paste it back.');
        em.retryable = false;
        em.memoryBound = true;
        em.hostUrl = mm.u || MD.manifest.partUrl(mm, 0);
        throw em;
      }

      var t0 = Date.now(), last = { done: 0, t: t0 }, bps = 0;
      var res = await MD.receive.assemble(mm, {
        password: r.password,
        writer: writer,
        signal: state.abort.signal,
        urls: r.urls || null,
        onProgress: function (p) {
          var now = Date.now();
          if (now - last.t > 350) {
            bps = bps * 0.55 + ((p.done - last.done) / ((now - last.t) / 1000)) * 0.45;
            last = { done: p.done, t: now };
          }
          var label = p.phase === 'write' ? 'writing' : 'downloading';
          UI.progress(p.done, p.total,
            'Part ' + (p.part + 1) + '/' + p.parts + ' ' + label + ' — ' + U.fmtBytes(p.done) + ' of ' + U.fmtBytes(p.total) +
            ' · ' + U.fmtRate(bps) + ' · ' + U.fmtEta(p.total - p.done, bps) + ' left');
        }
      });

      if (res.truncated) throw new Error(res.truncated);
      if (res.checkable && !res.verified) {
        throw new Error('Fingerprint mismatch: ' +
          (res.checkMode === 'chain' ? 'the parts do not hash to the chain the sender recorded'
            : 'the reassembled bytes hash to ' + String(res.fingerprint).slice(0, 12) + ' but the sender recorded ' + String(mm.h).slice(0, 12)) +
          '. Do not trust this file.' + (writer ? ' It was written to disk anyway so you can inspect it.' : ''));
      }
      if (!res.checkable) {
        UI.warn('This link carries no fingerprint, so nothing about the bytes could be checked — the file may be fine, but it is not proven.');
      }
      r.resultBlob = res.blob;
      r.resultBytes = res.bytes;
      r.resultFingerprint = res.fingerprint;
      r.writtenToFile = !!writer;
      UI.receiveReady(mm, res);
    } catch (e) {
      if (writer) { try { await writer.abort(); } catch (e2) { } }
      if (e && (e.hostUrl || (m && m.u))) UI.offerDirect(e.hostUrl || m.u, 'This host serves the file only to a direct click (no cross-origin read), so MailDrop cannot rebuild or verify it. The link above still works.');
      if (e && e.message === 'WRONG_PASSWORD') UI.error('That password does not match this transfer.');
      else if (e && e.cancelled) UI.note('Cancelled.');
      else UI.error((e && e.message ? e.message : String(e)) + (e && e.corsSuspect ? ' — if the file is on a host without CORS, open the receive page from that host or use a bucket.' : ''));
      if (UI.receiveFail) UI.receiveFail();
    } finally {
      r.busy = false;
      state.abort = null;
      UI.setBusy(false);
      UI.receiveDone();
    }
  }

  function pasteToken(text) {
    var m;
    try { m = MD.email.extract(text); }
    catch (e) { UI.error(e.message); return null; }
    var r = state.receive;
    if (r.m) {
      try { r.m = MD.manifest.merge(r.m, m); UI.renderReceive(r.m); UI.note('Merged. ' + MD.manifest.missingParts(r.m).length + ' part(s) still missing.'); }
      catch (e) { UI.error(e.message); }
    } else {
      UI.startReceive(m);
    }
    return m;
  }

  MD.app = {
    LS_KEY: LS_KEY,
    // 16 MiB: the receive side reads the host in 16 MiB windows, so hashing with
    // the same window means neither end ever buffers more than a window or two.
    HASH_CHUNK: 16 * 1024 * 1024,
    // above this, hashing the file for its fingerprint would cost the user a
    // noticeable wait before they even get a link, so the part chain is used
    FOLD_LIMIT: 8 * 1024 * 1024 * 1024,
    state: state,
    loadCfg: loadCfg,
    saveCfg: saveCfg,
    plan: plan,
    validateFiles: validateFiles,
    runSend: runSend,
    runReceive: runReceive,
    applyIncomingLink: applyIncomingLink,
    pasteToken: pasteToken,
    history: history,
    pushHistory: pushHistory,
    currentBackend: currentBackend,
    partCap: partCap,
    receiveBaseUrl: receiveBaseUrl,
    directUrl: '',
    MIN_PART: MIN_PART,
    SOFT_MIN_PART: SOFT_MIN_PART,
    MAX_PARTS_KEEN: MAX_PARTS_KEEN,
    MAX_TOKEN_CHARS: MAX_TOKEN_CHARS,
    expiryMs: expiryMs,
    memoryCeiling: memoryCeiling,
    resumeFor: resumeFor,
    forgetResume: async function (file) {
      var r = resumeFor(file);
      if (!r) return null;
      var out = null;
      if (r.backend.key === 'selfhost' && typeof r.backend.remove === 'function') {
        try { out = await deleteParts(r.backend, r.ids); }
        catch (e) { out = { gone: 0, failed: r.ids.length, ids: r.ids }; }
      }
      clearResume(r.sig);
      return { removed: out, count: r.count, ids: r.ids };
    },
    hashWholeFile: hashWholeFile,
    cancel: function () { if (state.abort) state.abort.abort(); }
  };

  // The view layer (ui.js) is a separate file so the logic above can be driven
  // headless in tests. The proxy resolves window.UI at call time and turns a
  // missing UI into a no-op, which keeps this file usable without a DOM.
  var QUIET_UI = {
    error: 1, warn: 1, note: 1, progress: 1, show: 1, hideProgress: 1,
    setBusy: 1, setStartLabel: 1, renderFiles: 1, renderPlan: 1, receivePhase: 1
  };
  function uiCall(name, args) {
    var u = global.UI;
    if (!u || typeof u[name] !== 'function') return undefined;
    // Reporting must not be able to fail: these calls happen inside catch
    // blocks, and a throw here would hide the error being reported.
    if (QUIET_UI[name]) { try { return u[name].apply(u, args); } catch (e) { return undefined; } }
    return u[name].apply(u, args);
  }
  var UI = new Proxy({}, {
    get: function (t, k) { return function () { return uiCall(k, arguments); }; },
    set: function (t, k, v) { if (global.UI) global.UI[k] = v; return true; }
  });
  MD.app.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
